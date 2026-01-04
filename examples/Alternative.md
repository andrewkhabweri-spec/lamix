const { name, status } = req.body;

const category = await BlogCategory.find(req.params.id);

const existingCategory = await BlogCategory.query()
  .where('name', name)
  .whereNot('id', category.id)
  .first();

if (existingCategory) {
  req.flash('error', 'Category name already exists.');
  return res.redirect('/blogcategory');
}

const { value } = req.body;

const categorry = await Category.find(req.params.id);
const existCategory = await Category.findBy('name', value);

if (existCategory && existCategory.id !== categorry.id) {
  req.flash('error', 'Category name already exists.');
  return res.redirect('/category');
}
