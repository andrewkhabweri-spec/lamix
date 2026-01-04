# Migration & Seeder CLI Tool
This package supports MySQL (mysql2), PostgreSQL (pg), and SQLite (sqlite3).
A simple Node.js CLI for generating and running database migrations and seeders with MySQL, using a custom DB wrapper.

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


Migrations table Supports chainable modifiers filled Manually  :

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
npm i nexium-orm

2. Install dependencies (if any).  
   > This tool uses `mysql2`,`pg`,`sqlite3` driver, so make sure you install your prefered driver:
 EITHER
 Configure DB via environment variables: `'DB_CONNECTION=mysql',DB_HOST`, `DB_USER`, `DB_PASS`, `DB_NAME`, `DB_PORT`, `DB_CONNECTION_LIMIT`.

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

npm install mysql2 dotenv bcrypt

```bash
#Make Sure you put this in package.json inside your project directory for 
#CLI generating Commands to work

"scripts": {
  "artisan": "node ./node_modules/lamix/artisan.js"
}

# TO See All the Available CLI Commands Run in Terminal
npm run artisan --
