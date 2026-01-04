// models/User.js
const { BaseModel} = require('lamix');

class User extends BaseModel {
  static table = 'users';
  static primaryKey = 'id';
  static timestamps = true;
  static softDeletes = true;// Optional if you don't need it
  static fillable = ['name', 'email', 'password'];// password is Auto encrypted when creating.
  static rules = {
    name: 'required|string',
    email: 'required|email|unique:users,email',
    password: 'required|string|min:6',
    phone: 'nullable|phone',
    status: 'nullable|boolean'
  };

  profile() {
    return this.hasOne(Profile).onDelete('restrict');
  }

  
  // Many-to-many: User ↔ Role via pivot user_roles (user_id, role_id)
  roles() {
    const Role = require('./Role');
    return this.belongsToMany(
      Role,
      'user_roles',
      'user_id',
      'role_id'
    ).onDelete('detach');
  }

  // One-to-many: User -> Post
  posts() {
    return this.hasMany(require('./Post'), 'user_id', 'id').onDelete('cascade');
  }
}

module.exports = User;
