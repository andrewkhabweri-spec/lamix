const qb = User.query();

// Select
const names = await User.query().select('id', 'name').get();

// Aggregates
const cnt = await User.query().count();
const sumId = await User.query().sum('id');
const avgId = await User.query().avg('id');
const minId = await User.query().min('id');
const maxId = await User.query().max('id');

// Status column example
const users = await User.query().where('status', true).get();

// Ordering
const usersorderbyid = await User.query()
  .where('status', true)
  .orderBy('id', 'desc')
  .get();

// Pluck
const emails = await User.query().pluck('email');

// Pagination
const page1 = await User.query().paginate(1, 10);

// Where In
const usersIn = await User.query().whereIn('id', [1, 2, 3]).get();

// Null checks
const withNull = await User.query().whereNull('deleted_at').get();
const notNull = await User.query().whereNotNull('deleted_at').get();

// Between
const inRange = await User.query().whereBetween('id', [10, 20]).get();

// Grouping & having
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

// Locking
await User.query().where('id', 5).forUpdate().get();

// Raw queries
const rows = await User.raw('SELECT * FROM users WHERE id = ?', [5]);
