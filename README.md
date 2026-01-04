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
 Configure DB via environment variables: `'DB_CONNECTION=mysql',DB_HOST=your db hast`, `DB_USER=your db user`, `DB_PASS=your db password`, `DB_NAME=your db name`, `DB_PORT=your db port`, `DB_CONNECTION_LIMIT=100`.

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

```bash
# TO See All the Available CLI Commands Run in Terminal
npx lamix
