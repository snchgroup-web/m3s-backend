const SOCIAL_INCOME_CATEGORIES = Object.freeze([
  'AIDE SOCIALE MENAGE',
  'AIDE SOCIALE M\u00C9NAGE',
  'AIDE SOCIALE',
]);

const validateColumn = (column) => {
  const value = String(column || '').trim();
  if (!/^[A-Za-z0-9_`.]+$/.test(value)) {
    throw new Error('Invalid Finance category column');
  }
  return value;
};

const socialCategoryList = SOCIAL_INCOME_CATEGORIES
  .map((category) => `'${category.replace(/'/g, "''")}'`)
  .join(', ');

const socialIncomePredicate = (column = 'NATURE_RECETTE') => {
  const safeColumn = validateColumn(column);
  return `UPPER(TRIM(${safeColumn})) IN (${socialCategoryList})`;
};

const nonSocialIncomePredicate = (column = 'NATURE_RECETTE') => {
  const safeColumn = validateColumn(column);
  return `(${safeColumn} IS NULL OR NOT (${socialIncomePredicate(safeColumn)}))`;
};

module.exports = {
  SOCIAL_INCOME_CATEGORIES,
  socialIncomePredicate,
  nonSocialIncomePredicate,
};
