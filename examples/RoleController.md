const Role = require('../app/models/Role');

class RoleController {
  async index(req, res) {
    const roles = await Role.query().get();
    return res.render('roles/index', { roles });
  }

  async show(req, res) {
    const { id } = req.params;
    const role = await Role.find(id);
    if (!role) return res.status(404).send('Role not found');
    return res.render('roles/show', { role });
  }

  async create(req, res) {
    return res.render('roles/create');
  }

  async store(req, res) {
    try {
      const r = await Role.create(req.body);
      return res.redirect(`/roles/${r.id}`);
    } catch (err) {
      console.error(err);
      return res.status(400).send('Error creating role');
    }
  }

  async edit(req, res) {
    const { id } = req.params;
    const role = await Role.find(id);
    if (!role) return res.status(404).send('Role not found');
    return res.render('roles/edit', { role });
  }

  async update(req, res) {
    try {
      const { id } = req.params;
      const role = await Role.find(id);
      if (!role) return res.status(404).send('Role not found');
      await role.fill(req.body);
      await role.save();
      return res.redirect(`/roles/${role.id}`);
    } catch (err) {
      console.error(err);
      return res.status(400).send('Error updating role');
    }
  }

  async destroy(req, res) {
    try {
      const { id } = req.params;
      const role = await Role.find(id);
      if (!role) return res.status(404).send('Role not found');
      await role.delete();
      return res.redirect('/roles');
    } catch (err) {
      console.error(err);
      return res.status(500).send('Error deleting role');
    }
  }
}

module.exports = new RoleController();
