'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const SECRET = 'auth-middleware-runtime-test-secret';
process.env.JWT_SECRET = SECRET;
process.env.NODE_ENV = 'test';

let dbRows = [];
let dbError = null;
let queryCount = 0;

const poolMock = {
  async query(sql, params) {
    queryCount += 1;
    if (dbError) throw dbError;
    return { rows: dbRows, rowCount: dbRows.length };
  }
};

const dbPath = require.resolve('../config/db');
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: poolMock
};

const { authMiddleware, authorize } = require('../middleware/authMiddleware');

function makeUser(overrides = {}) {
  return {
    id: 7,
    role: 'manager',
    restaurant_id: 12,
    is_active: true,
    current_session: 'session-abc',
    must_change_password: false,
    restaurant_name: 'Test Cafe',
    status: 'Active',
    expiry_date: null,
    ...overrides
  };
}

function makeRequest({ token, method = 'GET', path = '/api/orders', origin, cookie } = {}) {
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  if (cookie) headers.cookie = cookie;
  return {
    headers,
    method,
    originalUrl: path,
    get(name) {
      if (name.toLowerCase() === 'origin') return origin;
      return undefined;
    }
  };
}

function makeResponse() {
  return {
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
  };
}

function tokenFor(payload = {}) {
  return jwt.sign({
    id: 7,
    sessionId: 'session-abc',
    ...payload
  }, SECRET, { expiresIn: '5m' });
}

async function invoke(options = {}) {
  const req = makeRequest(options);
  const res = makeResponse();
  let nextCalled = false;
  await authMiddleware(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

test('runtime auth: missing token returns 401 without querying database', async () => {
  queryCount = 0;
  const result = await invoke();
  assert.equal(result.res.statusCode, 401);
  assert.equal(result.nextCalled, false);
  assert.equal(queryCount, 0);
});

test('runtime auth: malformed token returns 401', async () => {
  const result = await invoke({ token: 'not-a-valid-jwt' });
  assert.equal(result.res.statusCode, 401);
  assert.equal(result.nextCalled, false);
});

test('runtime auth: JWT without user ID or session ID is rejected before database lookup', async () => {
  queryCount = 0;
  const result = await invoke({ token: jwt.sign({ id: 7 }, SECRET) });
  assert.equal(result.res.statusCode, 401);
  assert.equal(result.res.body.message, 'Invalid session token');
  assert.equal(queryCount, 0);
});

test('runtime auth: token for deleted user returns 401', async () => {
  dbRows = [];
  const result = await invoke({ token: tokenFor() });
  assert.equal(result.res.statusCode, 401);
  assert.equal(result.res.body.message, 'User not found');
  assert.equal(result.nextCalled, false);
});

test('runtime auth: inactive user returns 403', async () => {
  dbRows = [makeUser({ is_active: false })];
  const result = await invoke({ token: tokenFor() });
  assert.equal(result.res.statusCode, 403);
  assert.equal(result.res.body.message, 'User account disabled');
  assert.equal(result.nextCalled, false);
});

test('runtime auth: stale session ID returns 401', async () => {
  dbRows = [makeUser({ current_session: 'newer-session' })];
  const result = await invoke({ token: tokenFor() });
  assert.equal(result.res.statusCode, 401);
  assert.match(result.res.body.message, /Session expired/);
  assert.equal(result.nextCalled, false);
});

test('runtime auth: suspended restaurant blocks non-super-admin', async () => {
  dbRows = [makeUser({ status: 'Suspended' })];
  const result = await invoke({ token: tokenFor() });
  assert.equal(result.res.statusCode, 403);
  assert.equal(result.res.body.message, 'Restaurant suspended');
});

test('runtime auth: expired restaurant subscription blocks non-super-admin', async () => {
  dbRows = [makeUser({ expiry_date: '2000-01-01T00:00:00.000Z' })];
  const result = await invoke({ token: tokenFor() });
  assert.equal(result.res.statusCode, 403);
  assert.equal(result.res.body.message, 'Restaurant subscription expired');
});

test('runtime auth: valid user receives only safe identity fields and reaches next', async () => {
  dbRows = [makeUser({ password: 'should-not-be-copied', password_hash: 'hash-secret' })];
  const result = await invoke({ token: tokenFor() });
  assert.equal(result.res.statusCode, 200);
  assert.equal(result.nextCalled, true);
  assert.deepEqual(result.req.user, {
    id: 7,
    role: 'manager',
    restaurant_id: 12,
    must_change_password: false
  });
  assert.equal('password' in result.req.user, false);
  assert.equal('password_hash' in result.req.user, false);
  assert.equal(result.req.authSessionId, 'session-abc');
});

test('runtime auth: first-password endpoint is allowed while password change is required', async () => {
  dbRows = [makeUser({ must_change_password: true })];
  const result = await invoke({
    token: tokenFor(),
    method: 'POST',
    path: '/api/auth/first-password'
  });
  assert.equal(result.nextCalled, true);
  assert.equal(result.res.statusCode, 200);
});

test('runtime auth: ordinary API request is blocked until initial password changes', async () => {
  dbRows = [makeUser({ must_change_password: true })];
  const result = await invoke({
    token: tokenFor(),
    method: 'GET',
    path: '/api/orders'
  });
  assert.equal(result.res.statusCode, 403);
  assert.equal(result.res.body.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal(result.nextCalled, false);
});

test('runtime auth: logout remains allowed while password change is required', async () => {
  dbRows = [makeUser({ must_change_password: true })];
  const result = await invoke({
    token: tokenFor(),
    method: 'POST',
    path: '/api/auth/logout'
  });
  assert.equal(result.nextCalled, true);
});

test('runtime auth: cookie-authenticated write without origin is rejected', async () => {
  queryCount = 0;
  const result = await invoke({
    cookie: 'sizlio_session=' + encodeURIComponent(tokenFor()),
    method: 'POST',
    path: '/api/orders'
  });
  assert.equal(result.res.statusCode, 403);
  assert.equal(result.res.body.message, 'Request origin rejected');
  assert.equal(queryCount, 0);
});

test('runtime auth: cookie-authenticated write from an untrusted origin is rejected', async () => {
  queryCount = 0;
  const result = await invoke({
    cookie: 'sizlio_session=' + encodeURIComponent(tokenFor()),
    method: 'POST',
    path: '/api/orders',
    origin: 'https://evil.example'
  });
  assert.equal(result.res.statusCode, 403);
  assert.equal(queryCount, 0);
});

test('runtime auth: cookie-authenticated write from Sizlio origin reaches session validation', async () => {
  dbRows = [makeUser()];
  const result = await invoke({
    cookie: 'sizlio_session=' + encodeURIComponent(tokenFor()),
    method: 'POST',
    path: '/api/orders',
    origin: 'https://sizlio.com'
  });
  assert.equal(result.nextCalled, true);
  assert.equal(result.res.statusCode, 200);
});

test('runtime auth: cookie-authenticated GET does not require an Origin header', async () => {
  dbRows = [makeUser()];
  const result = await invoke({
    cookie: 'sizlio_session=' + encodeURIComponent(tokenFor()),
    method: 'GET',
    path: '/api/orders'
  });
  assert.equal(result.nextCalled, true);
});

test('runtime auth: super-admin is not blocked by restaurant suspension or expiry', async () => {
  dbRows = [makeUser({
    role: 'super_admin',
    restaurant_id: null,
    status: 'Suspended',
    expiry_date: '2000-01-01T00:00:00.000Z'
  })];
  const result = await invoke({ token: tokenFor() });
  assert.equal(result.nextCalled, true);
  assert.equal(result.res.statusCode, 200);
});

test('runtime auth: database errors fail closed with 401', async () => {
  dbError = new Error('database unavailable');
  try {
    const result = await invoke({ token: tokenFor() });
    assert.equal(result.res.statusCode, 401);
    assert.equal(result.nextCalled, false);
  } finally {
    dbError = null;
  }
});


// BATCH ROLE AUTHORIZATION MATRIX.
// Exercises the actual exported authorize middleware, not source-code regexes.
// Each case invokes middleware and verifies the HTTP authorization decision.
const testedRoles = [
  'super_admin',
  'manager',
  'counter',
  'waiter',
  'kitchen',
  'delivery',
  'display',
  'unknown_role'
];

const endpointPolicies = [
  { name: 'manager only', roles: ['manager'] },
  { name: 'super admin only', roles: ['super_admin'] },
  { name: 'manager and counter', roles: ['manager', 'counter'] },
  { name: 'manager waiter counter', roles: ['manager', 'waiter', 'counter'] },
  { name: 'manager kitchen counter', roles: ['manager', 'kitchen', 'counter'] },
  { name: 'delivery manager counter', roles: ['delivery', 'manager', 'counter'] },
  { name: 'delivery only', roles: ['delivery'] },
  { name: 'waiter and manager', roles: ['waiter', 'manager'] },
  { name: 'waiter kitchen manager', roles: ['waiter', 'kitchen', 'manager'] },
  { name: 'manager counter waiter kitchen', roles: ['manager', 'counter', 'waiter', 'kitchen'] },
  { name: 'manager counter display', roles: ['manager', 'counter', 'display'] },
  { name: 'manager super admin', roles: ['manager', 'super_admin'] },
  { name: 'manager counter delivery', roles: ['manager', 'counter', 'delivery'] },
  { name: 'manager waiter kitchen counter delivery', roles: ['manager', 'waiter', 'kitchen', 'counter', 'delivery'] },
  { name: 'all standard POS roles', roles: ['manager', 'counter', 'waiter', 'kitchen', 'delivery', 'display'] },
  { name: 'waiter counter', roles: ['waiter', 'counter'] }
];

for (const policy of endpointPolicies) {
  for (const role of testedRoles) {
    test('runtime authorization matrix: ' + policy.name + ' / role=' + role, () => {
      const req = { user: { role } };
      const res = {
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
      };
      let nextCalled = false;
      authorize(...policy.roles)(req, res, () => { nextCalled = true; });

      if (policy.roles.includes(role)) {
        assert.equal(nextCalled, true, 'allowed role must reach next()');
        assert.equal(res.statusCode, 200);
        assert.equal(res.body, null);
      } else {
        assert.equal(nextCalled, false, 'disallowed role must not reach next()');
        assert.equal(res.statusCode, 403);
        assert.equal(res.body.success, false);
        assert.equal(res.body.message, 'Access denied');
      }
    });
  }
}

test('runtime authorization: role matching is case-sensitive and fails closed', () => {
  const req = { user: { role: 'Manager' } };
  const res = makeResponse();
  let nextCalled = false;
  authorize('manager')(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('runtime authorization: missing user is denied instead of throwing', () => {
  const req = {};
  const res = makeResponse();
  let nextCalled = false;
  assert.doesNotThrow(() => authorize('manager')(req, res, () => { nextCalled = true; }));
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('runtime authorization: empty allowlist denies every tested role', () => {
  for (const role of testedRoles) {
    const req = { user: { role } };
    const res = makeResponse();
    let nextCalled = false;
    authorize()(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  }
});


test('runtime authorization: null user is denied without throwing', () => {
  const req = { user: null };
  const res = makeResponse();
  let nextCalled = false;
  assert.doesNotThrow(() => authorize('manager')(req, res, () => { nextCalled = true; }));
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.message, 'Access denied');
});

test('runtime authorization: missing or non-string role is denied without throwing', () => {
  for (const user of [{}, { role: null }, { role: 123 }]) {
    const req = { user };
    const res = makeResponse();
    let nextCalled = false;
    assert.doesNotThrow(() => authorize('manager')(req, res, () => { nextCalled = true; }));
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.message, 'Access denied');
  }
});


// Extended runtime matrix: cookie-origin protection across HTTP methods and
// origin edge cases. These invoke authMiddleware with a real signed JWT and DB mock.
const originMatrixMethods = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE', 'TRACE'];
const originMatrixOrigins = [
  undefined,
  '',
  'https://sizlio.com',
  'https://www.sizlio.com',
  'https://evil.example',
  'http://sizlio.com',
  'https://sizlio.com.evil.example',
  'https://sizlio.com/',
  'null',
  'https://SIZLIO.com'
];

for (const method of originMatrixMethods) {
  for (const origin of originMatrixOrigins) {
    test('runtime auth origin matrix: method=' + method + ' origin=' + String(origin), async () => {
      dbError = null;
      dbRows = [makeUser()];
      queryCount = 0;
      const result = await invoke({
        cookie: 'sizlio_session=' + encodeURIComponent(tokenFor()),
        method,
        path: '/api/orders',
        origin
      });
      const safeMethod = ['GET', 'HEAD', 'OPTIONS'].includes(method);
      const trustedOrigin = origin === 'https://sizlio.com' || origin === 'https://www.sizlio.com';
      const expectedAllowed = safeMethod || trustedOrigin;
      assert.equal(result.nextCalled, expectedAllowed);
      if (expectedAllowed) {
        assert.equal(result.res.statusCode, 200);
        assert.equal(queryCount, 1);
      } else {
        assert.equal(result.res.statusCode, 403);
        assert.equal(result.res.body.message, 'Request origin rejected');
        assert.equal(queryCount, 0, 'reject origin before database access');
      }
    });
  }
}

// Extended runtime matrix: first-password gate must permit only the exact
// approved POST endpoints while rejecting all other method/path combinations.
const passwordGateMethods = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE', 'TRACE'];
const passwordGatePaths = [
  '/api/orders',
  '/api/auth/first-password',
  '/api/auth/first-password/',
  '/api/auth/first-password?next=/api/orders',
  '/api/auth/logout',
  '/api/auth/logout/',
  '/api/auth/login',
  '/api/auth/first-password/reset'
];

for (const method of passwordGateMethods) {
  for (const path of passwordGatePaths) {
    test('runtime auth password gate matrix: method=' + method + ' path=' + path, async () => {
      dbError = null;
      dbRows = [makeUser({ must_change_password: true })];
      const result = await invoke({ token: tokenFor(), method, path });
      const normalizedPath = path.split('?')[0];
      const allowed =
        method === 'POST' &&
        (normalizedPath === '/api/auth/first-password' || normalizedPath === '/api/auth/logout');
      assert.equal(result.nextCalled, allowed);
      if (allowed) {
        assert.equal(result.res.statusCode, 200);
      } else {
        assert.equal(result.res.statusCode, 403);
        assert.equal(result.res.body.code, 'PASSWORD_CHANGE_REQUIRED');
      }
    });
  }
}


// BATCH 2: deeper runtime authentication state matrices. These tests execute
// authMiddleware and assert status/next behavior against controlled DB rows.
const accountActiveValues = [true, false, 0, 1, null];
for (const role of testedRoles) {
  for (const isActive of accountActiveValues) {
    test('runtime account-state matrix: role=' + role + ' is_active=' + String(isActive), async () => {
      dbError = null;
      dbRows = [makeUser({ role, is_active: isActive, status: 'Active', expiry_date: null })];
      const result = await invoke({ token: tokenFor() });
      const expectedAllowed = Boolean(isActive);
      assert.equal(result.nextCalled, expectedAllowed);
      assert.equal(result.res.statusCode, expectedAllowed ? 200 : 403);
      if (!expectedAllowed) assert.equal(result.res.body.message, 'User account disabled');
    });
  }
}

const restaurantStatuses = [undefined, null, '', 'Active', 'active', 'Suspended', 0, true];
for (const role of testedRoles) {
  for (const status of restaurantStatuses) {
    test('runtime restaurant-status matrix: role=' + role + ' status=' + String(status), async () => {
      dbError = null;
      dbRows = [makeUser({ role, is_active: true, status, expiry_date: null })];
      const result = await invoke({ token: tokenFor() });
      const expectedAllowed = role === 'super_admin' || status === 'Active';
      assert.equal(result.nextCalled, expectedAllowed);
      assert.equal(result.res.statusCode, expectedAllowed ? 200 : 403);
      if (!expectedAllowed) assert.equal(result.res.body.message, 'Restaurant suspended');
    });
  }
}

const expiryValues = [
  null,
  undefined,
  '',
  '2000-01-01T00:00:00.000Z',
  '2999-01-01T00:00:00.000Z',
  'not-a-valid-date',
  0,
  false
];
for (const role of testedRoles) {
  for (const expiryDate of expiryValues) {
    test('runtime subscription-expiry matrix: role=' + role + ' expiry=' + String(expiryDate), async () => {
      dbError = null;
      dbRows = [makeUser({ role, is_active: true, status: 'Active', expiry_date: expiryDate })];
      const result = await invoke({ token: tokenFor() });
      const isExpired = Boolean(expiryDate) && new Date(expiryDate) < new Date();
      const expectedAllowed = role === 'super_admin' || !isExpired;
      assert.equal(result.nextCalled, expectedAllowed);
      assert.equal(result.res.statusCode, expectedAllowed ? 200 : 403);
      if (!expectedAllowed) assert.equal(result.res.body.message, 'Restaurant subscription expired');
    });
  }
}

const dbSessionValues = [undefined, null, '', 'session-abc', 'other-session', 0, 123, ' '];
const jwtSessionValues = ['session-abc', 'other-session', '0', ' '];
for (const currentSession of dbSessionValues) {
  for (const jwtSession of jwtSessionValues) {
    test('runtime session matrix: DB session=' + String(currentSession) + ' JWT session=' + jwtSession, async () => {
      dbError = null;
      dbRows = [makeUser({ current_session: currentSession })];
      const result = await invoke({ token: tokenFor({ sessionId: jwtSession }) });
      const expectedAllowed = Boolean(currentSession) && currentSession === jwtSession;
      assert.equal(result.nextCalled, expectedAllowed);
      assert.equal(result.res.statusCode, expectedAllowed ? 200 : 401);
      if (!expectedAllowed) assert.match(result.res.body.message, /Session expired/);
    });
  }
}

const jwtIdValues = [7, 0, null, '', '7', -1, {}, []];
for (const jwtId of jwtIdValues) {
  for (const jwtSession of jwtSessionValues) {
    test('runtime JWT identity-claim matrix: id=' + String(jwtId) + ' session=' + jwtSession, async () => {
      dbError = null;
      queryCount = 0;
      dbRows = [makeUser()];
      const result = await invoke({ token: tokenFor({ id: jwtId, sessionId: jwtSession }) });
      const validIdClaim =
        (typeof jwtId === 'number' && Number.isSafeInteger(jwtId) && jwtId > 0) ||
        (typeof jwtId === 'string' && /^[1-9][0-9]*$/.test(jwtId));
      const validSession = jwtSession === 'session-abc';
      assert.equal(result.nextCalled, validIdClaim && validSession);
      assert.equal(result.res.statusCode, validIdClaim && validSession ? 200 : 401);
      assert.equal(queryCount, validIdClaim ? 1 : 0);
      if (!validIdClaim) assert.equal(result.res.body.message, 'Invalid session token');
      else if (!validSession) assert.match(result.res.body.message, /Session expired/);
    });
  }
}


// BATCH 3: 200 runtime credential-precedence and cookie-parser cases.
// Each combination invokes the real auth middleware with a valid DB user.
const credentialMatrixToken = tokenFor();
const credentialHeaders = [
  undefined,
  '',
  'Bearer ' + credentialMatrixToken,
  'Bearer  ' + credentialMatrixToken,
  'Bearer ' + credentialMatrixToken + ' ',
  'bearer ' + credentialMatrixToken,
  'BEARER ' + credentialMatrixToken,
  'Basic ' + credentialMatrixToken,
  'Token ' + credentialMatrixToken,
  credentialMatrixToken,
  'Bearer',
  'Bearer ',
  'Bearer invalid',
  'Bearer invalid.token.value',
  'Bearer ' + credentialMatrixToken + '.tampered',
  'Bearer\t' + credentialMatrixToken,
  ' Bearer ' + credentialMatrixToken,
  'Bearer ' + credentialMatrixToken + ' extra',
  'Basic abc',
  'Digest abc',
  'Bearer null',
  'Bearer undefined',
  'Bearer 0',
  'Bearer %' + credentialMatrixToken,
  'Bearer ' + credentialMatrixToken.toUpperCase()
];
const credentialCookies = [
  null,
  'sizlio_session=' + credentialMatrixToken,
  'sizlio_session=' + encodeURIComponent(credentialMatrixToken),
  'other_cookie=abc',
  'sizlio_session=bad',
  'sizlio_session=',
  'sizlio_session=%E0%A4%A',
  'sizlio_session=bad; sizlio_session=' + credentialMatrixToken
];

for (const authHeader of credentialHeaders) {
  for (const cookieHeader of credentialCookies) {
    test('runtime credential precedence matrix: auth=' + String(authHeader).slice(0, 26) + ' cookie=' + String(cookieHeader).slice(0, 24), async () => {
      dbError = null;
      dbRows = [makeUser()];
      queryCount = 0;
      const headers = {};
      if (authHeader !== undefined) headers.authorization = authHeader;
      if (cookieHeader !== null) headers.cookie = cookieHeader;
      let malformedCookie = false;
      let cookieToken = null;
      try {
        cookieToken = (cookieHeader || '')
          .split(';')
          .map(part => part.trim())
          .filter(part => part.startsWith('sizlio_session='))
          .map(part => decodeURIComponent(part.slice('sizlio_session='.length)))[0] || null;
      } catch {
        malformedCookie = true;
      }
      const bearerToken = authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : null;
      const selectedToken = cookieToken || bearerToken;
      const expectedAllowed = !malformedCookie && selectedToken === credentialMatrixToken;
      const req = {
        headers,
        method: 'GET',
        originalUrl: '/api/orders',
        get() { return undefined; }
      };
      const res = makeResponse();
      let nextCalled = false;
      await authMiddleware(req, res, () => { nextCalled = true; });
      assert.equal(nextCalled, expectedAllowed);
      assert.equal(res.statusCode, expectedAllowed ? 200 : 401);
      assert.equal(queryCount, expectedAllowed ? 1 : 0);
    });
  }
}
