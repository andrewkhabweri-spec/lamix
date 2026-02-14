# Migration & Seeder CLI Tool
This package supports MySQL (mysql2), PostgreSQL (pg), and SQLite (sqlite3).
A simple Node.js CLI for generating Models and running database migrations and seeders with MySQL, using a custom DB wrapper.

---
get all Usage in examples provided for any issue or support get in tourch @ `andrewkhabweri@gmail.com`
## Features

- Generate migration files dynamically with fields
- Run migrations 
- Rollback last migration
- Generate seed files dynamically
- Run all unapplied seeders
- Refresh all seeds (rollback + rerun)
- Run specific seed files
- Built-in schema builder 

---
For rules Validation below are the Avalable data validation rules used in Model:
---
required
string
boolean
numeric
email
min
max
confirmed
date
url
regex
in
unique
exists
phone
alpha
alpha_num
array
json
between
not_in
integer
ip
uuid
slug
after
before
size
mimes
image
file


Migrations table Supports chainable modifiers filled can be added Manually  :

.notNullable()

.nullable()

.defaultTo(value)

.unsigned() (MySQL only)

.unique()

.primary()

.autoIncrement()

.comment('text') (MySQL only)

.after('columnName') (MySQL only)

## Prerequisites

- Node.js (v18+ recommended)
- MySQL database
- `.env` file configured with your database credentials (see example below)

---

## Setup

1. download this project.
npm i lamix

2. Install dependencies (if any).  
   > This tool uses `mysql2`,`pg`,`sqlite3` driver, so make sure you install your prefered driver:
 DATABASE CONNECTION IN `.env`FILE
 Configure DB via environment variables: `'DB_CONNECTION=mysql',DB_HOST=your db hast`, `DB_USER=your db user`, `DB_PASS=your db password`, `DB_NAME=your db name`, `DB_PORT=your db port`, `DB_CONNECTION_LIMIT=10`.

## Quick start
for database connection use any driver of your choice eg
`DB_CONNECTION=mysql` # if using mysql2
`DB_CONNECTION=pg` # if using PostgreSQL
`DB_CONNECTION=sqlite` # for sqlite

`DB_DATABASE=./database.sqlite`   # if using sqlite

1. Install dependencies:
   ```
   npm install
   ```
```bash
npm i lamix

npm install mysql2  # or pg or sqlite3

# TO See All the Available CLI Commands Run in Terminal
npx lamix

#Basic CRUD & Query

const User = require('./models/User');

# Create new user
const user = await User.create({ name: 'Alice', email: 'alice@example.com', password: 'secret' });

# Fill & save (update)
user.name = 'Alice Smith';  // you can also use user.fill({ name: 'Alice Smith' })
await user.save();

# Find by primary key
const user1 = await User.find(1);
const user2 = await User.findOrFail(param.id);

# Query with where
const someUsers = await User.where('email', 'alice@example.com').get();

# First match
const firstUser = await User.where('name', 'Alice').first();
const firstOrFail = await User.where('name', 'Alice').firstOrFail();

const user = await User.findBy('email', 'jane@example.com');
# by default Field password is Auto encrypted when creating
const isValid = await user.checkPassword('user_input_password');
# Delete (soft delete if enabled)
await user.delete();

# destroy (delete Multiple ids)
await user.destroy();

# update (by default)
await user.update({ body });

# or update
await user.fill({ body });
await user.save();

# Restore (if softDeletes enabled)
await user.restore();

# List all (excluding trashed, by default)
const allUsers = await User.all();

# Query including soft-deleted (trashed) records
const withTrashed = await User.withTrashed().where('id', 1).first();

#QueryBuilder Advanced Features

const qb = User.query();

# Select specific columns
const names = await User.query().select('id', 'name').get();

# Aggregates
const cnt = await User.query().count();          // count(*)
const sumId = await User.query().sum('id');
const avgId = await User.query().avg('id');
const minId = await User.query().min('id');
const maxId = await User.query().max('id');

# status a column (returns status of boolean values)
const usersAll = await User.all();
const users = await User.query().where('status', true).get();
const usersorderbyid = await User.query().where('status', true).orderBy('id', 'desc').get();
const usersorderbycreateAt = await User.query().where('status', true).orderBy('created_at', 'desc').get();

# Pluck a column (returns array of values)
const Pluckemails = await User.query().pluck('email');

# Pagination
const page1 = await User.query().paginate(1, 10);
// page1 = { total, perPage, page, lastPage, data: [users...] }

# Where In
const usersIn = await User.query().whereIn('id', [1, 2, 3]).get();

// Where Null / Not Null
const withNull = await User.query().whereNull('deleted_at').get();
const notNull = await User.query().whereNotNull('deleted_at').get();

# Where Between
const inRange = await User.query().whereBetween('id', [10, 20]).get();

# Ordering, grouping, having
const grouped = await User.query()
  .select('user_id', 'COUNT(*) as cnt')
  .groupBy('user_id')
  .having('cnt', '>', 1)
  .get();

# Joins
const withPosts = await User.query()
  .select('users.*', 'posts.title as post_title')
  .join('INNER', 'posts', 'users.id', '=', 'posts.user_id')
  .get();

# Using “forUpdate” (locking)
await User.query().where('id', 5).forUpdate().get();

# Raw queries
const rows = await User.raw('SELECT * FROM users WHERE id = ?', [5]);

# Caching
const cachedRows = await User.raw('SELECT * FROM users', []).then(rows => rows);
const cached = await DB.cached('SELECT * FROM users WHERE id = ?', [5], 60000);

#You can use relations:

const user = await User.find(1);
const posts = await user.posts().get();  // all posts for the user

# Eager load in a query with Relations:
const usersWithPosts = await User.query().with('posts').get();
# Each user will have a `posts` field with array of post models.

# Many-to-many example
# Suppose you have an intermediate pivot table user_roles (user_id, role_id)
# and models User and Role, with pivot user_roles.
#

# Then:
const user = await User.find(2);
const roles = await user.roles().get();

# Eager load with Relations:
const usersWithRoles = await User.query().with('roles').get();

# Eager load with Many to Many Relations:
const usersWith_Roles_posts_comments = await User.query().with(['roles', 'posts', 'comments' ]).get();
#OR with Many to Many Relations:
const users_With_Roles_posts_comments = await User.with(['roles', 'posts', 'comments' ]).get();

# Find by field
const user = await User.findBy('email', 'jane@example.com');

# Check hashed password
const isValid = await user.checkPassword('password');

# models/User.js(Example)
const { BaseModel} = require('lamix');

class User extends BaseModel {
  static table = 'users';
  static primaryKey = 'id';
  static timestamps = true;
  static softDeletes = false; # Optional if you don't need it
  static fillable = ['name', 'email', 'password'];  # password is Auto encrypted when creating.
  static rules = {   # Optional if you don't need it
    name: 'required|string',
    email: 'required|email|unique:users,email',
    password: 'required|string|min:6',
    phone: 'nullable|phone',
    status: 'boolean'
  };

  profile() {
    const Profile = require('./Profile');
    return this.hasOne(Profile).onDelete('restrict');
  }

  
  # Many-to-many: User ↔ Role via pivot user_roles (user_id, role_id)
  roles() {
    const Role = require('./Role');
    return this.belongsToMany(
      Role,
      'user_roles',
      'user_id',
      'role_id'
    ).onDelete('detach');
  }

  # One-to-many: User -> Post
  posts() {
    const Post = require('./Post');
    return this.hasMany(Post', 'user_id', 'id').onDelete('cascade');
  }

  # migrate sessions Table(whenever migration is run session is auto generated if missing)
  npx lamix migrate
  ➡️ sessions table + index are guaranteed to exist.

  # Session setup
  const express = require('express');
  const session = require('express-session');
  const { DB, LamixSessionStore } = require('lamix');

  DB.initFromEnv();

  (async () => {
    await DB.connect();
  })();

  const app = express();

  app.use(
    session({
      name: 'lamix.sid',
      secret: process.env.SESSION_SECRET || 'dev-secret',
      resave: false,
      saveUninitialized: false,
      store: new LamixSessionStore({
        ttl: 60 * 60 * 24, // 1 day
      }),
      cookie: {
        httpOnly: true,
        secure: false, // true behind HTTPS
        maxAge: 1000 * 60 * 60 * 24,
      },
    })
  );

  app.get('/', (req, res) => {
    req.session.views = (req.session.views || 0) + 1;
    res.json({ views: req.session.views });
  });

  app.listen(3000);
}
