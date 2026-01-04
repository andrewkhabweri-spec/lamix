const User = require('./models/User');

// Create
const user = await User.create({
  name: 'Alice',
  email: 'alice@example.com',
  password: 'secret'
});

// Update
user.name = 'Alice Smith';
await user.update();

// Find
const user1 = await User.find(1);
const user2 = await User.findOrFail(param.id);

// Query with where
const someUsers = await User.where('email', 'alice@example.com').get();

// First / firstOrFail
const firstUser = await User.where('name', 'Alice').first();
const firstOrFail = await User.where('name', 'Alice').firstOrFail();

// Find by field
const user = await User.findBy('email', 'jane@example.com');

// Check hashed password
const isValid = await user.checkPassword('password');

// Delete / soft delete
await user.delete();

// Destroy multiple
await user.destroy();

// Update using fill
await user.fill({ body });
await user.save();

//OR Update using without fill
await User.update({ body });

// Restore
await user.restore();

// List all
const allUsers = await User.all();

// With trashed
const withTrashed = await User.withTrashed().where('id', 1).first();
