const { BaseModel } = require('lamix');

class Role extends BaseModel {
  static table = 'roles';
  static primaryKey = 'id';
  static timestamps = false;
  static softDeletes = false;// Optional if you don't need it
  static fillable = ['name'];
  static rules = {
    name: 'required|string'
  };

  users() {
    const User = require('./User');
    return this.belongsToMany(
      User,
      'user_roles',
      'role_id',
      'user_id',
      'id',
      'id'
    ).onDelete('detach');
  }
}

module.exports = Role;
