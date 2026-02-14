'use strict';

const util = require('node:util');
const { performance } = require('perf_hooks');
const { AsyncLocalStorage } = require('async_hooks');
require('dotenv').config();
const session = require('express-session');
const { LRUCache } = require('lru-cache');
const zlib = require('zlib');

/* ---------------- Utilities ---------------- */

function tryRequire(name) {
  try { return require(name); } catch { return null; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- Errors ---------------- */

class DBError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'DBError';
    this.meta = meta;
    if (meta.err?.stack) this.stack += `\nCaused by: ${meta.err.stack}`;
  }
}

/* ---------------- Cache ---------------- */
class SimpleCache {
  constructor(options = {}) {
    const {
      maxSizeMB = 50,          // total memory cap
      defaultTTL = 1000 * 60 * 5, // 5 minutes
    } = options;

    this.cache = new LRUCache({
      maxSize: maxSizeMB * 1024 * 1024, // convert MB → bytes
      ttl: defaultTTL,
      ttlAutopurge: true,
      allowStale: false,

      // Estimate memory usage per entry
      sizeCalculation: (value, key) => {
        try {
          return Buffer.byteLength(JSON.stringify(value));
        } catch (err) {
          // fallback small size if stringify fails
          return 1024;
        }
      },
    });
  }

  /**
   * Get cached value
   * @param {string} key
   * @returns {*} value or null
   */
  get(key) {
    const value = this.cache.get(key);
    return value === undefined ? null : value;
  }

  /**
   * Set cache value
   * @param {string} key
   * @param {*} value
   * @param {number} ttl Optional TTL in ms
   */
  set(key, value, ttl = 0) {
    if (ttl > 0) {
      this.cache.set(key, value, { ttl });
    } else {
      this.cache.set(key, value);
    }
  }

  /**
   * Delete a key
   * @param {string} key
   */
  del(key) {
    this.cache.delete(key);
  }

  /**
   * Clear entire cache
   */
  clear() {
    this.cache.clear();
  }

  /**
   * Get cache stats (optional utility)
   */
  stats() {
    return {
      size: this.cache.size,
      calculatedSize: this.cache.calculatedSize,
      maxSize: this.cache.maxSize,
    };
  }
}


/* ---------------- Grammar ---------------- */

class Grammar {
  prepare(sql, bindings) {
    return { sql, bindings };
  }
}

class PostgresGrammar extends Grammar {
  prepare(sql, bindings) {
    let i = 0;
    return {
      sql: sql.replace(/\?/g, () => `$${++i}`),
      bindings
    };
  }
}

/* ---------------- DB Core ---------------- */

class DB {
  static driver = null;
  static config = null;
  static pool = null;

  static cache = new SimpleCache({ maxSizeMB: 500, defaultTTL: 1000 * 60 * 2});
  static retryAttempts = 1;

  static eventHandlers = { query: [], error: [], reconnect: [] };

  static _grammar = null;
  static _als = new AsyncLocalStorage();

  /* ---------- Init ---------- */

  static initFromEnv({
    driver = process.env.DB_CONNECTION || 'mysql',
    config = null,
    retryAttempts = 1
  } = {}) {
    this.driver = driver.toLowerCase();
    this.retryAttempts = Math.max(1, Number(retryAttempts));

    this._grammar =
      this.driver === 'pg' ? new PostgresGrammar() : new Grammar();

    if (config) {
      this.config = config;
      return;
    }

    if (this.driver === 'sqlite') {
      this.config = {
        filename: process.env.DB_DATABASE || ':memory:'
      };
    } else if (this.driver === 'pg') {
      this.config = {
        host: process.env.DB_HOST || '127.0.0.1',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASS || '',
        database: process.env.DB_NAME || 'postgres',
        port: Number(process.env.DB_PORT || 5432),
        max: Number(process.env.DB_CONNECTION_LIMIT || 10)
      };
    } else {
      this.config = {
        host: process.env.DB_HOST || '127.0.0.1',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASS || '',
        database: process.env.DB_NAME,
        port: Number(process.env.DB_PORT || 3306),
        waitForConnections: true,
        connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10)
      };
    }
  }

  /* ---------- Events ---------- */

  static on(event, fn) {
    if (!this.eventHandlers[event]) this.eventHandlers[event] = [];
    this.eventHandlers[event].push(fn);
  }

  static _emit(event, payload) {
    for (const fn of this.eventHandlers[event] || []) {
      try { fn(payload); } catch {}
    }
  }

  /* ---------- Driver ---------- */
  static _ensureModule() {
    if (!this.driver) this.initFromEnv();

    const safeRequire = (name) => {
      try {
        return require(name);
      } catch (err) {
        if (err.code === 'ERR_REQUIRE_ASYNC_MODULE') {
          throw new DBError(
            `${name} is ESM-only or uses top-level await. Use a CommonJS version.`,
            { module: name, err }
          );
        }
        throw err;
      }
    };

    if (this.driver === 'mysql') {
      return safeRequire('mysql2/promise');
    }

    if (this.driver === 'pg') {
      return safeRequire('pg');
    }

    if (this.driver === 'sqlite') {
      return safeRequire('sqlite3');
    }

    throw new DBError(`Unsupported driver: ${this.driver}`);
  }


  /* ---------- Connection ---------- */

  static async connect() {
    if (this.pool) return this.pool;

    const driver = this._ensureModule();

    if (this.driver === 'mysql') {
      this.pool = driver.createPool(this.config);
    }

    if (this.driver === 'pg') {
      const { Pool } = driver;
      this.pool = new Pool(this.config);
    }

    if (this.driver === 'sqlite') {
      const db = new driver.Database(this.config.filename);
      db.runAsync = util.promisify(db.run.bind(db));
      db.allAsync = util.promisify(db.all.bind(db));
      db.execAsync = util.promisify(db.exec.bind(db));

      await db.execAsync('PRAGMA journal_mode=WAL');
      await db.execAsync('PRAGMA busy_timeout=5000');

      this.pool = {
        __sqlite_db: db,
        async query(sql, params = []) {
          const isSelect = /^\s*(select|pragma)/i.test(sql);
          if (isSelect) return [await db.allAsync(sql, params)];
          const r = await db.runAsync(sql, params);
          return [{ insertId: r.lastID, affectedRows: r.changes }];
        },
        close: () => new Promise((r, j) => db.close(e => e ? j(e) : r()))
      };
    }

    return this.pool;
  }

  static async getConnection() {
    const store = this._als.getStore();
    if (store?.conn) return store.conn;
    return this.connect();
  }

  static async reconnect() {
    await this.end();
    this._emit('reconnect', {});
    return this.connect();
  }

  static async end() {
    if (!this.pool) return;
    try {
      if (this.driver !== 'sqlite') await this.pool.end();
      else await this.pool.close();
    } finally {
      this.pool = null;
    }
  }

  /* ---------- Core Runner ---------- */

  static async run(sql, bindings, executor, { isWrite = false } = {}) {
    let attempt = 0;

    while (++attempt <= this.retryAttempts) {
      const start = performance.now();

      try {
        const result = await executor();

        this._emit('query', {
          sql,
          bindings,
          time: performance.now() - start,
          driver: this.driver
        });

        return result;
      } catch (err) {
        const isConnectionError =
          err?.code === 'PROTOCOL_CONNECTION_LOST' ||
          err?.code === 'ECONNRESET' ||
          err?.code === 'ECONNREFUSED' ||
          err?.code === 'ETIMEDOUT' ||
          /dead|lost|timeout|reset|closed|connect/i.test(err.message);

        this._emit('error', {
          err,
          sql,
          bindings,
          attempt,
          connectionError: isConnectionError
        });

        const canRetry =
          (!isWrite || this._als.getStore()?.inTransaction) &&
          isConnectionError;

        if (canRetry && attempt < this.retryAttempts) {
          await this.reconnect();
          await sleep(100 * attempt);
          continue;
        }

        throw new DBError(
          isConnectionError ? 'DB connection failed' : 'DB query failed',
          {
            sql,
            bindings,
            attempt,
            connectionError: isConnectionError,
            err
          }
        );
      }
    }
  }

  /* ---------- Queries ---------- */

  static async raw(sql, bindings = []) {
    const pool = await this.getConnection();
    const prepared = this._grammar.prepare(sql, bindings);

    return this.run(sql, bindings, async () => {
      if (this.driver === 'pg') {
        const r = await pool.query(prepared.sql, prepared.bindings);
        return r.rows;
      }
      const [rows] = await pool.query(prepared.sql, prepared.bindings);
      return rows;
    });
  }

  static async affectingStatement(sql, bindings = []) {
    const pool = await this.getConnection();
    const prepared = this._grammar.prepare(sql, bindings);

    return this.run(sql, bindings, async () => {
      if (this.driver === 'pg') {
        const r = await pool.query(prepared.sql, prepared.bindings);
        return { affectedRows: r.rowCount };
      }
      const [r] = await pool.query(prepared.sql, prepared.bindings);
      return r;
    }, { isWrite: true });
  }

  static select(sql, bindings = []) { return this.raw(sql, bindings); }
  static statement(sql, bindings = []) { return this.affectingStatement(sql, bindings); }
  static async insert(sql, bindings = []) {
    const r = await this.affectingStatement(sql, bindings);
    return r.insertId ?? true;
  }
  static async update(sql, bindings = []) {
    const r = await this.affectingStatement(sql, bindings);
    return r.affectedRows ?? 0;
  }
  static delete(sql, bindings = []) { return this.update(sql, bindings); }

  /* ---------- Transactions ---------- */

  static async transaction(fn) {
    const pool = await this.connect();

    return this._als.run({ inTransaction: true }, async () => {
      let conn;

      try {
        if (this.driver === 'mysql') {
          conn = await pool.getConnection();
          await conn.beginTransaction();
          this._als.getStore().conn = conn;
          const r = await fn(conn);
          await conn.commit();
          return r;
        }

        if (this.driver === 'pg') {
          conn = await pool.connect();
          await conn.query('BEGIN');
          this._als.getStore().conn = conn;
          const r = await fn(conn);
          await conn.query('COMMIT');
          return r;
        }

        if (this.driver === 'sqlite') {
          await pool.__sqlite_db.execAsync('BEGIN');
          this._als.getStore().conn = pool;
          const r = await fn(pool);
          await pool.__sqlite_db.execAsync('COMMIT');
          return r;
        }
      } catch (e) {
        try {
          await conn?.query?.('ROLLBACK');
        } catch {}
        throw e;
      } finally {
        conn?.release?.();
      }
    });
  }

  /* ---------- Helpers ---------- */

  static escapeId(id) {
    if (id === '*') return '*';
    if (/\s|\(|\)| as /i.test(id)) return id;
    return this.driver === 'pg'
      ? `"${id.replace(/"/g, '""')}"`
      : `\`${id.replace(/`/g, '``')}\``;
  }

  static async cached(sql, bindings = [], ttl = 0) {
    const key = JSON.stringify([sql, bindings]);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const rows = await this.raw(sql, bindings);
    this.cache.set(key, rows, ttl);
    return rows;
  }
}

const escapeId = s => DB.escapeId(s);

class LamixSessionStore extends session.Store {
  constructor(options = {}) {
    super();

    this.table = options.table || 'sessions';
    this.ttl = options.ttl || 86400; // seconds
    this.cleanupInterval = options.cleanupInterval || 60000; // ms
    this.compress = options.compress !== false; // default true
    this.lazyInit = options.lazyInit || false;

    const {
      cacheSizeMB = 50,
      cacheTTL = 1000 * 60 * 5
    } = options;

    this.cache = new LRUCache({
      maxSize: cacheSizeMB * 1024 * 1024,
      ttl: cacheTTL,
      ttlAutopurge: true,
      sizeCalculation: (value) => {
        try { return Buffer.byteLength(JSON.stringify(value)); }
        catch { return 1024; }
      }
    });

    if (!this.lazyInit) {
      this._ensureTable().catch(err => {
        console.error('Session table init failed:', err);
      });
    }

    this._startCleanup();
  }

  /* ---------- Ensure Table ---------- */

  async _ensureTable() {
    const table = DB.escapeId(this.table);

    if (DB.driver === 'pg') {
      await DB.statement(`
        CREATE TABLE IF NOT EXISTS ${table} (
          sid TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          expires BIGINT NOT NULL
        )
      `);
    } else if (DB.driver === 'sqlite') {
      await DB.statement(`
        CREATE TABLE IF NOT EXISTS ${table} (
          sid TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          expires INTEGER NOT NULL
        )
      `);
    } else {
      await DB.statement(`
        CREATE TABLE IF NOT EXISTS ${table} (
          sid VARCHAR(255) PRIMARY KEY,
          data TEXT NOT NULL,
          expires BIGINT NOT NULL
        )
      `);
    }
  }

  /* ---------- Utilities ---------- */

  async _compress(data) {
    if (!this.compress) return Buffer.from(data);
    return util.promisify(zlib.deflate)(data);
  }

  async _decompress(buffer) {
    try {
      if (!this.compress) return buffer;
      return await util.promisify(zlib.inflate)(buffer);
    } catch {
      // fallback for old non-compressed sessions
      return buffer;
    }
  }

  _getExpiry(sessionData) {
    return sessionData.cookie?.expires
      ? new Date(sessionData.cookie.expires).getTime()
      : Date.now() + this.ttl * 1000;
  }

  _cacheTTL(expires) {
    const ms = expires - Date.now();
    return ms > 0 ? ms : 1;
  }

  /* ---------- Core ---------- */

  async get(sid, cb) {
    try {
      const cached = this.cache.get(sid);
      if (cached) return cb(null, cached);

      const rows = await DB.select(
        `SELECT data, expires FROM ${DB.escapeId(this.table)} WHERE sid = ? AND expires > ?`,
        [sid, Date.now()]
      );

      if (!rows.length) return cb(null, null);

      const buffer = Buffer.from(rows[0].data, 'base64');
      const decompressed = await this._decompress(buffer);

      const sessionData = JSON.parse(decompressed.toString());

      this.cache.set(sid, sessionData, { ttl: this._cacheTTL(rows[0].expires) });

      cb(null, sessionData);
    } catch (err) {
      cb(err);
    }
  }

  async set(sid, sessionData, cb) {
    try {
      const expires = this._getExpiry(sessionData);
      const raw = JSON.stringify(sessionData);
      const compressed = await this._compress(raw);
      const data = compressed.toString('base64');

      const table = DB.escapeId(this.table);

      if (DB.driver === 'pg') {
        await DB.statement(`
          INSERT INTO ${table} (sid, data, expires)
          VALUES (?, ?, ?)
          ON CONFLICT (sid)
          DO UPDATE SET data = EXCLUDED.data, expires = EXCLUDED.expires
        `, [sid, data, expires]);

      } else if (DB.driver === 'sqlite') {
        await DB.statement(`
          INSERT INTO ${table} (sid, data, expires)
          VALUES (?, ?, ?)
          ON CONFLICT(sid)
          DO UPDATE SET data=excluded.data, expires=excluded.expires
        `, [sid, data, expires]);

      } else {
        await DB.statement(`
          INSERT INTO ${table} (sid, data, expires)
          VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE data=VALUES(data), expires=VALUES(expires)
        `, [sid, data, expires]);
      }

      this.cache.set(sid, sessionData, { ttl: this._cacheTTL(expires) });

      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  async destroy(sid, cb) {
    try {
      await DB.delete(
        `DELETE FROM ${DB.escapeId(this.table)} WHERE sid = ?`,
        [sid]
      );
      this.cache.delete(sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  async touch(sid, sessionData, cb) {
    if (!sessionData) return cb();

    try {
      const expires = this._getExpiry(sessionData);

      await DB.update(
        `UPDATE ${DB.escapeId(this.table)} SET expires = ? WHERE sid = ?`,
        [expires, sid]
      );

      this.cache.set(sid, sessionData, { ttl: this._cacheTTL(expires) });

      cb();
    } catch (err) {
      cb(err);
    }
  }

  /* ---------- Cleanup ---------- */

  _startCleanup() {
    this._cleanupTimer = setInterval(async () => {
      try {
        await DB.delete(
          `DELETE FROM ${DB.escapeId(this.table)} WHERE expires < ?`,
          [Date.now()]
        );
      } catch {}
    }, this.cleanupInterval);

    this._cleanupTimer.unref();
  }

  close() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
    }
  }
}


// -----------------------------
// MAIN Validator
// -----------------------------
class Validator {
  constructor(data = {}, id = null, table = null, rules = {}, customMessages = {}, db = null) {
    this.data = data;
    this.id = id === undefined || id === null ? null : id;
    this.table = table || null;
    this.rules = rules || {};
    this.customMessages = customMessages || {};
    this.errorBag = {};
    this.primaryKey = 'id';
    this.db = db || (typeof DB !== 'undefined' ? DB : null);

  }

  // -----------------------------
  // MAIN
  // -----------------------------
  async fails() {
    this.errorBag = {};

    for (const field in this.rules) {
      let rulesArray = this.rules[field];

      if (typeof rulesArray === 'string') rulesArray = rulesArray.split('|');
      else if (!Array.isArray(rulesArray)) {
        this.addError(field, `Rules for field "${field}" must be string or array.`);
        continue;
      }

      const isNullable = rulesArray.includes('nullable');
      rulesArray = rulesArray.filter(r => r !== 'nullable');

      if (rulesArray.includes('sometimes')) {
        rulesArray = rulesArray.filter(r => r !== 'sometimes');
        if (!this.data.hasOwnProperty(field)) continue;
      }

      if (isNullable && (this.data[field] === '' || this.data[field] === null || this.data[field] === undefined)) continue;

      for (let rule of rulesArray) {
        const [ruleName, ...paramParts] = rule.split(':');
        const param = paramParts.join(':');
        const params = param ? param.split(',') : [];

        const method = `validate${ruleName.charAt(0).toUpperCase() + ruleName.slice(1)}`;
        
        try {
          if (typeof this[method] !== 'function') {
            this.addError(field, `Validation rule "${ruleName}" does not exist.`);
            continue;
          }

          if (['unique', 'exists'].includes(ruleName)) await this[method](field, ...params);
          else this[method](field, ...params);
        } catch (err) {
          this.addError(field, `Error validating ${field} with ${ruleName}: ${err.message}`);
        }
      }
    }

    return Object.keys(this.errorBag).length > 0;
  }

  passes() {
    return !Object.keys(this.errorBag).length;
  }

  getErrors() {
    return this.errorBag;
  }

  addError(field, message) {
    if (!this.errorBag[field]) this.errorBag[field] = [];
    this.errorBag[field].push(message);
  }

  msg(field, rule, fallback) {
    return this.customMessages[`${field}.${rule}`] || this.customMessages[rule] || fallback;
  }

  toNumber(val) {
    return val === undefined || val === null || val === "" ? null : Number(val);
  }

  // -----------------------------
  // CORE RULES
  // -----------------------------
  validateRequired(field) {
    const value = this.data[field];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      this.addError(field, this.msg(field, 'required', `${field} is required.`));
    }
  }

  validateString(field) {
    const value = this.data[field];
    if (typeof value !== 'string') {
      this.addError(field, this.msg(field, 'string', `${field} must be a string.`));
    }
  }

  validateBoolean(field) {
    const value = this.data[field];
    const allowed = [true, false, 1, 0, "1", "0", "true", "false"];

    if (!allowed.includes(value)) {
      this.addError(field, this.msg(field, 'boolean', `${field} must be boolean`));
    }
  }

  validateNumeric(field) {
    const value = this.data[field];
    if (isNaN(Number(value))) {
      this.addError(field, this.msg(field, 'numeric', `${field} must be numeric.`));
    }
  }

  validateInteger(field) {
    if (!Number.isInteger(Number(this.data[field]))) {
      this.addError(field, this.msg(field, 'integer', `${field} must be integer.`));
    }
  }

  validateEmail(field) {
    const value = String(this.data[field]);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      this.addError(field, this.msg(field, 'email', `${field} must be valid email.`));
    }
  }

  validateMin(field, min) {
    const val = this.data[field];
    if (val === undefined || val === null || val === '') return; // skip nullable

    // Ensure min is numeric
    const limit = Math.max(...[min].flat().map(Number));

    // For strings or arrays, use length
    if (typeof val === 'string' || Array.isArray(val)) {
      if (val.length < limit) {
        this.addError(field, 'min', `${field} must be at least ${limit} characters.`);
      }
    }
    // For numbers, compare numerically
    else if (!isNaN(Number(val))) {
      if (Number(val) < limit) {
        this.addError(field, 'min', `${field} must be at least ${limit}.`);
      }
    }
  }

  validateMax(field, max) {
    const val = this.data[field];
    if (val === undefined || val === null || val === '') return; // skip nullable

    // Ensure max is numeric
    const limit = Math.min(...[max].flat().map(Number));

    // For strings or arrays, use length
    if (typeof val === 'string' || Array.isArray(val)) {
      if (val.length > limit) {
        this.addError(field, 'max', `${field} must be no more than ${limit} characters.`);
      }
    }
    // For numbers, compare numerically
    else if (!isNaN(Number(val))) {
      if (Number(val) > limit) {
        this.addError(field, 'max', `${field} must be no more than ${limit}.`);
      }
    }
  }

  validateConfirmed(field) {
    const value = this.data[field];
    const confirm = this.data[field + '_confirmation'];
    if (value !== confirm) {
      this.addError(field, this.msg(field, 'confirmed', `${field} confirmation does not match.`));
    }
  }

  validateDate(field) {
    if (isNaN(Date.parse(this.data[field]))) {
      this.addError(field, this.msg(field, 'date', `${field} must be valid date.`));
    }
  }

  validateUrl(field) {
    try { new URL(String(this.data[field])); }
    catch { this.addError(field, this.msg(field, 'url', `${field} must be valid URL.`)); }
  }

  validateIp(field) {
    const value = String(this.data[field]);
    const regex = /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/;
    if (!regex.test(value)) {
      this.addError(field, this.msg(field, 'ip', `${field} must be valid IPv4 address.`));
    }
  }

    validateUuid(field) {
    const val = this.data[field];
    if (!val) return;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(val))) {
      this.addError(field, this.msg(field, 'uuid', `${field} must be a valid UUID.`));
    }
  }

  validateSlug(field) {
    const val = this.data[field];
    if (!val) return;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(val))) {
      this.addError(field, this.msg(field, 'slug', `${field} must be a valid slug.`));
    }
  }

  validateAfter(field, dateField) {
    const val = this.data[field];
    const other = this.data[dateField];
    if (!val || !other) return;
    const a = Date.parse(val);
    const b = Date.parse(other);
    if (isNaN(a) || isNaN(b)) return;
    if (a <= b) {
      this.addError(field, this.msg(field, 'after', `${field} must be a date after ${dateField}.`));
    }
  }

  validateBefore(field, dateField) {
    const val = this.data[field];
    const other = this.data[dateField];
    if (!val || !other) return;
    const a = Date.parse(val);
    const b = Date.parse(other);
    if (isNaN(a) || isNaN(b)) return;
    if (a >= b) {
      this.addError(field, this.msg(field, 'before', `${field} must be a date before ${dateField}.`));
    }
  }

  validateRegex(field, pattern) {
    const val = this.data[field];
    if (!val) return;
    let regex;
    try {
      if (/^\/.*\/[gimsuy]*$/.test(pattern)) {
        const lastSlash = pattern.lastIndexOf('/');
        const body = pattern.slice(1, lastSlash);
        const flags = pattern.slice(lastSlash + 1);
        regex = new RegExp(body, flags);
      } else {
        regex = new RegExp(pattern);
      }
    } catch (e) {
      throw new Error(`Invalid regex pattern for ${field}: ${pattern}`);
    }

    if (!regex.test(String(val))) {
      this.addError(field, this.msg(field, 'regex', `${field} format is invalid.`));
    }
  }

  validateIn(field, ...values) {
    const val = this.data[field];
    if (val === undefined || val === null || val === '') return;
    const normalizedValues = values.map(v => String(v));
    if (!normalizedValues.includes(String(val))) {
      this.addError(field, this.msg(field, 'in', `${field} must be one of [${values.join(', ')}].`));
    }
  }

  validateNotIn(field, ...values) {
    const val = this.data[field];
    if (val === undefined || val === null || val === '') return;
    const normalizedValues = values.map(v => String(v));
    if (normalizedValues.includes(String(val))) {
      this.addError(field, this.msg(field, 'not_in', `${field} must not be one of [${values.join(', ')}].`));
    }
  }

  // -----------------------------
  // HARDENED DB RULES
  // -----------------------------
  async validateUnique(field, table = null, column = null, ignore = null, pk = null) {
    if (!this.db) throw new Error("Database required for unique rule");
    const value = this.data[field];
    if (value === undefined || value === null || value === '') return;

    table  = table  || this.table;
    column = column || field;
    ignore = (ignore === undefined || ignore === null || ignore === '') ? this.id : ignore;
    pk     = pk || this.primaryKey;

    if (!table) throw new Error(`Unique rule requires a table. Example: unique:users,email`);

    const qb = new QueryBuilder(table)
      .select('1')
      .where(column, value);

    // Only ignore when we have an ID
    if (ignore !== null) {
      qb.whereNot(pk, ignore);
    }

    const exists = await qb.exists();
    if (exists === true) {
      this.addError(field, this.msg(field, 'unique', `${field} has already been taken.`));
    }
  }

  async validateExists(field, table = null, column = null, whereColumn = null, whereValue = null) {
    if (!this.db) throw new Error("Database required for exists rule");
    const value = this.data[field];
    if (value === undefined || value === null || value === '') return;

    table  = table  || this.table;
    column = column || field;

    if (!table) throw new Error(`Exists validation for "${field}" requires a table. Example: exists:users,id`);

    const qb = new QueryBuilder(table)
      .select('1')
      .where(column, value);

    if (whereColumn && whereValue !== undefined && whereValue !== null) {
      qb.where(whereColumn, whereValue);
    }

    const found = await qb.exists();
    if (!found) {
      this.addError(field, this.msg(field, 'exists', `${field} does not exist in ${table}.`));
    }
  }

    validatePhone(field) {
    const val = this.data[field];
    if (!val) return;
    const s = String(val);
    const phoneRegex = /^(0\d{9}|\+[1-9]\d{6,14})$/;
    if (!phoneRegex.test(s)) {
      this.addError(field, this.msg(field, 'phone', `${field} must be a valid phone number.`));
    }
  }

  validateAlpha(field) {
    const val = this.data[field];
    if (!val) return;
    if (!/^[A-Za-z]+$/.test(String(val))) {
      this.addError(field, this.msg(field, 'alpha', `${field} must contain only letters.`));
    }
  }

  validateAlphaNum(field) {
    const val = this.data[field];
    if (!val) return;
    if (!/^[A-Za-z0-9]+$/.test(String(val))) {
      this.addError(field, this.msg(field, 'alpha_num', `${field} must contain only letters and numbers.`));
    }
  }

  validateArray(field) {
    const val = this.data[field];
    if (val === undefined) return;
    if (!Array.isArray(val)) this.addError(field, this.msg(field, 'array', `${field} must be an array.`));
  }

  validateJson(field) {
    const val = this.data[field];
    if (!val) return;
    try { JSON.parse(String(val)); }
    catch (e) { this.addError(field, this.msg(field, 'json', `${field} must be valid JSON.`)); }
  }

  validateBetween(field, min, max) {
    const val = this.data[field];
    if (val === undefined || val === null || val === '') return;
    const nMin = Number(min), nMax = Number(max);
    if ((typeof val === 'number' && (val < nMin || val > nMax)) ||
      ((typeof val === 'string' || Array.isArray(val)) && (val.length < nMin || val.length > nMax)) ||
      (!isNaN(Number(val)) && (Number(val) < nMin || Number(val) > nMax))) {
      this.addError(field, this.msg(field, 'between', `${field} must be between ${min} and ${max}.`));
    }
  }

  // -----------------------------
  // FILE RULES HARDENED
  // -----------------------------
  validateFile(field) {
    const value = this.data[field];
    if (!value || typeof value !== 'object' || (!value.name && !value.size)) {
      this.addError(field, this.msg(field, 'file', `${field} must be valid file upload.`));
    }
  }

  validateImage(field) {
    const value = this.data[field];
    if (!value || !value.name) {
      this.addError(field, this.msg(field, 'image', `${field} must be valid image file.`));
      return;
    }
    const ext = value.name.split('.').pop().toLowerCase();
    if (!['jpg','jpeg','png','gif','webp','bmp','svg'].includes(ext)) {
      this.addError(field, this.msg(field, 'image', `${field} must be valid image file.`));
    }
  }

  validateMimes(field, types) {
    const value = this.data[field];
    if (!value || !value.name) return;

    const allowed = types.split(',').map(t => t.trim().toLowerCase());
    const ext = value.name.split('.').pop().toLowerCase();

    if (!allowed.includes(ext)) {
      this.addError(field, this.msg(field, 'mimes', `${field} must be of type: ${types}.`));
    }
  }

  validateSize(field, maxKB) {
    const value = this.data[field];
    if (!value || !value.size) return;
    const max = Number(maxKB) * 1024;
    if (value.size > max) {
      this.addError(field, this.msg(field, 'size', `${field} must not exceed ${maxKB} KB.`));
    }
  }
}

// ------------------------------------------------------------
// Collection Class (Safe Array Extension)
// ------------------------------------------------------------
class Collection extends Array {
  constructor(items = []) {
    super(...(Array.isArray(items) ? items : [items]));
  }

  // -------------------------
  // Meta
  // -------------------------
  count() { return this.length; }
  isEmpty() { return this.length === 0; }
  isNotEmpty() { return this.length > 0; }
  first() { return this[0] ?? null; }
  last() { return this[this.length - 1] ?? null; }
  nth(index) { return this[index] ?? null; }

  // -------------------------
  // Conversion
  // -------------------------
  toArray() { return [...this]; }
  toJSON() { return this.toArray(); }
  clone() { return new Collection(this); }

  // -------------------------
  // Iteration
  // -------------------------
  async each(fn) {
    for (let i = 0; i < this.length; i++) {
      await fn(this[i], i);
    }
    return this;
  }

  async mapAsync(fn) {
    const out = [];
    for (let i = 0; i < this.length; i++) {
      out.push(await fn(this[i], i));
    }
    return new Collection(out);
  }

  // -------------------------
  // Filtering
  // -------------------------
  /**
   * Enhanced filter:
   * - filter(fn)
   * - filter({ key: value })
   * - filter('key', value)
   * - filter('key', '>', value)
   */
  filter(condition, operator = null, value = null) {

    // 1️⃣ Callback style
    if (typeof condition === 'function') {
      return new Collection(
        Array.prototype.filter.call(this, condition)
      );
    }

    // 2️⃣ Object style
    if (typeof condition === 'object' && !Array.isArray(condition)) {
      return new Collection(
        Array.prototype.filter.call(this, item =>
          Object.entries(condition).every(
            ([k, v]) => item?.[k] === v
          )
        )
      );
    }

    // 3️⃣ Key/value or key/operator/value
    if (typeof condition === 'string') {

      // If only 2 args → assume "="
      if (value === null) {
        value = operator;
        operator = '=';
      }

      return new Collection(
        Array.prototype.filter.call(this, item => {
          const field = item?.[condition];

          switch (operator) {
            case '=':
            case '==':  return field == value;
            case '===': return field === value;
            case '!=':  return field != value;
            case '!==': return field !== value;
            case '>':   return field > value;
            case '>=':  return field >= value;
            case '<':   return field < value;
            case '<=':  return field <= value;
            case 'in':     return Array.isArray(value) && value.includes(field);
            case 'not in': return Array.isArray(value) && !value.includes(field);
            default: return false;
          }
        })
      );
    }

    return new Collection();
  }

  // Laravel-style aliases
  where(key, operator, value = null) {
    return this.filter(key, operator, value);
  }

  whereNot(key, value) {
    return this.filter(item => item?.[key] !== value);
  }

  filterNull() {
    return this.filter(v => v !== null && v !== undefined);
  }

  onlyKeys(keys) {
    return new Collection(this.map(item => {
      const o = {};
      keys.forEach(k => { if (k in item) o[k] = item[k]; });
      return o;
    }));
  }

  exceptKeys(keys) {
    return new Collection(this.map(item => {
      const o = { ...item };
      keys.forEach(k => delete o[k]);
      return o;
    }));
  }

  // -------------------------
  // Sorting
  // -------------------------
  sortBy(key) {
    return new Collection([...this].sort((a, b) =>
      a?.[key] > b?.[key] ? 1 : -1
    ));
  }

  sortByDesc(key) {
    return new Collection([...this].sort((a, b) =>
      a?.[key] < b?.[key] ? 1 : -1
    ));
  }

  // -------------------------
  // Mapping & Transform
  // -------------------------
  mapToArray(fn) {
    return super.map(fn);
  }

  pluck(key) {
    return new Collection(this.map(item => item?.[key]));
  }

  toObject() {
    return this.toArray().map(item => item.toObject ? item.toObject() : { ...item });
  }

  compact() {
    return new Collection(this.filter(Boolean));
  }

  flatten(depth = 1) {
    return new Collection(this.flat(depth));
  }

  flattenDeep() {
    return new Collection(this.flat(Infinity));
  }

  unique(fnOrKey = null) {
    if (typeof fnOrKey === 'string') {
      const seen = new Set();
      return new Collection(this.filter(item => {
        const val = item?.[fnOrKey];
        if (seen.has(val)) return false;
        seen.add(val);
        return true;
      }));
    }
    if (typeof fnOrKey === 'function') {
      const seen = new Set();
      return new Collection(this.filter(item => {
        const val = fnOrKey(item);
        if (seen.has(val)) return false;
        seen.add(val);
        return true;
      }));
    }
    return new Collection([...new Set(this)]);
  }

  // -------------------------
  // Reducing & Aggregates
  // -------------------------
  sum(key = null) {
    return this.reduce((acc, val) => acc + (key ? val[key] : val), 0);
  }

  avg(key = null) {
    return this.length ? this.sum(key) / this.length : 0;
  }

  max(key = null) {
    if (this.isEmpty()) return null;
    return key
      ? this.reduce((a, b) => (b[key] > a[key] ? b : a))
      : Math.max(...this);
  }

  min(key = null) {
    if (this.isEmpty()) return null;
    return key
      ? this.reduce((a, b) => (b[key] < a[key] ? b : a))
      : Math.min(...this);
  }

  // -------------------------
  // Grouping
  // -------------------------
  groupBy(keyOrFn) {
    const fn = typeof keyOrFn === 'function' ? keyOrFn : (item) => item?.[keyOrFn];
    const groups = {};
    for (const item of this) {
      const group = fn(item);
      if (!groups[group]) groups[group] = new Collection();
      groups[group].push(item);
    }
    return groups; // object of collections
  }

  // -------------------------
  // Selecting random items
  // -------------------------
  random(n = 1) {
    if (n === 1) {
      return this[Math.floor(Math.random() * this.length)] ?? null;
    }
    return new Collection(
      [...this].sort(() => Math.random() - 0.5).slice(0, n)
    );
  }

  shuffle() {
    return new Collection([...this].sort(() => Math.random() - 0.5));
  }

  // -------------------------
  // Chunking
  // -------------------------
  chunk(size) {
    const out = new Collection();
    for (let i = 0; i < this.length; i += size) {
      out.push(new Collection(this.slice(i, i + size)));
    }
    return out;
  }

  // -------------------------
  // Pagination helpers
  // -------------------------
  take(n) {
    return new Collection(this.slice(0, n));
  }

  skip(n) {
    return new Collection(this.slice(n));
  }

  // -------------------------
  // Find / Search
  // -------------------------
  find(fn) {
    return this.filter(fn)[0] ?? null;
  }

  includesWhere(key, value) {
    return this.some(item => item?.[key] === value);
  }

  has(fn) {
    return this.some(fn);
  }

  // -------------------------
  // Set operations
  // -------------------------
  intersect(otherCollection) {
    return new Collection(this.filter(i => otherCollection.includes(i)));
  }

  diff(otherCollection) {
    return new Collection(this.filter(i => !otherCollection.includes(i)));
  }

  union(otherCollection) {
    return new Collection([...new Set([...this, ...otherCollection])]);
  }

  // -------------------------
  // Pipe (functional style)
  // -------------------------
  pipe(fn) {
    return fn(this);
  }

  // -------------------------
  // Static helpers
  // -------------------------
  static make(items = []) {
    return new Collection(items);
  }

  static range(start, end) {
    const arr = [];
    for (let i = start; i <= end; i++) arr.push(i);
    return new Collection(arr);
  }
}

// Simple Paginator class — returns JSON-friendly output
class Paginator {
  constructor(data, total, page, perPage) {
    this.data = data;         // likely a Collection or Array
    this.total = Number(total) || 0;
    this.page = Math.max(1, Number(page));
    this.perPage = Math.max(1, Number(perPage));
    this.lastPage = Math.max(1, Math.ceil(this.total / this.perPage));
  }

  // try common conversions: Collection -> array, toJSON, toArray, or fallback
  _dataToArray() {
    const d = this.data;

    // If it's already a plain array
    if (Array.isArray(d)) return d;

    // If object has toJSON()
    if (d && typeof d.toJSON === 'function') {
      try { return d.toJSON(); } catch(e) { /* fallthrough */ }
    }

    // If object has toArray()
    if (d && typeof d.toArray === 'function') {
      try { return d.toArray(); } catch(e) { /* fallthrough */ }
    }

    // If it's iterable (like a Collection), try Array.from
    try {
      return Array.from(d);
    } catch (e) { /* fallthrough */ }

    // Last resort: return as single-item array
    return [d];
  }

  toJSON() {
    return {
      data: this._dataToArray(),
      total: this.total,
      page: this.page,
      perPage: this.perPage,
      lastPage: this.lastPage
    };
  }
}


const VALID_OPERATORS = ['=', '<', '<=', '>', '>=', '<>', '!=', 'LIKE', 'ILIKE'];
/******************************************************************************
 * QueryBuilder (Bug-Free)
 *****************************************************************************/
class QueryBuilder {
  constructor(table, modelClass = null, dialect = 'mysql') {
    this.table = table;
    this.tableAlias = null;
    this.modelClass = modelClass;

    this._select = ['*'];
    this._joins = [];
    this._wheres = [];
    this._group = [];
    this._having = [];
    this._orders = [];
    this._limit = null;
    this._offset = null;
    this._forUpdate = false;
    this._distinct = false;
    this.dialect = dialect;

    this._with = [];
    this._ignoreSoftDeletes = false;

    this._ctes = [];
    this._unions = [];
    this._fromRaw = null;
  }

  // Helper to normalize operator
  _normalizeOperator(operator) {
    const op = operator ? operator.toUpperCase() : '='
    if (!VALID_OPERATORS.includes(op)) {
      throw new DBError('Invalid SQL operator', {
        operator,
        normalized: op,
        method: '_normalizeOperator'
      });
    }

    // Convert ILIKE to proper operator for MySQL
    if (op === 'ILIKE' && this.dialect === 'mysql') {
      return 'LIKE';
    }

    return op;
  }

  /**************************************************************************
   * BASIC CONFIG
   **************************************************************************/
  alias(a) { this.tableAlias = a; return this; }
  distinct() { this._distinct = true; return this; }

  /**************************************************************************
   * SELECT
   **************************************************************************/
  select(...cols) {
    if (!cols.length) return this;

    const flat = cols.flat();
    const normalized = flat.flatMap(col => {
      if (typeof col === 'object' && !Array.isArray(col)) {
        return Object.entries(col).map(([k, v]) =>
          `${escapeId(k)} AS ${escapeId(v)}`
        );
      }
      return col;
    });

    this._select = normalized;
    return this;
  }

  addSelect(...cols) {
    this._select.push(...cols.flat());
    return this;
  }

  /**************************************************************************
   * JOINS
   **************************************************************************/
  join(type, table, first, operator, second) {
    this._joins.push({
      type: type.toUpperCase(),
      table,
      first,
      operator,
      second
    });
    return this;
  }

  innerJoin(t, f, o, s) { return this.join('INNER', t, f, o, s); }
  leftJoin(t, f, o, s) { return this.join('LEFT', t, f, o, s); }
  rightJoin(t, f, o, s) { return this.join('RIGHT', t, f, o, s); }
  crossJoin(t) { return this.join('CROSS', t, null, null, null); }

  /**************************************************************************
   * WHERE HELPERS
   **************************************************************************/
  _pushWhere(w) {
    if (!this._wheres) this._wheres = [];

    if (w.boolean == null) w.boolean = "AND";
    if (w.bindings === undefined) w.bindings = [];

    this._wheres.push(w);
    return this;
  }

  then(resolve, reject) {
    return this.get().then(resolve, reject);
  }


  where(columnOrObject, operator, value) {
    if (typeof columnOrObject === 'function') {
      columnOrObject(this);
      return this;
    }

    if (typeof columnOrObject === 'object' && columnOrObject !== null) {
      let query = this;
      for (const [col, val] of Object.entries(columnOrObject)) {
        query = query.where(col, val);
      }
      return query;
    }

    if (arguments.length === 2) {
      value = operator;
      operator = '=';
    }

    const op = this._normalizeOperator(operator);

    // For MySQL + LIKE case-insensitive, wrap with LOWER()
    const useLower = this.dialect === 'mysql' && operator.toUpperCase() === 'ILIKE';
    return this._pushWhere({
      type: 'basic',
      boolean: 'AND',
      column: useLower ? `LOWER(${columnOrObject})` : columnOrObject,
      operator: op,
      value: useLower ? value.toLowerCase() : value,
      bindings: [useLower ? value.toLowerCase() : value],
    });
  }

  andWhere(...args) {
    return this.where(...args);
  }

  orWhere(columnOrObject, operatorOrValue, value) {
    if (typeof columnOrObject === 'object' && columnOrObject !== null) {
      let query = this;
      for (const [col, val] of Object.entries(columnOrObject)) {
        query = query.orWhere(col, val);
      }
      return query;
    }

    if (arguments.length === 2) {
      value = operatorOrValue;
      operatorOrValue = '=';
    }

    const op = this._normalizeOperator(operatorOrValue);

    const useLower = this.dialect === 'mysql' && operatorOrValue.toUpperCase() === 'ILIKE';
    return this._pushWhere({
      type: 'basic',
      boolean: 'OR',
      column: useLower ? `LOWER(${columnOrObject})` : columnOrObject,
      operator: op,
      value: useLower ? value.toLowerCase() : value,
      bindings: [useLower ? value.toLowerCase() : value],
    });
  }

  // Example method to generate SQL
  // toSQL() {
  //   if (!this.wheres.length) return '';
  //   const sql = this.wheres.map((w, i) => {
  //     const prefix = i === 0 ? '' : ` ${w.boolean} `;
  //     return `${prefix}\`${w.column}\` ${w.operator} ?`;
  //   }).join('');
  //   return 'WHERE ' + sql;
  // }

  whereRaw(sql, bindings = []) {
    return this._pushWhere({
      type: 'raw',
      raw: sql,
      bindings: Array.isArray(bindings) ? bindings : [bindings]
    });
  }

  orWhereRaw(sql, bindings = []) {
    return this._pushWhere({
      type: 'raw',
      boolean: 'OR',
      raw: sql,
      bindings: Array.isArray(bindings) ? bindings : [bindings]
    });
  }

  whereColumn(a, op, b) {
    if (arguments.length === 2) { b = op; op = '='; }
    return this._pushWhere({
      type: 'columns',
      first: a,
      operator: op,
      second: b
    });
  }

  orWhereColumn(a, op, b) {
    if (arguments.length === 2) { b = op; op = '='; }
    return this._pushWhere({
      type: 'columns',
      boolean: 'OR',
      first: a,
      operator: op,
      second: b
    });
  }

  whereNested(cb) {
    const qb = new QueryBuilder(this.table, this.modelClass);
    cb(qb);

    return this._pushWhere({
      type: 'nested',
      query: qb,
      bindings: qb._gatherBindings()
    });
  }

  whereIn(column, values = []) {
    if (!Array.isArray(values)) {
      throw new DBError('whereIn expects an array', {
        method: 'whereIn',
        column,
        values
      });
    }
    if (!values.length) {
      return this._pushWhere({ type: 'raw', raw: '0 = 1', bindings: [] });
    }

    return this._pushWhere({
      type: 'in',
      column,
      values,
      bindings: [...values]
    });
  }

  /** COMPLETELY FIXED VERSION */
  whereNot(column, operatorOrValue, value) {
    if (typeof column === 'object' && column !== null) {
      for (const [k, v] of Object.entries(column))
        this.whereNot(k, v);
      return this;
    }

    let operator = '=';
    let val = operatorOrValue;

    if (arguments.length === 3) {
      operator = operatorOrValue;
      val = value;
    }

    if (operator === '=') operator = '!=';
    if (operator.toUpperCase() === 'IN') operator = 'NOT IN';

    return this._pushWhere({
      type: 'basic',
      not: true,
      column,
      operator,
      value: val,
      bindings: [val]
    });
  }

  whereNotIn(column, values = []) {
    if (!Array.isArray(values)) {
      throw new DBError('whereNotIn expects an array', {
        method: 'whereNotIn',
        column,
        values
      });
    }
    if (!values.length) {
      return this._pushWhere({ type: 'raw', raw: '1 = 1', bindings: [] });
    }

    return this._pushWhere({
      type: 'notIn',
      column,
      values,
      bindings: [...values]
    });
  }

  whereNull(col) {
    return this._pushWhere({ type: 'null', column: col, not: false });
  }

  whereNotNull(col) {
    return this._pushWhere({ type: 'null', column: col, not: true });
  }

  whereBetween(col, [a, b]) {
    return this._pushWhere({
      type: 'between',
      column: col,
      bounds: [a, b],
      not: false,
      bindings: [a, b]
    });
  }

  whereNotBetween(col, [a, b]) {
    return this._pushWhere({
      type: 'between',
      column: col,
      bounds: [a, b],
      not: true,
      bindings: [a, b]
    });
  }

  whereExists(builderOrRaw) {
    return this._existsHelper(builderOrRaw, false);
  }

  whereNotExists(builderOrRaw) {
    return this._existsHelper(builderOrRaw, true);
  }

  _existsHelper(builderOrRaw, neg) {
    if (typeof builderOrRaw === 'function') {
      const qb = new QueryBuilder(this.table, this.modelClass);
      builderOrRaw(qb);

      return this._pushWhere({
        type: neg ? 'notExists' : 'exists',
        query: qb,
        bindings: qb._gatherBindings()
      });
    }

    if (builderOrRaw instanceof QueryBuilder) {
      return this._pushWhere({
        type: neg ? 'notExists' : 'exists',
        query: builderOrRaw,
        bindings: builderOrRaw._gatherBindings()
      });
    }

    return this._pushWhere({
      type: neg ? 'rawNotExists' : 'rawExists',
      raw: builderOrRaw
    });
  }

  /**************************************************************************
   * JSON
   **************************************************************************/
  whereJsonPath(column, path, operator, value) {
    if (arguments.length === 3) { value = operator; operator = '='; }

    return this._pushWhere({
      type: 'raw',
      raw: `JSON_EXTRACT(${escapeId(column)}, '${path}') ${operator} ?`,
      bindings: [value]
    });
  }

  whereJsonContains(column, value) {
    return this._pushWhere({
      type: 'raw',
      raw: `JSON_CONTAINS(${escapeId(column)}, ?)`,
      bindings: [JSON.stringify(value)]
    });
  }

  /**************************************************************************
   * GROUP / HAVING
   **************************************************************************/
  groupBy(...cols) {
    this._group.push(...cols.flat());
    return this;
  }

  having(column, operatorOrValue, value) {
    if (arguments.length === 2) {
      return this._pushHaving(column, '=', operatorOrValue, 'AND');
    }
    return this._pushHaving(column, operatorOrValue, value, 'AND');
  }

  orHaving(column, operatorOrValue, value) {
    if (arguments.length === 2) {
      return this._pushHaving(column, '=', operatorOrValue, 'OR');
    }
    return this._pushHaving(column, operatorOrValue, value, 'OR');
  }

  _pushHaving(column, op, value, bool) {
    this._having.push({
      column,
      operator: op,
      value,
      boolean: bool,
      bindings: [value]
    });
    return this;
  }

  /**************************************************************************
   * ORDER / LIMIT
   **************************************************************************/
  orderBy(col, dir = 'ASC') {
    this._orders.push([col, dir.toUpperCase() === 'DESC' ? 'DESC' : 'ASC']);
    return this;
  }

  limit(n) { this._limit = Number(n); return this; }
  offset(n) { this._offset = Number(n); return this; }
  forUpdate() { this._forUpdate = true; return this; }

  /**************************************************************************
   * CTE
   **************************************************************************/
  withCTE(name, query, { recursive = false } = {}) {
    this._ctes.push({ name, query, recursive });
    return this;
  }

  /**************************************************************************
   * UNION
   **************************************************************************/
  union(q) { this._unions.push({ type: 'UNION', query: q }); return this; }
  unionAll(q) { this._unions.push({ type: 'UNION ALL', query: q }); return this; }

  /**************************************************************************
   * RAW FROM
   **************************************************************************/
  fromRaw(raw) { this._fromRaw = raw; return this; }

  /**************************************************************************
   * WITH (Eager Load)
   **************************************************************************/
  with(relations) {
    if (!Array.isArray(relations)) relations = [relations];

    for (const r of relations) {
      if (!this._with.includes(r)) this._with.push(r);
    }

    return this;
  }

  preload(relations) {
    return this.with(relations);
  }

  ignoreSoftDeletes() {
    this._ignoreSoftDeletes = true;
    return this;
  }

  whereHas(relationName, callback, boolean = 'AND') {
    const relation = this.modelClass.relations()?.[relationName];
    if (!relation) {
      throw new DBError(
        `Relation '${relationName}' is not defined`,
        {
          model: this.modelClass?.name,
          relation: relationName,
          method: 'whereHas'
        }
      );
    }

    const RelatedModel = relation.model();
    const relatedQuery = RelatedModel.query();

    // let user modify the related query
    callback(relatedQuery);

    // Build EXISTS() JOIN based on relation type
    const parentTable = this.table;
    const relatedTable = RelatedModel.table;
    const parentKey = relation.localKey || this.modelClass.primaryKey;
    const foreignKey = relation.foreignKey;

    // The related subquery should NOT include SELECT columns.
    // Instead, wrap it as an EXISTS with WHEREs + join condition.
    const existsQuery = RelatedModel.query();
    
    // copy user-added wheres
    existsQuery._wheres = relatedQuery._wheres.slice();

    // add the relation join constraint
    existsQuery.whereRaw(
      `${escapeId(relatedTable)}.${escapeId(foreignKey)} = ${escapeId(parentTable)}.${escapeId(parentKey)}`
    );

    // Now push EXISTS into parent _wheres
    this._wheres.push({
      type: 'exists',
      boolean,
      query: existsQuery
    });

    return this;
  }

  /**************************************************************************
   * COMPILERS
   **************************************************************************/
  _compileSelect() {
    const parts = [];

    /* CTEs */
    if (this._ctes.length) {
      const rec = this._ctes.some(x => x.recursive)
        ? 'WITH RECURSIVE '
        : 'WITH ';

      const cteSql = this._ctes
        .map(cte => {
          const q =
            cte.query instanceof QueryBuilder
              ? `(${cte.query._compileSelect()})`
              : `(${cte.query})`;
          return `${escapeId(cte.name)} AS ${q}`;
        })
        .join(', ');

      parts.push(rec + cteSql);
    }

    parts.push('SELECT');
    if (this._distinct) parts.push('DISTINCT');

    // Normalize SELECT * to table.* when a model is attached
    if (
      this.modelClass &&
      this._select.length === 1 &&
      this._select[0] === '*'
    ) {
      const table = this.tableAlias || this.table;
      this._select = [`${escapeId(table)}.*`];
    }

    parts.push(this._select.length ? this._select.join(', ') : '*');

    if (this._fromRaw) {
      parts.push('FROM ' + this._fromRaw);
    } else {
      parts.push(
        'FROM ' +
        escapeId(this.table) +
        (this.tableAlias ? ' AS ' + escapeId(this.tableAlias) : '')
      );
    }

    /* JOINS */
    for (const j of this._joins) {
      if (j.type === 'CROSS') {
        parts.push(`CROSS JOIN ${escapeId(j.table)}`);
      } else {
        parts.push(
          `${j.type} JOIN ${escapeId(j.table)} ON ${escapeId(j.first)} ${j.operator} ${escapeId(j.second)}`
        );
      }
    }

    /* WHERE */
    const whereSql = this._compileWheres();
    if (whereSql) parts.push(whereSql);

    /* GROUP */
    if (this._group.length) {
      parts.push('GROUP BY ' + this._group.map(escapeId).join(', '));
    }

    /* HAVING */
    if (this._having.length) {
      const has = this._having
        .map((h, i) => {
          const pre = i === 0 ? 'HAVING ' : `${h.boolean} `;
          return pre + `${escapeId(h.column)} ${h.operator} ?`;
        })
        .join(' ');
      parts.push(has);
    }

    /* ORDER */
    if (this._orders.length) {
      parts.push(
        'ORDER BY ' +
        this._orders
          .map(([c, d]) => `${escapeId(c)} ${d}`)
          .join(', ')
      );
    }

    /* LIMIT / OFFSET */
    if (this._limit != null) parts.push(`LIMIT ${this._limit}`);
    if (this._offset != null) parts.push(`OFFSET ${this._offset}`);

    if (this._forUpdate) parts.push('FOR UPDATE');

    let sql = parts.join(' ');

    /* UNION */
    if (this._unions.length) {
      for (const u of this._unions) {
        const other =
          u.query instanceof QueryBuilder
            ? u.query._compileSelect()
            : u.query;
        sql = `(${sql}) ${u.type} (${other})`;
      }
    }

    return sql;
  }

  _compileWheres() {
    if (!this._wheres.length) return '';

    const out = [];

    this._wheres.forEach((w, i) => {
      const pre = i === 0 ? 'WHERE ' : w.boolean + ' ';

      switch (w.type) {
        case 'raw':
          out.push(pre + w.raw);
          break;

        case 'basic':
          out.push(pre + `${escapeId(w.column)} ${w.operator} ?`);
          break;

        case 'columns':
          out.push(pre + `${escapeId(w.first)} ${w.operator} ${escapeId(w.second)}`);
          break;

        case 'nested': {
          const inner = w.query._compileWheres().replace(/^WHERE\s*/i, '');
          out.push(pre + `(${inner})`);
          break;
        }

        case 'in':
          out.push(
            pre + `${escapeId(w.column)} IN (${w.values.map(() => '?').join(', ')})`
          );
          break;

        case 'notIn':
          out.push(
            pre + `${escapeId(w.column)} NOT IN (${w.values.map(() => '?').join(', ')})`
          );
          break;

        case 'null':
          out.push(
            pre + `${escapeId(w.column)} IS ${w.not ? 'NOT ' : ''}NULL`
          );
          break;

        case 'between':
          out.push(
            pre +
            `${escapeId(w.column)} ${w.not ? 'NOT BETWEEN' : 'BETWEEN'} ? AND ?`
          );
          break;

        case 'exists':
          out.push(pre + `EXISTS (${w.query._compileSelect()})`);
          break;

        case 'notExists':
          out.push(pre + `NOT EXISTS (${w.query._compileSelect()})`);
          break;

        case 'rawExists':
          out.push(pre + `EXISTS (${w.raw})`);
          break;

        case 'rawNotExists':
          out.push(pre + `NOT EXISTS (${w.raw})`);
          break;

        default:
          throw new DBError('Unknown where clause type', {
            type: w.type,
            where: w
          });
      }
    });

    return out.join(' ');
  }

  _gatherBindings() {
    const out = [];

    for (const c of this._ctes) {
      if (c.query instanceof QueryBuilder)
        out.push(...c.query._gatherBindings());
    }

    for (const w of this._wheres) {
      if (w.bindings?.length) out.push(...w.bindings);
    }

    for (const h of this._having) {
      if (h.bindings?.length) out.push(...h.bindings);
    }

    for (const u of this._unions) {
      if (u.query instanceof QueryBuilder)
        out.push(...u.query._gatherBindings());
    }

    return out;
  }

  /**************************************************************************
   * READ METHODS
   **************************************************************************/
  async get() {
    const sql = this._compileSelect();
    const binds = this._gatherBindings();

    try {
      const rows = await DB.raw(sql, binds);

      if (this.modelClass) {
        const models = rows.map(r => new this.modelClass(r, true));

        if (this._with.length) {
          const loaded = await this._eagerLoad(models);
          return new Collection(loaded);
        }

        return new Collection(models);
      }

      return new Collection(rows);
    } catch (err) {
      throw new DBError('Select query failed', {
        table: this.table,
        sql,
        bindings: binds,
        err
      });
    }
  }

  async first() {
    const c = this._clone();
    c.limit(1);

    const rows = await c.get();
    return Array.isArray(rows) ? rows[0] || null : null;
  }

  async firstOrFail() {
    const r = await this.first();
    if (!r) {
      throw new DBError('Record not found', {
        method: 'firstOrFail',
        table: this.table,
        model: this.modelClass?.name
      });
    }
    return r;
  }

  async exists() {
    const c = this._clone();
    c._select = ['1'];
    c._orders = [];
    c.limit(1);

    const sql = c._compileSelect();
    const bindings = c._gatherBindings();

    try {
      const rows = await DB.raw(sql, bindings);
      return rows.length > 0;
    } catch (err) {
      throw new DBError('Exists query failed', {
        table: this.table,
        sql,
        bindings,
        err
      });
    }
  }

  async doesntExist() {
    return !(await this.exists());
  }

  async count(column = '*') {
    const c = this._clone();
    c._select = [`COUNT(${column}) AS aggregate`];
    c._orders = [];
    c._limit = null;
    c._offset = null;

    const sql = c._compileSelect();
    const bindings = c._gatherBindings();

    try {
      const rows = await DB.raw(sql, bindings);
      return rows[0] ? Number(rows[0].aggregate) : 0;
    } catch (err) {
      throw new DBError('Count query failed', {
        table: this.table,
        sql,
        bindings,
        err
      });
    }
  }

  async _aggregate(expr) {
    const c = this._clone();
    c._select = [`${expr} AS aggregate`];
    c._orders = [];
    c._limit = null;
    c._offset = null;

    const sql = c._compileSelect();
    const bindings = c._gatherBindings();

    try {
      const rows = await DB.raw(sql, bindings);
      return rows[0] ? Number(rows[0].aggregate) : 0;
    } catch (err) {
      throw new DBError('Aggregate query failed', {
        table: this.table,
        expression: expr,
        sql,
        bindings,
        err
      });
    }
  }

  sum(c) { return this._aggregate(`SUM(${escapeId(c)})`); }
  avg(c) { return this._aggregate(`AVG(${escapeId(c)})`); }
  min(c) { return this._aggregate(`MIN(${escapeId(c)})`); }
  max(c) { return this._aggregate(`MAX(${escapeId(c)})`); }
  countDistinct(c) { return this._aggregate(`COUNT(DISTINCT ${escapeId(c)})`); }

  async pluck(col) {
    const c = this._clone();
    c._select = [escapeId(col)];

    const sql = c._compileSelect();
    const bindings = c._gatherBindings();

    try {
      const rows = await DB.raw(sql, bindings);
      return rows.map(r => r[col]);
    } catch (err) {
      throw new DBError('Pluck query failed', {
        table: this.table,
        column: col,
        sql,
        bindings,
        err
      });
    }
  }

  async paginate(page = 1, perPage = 15) {
    page = Math.max(1, Number(page));
    perPage = Math.max(1, Number(perPage));

    try {
      const countClone = this._clone();
      countClone._select = [`COUNT(*) AS aggregate`];
      countClone._orders = [];
      countClone._limit = null;
      countClone._offset = null;

      const total = await countClone.count('*');

      const offset = (page - 1) * perPage;

      const rows = await this._clone()
        .limit(perPage)
        .offset(offset)
        .get();

      return new Paginator(rows, total, page, perPage);
    } catch (err) {
      throw new DBError('Pagination failed', {
        table: this.table,
        page,
        perPage,
        err
      });
    }
  }

  /**************************************************************************
   * WRITE METHODS
   **************************************************************************/
  async insert(values) {
    const keys = Object.keys(values);
    const placeholders = keys.map(() => '?').join(', ');
    const sql =
      `INSERT INTO ${escapeId(this.table)} (` +
      keys.map(escapeId).join(', ') +
      `) VALUES (${placeholders})`;

    const bindings = Object.values(values);
    try {
      const result = await DB.raw(sql, bindings);

      return result.affectedRows || 0;
    } catch (err) {
      throw new DBError('Insert failed', {
        table: this.table,
        sql,
        bindings,
        err
      });
    }
  }

  async insertGetId(values) {
    const keys = Object.keys(values);
    const placeholders = keys.map(() => '?').join(', ');
    const sql =
      `INSERT INTO ${escapeId(this.table)} (` +
      keys.map(escapeId).join(', ') +
      `) VALUES (${placeholders})`;

    const bindings = Object.values(values);
    try {
      const result = await DB.raw(sql, bindings);

      return result.insertId ?? null;
    } catch (err) {
      throw new DBError('Insert (get ID) failed', {
        table: this.table,
        sql,
        bindings,
        err
      });
    }
  }

  async update(values) {
    if (!Object.keys(values).length) return 0;
    const setClause = Object.keys(values)
      .map(k => `${escapeId(k)} = ?`)
      .join(', ');

    const whereSql = this._compileWhereOnly();
    const sql =
      `UPDATE ${escapeId(this.table)} SET ${setClause} ${whereSql}`;

    const bindings = [...Object.values(values), ...this._gatherBindings()];
    try {
      const result = await DB.raw(sql, bindings);

      return result.affectedRows || 0;
    } catch (err) {
      throw new DBError('Update failed', {
        table: this.table,
        sql,
        bindings,
        err
      });
    }
  }

  async increment(col, by = 1) {
    const sql =
      `UPDATE ${escapeId(this.table)} ` +
      `SET ${escapeId(col)} = ${escapeId(col)} + ? ` +
      this._compileWhereOnly();

    const bindings = [by, ...this._gatherBindings()];

    try {
      const res = await DB.raw(sql, bindings);
      return res.affectedRows || 0;
    } catch (err) {
      throw new DBError('Increment failed', {
        table: this.table,
        column: col,
        sql,
        bindings,
        err
      });
    }
  }

  async decrement(col, by = 1) {
    const sql =
      `UPDATE ${escapeId(this.table)} ` +
      `SET ${escapeId(col)} = ${escapeId(col)} - ? ` +
      this._compileWhereOnly();

    const bindings = [by, ...this._gatherBindings()];

    try {
      const res = await DB.raw(sql, bindings);
      return res.affectedRows || 0;
    } catch (err) {
      throw new DBError('Decrement failed', {
        table: this.table,
        column: col,
        sql,
        bindings,
        err
      });
    }
  }

  async delete() {
    const sql =
      `DELETE FROM ${escapeId(this.table)} ` +
      this._compileWhereOnly();

    const bindings = this._gatherBindings();

    try {
      const res = await DB.raw(sql, bindings);
      return res.affectedRows || 0;
    } catch (err) {
      throw new DBError('Delete failed', {
        table: this.table,
        sql,
        bindings,
        err
      });
    }
  }

  async truncate() {
    const sql = `TRUNCATE TABLE ${escapeId(this.table)}`;

    try {
      await DB.raw(sql);
      return true;
    } catch (err) {
      throw new DBError('Truncate failed', {
        table: this.table,
        sql,
        err
      });
    }
  }

  _compileWhereOnly() {
    const w = this._compileWheres();
    return w ? w : '';
  }

  /**************************************************************************
   * EAGER LOAD (unchanged except robust checks)
   **************************************************************************/
  async _eagerLoad(models) {
    if (!models.length) return models;

    for (const relName of this._with) {
      const sample = models.find(m => typeof m[relName] === 'function');
      if (!sample) continue;

      const relation = sample[relName]();

      if (!relation || typeof relation.eagerLoad !== 'function') {
        throw new DBError(
          `Relation "${relName}" is not eager-loadable`,
          {
            model: sample.constructor.name,
            relation: relName,
            method: 'eagerLoad'
          }
        );
      }

      await relation.eagerLoad(models, relName);
    }

    return models;
  }

  /**************************************************************************
   * CLONE
   **************************************************************************/
  _clone() {
    const c = new QueryBuilder(this.table, this.modelClass);

    c.tableAlias = this.tableAlias;
    c._select = [...this._select];
    c._joins = JSON.parse(JSON.stringify(this._joins));
    c._group = [...this._group];
    c._orders = [...this._orders];
    c._limit = this._limit;
    c._offset = this._offset;
    c._forUpdate = this._forUpdate;
    c._distinct = this._distinct;
    c._with = [...this._with];
    c._ignoreSoftDeletes = this._ignoreSoftDeletes;
    c._fromRaw = this._fromRaw;

    // rehydrate nested queries
    c._wheres = this._rehydrateWheres(this._wheres);

    // rehydrate CTEs
    c._ctes = this._rehydrateCTEs(this._ctes);

    // rehydrate unions
    c._unions = this._rehydrateUnions(this._unions);

    // having is simple
    c._having = JSON.parse(JSON.stringify(this._having));

    return c;
  }

  _rehydrateWheres(ws) {
    return ws.map(w => {
      if (w.type === 'nested' && w.query) {
        const qb = new QueryBuilder(this.table, this.modelClass);
        qb._wheres = this._rehydrateWheres(w.query._wheres);
        qb._joins = w.query._joins ? [...w.query._joins] : [];
        qb._group = w.query._group ? [...w.query._group] : [];
        qb._having = w.query._having ? [...w.query._having] : [];
        qb._orders = w.query._orders ? [...w.query._orders] : [];
        qb._limit = w.query._limit;
        qb._offset = w.query._offset;
        qb._forUpdate = w.query._forUpdate;
        qb._select = [...w.query._select];

        return {
          ...w,
          query: qb,
          bindings: qb._gatherBindings()
        };
      }

      if ((w.type === 'exists' || w.type === 'notExists') && w.query) {
        const qb = new QueryBuilder(w.query.table, w.query.modelClass);
        qb._wheres = this._rehydrateWheres(w.query._wheres);
        qb._select = [...w.query._select];
        return {
          ...w,
          query: qb,
          bindings: qb._gatherBindings()
        };
      }

      return JSON.parse(JSON.stringify(w));
    });
  }

  _rehydrateCTEs(ctes) {
    return ctes.map(cte => {
      if (cte.query instanceof QueryBuilder) {
        const qb = new QueryBuilder(cte.query.table, cte.query.modelClass);
        qb._wheres = this._rehydrateWheres(cte.query._wheres);
        qb._select = [...cte.query._select];
        return {
          ...cte,
          query: qb
        };
      }
      return { ...cte };
    });
  }

  _rehydrateUnions(unions) {
    return unions.map(u => {
      if (u.query instanceof QueryBuilder) {
        const qb = new QueryBuilder(u.query.table, u.query.modelClass);
        qb._wheres = this._rehydrateWheres(u.query._wheres);
        qb._select = [...u.query._select];
        return {
          ...u,
          query: qb
        };
      }
      return { ...u };
    });
  }

  toJSON() {
    return {
      table: this.table,
      tableAlias: this.tableAlias,
      modelClass: this.modelClass ? this.modelClass.name : null,
      dialect: this.dialect,

      select: this._select,
      joins: this._joins,
      wheres: this._wheres.map(w => {
        const copy = { ...w };
        // nested queries convert safely
        if (w.query instanceof QueryBuilder) {
          copy.query = w.query.toJSON();
        }
        return copy;
      }),

      group: this._group,
      having: this._having,
      orders: this._orders,

      limit: this._limit,
      offset: this._offset,
      distinct: this._distinct,
      forUpdate: this._forUpdate,

      with: this._with,
      ignoreSoftDeletes: this._ignoreSoftDeletes,

      ctes: this._ctes.map(c => ({
        name: c.name,
        recursive: c.recursive,
        query:
          c.query instanceof QueryBuilder
            ? c.query.toJSON()
            : c.query
      })),

      unions: this._unions.map(u => ({
        type: u.type,
        query: u.query instanceof QueryBuilder
          ? u.query.toJSON()
          : u.query
      })),

      fromRaw: this._fromRaw
    };
  }

  static fromJSON(json) {
    const qb = new QueryBuilder(json.table, null, json.dialect);

    qb.tableAlias = json.tableAlias;
    qb._select = [...json.select];
    qb._joins = JSON.parse(JSON.stringify(json.joins));

    qb._group = [...json.group];
    qb._having = JSON.parse(JSON.stringify(json.having));
    qb._orders = JSON.parse(JSON.stringify(json.orders));
    qb._limit = json.limit;
    qb._offset = json.offset;
    qb._distinct = json.distinct;
    qb._forUpdate = json.forUpdate;

    qb._with = [...json.with];
    qb._ignoreSoftDeletes = json.ignoreSoftDeletes;

    qb._fromRaw = json.fromRaw;

    // rebuild CTEs
    qb._ctes = json.ctes.map(c => ({
      name: c.name,
      recursive: c.recursive,
      query: typeof c.query === 'object'
        ? QueryBuilder.fromJSON(c.query)
        : c.query
    }));

    // rebuild unions
    qb._unions = json.unions.map(u => ({
      type: u.type,
      query: typeof u.query === 'object'
        ? QueryBuilder.fromJSON(u.query)
        : u.query
    }));

    // rebuild wheres (with nested query reconstruction)
    qb._wheres = json.wheres.map(w => {
      const copy = { ...w };

      if (w.query && typeof w.query === 'object') {
        copy.query = QueryBuilder.fromJSON(w.query);
      }

      return copy;
    });

    return qb;
  }



  /**************************************************************************
   * TO SQL
   **************************************************************************/
  toSQL() {
    return {
      sql: this._compileSelect(),
      bindings: this._gatherBindings()
    };
  }

  toSQLJSON() {
    const sql = this._compileSelect();
    const bindings = this._gatherBindings();
    return { sql, bindings };
  }


  toSQLWhereOnly() {
    return {
      sql: this._compileWhereOnly(),
      bindings: this._gatherBindings()
    };
  }
}

// --- Relations ---
class Relation {
  constructor(parent, relatedClass, foreignKey = null, localKey = null) {
    this.parent = parent;
    this.relatedClass = relatedClass;
    this.foreignKey = foreignKey;
    this.localKey = localKey || (parent.constructor.primaryKey || "id");
    this.deleteBehavior = null;
  }

  onDelete(behavior) {
    this.deleteBehavior = behavior;
    return this;
  }
}


class BelongsTo extends Relation {
  constructor(parent, relatedClass, foreignKey = null, ownerKey = null) {
    super(parent, relatedClass, foreignKey, ownerKey || relatedClass.primaryKey || "id");

    this.foreignKey = foreignKey || `${relatedClass.table.replace(/s$/, "")}_id`;
    this.ownerKey = ownerKey || relatedClass.primaryKey || "id";
  }

  async get() {
    const fkValue = this.parent[this.foreignKey];
    return await this.relatedClass.query().where(this.ownerKey, fkValue).first();
  }

  async eagerLoad(parents, relName) {
    const fkValues = parents.map(p => p[this.foreignKey]).filter(Boolean);

    const relatedRows = await this.relatedClass
      .query()
      .whereIn(this.ownerKey, fkValues)
      .get();

    const map = new Map();
    relatedRows.forEach(r => map.set(r[this.ownerKey], r));

    parents.forEach(parent => {
      parent[relName] = map.get(parent[this.foreignKey]) || null;
    });
  }
}


/* ---------------- HasOne ---------------- */
class HasOne extends Relation {
  async get() {
    return await this.relatedClass
      .query()
      .where(this.foreignKey, this.parent[this.localKey])
      .first();
  }

  async eagerLoad(parents, relName) {
    const parentIds = parents.map(p => p[this.localKey]);

    const relatedRows = await this.relatedClass
      .query()
      .whereIn(this.foreignKey, parentIds)
      .get();

    const grouped = new Map();
    parents.forEach(p => grouped.set(p[this.localKey], null));

    relatedRows.forEach(r => grouped.set(r[this.foreignKey], r));

    parents.forEach(p => {
      p[relName] = grouped.get(p[this.localKey]) || null;
    });
  }
}


/* ---------------- BelongsTo ---------------- */
class HasMany extends Relation {
  async get() {
    return await this.relatedClass
      .query()
      .where(this.foreignKey, this.parent[this.localKey])
      .get();
  }

  async eagerLoad(parents, relName) {
    const parentIds = parents.map(p => p[this.localKey]);

    const rows = await this.relatedClass
      .query()
      .whereIn(this.foreignKey, parentIds)
      .get();

    const grouped = new Map();
    parents.forEach(p => grouped.set(p[this.localKey], []));

    rows.forEach(r => grouped.get(r[this.foreignKey]).push(r));

    parents.forEach(p => {
      p[relName] = grouped.get(p[this.localKey]);
    });
  }
}

class HasManyThrough extends Relation {
  constructor(parent, relatedClass, throughClass, firstKey, secondKey, localKey, secondLocalKey) {
    super(parent, relatedClass, firstKey, localKey);
    this.throughClass = throughClass;
    this.firstKey = firstKey || parent.constructor.primaryKey || "id";
    this.secondKey = secondKey || `${throughClass.table.replace(/s$/, "")}_id`;
    this.localKey = localKey || (parent.constructor.primaryKey || "id");
    this.secondLocalKey = secondLocalKey || relatedClass.primaryKey || "id";
  }

  async get() {
    const throughRows = await this.throughClass
      .query()
      .where(this.firstKey, this.parent[this.localKey])
      .get();

    const throughIds = throughRows.map(r => r[this.secondKey]);

    return await this.relatedClass
      .query()
      .whereIn(this.secondLocalKey, throughIds)
      .get();
  }
}

class MorphOne extends Relation {
  constructor(parent, relatedClass, morphName, localKey = null) {
    super(parent, relatedClass, `${morphName}_id`, localKey);
    this.morphType = `${morphName}_type`;
  }

  async get() {
    return await this.relatedClass
      .query()
      .where(this.foreignKey, this.parent[this.localKey])
      .where(this.morphType, this.parent.constructor.name)
      .first();
  }
}

class MorphMany extends Relation {
  constructor(parent, relatedClass, morphName, localKey = null) {
    super(parent, relatedClass, `${morphName}_id`, localKey);
    this.morphType = `${morphName}_type`;
  }

  async get() {
    return await this.relatedClass
      .query()
      .where(this.foreignKey, this.parent[this.localKey])
      .where(this.morphType, this.parent.constructor.name)
      .get();
  }
}

class MorphTo {
  constructor(parent, typeField = "morph_type", idField = "morph_id") {
    this.parent = parent;
    this.typeField = typeField;
    this.idField = idField;
  }

  async get() {
    const klass = globalThis[this.parent[this.typeField]];
    const id = this.parent[this.idField];
    return await klass.find(id);
  }
}

class MorphToMany extends Relation {
  constructor(parent, relatedClass, morphName, pivotTable = null, foreignKey = null, relatedKey = null) {
    const morphId = `${morphName}_id`;
    const morphType = `${morphName}_type`;

    super(parent, relatedClass, morphId, parent.constructor.primaryKey);

    this.morphTypeColumn = morphType;

    this.pivotTable =
      pivotTable || `${morphName}_${relatedClass.table}`;

    this.foreignKey = foreignKey || morphId;
    this.relatedKey = relatedKey || `${relatedClass.table.replace(/s$/, "")}_id`;
  }
}

class MorphedByMany extends MorphToMany {
  constructor(parent, relatedClass, morphName, pivotTable = null, foreignKey = null, relatedKey = null) {
    super(parent, relatedClass, morphName, pivotTable, foreignKey, relatedKey);
  }
}


/* ---------------- BelongsToMany ---------------- */

class BelongsToMany extends Relation {
  constructor(parent, relatedClass, pivotTable = null, foreignKey = null, relatedKey = null) {
    const parentTable = parent.constructor.table;
    const relatedTable = relatedClass.table;

    const parentPK = parent.constructor.primaryKey || "id";
    const relatedPK = relatedClass.primaryKey || "id";

    if (!pivotTable) {
      const sorted = [parentTable, relatedTable].sort();
      pivotTable = sorted.join("_");
    }

    if (!foreignKey) foreignKey = `${parentTable.replace(/s$/, "")}_id`;
    if (!relatedKey) relatedKey = `${relatedTable.replace(/s$/, "")}_id`;

    super(parent, relatedClass, foreignKey, parentPK);

    this.pivotTable = pivotTable;
    this.relatedKey = relatedKey;

    this.parentPK = parentPK;
    this.relatedPK = relatedPK;

    // Optional pivot options
    this._pivotColumns = [];
    this._withTimestamps = false;
    this._pivotOrder = null;
  }

  // -----------------------------------------------------
  //  CONFIGURATION HELPERS
  // -----------------------------------------------------

  withPivot(...columns) {
    this._pivotColumns.push(...columns);
    return this;
  }

  withTimestamps() {
    this._withTimestamps = true;
    return this;
  }

  orderByPivot(column, direction = "asc") {
    this._pivotOrder = { column, direction };
    return this;
  }

  // -----------------------------------------------------
  //  LAZY LOAD RELATIONSHIP
  // -----------------------------------------------------
  async get() {
    const parentId = this.parent[this.parentPK];

    const pivotCols = [
      `${this.pivotTable}.${this.foreignKey}`,
      `${this.pivotTable}.${this.relatedKey}`,
      ...this._pivotColumns.map(c => `${this.pivotTable}.${c}`)
    ];

    if (this._withTimestamps) {
      pivotCols.push(`${this.pivotTable}.created_at`);
      pivotCols.push(`${this.pivotTable}.updated_at`);
    }

    const query = this.relatedClass
      .query()
      .join(
        this.pivotTable,
        `${this.relatedClass.table}.${this.relatedPK}`,
        "=",
        `${this.pivotTable}.${this.relatedKey}`
      )
      .where(`${this.pivotTable}.${this.foreignKey}`, parentId)
      .select(`${this.relatedClass.table}.*`, ...pivotCols);

    if (this._pivotOrder) {
      query.orderBy(
        `${this.pivotTable}.${this._pivotOrder.column}`,
        this._pivotOrder.direction
      );
    }

    const rows = await query.get();

    return this._hydratePivot(rows);
  }

  // -----------------------------------------------------
  //  EAGER LOADING
  // -----------------------------------------------------
  async eagerLoad(parents, relName) {
    if (!parents.length) {
      parents.forEach(p => (p[relName] = []));
      return;
    }

    const parentIds = parents.map(p => p[this.parentPK]);

    const pivotRows = await new QueryBuilder(this.pivotTable)
      .whereIn(this.foreignKey, parentIds)
      .get();

    if (!pivotRows.length) {
      parents.forEach(p => (p[relName] = []));
      return;
    }

    const relatedIds = pivotRows.map(p => p[this.relatedKey]);

    const relatedRows = await new QueryBuilder(
      this.relatedClass.table,
      this.relatedClass
    )
      .whereIn(this.relatedPK, relatedIds)
      .get();

    const pivotByParent = new Map();
    parents.forEach(p => pivotByParent.set(p[this.parentPK], []));
    pivotRows.forEach(p => pivotByParent.get(p[this.foreignKey]).push(p));

    const relatedById = new Map();
    relatedRows.forEach(r => relatedById.set(r[this.relatedPK], r));

    parents.forEach(parent => {
      const pivots = pivotByParent.get(parent[this.parentPK]) || [];
      parent[relName] = pivots.map(pivot => {
        const related = { ...relatedById.get(pivot[this.relatedKey]) };
        related._pivot = pivot;
        return related;
      });
    });
  }

  // -----------------------------------------------------
  //  MUTATORS (attach, detach, sync, toggle)
  // -----------------------------------------------------

  async attach(ids, pivotData = {}) {
    if (!Array.isArray(ids)) ids = [ids];

    const rows = ids.map(id => {
      const data = {
        [this.foreignKey]: this.parent[this.parentPK],
        [this.relatedKey]: id,
        ...pivotData
      };

      if (this._withTimestamps) {
        data.created_at = new Date();
        data.updated_at = new Date();
      }

      return data;
    });

    return await new QueryBuilder(this.pivotTable).insert(rows);
  }

  async detach(ids = null) {
    const query = new QueryBuilder(this.pivotTable)
      .where(this.foreignKey, this.parent[this.parentPK]);

    if (ids) {
      if (!Array.isArray(ids)) ids = [ids];
      query.whereIn(this.relatedKey, ids);
    }

    return await query.delete();
  }

  async sync(ids) {
    if (!Array.isArray(ids)) ids = [ids];

    const current = await new QueryBuilder(this.pivotTable)
      .where(this.foreignKey, this.parent[this.parentPK])
      .get();

    const currentIds = current.map(r => r[this.relatedKey]);

    const toAttach = ids.filter(id => !currentIds.includes(id));
    const toDetach = currentIds.filter(id => !ids.includes(id));

    await this.attach(toAttach);
    await this.detach(toDetach);

    return { attached: toAttach, detached: toDetach };
  }

  async toggle(ids) {
    if (!Array.isArray(ids)) ids = [ids];

    const current = await new QueryBuilder(this.pivotTable)
      .where(this.foreignKey, this.parent[this.parentPK])
      .get();

    const currentIds = current.map(r => r[this.relatedKey]);

    const toAttach = ids.filter(id => !currentIds.includes(id));
    const toDetach = ids.filter(id => currentIds.includes(id));

    await this.attach(toAttach);
    await this.detach(toDetach);

    return { attached: toAttach, detached: toDetach };
  }

  // -----------------------------------------------------
  //  Internal helper
  // -----------------------------------------------------
  _hydratePivot(rows) {
    return rows.map(row => {
      const model = { ...row };
      model._pivot = {};

      model._pivot[this.foreignKey] = row[this.foreignKey];
      model._pivot[this.relatedKey] = row[this.relatedKey];

      this._pivotColumns.forEach(col => {
        model._pivot[col] = row[col];
      });

      if (this._withTimestamps) {
        model._pivot.created_at = row.created_at;
        model._pivot.updated_at = row.updated_at;
      }

      return model;
    });
  }
}

class ValidationError extends Error {
  /**
   * @param {string | string[] | Record<string, any>} messages - Validation messages
   * @param {ErrorOptions} [options] - Optional error options
   */
  constructor(messages, options = {}) {
    // Convert messages into a human-readable string
    const formattedMessage = ValidationError.formatMessages(messages);

    super(formattedMessage, options);

    // Preserve proper prototype chain
    Object.setPrototypeOf(this, ValidationError.prototype);

    this.name = 'ValidationError';
    this.messages = messages; // raw messages (can be string, array, or object)
    this.status = 422; // HTTP status for Unprocessable Entity
    this.code = 'VALIDATION_ERROR';
  }

  /**
   * Converts messages to a string suitable for web users
   */
  static formatMessages(messages) {
    if (!messages) return 'Validation failed.';
    if (typeof messages === 'string') return messages;
    if (Array.isArray(messages)) return messages.join(', ');
    if (typeof messages === 'object') {
      // Flatten object values and join them
      return Object.values(messages)
        .flat()
        .map(String)
        .join(', ');
    }
    return String(messages);
  }

  // Symbol.toStringTag for TypeScript-like behavior
  get [Symbol.toStringTag]() {
    return 'ValidationError';
  }

  toString() {
    return `${this.name}: ${ValidationError.formatMessages(this.messages)}`;
  }

  // Convenient method to get a user-friendly message
  get errors() {
    return ValidationError.formatMessages(this.messages);
  }
}


// --- The Model class (fixed / cleaned) ---
class Model {
  // class-level defaults
  static table = null;
  static primaryKey = 'id';
  static slugKey = 'slug';
  static timestamps = false;
  static fillable = null;
  static tableSingular = null;

  static softDeletes = false;
  static deletedAt = 'deleted_at';
  static hidden = [];
  static visible = null; 
  static rules = {}; // define default validation rules
  static customMessages = {};

  constructor(attributes = {}, fresh = false, data = {}) {
    this._attributes = {};
    this._original = {};
    this._relations = {};
    this._exists = !!fresh;

    // ──────────────────────────────
    // 1️⃣ hydrate attributes safely
    // ──────────────────────────────
    for (const [k, v] of Object.entries(attributes)) {
      if (v !== undefined) {
        this._attributes[k] = v;
      }
    }

    // ──────────────────────────────
    // 2️⃣ ensure timestamps ALWAYS exist
    // ──────────────────────────────
    if (this.constructor.timestamps) {
      if ('created_at' in attributes)
        this._attributes.created_at = attributes.created_at;

      if ('updated_at' in attributes)
        this._attributes.updated_at = attributes.updated_at;
    }

    // ──────────────────────────────
    // 3️⃣ always keep primary key
    // ──────────────────────────────
    const pk = this.constructor.primaryKey;
    if (pk && pk in attributes) {
      this._attributes[pk] = attributes[pk];
    }

    this._original = { ...this._attributes, ...data };

    // ──────────────────────────────
    // 4️⃣ define getters/setters FOR ALL ATTRIBUTES
    // ──────────────────────────────
    for (const k of Object.keys(this._attributes)) {
      if (!(k in this)) {
        Object.defineProperty(this, k, {
          get: () => this._attributes[k],
          set: v => { this._attributes[k] = v; },
          enumerable: true,
          configurable: true
        });
      }
    }
  }

  static async validate(data, id, ignoreId = null) {
    if (!Validator) {
      throw new DBError('Validator not found', {
        model: this.name
      });
    }

    const rules = this.rules || {};

    // Inject ignoreId into unique rules automatically
    const preparedRules = {};

    for (const field in rules) {
        let r = rules[field];

        if (typeof r === 'string') r = r.split('|');

        // auto attach ignoreId to unique rules
        r = r.map(rule => {
            if (rule.startsWith('unique:') && ignoreId) {
                const [name, table, col] = rule.split(':')[1].split(',');
                return `unique:${table},${col || field},${ignoreId}`;
            }
            return rule;
        });

        preparedRules[field] = r;
    }

    const validator = new Validator(data, id, this.table, preparedRules, this.customMessages, DB);
    const failed = await validator.fails();

    if (failed) {
        throw new ValidationError(validator.getErrors());
    }

    return validator;
  }

  // recommended: length as property
  get length() {
    return Object.keys(this._attributes).length;
  }

  // legacy compatibility: keep a count() method instead of duplicating 'length'
  count() { return this.length; }

  // ──────────────────────────────
  // Core static getters & booting
  // ──────────────────────────────
  static get tableName() {
    if (!this.table) throw new DBError('Model.table must be set for ' + this.name);
    return this.table;
  }

  static boot() {
    if (!this._booted) {
      this._events = { creating: [], updating: [], deleting: [] };
      this._booted = true;
    }
  }

  static on(event, handler) {
    this.boot();
    if (this._events[event]) this._events[event].push(handler);
  }

  // convenience aliases
  static before(event, handler) { return this.on(event, handler); }
  static after(event, handler) { return this.on(event, handler); }

  async trigger(event) {
    const events = this.constructor._events?.[event] || [];
    for (const fn of events) {
      // allow handlers that return promises or sync
      await fn(this);
    }
  }

  static query({ withTrashed = false } = {}) {
    const qb = new QueryBuilder(this.tableName, this);

    if (this.softDeletes && !withTrashed) {
      qb._wheres = Array.isArray(qb._wheres) ? qb._wheres.slice() : [];
      qb._wheres.push({ raw: `${DB.escapeId(this.deletedAt)} IS NULL` });
    }

    // Wrap with proxy so await Video.query() auto calls .get()
    let getCalled = false;

    const proxy = new Proxy(qb, {
      get(target, prop, receiver) {
        if (prop === 'get') {
          return (...args) => {
            getCalled = true;     // mark that user called .get() manually
            return target.get(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },

      // Auto-run get() only if user didn't call get() explicitly
      then(resolve, reject) {
        if (getCalled) {
          // user already called .get()
          return;
        }
        target.get()
          .then(resolve)
          .catch(reject);
      }
    });

    return proxy;
  }

  static setTable(table) {
    this.table = table;
  }

  static withTrashed() { return this.query({ withTrashed: true }); }

  // ──────────────────────────────
  // Retrieval methods
  // ──────────────────────────────
  static async all() { return await this.query().get(); }
  static where(...args) { return this.query().where(...args); }
  // static filter(...args) { return this.query().where(...args); }
  static whereIn(col, arr) { return this.query().whereIn(col, arr); }
  static whereNot(...args) { return this.query().whereNot(...args); }
  static whereNotIn(col, arr) { return this.query().whereNotIn(col, arr); }
  static whereNull(col) { return this.query().whereNull(col); }

  static filter(...args) {
    const qb = this.query();
    if (args.length === 1 && typeof args[0] === 'object' && !Array.isArray(args[0])) {
      for (const [key, value] of Object.entries(args[0])) {
        qb.where(key, value);
      }
      return qb;
    }
    return qb.where(...args);
  }

  static async find(value) {
    if (value === undefined || value === null) return null;
    const query = this.query();
    // If numeric → try primary key first
    if (!isNaN(value)) {
      const row = await query.where(this.primaryKey, value).first();
      if (row) return row;
    }
    // Fallback or non-numeric → try slug
    return await this.query()
      .where(this.slugKey, value)
      .first();
  }

  static async findOrFail(value) {
    const row = await this.find(value);
    if (!row) {
      // Better error message (handles both cases)
      throw new DBError(
        `${this.name} not found using ${this.primaryKey} or ${this.slugKey} = ${value}`
      );
    }
    return row;
  }

  static async findBy(col, value) { return await this.query().where(col, value).first(); }
  static async findByOrFail(col, value) {
    const row = await this.findBy(col, value);
    if (!row) throw new DBError(`${this.name} record not found where ${col} = ${value}`);
    return row;
  }

  static async findManyBy(col, values = []) {
    if (!Array.isArray(values)) {
      throw new DBError('findManyBy expects an array of values', {
        method: 'findManyBy',
        column: col
      });
    }
    if (!values.length) return [];
    return await this.query().whereIn(col, values).get();
  }

  // additional common accessors
  static async findMany(ids = []) {
    // if (!Array.isArray(ids)) ids = [ids];
    if (!Array.isArray(ids)) {
      throw new DBError('findMany expects an array of IDs', {
        method: 'findMany',
        model: this.name,
        ids
      });
    }
    if (!ids.length) return [];
    return await this.query().whereIn(this.primaryKey, ids).get();
  }

  // Global .first() support
  static async first(...args) {
    const qb = args.length ? this.where(...args) : this.query();
    return await qb.first();
  }

  static async firstOrFail(...args) {
    const qb = args.length ? this.where(...args) : this.query();
    const row = await qb.first();
    if (!row) throw new DBError(`${this.name} record not found`);
    return row;
  }

  static async firstOrNew(whereAttrs, defaults = {}) {
    const record = await this.query().where(whereAttrs).first();
    if (record) return record;
    return new this({ ...whereAttrs, ...defaults });
  }

  static async firstOrCreate(whereAttrs, defaults = {}) {
    const found = await this.query().where(whereAttrs).first();
    if (found) return found;
    return await this.create({ ...whereAttrs, ...defaults });
  }

  static async updateOrCreate(whereAttrs, values = {}) {
    const query = this.query();

    for (const [col, val] of Object.entries(whereAttrs)) {
      query.where(col, val);
    }

    const found = await query.first();

    if (found) {
      found.fill(values);
      await found.save();
      return found;
    }

    return await this.create({ ...whereAttrs, ...values });
  }

  // ──────────────────────────────
  // CREATE (static)
  // ──────────────────────────────
  static async create(attrs = {}) {
    const clean = {};

    // 1. Remove bad values
    for (const [key, val] of Object.entries(attrs)) {
      if (val !== undefined && !this.isBadValue(val)) {
        clean[key] = val;
      }
    }

    // 2. Enforce fillable whitelist
    const payload = {};
    const fillable = this.fillable || Object.keys(clean);
    for (const key of fillable) {
      if (key in clean) payload[key] = clean[key];
    }

    // 3. Block empty payload
    if (!Object.keys(payload).length) {
      throw new DBError('Attempted to create with empty payload', {
        model: this.name,
        attrs
      });
    }

    // 4. Create + save
    const model = new this();
    return model.saveNew(payload);
  }

  static async createMany(arr = []) {
    if (!Array.isArray(arr)) throw new DBError('createMany expects an array');
    if (!arr.length) return [];
    const results = [];
    await DB.transaction(async () => {
      for (const attrs of arr) {
        const r = await this.create(attrs);
        results.push(r);
      }
    });
    return results;
  }

  static async fetchOrNewUpMany(list = [], defaults = {}) {
    if (!Array.isArray(list)) throw new DBError('fetchOrNewUpMany expects an array of where objects');
    const out = [];
    for (const whereObj of list) {
      const found = await this.query().where(whereObj).first();
      if (found) out.push(found);
      else out.push(new this({ ...whereObj, ...defaults }));
    }
    return out;
  }

  static async fetchOrCreateMany(list = [], defaults = {}) {
    if (!Array.isArray(list)) throw new DBError('fetchOrCreateMany expects an array of where objects');
    const out = [];
    await DB.transaction(async () => {
      for (const whereObj of list) {
        const found = await this.query().where(whereObj).first();
        if (found) out.push(found);
        else out.push(await this.create({ ...whereObj, ...defaults }));
      }
    });
    return out;
  }

  static async updateOrCreateMany(items = []) {
    if (!Array.isArray(items)) throw new DBError('updateOrCreateMany expects an array');
    const out = [];
    await DB.transaction(async () => {
      for (const it of items) {
        const whereObj = it.where || {};
        const values = it.values || {};
        const found = await this.query().where(whereObj).first();
        if (found) {
          await found.fill(values).save();
          out.push(found);
        } else {
          out.push(await this.create({ ...whereObj, ...values }));
        }
      }
    });
    return out;
  }

  static async truncate() {
    if (DB.driver === 'mysql') {
      await DB.raw(`TRUNCATE TABLE ${this.tableName}`);
    } else if (DB.driver === 'pg') {
      await DB.raw(`TRUNCATE TABLE ${this.tableName} RESTART IDENTITY CASCADE`);
    } else {
      await DB.raw(`DELETE FROM ${this.tableName}`);
      if (DB.driver === 'sqlite') {
        try {
          await DB.raw(`DELETE FROM sqlite_sequence WHERE name = ?`, [this.tableName]);
        } catch (e) { /* ignore */ }
      }
    }
  }

  static async raw(sql, params) { return await DB.raw(sql, params); }

  static async transaction(fn) { return await DB.transaction(fn); }

  // ──────────────────────────────
  // 🛡 SANITIZATION UTIL
  // ──────────────────────────────
  static isBadValue(value) {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string' && !value.trim()) return true; // empty string
    return false; // allow 0, false, etc.
  }

  sanitize(attrs = {}) {
    const clean = {};
    const keepCols = this.constructor.columns || [];

    for (const key of Object.keys(attrs)) {
      const val = attrs[key];

      if (!this.constructor.isBadValue(val)) {
        clean[key] = val;   // keep 0, false, etc.
      } else if (keepCols.includes(key)) {
        clean[key] = null;
      }
    }

    return clean;
  }

  // ──────────────────────────────
  // SAFE fill() – allow only good values
  // ──────────────────────────────
  async fill(attrs = {}) {
    const allowed = this.constructor.fillable || Object.keys(attrs);
    let filled = false;

    for (const key of Object.keys(attrs)) {
      const val = attrs[key];
      if (allowed.includes(key) && val !== undefined) {
        this._attributes[key] = val; // 0, false, null preserved
        filled = true;
      }
    }

    if (!filled && Object.keys(attrs).length > 0) {
      throw new DBError('No fillable attributes provided', {
        model: this.constructor.name,
        attrs,
        fillable: allowed
      });
    }

    return this;
  }

  async merge(attrs = {}) {
    return this.fill(attrs);
  }

  // ──────────────────────────────
  // INSERT – validation first
  // ──────────────────────────────
  async saveNew(attrs) {
    this._attributes = { ...attrs }; 
    
    if (!Object.keys(this._attributes).length) {
      throw new DBError('Cannot save empty model', {
        model: this.constructor.name
      });
    }

    const payload = this.sanitize(attrs || this._attributes);

    // validate BEFORE hooks/db
    await this.constructor.validate(payload);
    await this.trigger('creating');

    // timestamps
    if (this.constructor.timestamps) {
      const now = new Date();
      if (payload.created_at === undefined) payload.created_at = now;
      if (payload.updated_at === undefined) payload.updated_at = now;
    }

    // soft deletes
    if (this.constructor.softDeletes) {
      const delCol = this.constructor.deletedAt;
      if (delCol in payload && this.constructor.isBadValue(payload[delCol])) {
        delete payload[delCol];
      }
    }

    const qb = this.constructor.query();
    const result = await qb.insert(payload);

    // handle pk
    const pk = this.constructor.primaryKey;
    const insertId = Array.isArray(result) ? result[0] : result;
    if (!(pk in payload) && insertId !== undefined) {
      payload[pk] = insertId;
    }

    this._attributes = { ...payload };
    this._original = { ...payload };
    this._exists = true;

    return this;
  }
  // ──────────────────────────────
  // UPDATE – only dirty fields
  // ──────────────────────────────
  async save() {
    // if (!this._exists) return this.saveNew(this._attributes);
    if (!this._exists && !Object.keys(this._attributes).length) {
      throw new DBError('Cannot save empty model', {
        model: this.constructor.name
      });
    }

    await this.trigger('updating');

    const dirty = {};
    const attrs = this._attributes;
    const orig = this._original;

    for (const key of Object.keys(attrs)) {
      const val = attrs[key];

      if (val !== orig[key] && val !== undefined) { // only treat undefined as "no change"
        if (this.constructor.softDeletes && key === this.constructor.deletedAt) continue;
        dirty[key] = val;
      }
    }

    const payload = this.sanitize(dirty);
    if (!Object.keys(payload).length) return this;

    // timestamps
    if (this.constructor.timestamps) {
      const now = new Date();
      payload.updated_at = now;
      this._attributes.updated_at = now;
    }

    // validate BEFORE db write
    const pk = this.constructor.primaryKey;
    await this.constructor.validate({ ...this._original, ...payload }, this._attributes[pk]);

    const id = this._attributes[pk];
    const qb = this.constructor.query();
    await qb.where(pk, id).update(payload);

    this._original = { ...this.sanitize(this._attributes) };

    return this;
  }

  // ──────────────────────────────
  // update() → proxies fill + save()
  // ──────────────────────────────
  async update(attrs = {}) {
    const payload = this.sanitize(attrs);
    await this.fill(payload);
    return this.save();
  }

  static getRelations() {
    if (this._cachedRelations) return this._cachedRelations;

    const proto = this.prototype;
    const relations = {};

    // dummy instance for calling methods
    const dummy = new this({}, false);

    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const fn = proto[name];
      if (typeof fn !== 'function') continue;

      let rel;
      try {
        rel = fn.call(dummy);
      } catch (err) {
        // continue;
        throw new DBError('Failed to resolve relation', {
          model: this.name,
          relation: name,
          err
        });
      }

      if (!rel) continue;

      // Check if rel is one of your relation classes
      if (
        rel instanceof BelongsTo ||
        rel instanceof HasOne ||
        rel instanceof HasMany ||
        rel instanceof BelongsToMany ||
        rel instanceof MorphOne ||
        rel instanceof MorphMany ||
        rel instanceof MorphTo ||
        rel instanceof MorphToMany ||
        rel instanceof MorphedByMany ||
        rel instanceof HasManyThrough
      ) {
        rel._name = name;
        relations[name] = rel;
      }
    }

    this._cachedRelations = relations;
    return relations;
  }

  // Delete & Restore
  async delete() {
    if (!this._exists) return false;

    // Run events
    await this.trigger('deleting');

    const pk = this.constructor.primaryKey;

    // Soft delete
    if (this.constructor.softDeletes) {
      this._attributes[this.constructor.deletedAt] = new Date();
      return this.save();
    }

    // ────────────────────────────────────────
    // AUTO-DISCOVER RELATIONS
    // ────────────────────────────────────────
    const relations = this.constructor.getRelations();

    for (const relName in relations) {
      const relMeta = relations[relName];

      // Load related models (Array|Model|null)
      let related;
      try {
        related = await this[relName]();
      } catch {
        continue; // relation method may need instance values; skip if fails
      }

      if (!related) continue;

      const behavior = relMeta.deleteBehavior || 'ignore';

      switch (behavior) {

        // ──────────────────────────────────
        // RESTRICT — block delete
        // ──────────────────────────────────
        case 'restrict':
          throw new DBError(
            `Cannot delete ${this.constructor.name}: related ${relName} exists`,
            {
              model: this.constructor.name,
              relation: relName,
              behavior: 'restrict'
            }
          );

        // ──────────────────────────────────
        // DETACH — only for BelongsToMany / MorphToMany
        // ──────────────────────────────────
        case 'detach':
          // must be a pivot relation
          if (
            relMeta.pivotTable &&
            relMeta.foreignKey &&
            relMeta.relatedKey
          ) {
            const parentId = this[this.constructor.primaryKey];

            const relatedIds = Array.isArray(related)
              ? related.map(r => r[r.constructor.primaryKey])
              : [related[related.constructor.primaryKey]];

            await new QueryBuilder(relMeta.pivotTable)
              .where(relMeta.foreignKey, parentId)
              .whereIn(relMeta.relatedKey, relatedIds)
              .delete();
          }
          break;

        // ──────────────────────────────────
        // CASCADE — delete related models
        // ──────────────────────────────────
        case 'cascade':
          if (Array.isArray(related)) {
            for (const child of related) {
              if (child && typeof child.delete === 'function')
                await child.delete();
            }
          } else if (typeof related.delete === 'function') {
            await related.delete();
          }
          break;

        // ──────────────────────────────────
        // IGNORE — do nothing
        // ──────────────────────────────────
        case 'ignore':
        default:
          break;
      }
    }

    // ────────────────────────────────────────
    // PHYSICAL DELETE
    // ────────────────────────────────────────
    const qb = this.constructor.query().where(pk, this._attributes[pk]);

    await qb.delete();

    this._exists = false;
    return true;
  }


  static async destroy(ids) {
    if (!Array.isArray(ids)) {
      throw new DBError('destroy expects an array of IDs', {
        model: this.name,
        ids
      });
    }

    // if (!Array.isArray(ids)) ids = [ids];
    const pk = this.primaryKey;

    // --- Load models so cascade works ---
    const models = await this.whereIn(pk, ids).get();

    for (const model of models) {
      await model.delete();  // uses the patched cascade delete
    }

    return models.length;
  }

  async restore() {
    if (!this.constructor.softDeletes) return this;
    this._attributes[this.constructor.deletedAt] = null;
    return await this.save();
  }

  // Relationships
  // Give each instance ability to create relations
  belongsTo(RelatedClass, foreignKey = null, ownerKey = null) {
    return new BelongsTo(this, RelatedClass, foreignKey, ownerKey);
  }

  hasOne(RelatedClass, foreignKey = null, localKey = null) {
    return new HasOne(this, RelatedClass, foreignKey, localKey);
  }

  hasMany(RelatedClass, foreignKey = null, localKey = null) {
    return new HasMany(this, RelatedClass, foreignKey, localKey);
  }

  belongsToMany(RelatedClass, pivotTable = null, foreignKey = null, relatedKey = null) {
    return new BelongsToMany(this, RelatedClass, pivotTable, foreignKey, relatedKey);
  }

  hasManyThrough(RelatedClass, ThroughClass, firstKey = null, secondKey = null, localKey = null, secondLocalKey = null) {
    return new HasManyThrough(this, RelatedClass, ThroughClass, firstKey, secondKey, localKey, secondLocalKey);
  }

  morphOne(RelatedClass, morphName, localKey = null) {
    return new MorphOne(this, RelatedClass, morphName, localKey);
  }

  morphMany(RelatedClass, morphName, localKey = null) {
    return new MorphMany(this, RelatedClass, morphName, localKey);
  }

  morphTo(typeField = "morph_type", idField = "morph_id") {
    return new MorphTo(this, typeField, idField);
  }

  morphToMany(RelatedClass, morphName, pivotTable = null, foreignKey = null, relatedKey = null) {
    return new MorphToMany(this, RelatedClass, morphName, pivotTable, foreignKey, relatedKey);
  }

  morphedByMany(RelatedClass, morphName, pivotTable = null, foreignKey = null, relatedKey = null) {
    return new MorphedByMany(this, RelatedClass, morphName, pivotTable, foreignKey, relatedKey);
  }

  static with(relations) { return this.query().with(relations); }

  // Serialization & Conversion
  toObject({ relations = true } = {}) {
    const base = {};

    // copy attributes
    for (const [k, v] of Object.entries(this._attributes)) {
      if (v instanceof Date) base[k] = this.serializeDate(v);
      else if (v instanceof Model) base[k] = v.toObject();
      else base[k] = v;
    }

    // relations
    if (relations && this._relations) {
      for (const [name, rel] of Object.entries(this._relations)) {
        if (Array.isArray(rel)) {
          base[name] = rel.map(r =>
            r instanceof Model ? r.toObject() : r
          );
        } else if (rel instanceof Model) {
          base[name] = rel.toObject();
        } else if (rel && typeof rel.then === "function") {
          // relation didn't resolve yet
          base[name] = null;
        } else {
          base[name] = rel;
        }
      }
    }

    // apply hidden/visible properly
    const hidden = this.constructor.hidden || [];
    const visible = this.constructor.visible;

    let out = { ...base };

    if (visible && Array.isArray(visible)) {
      out = Object.fromEntries(
        Object.entries(out).filter(([k]) => visible.includes(k))
      );
    } else if (hidden.length) {
      for (const k of hidden) delete out[k];
    }

    return out;
  }

  toJSON() {
    if (typeof this.toObject === 'function') {
      return this.toObject();
    }
    return {};
  }
  
  toString() {
    return `${this.constructor.name} ${JSON.stringify(this.toObject(), null, 2)}`;
  }

  // Node's util.inspect custom symbol
  [util.inspect.custom]() {
    return this.toObject();
  }

  serializeDate(date) {
    return date.toLocaleString();
  }

  // Utility helpers
  clone(deep = false) {
    const attrs = deep
      ? (globalThis.structuredClone
          ? structuredClone(this._attributes)
          : JSON.parse(JSON.stringify(this._attributes)))
      : { ...this._attributes };

    const m = new this.constructor(attrs, this._exists);
    m._original = { ...this._original };
    return m;
  }

  only(keys = []) {
    const out = {};
    for (const k of keys) if (k in this._attributes) out[k] = this._attributes[k];
    return out;
  }

  except(keys = []) {
    const out = {};
    for (const k of Object.keys(this._attributes))
      if (!keys.includes(k)) out[k] = this._attributes[k];
    return out;
  }

  getAttribute(key) { return this._attributes[key]; }
  setAttribute(key, value) { this._attributes[key] = value; return this; }

  async refresh() {
    const pk = this.constructor.primaryKey;
    // if (!this._attributes[pk]) return this;
    if (!this._attributes[pk]) {
      throw new DBError('Cannot refresh model without primary key', {
        model: this.constructor.name
      });
    }
    const fresh = await this.constructor.find(this._attributes[pk]);
    if (fresh) {
      this._attributes = { ...fresh._attributes };
      this._original = { ...fresh._original };
    }
    return this;
  }

  get exists() { return this._exists; }

  isDirty(key) {
    if (!key) return Object.keys(this._attributes).some(k => this._attributes[k] !== this._original[k]);
    return this._attributes[key] !== this._original[key];
  }

  getChanges() {
    const dirty = {};
    for (const k of Object.keys(this._attributes))
      if (this._attributes[k] !== this._original[k]) dirty[k] = this._attributes[k];
    return dirty;
  }
}

// --- BaseModel with bcrypt hashing ---
const bcrypt = tryRequire('bcrypt');
class BaseModel extends Model {
  static passwordField = 'password';
  static hashRounds = 10;

  /**
   * Lifecycle hook placeholders
   * Subclasses can override these.
   */
  async beforeCreate(attrs) {}
  async afterCreate(savedRecord) {}
  async beforeSave(attrs) {}
  async afterSave(savedRecord) {}

  /**
   * Called when inserting a new record.
   */
  async saveNew(attrs) {
    await this.beforeSave(attrs);
    await this.beforeCreate(attrs);

    await this._maybeHashPassword(attrs);
    const saved = await super.saveNew(attrs);

    await this.afterCreate(saved);
    await this.afterSave(saved);

    return saved;
  }

  /**
   * Called when updating an existing record.
   */
  async save() {
    await this.beforeSave(this._attributes);
    await this._maybeHashPassword(this._attributes);

    const saved = await super.save();

    await this.afterSave(saved);
    return saved;
  }

  /**
   * Hash password field if needed.
   */
  async _maybeHashPassword(attrs) {
    const field = this.constructor.passwordField;
    if (!attrs[field]) return;

    if (!bcrypt)
      throw new DBError('bcrypt module required. Install: npm i bcrypt');

    const isHashed =
      typeof attrs[field] === 'string' && /^\$2[abxy]\$/.test(attrs[field]);

    if (!isHashed) {
      const salt = await bcrypt.genSalt(this.constructor.hashRounds);
      attrs[field] = await bcrypt.hash(attrs[field], salt);
    }
  }

  /**
   * Check a plain text password against the hashed one.
   */
  async checkPassword(rawPassword) {
    const field = this.constructor.passwordField;
    const hashed = this._attributes[field];
    if (!hashed) return false;
    return await bcrypt.compare(rawPassword, hashed);
  }

  /**
   * Serialize model data for output.
   * Override this to customize output (e.g. hide sensitive fields).
   */
  serialize() {
    const data = { ...this._attributes };
    const passwordField = this.constructor.passwordField;

    // Remove password or other sensitive data
    if (data[passwordField]) delete data[passwordField];

    return data;
  }
}

// ======================
// Database Init
// ======================
DB.initFromEnv();

(async () => {
  await DB.connect();
})();

module.exports = { DB, Model, Validator, ValidationError, Collection, QueryBuilder, HasMany, HasOne, BelongsTo, BelongsToMany, DBError, LamixSessionStore, BaseModel};
