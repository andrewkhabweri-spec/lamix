//Basic CRUD & Query

const User = require('./models/User');

// Create new user
const user = await User.create({ name: 'Alice', email: 'alice@example.com', password: 'secret' });

// Fill & save (update)
user.name = 'Alice Smith';  // you can also use user.fill({ name: 'Alice Smith' })
await user.save();

// Find by primary key
const user1 = await User.find(1);
const user2 = await User.findOrFail(param.id);

// Query with where
const someUsers = await User.where('email', 'alice@example.com').get();

// First match
const firstUser = await User.where('name', 'Alice').first();
const firstOrFail = await User.where('name', 'Alice').firstOrFail();

const user = await User.findBy('email', 'jane@example.com');
// by default Field password is Auto encrypted when creating
const isValid = await user.checkPassword('user_input_password');
// Delete (soft delete if enabled)
await user.delete();

// destroy (delete Multiple ids)
await user.destroy();

// update (by default)
await user.update({ body });
or
// update
await user.fill({ body });
await user.save();

// Restore (if softDeletes enabled)
await user.restore();

// List all (excluding trashed, by default)
const allUsers = await User.all();

// Query including soft-deleted (trashed) records
const withTrashed = await User.withTrashed().where('id', 1).first();

//QueryBuilder Advanced Features

const qb = User.query();

// Select specific columns
const names = await User.query().select('id', 'name').get();

// Aggregates
const cnt = await User.query().count();          // count(*)
const sumId = await User.query().sum('id');
const avgId = await User.query().avg('id');
const minId = await User.query().min('id');
const maxId = await User.query().max('id');

// status a column (returns status of boolean values)
const usersAll = await User.all();
const users = await User.query().where('status', true).get();
const usersorderbyid = await User.query().where('status', true).orderBy('id', 'desc').get();
const usersorderbycreateAt = await User.query().where('status', true).orderBy('created_at', 'desc').get();

// Pluck a column (returns array of values)
const Pluckemails = await User.query().pluck('email');

// Pagination
const page1 = await User.query().paginate(1, 10);
// page1 = { total, perPage, page, lastPage, data: [users...] }

// Where In
const usersIn = await User.query().whereIn('id', [1, 2, 3]).get();

// Where Null / Not Null
const withNull = await User.query().whereNull('deleted_at').get();
const notNull = await User.query().whereNotNull('deleted_at').get();

// Where Between
const inRange = await User.query().whereBetween('id', [10, 20]).get();

// Ordering, grouping, having
const grouped = await User.query()
  .select('user_id', 'COUNT(*) as cnt')
  .groupBy('user_id')
  .having('cnt', '>', 1)
  .get();

// Joins
const withPosts = await User.query()
  .select('users.*', 'posts.title as post_title')
  .join('INNER', 'posts', 'users.id', '=', 'posts.user_id')
  .get();

// Using “forUpdate” (locking)
await User.query().where('id', 5).forUpdate().get();

// Raw queries
const rows = await User.raw('SELECT * FROM users WHERE id = ?', [5]);

// Caching
const cachedRows = await User.raw('SELECT * FROM users', []).then(rows => rows);
const cached = await DB.cached('SELECT * FROM users WHERE id = ?', [5], 60000);

//You can use relations:

const user = await User.find(1);
const posts = await user.posts().get();  // all posts for the user

// Eager load in a query with Relations:
const usersWithPosts = await User.query().with('posts').get();
// Each user will have a `posts` field with array of post models.

// Many-to-many example
// Suppose you have an intermediate pivot table user_roles (user_id, role_id)
// and models User and Role, with pivot user_roles.
//

// Then:
const user = await User.find(2);
const roles = await user.roles().get();

// Eager load with Relations:
const usersWithRoles = await User.query().with('roles').get();

// Eager load with Many to Many Relations:
const usersWith_Roles_posts_comments = await User.query().with(['roles', 'posts', 'comments' ]).get();
//OR with Many to Many Relations:
const users_With_Roles_posts_comments = await User.with(['roles', 'posts', 'comments' ]).get();
