#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { DB } = require('lamix');
const chalk = require('chalk');
const args = process.argv.slice(2);

// ------------------ LOGGER ------------------

const log = {
  success: (msg) => console.log(chalk.green(msg)),
  warn: (msg) => console.log(chalk.yellow(msg)),
  error: (msg) => console.log(chalk.red(msg)),
  info: (msg) => console.log(chalk.blue(msg))
};

// ------------------ CONSTANTS ------------------

const MIGRATIONS_DIR = './database/migrations';
const MIGRATIONS_TABLE = 'migrations';
const SEEDERS_DIR = './database/seeders';
const SEEDS_TABLE = 'seeds';

function getTimestamp() {
  const now = new Date();
  return now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
}

// ------------------ SCHEMA BUILDER ------------------

DB.schema = {
  createTable: async (tableName, callback) => {
    // --- Check if table exists dynamically ---
    async function tableExists(name) {
      if (DB.driver === 'mysql') {
        const rows = await DB.raw('SHOW TABLES LIKE ?', [name]);
        return rows.length > 0;
      } else if (DB.driver === 'sqlite') {
        const rows = await DB.raw(
          'SELECT name FROM sqlite_master WHERE type="table" AND name=?',
          [name]
        );
        return rows.length > 0;
      } else if (DB.driver === 'pg') {
        const rows = await DB.raw(
          `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
          [name]
        );
        return rows.length > 0;
      }
      return false;
    }

    if (await tableExists(tableName)) {
      log.warn(`⚠️ Skipping: table '${tableName}' already exists.`);
      return;
    }

    // --- Columns collection ---
    const columns = [];

    // --- Column wrapper for chainable modifiers ---
    function wrapColumn(name, type) {
      const col = { name, sql: `${DB.driver === 'pg' ? `"${name}"` : `\`${name}\``} ${type}` };
      columns.push(col);

      return {
        notNullable() {
          col.sql += ' NOT NULL';
          return this;
        },
        nullable() {
          col.sql += ' NULL';
          return this;
        },
        defaultTo(value) {
          if (value === null) col.sql += ' DEFAULT NULL';
          else if (typeof value === 'string' && !/^CURRENT_TIMESTAMP$/i.test(value)) col.sql += ` DEFAULT '${value}'`;
          else col.sql += ` DEFAULT ${value}`;
          return this;
        },
        unsigned() {
          if (DB.driver === 'mysql') col.sql += ' UNSIGNED';
          return this;
        },
        unique() {
          col.sql += ' UNIQUE';
          return this;
        },
        primary() {
          col.sql += ' PRIMARY KEY';
          return this;
        },
        autoIncrement() {
          if (DB.driver === 'mysql') col.sql += ' AUTO_INCREMENT';
          if (DB.driver === 'pg') col.sql = `"${name}" SERIAL`;
          if (DB.driver === 'sqlite') col.sql = `"${name}" INTEGER PRIMARY KEY AUTOINCREMENT`;
          return this;
        },
        comment(text) {
          if (DB.driver === 'mysql') col.sql += ` COMMENT '${text}'`;
          return this;
        },
        after(columnName) {
          if (DB.driver === 'mysql') col.sql += ` AFTER \`${columnName}\``;
          return this;
        }
      };
    }


    // --- Column type helper ---
    function typeMapping(type) {
      switch (DB.driver) {
        case 'mysql':
          return {
            increments: 'INT AUTO_INCREMENT PRIMARY KEY',
            string: 'VARCHAR(255)',
            integer: 'INT',
            boolean: 'TINYINT(1)',
            text: 'TEXT',
            float: 'FLOAT',
            decimal: 'DECIMAL(10,2)',
            date: 'DATE',
            dateTime: 'DATETIME',
            json: 'JSON',
            binary: 'BLOB'
          }[type];
        case 'sqlite':
          return {
            increments: 'INTEGER PRIMARY KEY AUTOINCREMENT',
            string: 'TEXT',
            integer: 'INTEGER',
            boolean: 'INTEGER',
            text: 'TEXT',
            float: 'REAL',
            decimal: 'REAL',
            date: 'TEXT',
            dateTime: 'TEXT',
            json: 'TEXT',
            binary: 'BLOB'
          }[type];
        case 'pg':
          return {
            increments: 'SERIAL PRIMARY KEY',
            string: 'VARCHAR(255)',
            integer: 'INTEGER',
            boolean: 'BOOLEAN',
            text: 'TEXT',
            float: 'REAL',
            decimal: 'NUMERIC(10,2)',
            date: 'DATE',
            dateTime: 'TIMESTAMP',
            json: 'JSONB',
            binary: 'BYTEA'
          }[type];
      }
    }

    // --- Table object with types and timestamps ---
    const table = {
      increments: (name) => wrapColumn(name, typeMapping('increments')),
      string: (name) => wrapColumn(name, typeMapping('string')),
      integer: (name) => wrapColumn(name, typeMapping('integer')),
      boolean: (name) => wrapColumn(name, typeMapping('boolean')),
      text: (name) => wrapColumn(name, typeMapping('text')),
      float: (name) => wrapColumn(name, typeMapping('float')),
      decimal: (name) => wrapColumn(name, typeMapping('decimal')),
      date: (name) => wrapColumn(name, typeMapping('date')),
      dateTime: (name) => wrapColumn(name, typeMapping('dateTime')),
      json: (name) => wrapColumn(name, typeMapping('json')),
      binary: (name) => wrapColumn(name, typeMapping('binary')),
      timestamps: () => {
        if (DB.driver === 'pg') {
          columns.push({ sql: `"created_at" TIMESTAMP DEFAULT NOW()` });
          columns.push({ sql: `"updated_at" TIMESTAMP DEFAULT NOW()` });
        } else if (DB.driver === 'sqlite') {
          columns.push({ sql: `"created_at" TEXT DEFAULT (DATETIME('now'))` });
          columns.push({ sql: `"updated_at" TEXT DEFAULT (DATETIME('now'))` });
        } else {
          columns.push({ sql: '`created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP' });
          columns.push({ sql: '`updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' });
        }
      }
    };

    await callback(table);

    // --- Build SQL ---
    const sql = `CREATE TABLE ${DB.driver === 'pg' ? `"${tableName}"` : `\`${tableName}\``} (\n  ${columns.map(c => c.sql).join(',\n  ')}\n)`;

    return await DB.raw(sql);
  },

  dropTableIfExists: async (tableName) => {
    const sql = DB.driver === 'pg' || DB.driver === 'sqlite'
      ? `DROP TABLE IF EXISTS "${tableName}"`
      : `DROP TABLE IF EXISTS \`${tableName}\``;
    return await DB.raw(sql);
  }
};

// ------------------ MIGRATION GENERATOR ------------------

function parseFields(fieldArgs) {
  const typeMap = {
    string: 'string',
    integer: 'integer',
    boolean: 'boolean',
    text: 'text',
    date: 'date',
    datetime: 'dateTime',
    float: 'float',
    decimal: 'decimal',
    json: 'json',
    binary: 'binary'
  };

  return fieldArgs.map(arg => {
    const [name, type] = arg.split(':');
    const fn = typeMap[type];
    if (!name || !fn) throw new Error(`Invalid field: ${arg}`);
    return `table.${fn}('${name}');`;
  });
}

function generateMigration(table, fields) {
  const timestamp = getTimestamp();
  const fileName = `${timestamp}_create_${table}_table.js`;
  const filePath = path.join(MIGRATIONS_DIR, fileName);

  const content = `
// Migration: Create ${table} table

module.exports = {
  up: async function (db) {
    await db.schema.createTable('${table}', (table) => {
      table.increments('id');
      ${fields.map(f => `      ${f}`).join('\n')}
      table.timestamps();
    });
  },

  down: async function (db) {
    await db.schema.dropTableIfExists('${table}');
  }
};
`;

  fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
  fs.writeFileSync(filePath, content.trimStart());
  log.success(`✅ Migration generated: ${filePath}`);
}

// ------------------ MIGRATIONS: UP / ROLLBACK ------------------

async function ensureMigrationsTable() {
  await DB.raw(`CREATE TABLE IF NOT EXISTS \`${MIGRATIONS_TABLE}\` (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) UNIQUE,
    run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
}

async function getAppliedMigrations() {
  await ensureMigrationsTable();
  const rows = await DB.raw(`SELECT name FROM \`${MIGRATIONS_TABLE}\``);
  return new Set(rows.map(r => r.name));
}

async function runMigrations() {
  DB.initFromEnv();
  await DB.connect();

  const applied = await getAppliedMigrations();
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.js'))
    .sort();

  // Helper to extract table name from migration file
  const extractTableName = (filePath) => {
    const content = fs.readFileSync(filePath, 'utf-8');
    const match = content.match(/db\.schema\.createTable\s*\(\s*['"]([^'"]+)['"]/);
    return match ? match[1] : null;
  };

  for (const file of files) {
    const migrationPath = path.resolve(MIGRATIONS_DIR, file);
    const migration = require(migrationPath);

    // Auto-detect tableName if not defined
    if (!migration.tableName) {
      migration.tableName = extractTableName(migrationPath);
    }

    let shouldRun = true;

    if (applied.has(file)) {
      if (migration.tableName) {
        const exists = await tableExists(migration.tableName);
        if (!exists) {
          log.warn(`⚠️ Migration '${file}' applied but table '${migration.tableName}' missing. Re-running...`);
        } else {
          log.info(`✅ Migration '${file}' already applied and table exists. Skipping.`);
          shouldRun = false;
        }
      } else {
        log.warn(`⚠️ Migration '${file}' applied but table unknown. Running migration.`);
      }
    }

    if (!shouldRun) continue;

    log.info(`⏳ Running migration: ${file}`);
    await migration.up(DB);

    if (!applied.has(file)) {
      await DB.raw(`INSERT INTO \`${MIGRATIONS_TABLE}\` (name) VALUES (?)`, [file]);
    }

    log.success(`✅ Applied: ${file}`);
  }

  await DB.end();
}

// ------------------ helper ------------------

async function tableExists(tableName) {
  if (DB.driver === 'mysql') {
    const rows = await DB.raw('SHOW TABLES LIKE ?', [tableName]);
    return rows.length > 0;
  } else if (DB.driver === 'sqlite') {
    const rows = await DB.raw(
      'SELECT name FROM sqlite_master WHERE type="table" AND name=?',
      [tableName]
    );
    return rows.length > 0;
  } else if (DB.driver === 'pg') {
    const rows = await DB.raw(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
      [tableName]
    );
    return rows.length > 0;
  }
  return false;
}


async function rollbackLastMigration() {
  DB.initFromEnv();
  await DB.connect();

  const [last] = await DB.raw(`SELECT name FROM \`${MIGRATIONS_TABLE}\` ORDER BY run_at DESC LIMIT 1`);

  if (!last) {
    log.info('ℹ️ No migrations to rollback.');
    return;
  }

  const file = last.name;
  const migration = require(path.resolve(MIGRATIONS_DIR, file));

  log.info(`⏳ Rolling back: ${file}`);
  await migration.down(DB);
  await DB.raw(`DELETE FROM \`${MIGRATIONS_TABLE}\` WHERE name = ?`, [file]);
  log.success(`✅ Rolled back: ${file}`);

  await DB.end();
}

// ------------------ SEEDERS ------------------

function generateSeeder(name) {
  const timestamp = getTimestamp();
  const fileName = `${timestamp}_${name}.js`;
  const filePath = path.join(SEEDERS_DIR, fileName);

  const content = `
// Seeder: ${name}

module.exports = {
  seed: async function (db) {
    // Example:
    // await db.raw("INSERT INTO users (name) VALUES (?)", ['Example']);
  }
};
`;

  fs.mkdirSync(SEEDERS_DIR, { recursive: true });
  fs.writeFileSync(filePath, content.trimStart());
  log.success(`✅ Seeder generated: ${filePath}`);
}

async function ensureSeedsTable() {
  await DB.raw(`CREATE TABLE IF NOT EXISTS \`${SEEDS_TABLE}\` (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) UNIQUE,
    run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
}

async function getAppliedSeeds() {
  const rows = await DB.raw(`SELECT name FROM \`${SEEDS_TABLE}\``);
  return new Set(rows.map(r => r.name));
}

async function runSeeders({ refresh = false, only = null } = {}) {
  DB.initFromEnv();
  await DB.connect();
  await ensureSeedsTable();

  const files = fs.readdirSync(SEEDERS_DIR).filter(f => f.endsWith('.js')).sort();
  let targets = files;

  if (only) {
    if (!files.includes(only)) {
      log.warn(`⚠️ Seed file not found: ${only}`);
      await DB.end();
      return;
    }
    targets = [only];
  }

  if (refresh) {
    await DB.raw(`DELETE FROM \`${SEEDS_TABLE}\``);
    log.info(`🔁 Refreshing all seeds...`);
  } else {
    const applied = await getAppliedSeeds();
    targets = targets.filter(f => !applied.has(f));
  }

  if (!targets.length) {
    log.success('✅ No seeders to run.');
    await DB.end();
    return;
  }

  for (const file of targets) {
    const seeder = require(path.resolve(SEEDERS_DIR, file));

    if (typeof seeder.seed !== 'function') {
      log.warn(`⚠️ Skipping invalid seeder: ${file}`);
      continue;
    }

    try {
      log.info(`🌱 Running seeder: ${file}`);
      await seeder.seed(DB);
      await DB.raw(`INSERT INTO \`${SEEDS_TABLE}\` (name) VALUES (?)`, [file]);
      log.success(`✅ Seeded: ${file}`);
    } catch (err) {
      log.error(`❌ Seeder failed: ${file}\n${err}`);
      break;
    }
  }

  await DB.end();
}

// ------------------ MODEL GENERATOR ------------------

function generateModel(name, fieldArgs = []) {
  try {
    if (!name || typeof name !== 'string') {
      log.error('❌ Invalid model name.');
      process.exit(1);
    }

    const modelDir = './models';
    fs.mkdirSync(modelDir, { recursive: true });

    let tableName = name.toLowerCase() + 's';

    const tableOptionIndex = fieldArgs.findIndex(arg => arg.startsWith('--table='));

    if (tableOptionIndex !== -1) {
      const parts = fieldArgs[tableOptionIndex].split('=');

      if (!parts[1]) {
        log.error('❌ Invalid --table option. Usage: --table=table_name');
        process.exit(1);
      }

      tableName = parts[1];
      fieldArgs.splice(tableOptionIndex, 1);
    }

    const fields = fieldArgs
      .filter(arg => arg.includes(':'))
      .map(arg => arg.split(':')[0])
      .filter(Boolean);

    const fillableArray = fields.length ? `['${fields.join("', '")}']` : `[]`;

    const className = name.charAt(0).toUpperCase() + name.slice(1);
    const filePath = path.join(modelDir, `${className}.js`);

    const content = `
// ${className} Model
const { BaseModel } = require('lamix');

class ${className} extends BaseModel {
  static table = '${tableName}';
  static primaryKey = 'id';
  static timestamps = true;
  static fillable = ${fillableArray};
}

module.exports = ${className};
`;

    fs.writeFileSync(filePath, content.trimStart());
    log.success(`✅ Model generated successfully: ${filePath}`);

  } catch (err) {
    log.error(`❌ Failed to generate model: ${err.message}`);
    process.exit(1);
  }
}

// ------------------ CLI HANDLER ------------------

(async () => {
  const command = args[0];

  switch (command) {
    case 'make:migration': {
      const table = args[1];
      const fields = args.slice(2);
      if (!table || fields.length === 0) {
        log.error('❌ Usage: make:migration <table> <field:type>...');
        process.exit(1);
      }
      generateMigration(table, parseFields(fields));
      break;
    }

    case 'migrate':
      await runMigrations();
      break;

    case 'migrate:rollback':
      await rollbackLastMigration();
      break;

    case 'make:seeder': {
      const seedName = args[1];
      if (!seedName) {
        log.error('❌ Usage: make:seeder <name>');
        process.exit(1);
      }
      generateSeeder(seedName);
      break;
    }

    case 'db:seed':
      await runSeeders();
      break;

    case 'db:seed:refresh':
      await runSeeders({ refresh: true });
      break;

    case 'db:seed:only': {
      const onlySeed = args[1];
      if (!onlySeed) {
        log.error('❌ Usage: db:seed:only <filename.js>');
        process.exit(1);
      }
      await runSeeders({ only: onlySeed });
      break;
    }

    case 'make:model': {
      const modelName = args[1];
      const modelFields = args.slice(2);

      if (!modelName) {
        log.error('❌ Usage: make:model <ModelName> [field:type ...]');
        process.exit(1);
      }

      generateModel(modelName, modelFields);
      break;
    }

    default:
      log.info(`
📦 CLI Migration & Seeder Tool

Usage:
   npm run artisan --
  🔹 Migration Commands:
    npm run artisan -- make:migration <TableName> [columns]
    npm run artisan -- migrate
    npm run artisan -- migrate:rollback

  🔹 Seeder Commands:
    npm run artisan -- make:seeder <name>
    npm run artisan -- db:seed
    npm run artisan -- db:seed:refresh
    npm run artisan -- db:seed:only <filename.js>

  🔹 Model Generator:
    npm run artisan -- make:model <name>
    npm run artisan -- make:model <ModelName> [field:type ...]
    npm run artisan -- make:model <name> name:string price:decimal stock:integer
`);
  }
})();
