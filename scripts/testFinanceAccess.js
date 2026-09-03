const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  PERMISSIONS,
  defaultPermissionsForRole,
  normalizeExplicitPermissions,
  hasFinancePermissionConfiguration,
  permissionsForAccount,
  permissionsForUser,
  createFinanceAuthorizationMiddleware
} = require('../financeAccess');

const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  }
});

const runMiddleware = (permission, user) => {
  const response = createResponse();
  let nextCalled = false;
  createFinanceAuthorizationMiddleware(permission)(
    { user },
    response,
    () => { nextCalled = true; }
  );
  return { response, nextCalled };
};

const run = () => {
  const founder = defaultPermissionsForRole('Membre fondateur');
  assert(founder.includes(PERMISSIONS.READ));
  assert(founder.includes(PERMISSIONS.WRITE));
  assert(founder.includes(PERMISSIONS.SOCIAL_READ));
  assert(founder.includes(PERMISSIONS.REAL_ESTATE_READ));
  assert(founder.includes(PERMISSIONS.REAL_ESTATE_WRITE));

  assert.deepEqual(defaultPermissionsForRole('Utilisateur'), [PERMISSIONS.READ]);
  assert(defaultPermissionsForRole('Admin Finance').includes(PERMISSIONS.REAL_ESTATE_WRITE));

  assert.deepEqual(normalizeExplicitPermissions(['Read Finance', 'Update Finance']), [
    PERMISSIONS.READ,
    PERMISSIONS.WRITE
  ]);
  assert.deepEqual(permissionsForAccount({ role: 'Membre fondateur', permissions: [PERMISSIONS.READ] }), [PERMISSIONS.READ]);
  assert.deepEqual(
    permissionsForAccount({ role: 'Membre fondateur', permissions: ['administration:resources:read'] }),
    founder
  );
  assert.deepEqual(permissionsForAccount({ role: 'Membre fondateur', financePermissions: [] }), []);
  assert.equal(hasFinancePermissionConfiguration({ permissions: ['administration:resources:read'] }), false);
  assert.equal(hasFinancePermissionConfiguration({ permissions: ['Read Finance'] }), true);
  assert.equal(hasFinancePermissionConfiguration({ financePermissions: [] }), true);

  // Existing tokens do not carry permissionsExplicit. Role defaults keep them usable.
  assert(permissionsForUser({ role: 'Membre fondateur', permissions: [] }).includes(PERMISSIONS.WRITE));
  // New explicit configurations remain authoritative and can deliberately deny write access.
  assert.deepEqual(permissionsForUser({ role: 'Membre fondateur', financePermissionsExplicit: true, permissions: [PERMISSIONS.READ] }), [PERMISSIONS.READ]);

  const unauthenticated = runMiddleware(PERMISSIONS.READ, null);
  assert.equal(unauthenticated.response.statusCode, 401);
  assert.equal(unauthenticated.nextCalled, false);

  const reader = { id: 'USR-1', tenantId: '2sg', role: 'Utilisateur', permissions: [PERMISSIONS.READ], financePermissionsExplicit: true };
  const allowedRead = runMiddleware(PERMISSIONS.READ, reader);
  assert.equal(allowedRead.nextCalled, true);

  const forbiddenWrite = runMiddleware(PERMISSIONS.WRITE, reader);
  assert.equal(forbiddenWrite.response.statusCode, 403);
  assert.equal(forbiddenWrite.response.body.code, 'FINANCE_FORBIDDEN');

  const financeOwner = { id: 'USR-2', tenantId: '2sg', role: 'Admin Finance', permissions: [], financePermissionsExplicit: false };
  assert.equal(runMiddleware(PERMISSIONS.REAL_ESTATE_READ, financeOwner).nextCalled, true);
  assert.equal(runMiddleware(PERMISSIONS.REAL_ESTATE_WRITE, financeOwner).nextCalled, true);

  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const financeRoutes = [...serverSource.matchAll(
    /app\.(get|post|put|delete)\('([^']*\/api\/finance\/[^']*)',\s*([A-Za-z0-9_.]+)/g
  )].map(match => ({ method: match[1], route: match[2], guard: match[3] }));
  assert.equal(financeRoutes.length, 19);
  const expectedGuards = new Map([
    ['get /api/finance/budget-drafts/capabilities', 'budgetDraftHandlers.capabilities'],
    ['get /api/finance/budget-drafts', 'budgetDraftHandlers.list'],
    ['get /api/finance/budget-drafts/:id', 'budgetDraftHandlers.get'],
    ['post /api/finance/budget-drafts', 'budgetDraftHandlers.create'],
    ['put /api/finance/budget-drafts/:id', 'budgetDraftHandlers.update'],
    ['get /api/finance/expenses', 'requireFinanceRead'],
    ['get /api/finance/income', 'requireFinanceRead'],
    ['get /api/finance/social', 'requireFinanceSocialRead'],
    ['post /api/finance/expenses', 'requireFinanceWrite'],
    ['put /api/finance/expenses/:id', 'requireFinanceWrite'],
    ['delete /api/finance/expenses/:id', 'requireFinanceWrite'],
    ['post /api/finance/income', 'requireFinanceWrite'],
    ['put /api/finance/income/:id', 'requireFinanceWrite'],
    ['delete /api/finance/income/:id', 'requireFinanceWrite'],
    ['get /api/finance/real-estate', 'requireFinanceRealEstateRead'],
    ['post /api/finance/real-estate', 'requireFinanceRealEstateWrite'],
    ['put /api/finance/real-estate/:id', 'requireFinanceRealEstateWrite'],
    ['delete /api/finance/real-estate/:id', 'requireFinanceRealEstateWrite'],
    ['get /api/finance/dashboard', 'requireFinanceRead']
  ]);
  financeRoutes.forEach(({ method, route, guard }) => {
    assert.equal(guard, expectedGuards.get(`${method} ${route}`), `Unexpected guard for ${method.toUpperCase()} ${route}`);
  });
  const budgetGuard = serverSource.indexOf("app.use('/api/finance/budget-drafts', authenticateRequest, requireCurrentBudgetAccount)");
  assert(budgetGuard >= 0, 'Budget must not inherit the optional legacy Finance authentication');
  financeRoutes.filter(({ route }) => route.includes('/budget-drafts')).forEach(({ method, route }) => {
    assert(serverSource.indexOf(`app.${method}('${route}'`) > budgetGuard, 'Budget authentication must precede its routes');
  });

  console.log('Finance access tests passed');
};

run();
