const assert = require('assert');
const {
  isDebugRoleAllowed,
  createDebugAccessMiddleware,
  createDebugSampleGuard
} = require('../debugAccess');

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

const run = () => {
  assert.equal(isDebugRoleAllowed('Membre fondateur'), true);
  assert.equal(isDebugRoleAllowed('Administrateur'), true);
  assert.equal(isDebugRoleAllowed('Manager'), true);
  assert.equal(isDebugRoleAllowed('Utilisateur'), false);
  assert.equal(isDebugRoleAllowed('Organisation & RH'), false);

  let nextCalls = 0;
  const authenticateRequest = (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false });
    return next();
  };
  const middleware = createDebugAccessMiddleware(authenticateRequest);

  const anonymousResponse = createResponse();
  middleware({}, anonymousResponse, () => { nextCalls += 1; });
  assert.equal(anonymousResponse.statusCode, 401);
  assert.equal(nextCalls, 0);

  const userResponse = createResponse();
  middleware({ user: { role: 'Utilisateur' } }, userResponse, () => { nextCalls += 1; });
  assert.equal(userResponse.statusCode, 403);
  assert.equal(userResponse.body.code, 'DEBUG_ACCESS_FORBIDDEN');
  assert.equal(nextCalls, 0);

  const founderResponse = createResponse();
  middleware({ user: { role: 'Membre fondateur' } }, founderResponse, () => { nextCalls += 1; });
  assert.equal(founderResponse.statusCode, 200);
  assert.equal(nextCalls, 1);

  const productionResponse = createResponse();
  createDebugSampleGuard('production')({}, productionResponse, () => { nextCalls += 1; });
  assert.equal(productionResponse.statusCode, 404);
  assert.equal(productionResponse.body.code, 'DEBUG_SAMPLE_DISABLED');
  assert.equal(nextCalls, 1);

  const developmentResponse = createResponse();
  createDebugSampleGuard('development')({}, developmentResponse, () => { nextCalls += 1; });
  assert.equal(developmentResponse.statusCode, 200);
  assert.equal(nextCalls, 2);

  console.log('Debug access policy tests: OK');
};

run();
