// controllers/UserController.js
const User = require('Model-User');
const { ValidationError } = require('lamix');

class UserController {
  // GET /users
  async index(req, res) {
    try {
      const users = await User.query().get();
      return res.json(users);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to fetch users.' });
    }
  }

  // GET /users/:id
  async show(req, res) {
    try {
      const user = await User.find(req.params.id);
      if (!user) return res.status(404).json({ error: 'User not found.' });
      return res.json(user);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to fetch user.' });
    }
  }

  // POST /users
  static async store(req, res) {
    const input = {
      name: req.body.name,
      email: req.body.email,
      password: req.body.password,
      phone: req.body.phone,
      status: req.body.status,
    };

    try {
      await User.create({
        name: input.name,
        email: input.email,
        password: input.password,
        phone: input.phone,
        status: input.status === 'true',
      });

      req.flash('success', 'User created successfully!');
      res.redirect('/users');
    } catch (e) {
      if (e instanceof ValidationError) {
        return res.status(422).json(e.errors);
      }
      throw e;
    }
  }

  // PUT /users/:id
  async update(req, res) {
    try {
      const user = await User.find(req.params.id);
      if (!user) return res.status(404).json({ error: 'User not found.' });

      await user.fill(req.body);
      await user.save();

      return res.json(user);
    } catch (err) {
      return res.status(400).json({ error: 'Failed to update user.' });
    }
  }

  // DELETE /users/:id
  async destroy(req, res) {
    try {
      const user = await User.find(req.params.id);
      if (!user) return res.status(404).json({ error: 'User not found.' });

      await user.delete();
      return res.status(204).send();
    } catch (err) {
      return res.status(500).json({ error: 'Failed to delete user.' });
    }
  }

  // POST /users/:id/restore
  async restore(req, res) {
    try {
      const user = await User.withTrashed().where('id', req.params.id).first();
      if (!user) return res.status(404).json({ error: 'User not found.' });

      await user.restore();
      return res.json(user);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to restore user.' });
    }
  }
}

module.exports = new UserController();
