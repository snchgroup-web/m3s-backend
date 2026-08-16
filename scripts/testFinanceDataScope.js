const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  SOCIAL_INCOME_CATEGORIES,
  socialIncomePredicate,
  nonSocialIncomePredicate,
} = require('../financeDataScope');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

assert.deepStrictEqual(SOCIAL_INCOME_CATEGORIES, [
  'AIDE SOCIALE MENAGE',
  'AIDE SOCIALE M\u00C9NAGE',
  'AIDE SOCIALE',
]);
assert.match(socialIncomePredicate(), /^UPPER\(TRIM\(NATURE_RECETTE\)\) IN /);
assert.match(nonSocialIncomePredicate(), /^\(NATURE_RECETTE IS NULL OR NOT \(UPPER/);
assert.throws(() => socialIncomePredicate('NATURE_RECETTE; DROP TABLE income'));

const incomeRoute = serverSource.slice(
  serverSource.indexOf("app.get('/api/finance/income'"),
  serverSource.indexOf("app.get('/api/finance/social'")
);
const socialRoute = serverSource.slice(
  serverSource.indexOf("app.get('/api/finance/social'"),
  serverSource.indexOf('const numberOrZero')
);
const dashboardRoute = serverSource.slice(
  serverSource.indexOf("app.get('/api/finance/dashboard'"),
  serverSource.indexOf('// API ROUTES - DOCUMENTS')
);

assert.ok(incomeRoute.includes('WHERE ${nonSocialIncomeWhere}'), 'Generic income must exclude social rows');
assert.ok(socialRoute.includes('WHERE ${socialIncomeWhere}'), 'Social route must use the governed social scope');
assert.ok(dashboardRoute.includes('WHERE ${nonSocialIncomeWhere}'), 'Dashboard income totals must exclude social rows');

console.log('Finance data scope tests passed.');
