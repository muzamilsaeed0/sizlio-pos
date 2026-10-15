'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'controllers', 'authController.js'),
  'utf8'
);

test('staff login requires explicit matching restaurant and role context after password verification', () => {
  const passwordCheck = source.indexOf('const isMatch = await bcrypt.compare(password, user.password);');
  const contextGuard = source.indexOf('A staff account must not enter through the Super Admin-style');
  const sessionMutation = source.indexOf('SET current_session = $1');

  assert.notEqual(passwordCheck, -1, 'password verification must exist');
  assert.notEqual(contextGuard, -1, 'staff login context guard must exist');
  assert.notEqual(sessionMutation, -1, 'session mutation must exist');
  assert.ok(passwordCheck < contextGuard, 'password must be checked before context validation');
  assert.ok(contextGuard < sessionMutation, 'context validation must happen before creating a session');
  assert.match(source.slice(contextGuard, sessionMutation), /user\.role !== 'super_admin'/);
  assert.match(source.slice(contextGuard, sessionMutation), /!restaurant_id \|\| !role/);
  assert.match(source.slice(contextGuard, sessionMutation), /String\(restaurant_id\) !== String\(user\.restaurant_id\)/);
  assert.match(source.slice(contextGuard, sessionMutation), /message: 'Invalid username or password'/);
});
