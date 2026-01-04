const Post = require('../app/models/Post');
const User = require('../app/models/User');

class PostController {
  async index(req, res) {
    try {
      const { page, perPage } = req.query;
      const result = await Post.query().paginate(page || 1, perPage || 10);
      return res.render('posts/index', { posts: result.data, page: result.page, lastPage: result.lastPage });
    } catch (err) {
      console.error(err);
      return res.status(500).send('Error listing posts');
    }
  }

  async show(req, res) {
    try {
      const { id } = req.params;
      const post = await Post.query().with('user').where('id', id).first();
      if (!post) return res.status(404).send('Post not found');
      return res.render('posts/show', { post });
    } catch (err) {
      console.error(err);
      return res.status(500).send('Error fetching post');
    }
  }

  async create(req, res) {
    const users = await User.query().get();
    return res.render('posts/create', { users });
  }

  async store(req, res) {
    try {
      const attrs = req.body;
      const post = await Post.create(attrs);
      return res.redirect(`/posts/${post.id}`);
    } catch (err) {
      console.error(err);
      return res.status(400).send('Error creating post');
    }
  }

  async edit(req, res) {
    const { id } = req.params;
    const post = await Post.find(id);
    if (!post) return res.status(404).send('Post not found');
    const users = await User.query().get();
    return res.render('posts/edit', { post, users });
  }

  async update(req, res) {
    try {
      const { id } = req.params;
      const post = await Post.find(id);
      if (!post) return res.status(404).send('Post not found');
      await post.fill(req.body);
      await post.save();
      return res.redirect(`/posts/${post.id}`);
    } catch (err) {
      console.error(err);
      return res.status(400).send('Error updating post');
    }
  }

  async destroy(req, res) {
    try {
      const { id } = req.params;
      const post = await Post.find(id);
      if (!post) return res.status(404).send('Post not found');
      await post.delete();
      return res.redirect('/posts');
    } catch (err) {
      console.error(err);
      return res.status(500).send('Error deleting post');
    }
  }

  async restore(req, res) {
    try {
      const { id } = req.params;
      const p = await Post.withTrashed().where('id', id).first();
      if (!p) return res.status(404).send('Post not found');
      await p.restore();
      return res.redirect(`/posts/${p.id}`);
    } catch (err) {
      console.error(err);
      return res.status(500).send('Error restoring post');
    }
  }
}

module.exports = new PostController();
