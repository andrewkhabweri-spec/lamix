// One-to-many
const user = await User.find(1);
const posts = await user.posts().get();

// Eager loading
const usersWithPosts = await User.query().with('posts').get();

// Many-to-many
const user = await User.find(2);

const roles = await user.roles().get();
await user.roles().attach(5);
await user.roles().detach(3);

// Eager load multiple relations
const users = await User.query().with(['roles', 'posts', 'comments']).get();
