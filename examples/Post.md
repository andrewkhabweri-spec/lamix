const { BaseModel } = require('lamix');

class Post extends BaseModel {
  static table = 'posts';
  static primaryKey = 'id';
  static timestamps = true;
  static softDeletes = true;// Optional if you don't need it
  static fillable = ['title', 'body', 'user_id'];
  static rules = {
    name: 'required|string',
    body: 'nullable|string',
    user_id: 'nullable|integer'
  };

  user() {
    const User = require('./User');
    return this.belongsTo(User, 'user_id', 'id').onDelete('detach');
  }

  categories() {
    const Category = require('./Category');
    return this.belongsToMany(Category)
      .withPivot("featured")
      .withTimestamps().onDelete('detach');
  };
}

module.exports = Post;
