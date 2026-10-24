import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isApiPath, SPA_PATHS } from '../src/routes.ts';
import { blobKey } from '../src/server.ts';
import {
  create,
  fromBinary,
  merkle,
  MessageEnvelopeSchema,
  MessageSchema,
  SyncRequestSchema,
  SyncResponseSchema,
  Timestamp,
  toBinary,
} from '../src/vendor/crdt/index.ts';

import { makeServer } from './harness.ts';

const PASSWORD = 'correct horse battery staple';

async function setup() {
  const s = makeServer();
  const res = await s.call('POST', '/account/bootstrap', { json: { password: PASSWORD } });
  assert.equal(res.status, 200);
  const { data } = await res.json();
  return { ...s, token: data.token as string };
}

function makeMessage(millis: number, node: string, value: string) {
  const timestamp = new Timestamp(millis, 0, node).toString();
  const content = toBinary(
    MessageSchema,
    create(MessageSchema, { dataset: 'transactions', row: 'row-1', column: 'notes', value }),
  );
  return create(MessageEnvelopeSchema, { timestamp, isEncrypted: false, content });
}

async function sync(
  call: ReturnType<typeof makeServer>['call'],
  token: string,
  req: { fileId: string; groupId: string; keyId?: string; since: string; messages: any[] },
) {
  const body = toBinary(SyncRequestSchema, create(SyncRequestSchema, req));
  return call('POST', '/sync/sync', {
    body,
    headers: { 'x-actual-token': token, 'content-type': 'application/actual-sync' },
  });
}

async function upload(
  call: ReturnType<typeof makeServer>['call'],
  token: string,
  fileId: string,
  content: Uint8Array,
  extra: Record<string, string> = {},
) {
  return call('POST', '/sync/upload-user-file', {
    body: content,
    headers: {
      'content-type': 'application/encrypted-file',
      'x-actual-token': token,
      'x-actual-file-id': fileId,
      'x-actual-name': encodeURIComponent('My Budget ✓'),
      'x-actual-format': '2',
      ...extra,
    },
  });
}

test('fresh server reports it needs a password', async () => {
  const { call } = makeServer();
  const res = await call('GET', '/account/needs-bootstrap');
  assert.deepEqual(await res.json(), {
    status: 'ok',
    data: { bootstrapped: false, loginMethod: 'password', availableLoginMethods: [], multiuser: false },
  });
});

test('bootstrap, login, validate and logout', async () => {
  const { call, token } = await setup();

  const boot = await call('GET', '/account/needs-bootstrap');
  const bootData = (await boot.json()).data;
  assert.equal(bootData.bootstrapped, true);
  assert.equal(bootData.loginMethod, 'password');

  const again = await call('POST', '/account/bootstrap', { json: { password: 'x' } });
  assert.equal(again.status, 400);
  assert.deepEqual(await again.json(), { status: 'error', reason: 'already-bootstrapped' });

  const bad = await call('POST', '/account/login', { json: { password: 'wrong' } });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { status: 'error', reason: 'invalid-password' });

  const login = await call('POST', '/account/login', { json: { password: PASSWORD } });
  const loginToken = (await login.json()).data.token;
  assert.ok(loginToken && loginToken !== token);

  const validate = await call('GET', '/account/validate', {
    headers: { 'x-actual-token': loginToken },
  });
  const v = await validate.json();
  assert.equal(v.status, 'ok');
  assert.equal(v.data.validated, true);
  assert.equal(v.data.permission, 'ADMIN');
  assert.equal(v.data.loginMethod, 'password');

  await call('POST', '/account/logout', { json: { token: loginToken } });
  const after = await call('GET', '/account/validate', {
    headers: { 'x-actual-token': loginToken },
  });
  assert.equal(after.status, 401);

  // Like upstream, only owners with a user name count: none on a password-only server.
  const owner = await call('GET', '/admin/owner-created/');
  assert.equal(await owner.json(), false);
});

test('login is rate limited after 5 failures', async () => {
  const { call } = await setup();
  for (let i = 0; i < 5; i++) {
    const r = await call('POST', '/account/login', { json: { password: 'nope' }, ip: '198.51.100.7' });
    assert.equal(r.status, 400);
  }
  const blocked = await call('POST', '/account/login', {
    json: { password: PASSWORD },
    ip: '198.51.100.7',
  });
  assert.equal(blocked.status, 429);

  const otherClient = await call('POST', '/account/login', {
    json: { password: PASSWORD },
    ip: '198.51.100.8',
  });
  assert.equal(otherClient.status, 200);
});

test('parallel bad logins are limited before the password checks finish', async () => {
  const { call } = await setup();
  const ip = '198.51.100.20';
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      call('POST', '/account/login', { json: { password: 'nope' }, ip }),
    ),
  );
  const limited = results.filter(r => r.status === 429);
  assert.ok(limited.length >= 15, `only ${limited.length} requests were limited`);
  assert.ok(limited[0].headers.get('retry-after'));
  assert.deepEqual(await limited[0].json(), { status: 'error', reason: 'too-many-requests' });

  const blocked = await call('POST', '/account/login', { json: { password: PASSWORD }, ip });
  assert.equal(blocked.status, 429);

  const other = await call('POST', '/account/login', {
    json: { password: PASSWORD },
    ip: '198.51.100.21',
  });
  assert.equal(other.status, 200);
});

test('successful logins do not count towards the limit, and old windows are cleaned up', async () => {
  const { call, sql } = await setup();
  const ip = '198.51.100.30';
  for (let i = 0; i < 8; i++) {
    const ok = await call('POST', '/account/login', { json: { password: PASSWORD }, ip });
    assert.equal(ok.status, 200);
  }
  assert.equal(sql.first<{ count: number }>('SELECT count FROM auth_failures WHERE client = ?', ip)?.count, 0);

  // An expired window of another client is removed when a new window starts.
  sql.run('INSERT INTO auth_failures (client, count, window_start) VALUES (?, 5, ?)', 'stale', Date.now() - 16 * 60 * 1000);
  await call('POST', '/account/login', { json: { password: 'nope' }, ip: '198.51.100.31' });
  assert.equal(sql.first('SELECT 1 AS x FROM auth_failures WHERE client = ?', 'stale'), null);

  // A client whose window expired starts again from one.
  sql.run('UPDATE auth_failures SET count = 5, window_start = ? WHERE client = ?', Date.now() - 16 * 60 * 1000, ip);
  const again = await call('POST', '/account/login', { json: { password: 'nope' }, ip });
  assert.equal(again.status, 400);
  assert.equal(sql.first<{ count: number }>('SELECT count FROM auth_failures WHERE client = ?', ip)?.count, 1);
});

test('unauthenticated sync requests are rejected', async () => {
  const { call } = await setup();
  const res = await call('GET', '/sync/list-user-files');
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), {
    status: 'error',
    reason: 'unauthorized',
    details: 'token-not-found',
  });
});

test('upload, list, info, download, rename and delete a budget', async () => {
  const { call, token, blobs } = await setup();
  const fileId = crypto.randomUUID();
  const zip = new Uint8Array([80, 75, 3, 4, 1, 2, 3, 4, 5]);

  const up = await upload(call, token, fileId, zip);
  assert.equal(up.status, 200);
  const { status, groupId } = await up.json();
  assert.equal(status, 'ok');
  assert.ok(groupId);
  assert.ok(blobs.files.has(blobKey(fileId)));

  const list = await (await call('GET', '/sync/list-user-files', {
    headers: { 'x-actual-token': token },
  })).json();
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].fileId, fileId);
  assert.equal(list.data[0].name, 'My Budget ✓');
  assert.equal(list.data[0].groupId, groupId);
  assert.equal(list.data[0].deleted, 0);
  assert.equal(list.data[0].usersWithAccess[0].owner, true);

  const info = await (await call('GET', '/sync/get-user-file-info', {
    headers: { 'x-actual-token': token, 'x-actual-file-id': fileId },
  })).json();
  assert.equal(info.data.fileId, fileId);
  assert.equal(info.data.encryptMeta, null);

  const dl = await call('GET', '/sync/download-user-file', {
    headers: { 'x-actual-token': token, 'x-actual-file-id': fileId },
  });
  assert.equal(dl.status, 200);
  assert.deepEqual(new Uint8Array(await dl.arrayBuffer()), zip);

  await call('POST', '/sync/update-user-filename', {
    json: { token, fileId, name: 'Renamed' },
  });
  const renamed = await (await call('GET', '/sync/list-user-files', {
    headers: { 'x-actual-token': token },
  })).json();
  assert.equal(renamed.data[0].name, 'Renamed');

  const del = await call('POST', '/sync/delete-user-file', { json: { token, fileId } });
  assert.equal(del.status, 200);
  const empty = await (await call('GET', '/sync/list-user-files', {
    headers: { 'x-actual-token': token },
  })).json();
  assert.equal(empty.data.length, 0);

  const missing = await call('GET', '/sync/get-user-file-info', {
    headers: { 'x-actual-token': token, 'x-actual-file-id': fileId },
  });
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { status: 'error', reason: 'file-not-found' });
});

test('two devices exchange changes and agree on the merkle trie', async () => {
  const { call, token } = await setup();
  const fileId = crypto.randomUUID();
  const { groupId } = await (await upload(call, token, fileId, new Uint8Array([1]))).json();
  const since = Timestamp.since(new Date(0).toISOString());

  const base = Date.now();
  const fromA = [
    makeMessage(base, '000000000000000a', 'S:groceries'),
    makeMessage(base + 1, '000000000000000a', 'S:rent'),
  ];

  // Device A sends its changes.
  const resA = await sync(call, token, { fileId, groupId, since, messages: fromA });
  assert.equal(resA.status, 200);
  assert.equal(resA.headers.get('content-type'), 'application/actual-sync');
  const decodedA = fromBinary(SyncResponseSchema, new Uint8Array(await resA.arrayBuffer()));
  assert.equal(decodedA.messages.length, 0, 'nothing new for A yet');

  let expected = {};
  for (const m of fromA) expected = merkle.insert(expected, Timestamp.parse(m.timestamp)!);
  expected = merkle.prune(expected);
  assert.deepEqual(JSON.parse(decodedA.merkle), expected);

  // Device B sends one change and receives A's.
  const fromB = [makeMessage(base + 2, '000000000000000b', 'N:42')];
  const resB = await sync(call, token, { fileId, groupId, since, messages: fromB });
  const decodedB = fromBinary(SyncResponseSchema, new Uint8Array(await resB.arrayBuffer()));
  assert.deepEqual(
    decodedB.messages.map(m => m.timestamp),
    fromA.map(m => m.timestamp),
  );
  const content = fromBinary(MessageSchema, decodedB.messages[0].content);
  assert.equal(content.value, 'S:groceries');

  // Re-sending a message already stored must not change anything.
  const resRepeat = await sync(call, token, { fileId, groupId, since, messages: fromB });
  const decodedRepeat = fromBinary(SyncResponseSchema, new Uint8Array(await resRepeat.arrayBuffer()));
  assert.equal(decodedRepeat.messages.length, 3);
  for (const m of fromB) expected = merkle.insert(expected, Timestamp.parse(m.timestamp)!);
  expected = merkle.prune(expected);
  assert.deepEqual(JSON.parse(decodedRepeat.merkle), expected);

  // "since" filters out older messages.
  const resLater = await sync(call, token, {
    fileId,
    groupId,
    since: fromA[1].timestamp,
    messages: [],
  });
  const decodedLater = fromBinary(SyncResponseSchema, new Uint8Array(await resLater.arrayBuffer()));
  assert.deepEqual(decodedLater.messages.map(m => m.timestamp), [fromB[0].timestamp]);
});

test('sync validation errors match the original server', async () => {
  const { call, token } = await setup();
  const fileId = crypto.randomUUID();
  const { groupId } = await (await upload(call, token, fileId, new Uint8Array([1]))).json();
  const since = Timestamp.since(new Date(0).toISOString());

  const noSince = await sync(call, token, { fileId, groupId, since: '', messages: [] });
  assert.equal(noSince.status, 422);

  const wrongGroup = await sync(call, token, { fileId, groupId: 'old-group', since, messages: [] });
  assert.equal(wrongGroup.status, 400);
  assert.equal(await wrongGroup.text(), 'file-has-reset');

  const unknown = await sync(call, token, { fileId: 'does-not-exist', groupId, since, messages: [] });
  assert.equal(unknown.status, 400);
  assert.equal(await unknown.text(), 'file-not-found');

  const oldFormat = crypto.randomUUID();
  await upload(call, token, oldFormat, new Uint8Array([1]), { 'x-actual-format': '1' });
  const old = await sync(call, token, { fileId: oldFormat, groupId, since, messages: [] });
  assert.equal(await old.text(), 'file-old-version');
});

test('end-to-end encryption key setup and reset flow', async () => {
  const { call, token } = await setup();
  const fileId = crypto.randomUUID();
  const { groupId: firstGroup } = await (await upload(call, token, fileId, new Uint8Array([1]))).json();
  const since = Timestamp.since(new Date(0).toISOString());

  // The client resets sync, registers a key, then re-uploads the encrypted file.
  const reset = await call('POST', '/sync/reset-user-file', { json: { token, fileId } });
  assert.equal(reset.status, 200);

  const needsUpload = await sync(call, token, { fileId, groupId: firstGroup, since, messages: [] });
  assert.equal(await needsUpload.text(), 'file-needs-upload');

  const keyId = crypto.randomUUID();
  const created = await call('POST', '/sync/user-create-key', {
    json: { token, fileId, keyId, keySalt: 'salt-123', testContent: '{"value":"x"}' },
  });
  assert.equal(created.status, 200);

  const key = await (await call('POST', '/sync/user-get-key', { json: { token, fileId } })).json();
  assert.deepEqual(key, {
    status: 'ok',
    data: { id: keyId, salt: 'salt-123', test: '{"value":"x"}' },
  });

  const meta = JSON.stringify({ keyId, algorithm: 'aes-256-gcm', iv: 'iv', authTag: 'tag' });

  // Uploading with the wrong key is refused.
  const wrongKey = await upload(call, token, fileId, new Uint8Array([9]), {
    'x-actual-encrypt-meta': JSON.stringify({ keyId: 'other' }),
  });
  assert.equal(await wrongKey.text(), 'file-has-new-key');

  const encrypted = await upload(call, token, fileId, new Uint8Array([7, 7, 7]), {
    'x-actual-encrypt-meta': meta,
  });
  const { groupId: newGroup } = await encrypted.json();
  assert.ok(newGroup && newGroup !== firstGroup);

  const info = await (await call('GET', '/sync/get-user-file-info', {
    headers: { 'x-actual-token': token, 'x-actual-file-id': fileId },
  })).json();
  assert.equal(info.data.encryptMeta.keyId, keyId);

  const list = await (await call('GET', '/sync/list-user-files', {
    headers: { 'x-actual-token': token },
  })).json();
  assert.equal(list.data[0].encryptKeyId, keyId);

  // Syncing without the key id is refused; with it, encrypted messages flow.
  const noKey = await sync(call, token, { fileId, groupId: newGroup, since, messages: [] });
  assert.equal(await noKey.text(), 'file-has-new-key');

  const msg = create(MessageEnvelopeSchema, {
    timestamp: new Timestamp(Date.now(), 0, '000000000000000c').toString(),
    isEncrypted: true,
    content: new Uint8Array([1, 2, 3, 4]),
  });
  const ok = await sync(call, token, { fileId, groupId: newGroup, keyId, since, messages: [msg] });
  assert.equal(ok.status, 200);
  const other = await sync(call, token, { fileId, groupId: newGroup, keyId, since, messages: [] });
  const decoded = fromBinary(SyncResponseSchema, new Uint8Array(await other.arrayBuffer()));
  assert.equal(decoded.messages.length, 1);
  assert.equal(decoded.messages[0].isEncrypted, true);
  assert.deepEqual(decoded.messages[0].content, new Uint8Array([1, 2, 3, 4]));
});

test('changing the password signs out existing sessions', async () => {
  const { call, token } = await setup();
  const wrong = await call('POST', '/account/change-password', {
    json: { token, currentPassword: 'nope', password: 'new-password' },
  });
  assert.equal(wrong.status, 400);

  const ok = await call('POST', '/account/change-password', {
    json: { token, currentPassword: PASSWORD, password: 'new-password' },
  });
  assert.equal(ok.status, 200);

  const old = await call('GET', '/account/validate', { headers: { 'x-actual-token': token } });
  assert.equal(old.status, 401);

  const login = await call('POST', '/account/login', { json: { password: 'new-password' } });
  assert.equal(login.status, 200);
});

test('server prefs are saved and returned by validate', async () => {
  const { call, token } = await setup();
  await call('POST', '/account/server-prefs', {
    json: { token, prefs: { 'flags.plugins': 'true' } },
  });
  const v = await (await call('GET', '/account/validate', {
    headers: { 'x-actual-token': token },
  })).json();
  assert.deepEqual(v.data.prefs, { 'flags.plugins': 'true' });
});

test('switched-off features answer politely', async () => {
  const { call, token } = await setup();
  const headers = { 'x-actual-token': token };

  for (const provider of ['gocardless', 'simplefin', 'pluggyai', 'akahu', 'enablebanking']) {
    const res = await call('POST', `/${provider}/status`, { json: {}, headers });
    assert.deepEqual(await res.json(), { status: 'ok', data: { configured: false } });
  }

  const secret = await call('GET', '/secret/simplefin_token', { headers });
  assert.equal(secret.status, 404);

  const save = await call('POST', '/secret', { json: { name: 'x', value: 'y' }, headers });
  assert.equal(save.status, 400);

  const openid = await call('POST', '/account/bootstrap', { json: { openId: {} } });
  assert.equal(openid.status, 400);
});

test('info, health, CORS and routing', async () => {
  const { call } = makeServer();

  const info = await (await call('GET', '/info')).json();
  assert.equal(info.build.version, '26.10.0');

  const health = await call('GET', '/health');
  assert.equal(health.headers.get('access-control-allow-origin'), '*');

  const pre = await call('OPTIONS', '/sync/sync', {
    headers: { 'Access-Control-Request-Headers': 'x-actual-token,content-type' },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-headers'), 'x-actual-token,content-type');

  assert.equal(isApiPath('/sync/sync'), true);
  assert.equal(isApiPath('/account/login'), true);
  assert.equal(isApiPath('/info'), true);
  assert.equal(isApiPath('/accounts/abc'), false);
  assert.equal(isApiPath('/budget'), false);
  assert.equal(isApiPath('/'), false);

  // Client-side routes of the app that sit under API prefixes.
  assert.deepEqual([...SPA_PATHS].sort(), ['/enablebanking/auth_callback', '/gocardless/link']);
  assert.equal(isApiPath('/gocardless/link'), false);
  assert.equal(isApiPath('/enablebanking/auth_callback'), false);
  assert.equal(isApiPath('/gocardless/status'), true);
  assert.equal(isApiPath('/enablebanking/status'), true);
});

test('oversized uploads are refused', async () => {
  const s = makeServer({ uploadLimitMB: 1 });
  const res = await s.call('POST', '/account/bootstrap', { json: { password: PASSWORD } });
  const { token } = (await res.json()).data;
  const big = await upload(s.call, token, 'big-file', new Uint8Array(2 * 1024 * 1024));
  assert.equal(big.status, 413);
  assert.equal(await big.text(), 'PayloadTooLargeError');
  assert.equal(s.blobs.files.size, 0);

  // A declared length over the limit is refused without reading the body.
  const declared = new Request('https://budget.example.com/sync/upload-user-file', {
    method: 'POST',
    body: new Uint8Array(16),
    headers: {
      'content-length': String(2 * 1024 * 1024),
      'x-actual-token': token,
      'x-actual-file-id': 'big-file',
      'x-actual-name': 'x',
    },
  });
  assert.equal((await s.server.handle(declared)).status, 413);
  assert.equal(declared.bodyUsed, false);

  // The same limit applies to sync requests.
  const bigSync = await s.call('POST', '/sync/sync', {
    body: new Uint8Array(2 * 1024 * 1024),
    headers: { 'x-actual-token': token, 'content-type': 'application/actual-sync' },
  });
  assert.equal(bigSync.status, 413);

  // A file below the limit still goes through.
  const small = await upload(s.call, token, 'small-file', new Uint8Array(512 * 1024));
  assert.equal(small.status, 200);
});

test('large bodies are not read before the request is authenticated', async () => {
  const { server, call, token } = await setup();
  const big = new Uint8Array(5 * 1024 * 1024);
  const headers = {
    'content-type': 'application/encrypted-file',
    'x-actual-file-id': 'some-file',
    'x-actual-name': 'x',
  };

  const anon = new Request('https://budget.example.com/sync/upload-user-file', {
    method: 'POST',
    body: big,
    headers,
  });
  const res = await server.handle(anon);
  assert.equal(res.status, 401);
  assert.equal(anon.bodyUsed, false);

  const anonSync = new Request('https://budget.example.com/sync/sync', {
    method: 'POST',
    body: big,
    headers,
  });
  assert.equal((await server.handle(anonSync)).status, 401);
  assert.equal(anonSync.bodyUsed, false);

  // With a valid session, header problems are reported before the body is read.
  const noName = new Request('https://budget.example.com/sync/upload-user-file', {
    method: 'POST',
    body: big,
    headers: { 'content-type': 'application/encrypted-file', 'x-actual-token': token },
  });
  assert.equal((await server.handle(noName)).status, 400);
  assert.equal(noName.bodyUsed, false);

  // So are the checks against the stored file.
  const fileId = crypto.randomUUID();
  await upload(call, token, fileId, new Uint8Array([1]));
  const reset = new Request('https://budget.example.com/sync/upload-user-file', {
    method: 'POST',
    body: big,
    headers: { ...headers, 'x-actual-token': token, 'x-actual-file-id': fileId, 'x-actual-group-id': 'old-group' },
  });
  const resetRes = await server.handle(reset);
  assert.equal(await resetRes.text(), 'file-has-reset');
  assert.equal(reset.bodyUsed, false);
});

test('JSON bodies are limited to 1 MB', async () => {
  const { call, server } = makeServer({ uploadLimitMB: 50 });

  const big = await call('POST', '/account/login', { json: { password: 'x'.repeat(1024 * 1024 + 1) } });
  assert.equal(big.status, 413);
  assert.equal(await big.text(), 'PayloadTooLargeError');

  const declared = new Request('https://budget.example.com/account/login', {
    method: 'POST',
    body: '{}',
    headers: { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024) },
  });
  assert.equal((await server.handle(declared)).status, 413);
  assert.equal(declared.bodyUsed, false);

  const fine = await call('POST', '/account/login', { json: { password: 'x'.repeat(500 * 1024) } });
  assert.equal(fine.status, 400);
});

test('/admin/owner-created and /admin/users', async () => {
  const { call, token } = await setup();

  const users = await call('GET', '/admin/users', { headers: { 'x-actual-token': token } });
  assert.equal(users.status, 200);
  assert.deepEqual(await users.json(), []);

  const anon = await call('GET', '/admin/users');
  assert.equal(anon.status, 401);

  // Other admin endpoints are still switched off.
  const other = await call('GET', '/admin/access', { headers: { 'x-actual-token': token } });
  assert.equal(other.status, 404);
  assert.equal((await other.json()).reason, 'not-supported');
});

test('bootstrap checks run in the same order as the original server', async () => {
  const fresh = makeServer();
  const empty = await fresh.call('POST', '/account/bootstrap', { json: {} });
  assert.equal(empty.status, 400);
  assert.deepEqual(await empty.json(), { status: 'error', reason: 'no-auth-method-selected' });

  const badPassword = await fresh.call('POST', '/account/bootstrap', {
    json: { password: '', openId: {} },
  });
  assert.deepEqual(await badPassword.json(), { status: 'error', reason: 'invalid-password' });

  const { call } = await setup();
  const done = await call('POST', '/account/bootstrap', { json: {} });
  assert.equal(done.status, 400);
  assert.deepEqual(await done.json(), { status: 'error', reason: 'already-bootstrapped' });

  const doneOpenId = await call('POST', '/account/bootstrap', { json: { openId: {} } });
  assert.deepEqual(await doneOpenId.json(), { status: 'error', reason: 'already-bootstrapped' });

  const donePassword = await call('POST', '/account/bootstrap', { json: { password: '' } });
  assert.deepEqual(await donePassword.json(), { status: 'error', reason: 'invalid-password' });
});

test('reset-password is off unless a reset token is configured', async () => {
  const { call, token } = await setup();
  const res = await call('POST', '/account/reset-password', { headers: { 'x-reset-token': 'anything' } });
  assert.equal(res.status, 404);
  assert.equal(await res.text(), 'Cannot POST /account/reset-password');

  const validate = await call('GET', '/account/validate', { headers: { 'x-actual-token': token } });
  assert.equal(validate.status, 200);
});

test('reset-password removes the password but keeps the budgets', async () => {
  const RESET = 'a-long-random-reset-token';
  const s = makeServer({ resetToken: RESET });
  const boot = await s.call('POST', '/account/bootstrap', { json: { password: PASSWORD } });
  const token = (await boot.json()).data.token as string;
  const { call } = s;

  const fileId = crypto.randomUUID();
  await upload(call, token, fileId, new Uint8Array([1, 2, 3]));

  const missing = await call('POST', '/account/reset-password');
  assert.equal(missing.status, 401);
  assert.deepEqual(await missing.json(), { status: 'error', reason: 'unauthorized' });

  const wrong = await call('POST', '/account/reset-password', { headers: { 'x-reset-token': RESET + 'x' } });
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), { status: 'error', reason: 'unauthorized' });

  const before = await (await call('GET', '/account/needs-bootstrap')).json();
  assert.equal(before.data.bootstrapped, true);

  const ok = await call('POST', '/account/reset-password', { headers: { 'x-reset-token': RESET } });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { status: 'ok', data: {} });

  const after = await (await call('GET', '/account/needs-bootstrap')).json();
  assert.equal(after.data.bootstrapped, false);

  const old = await call('GET', '/account/validate', { headers: { 'x-actual-token': token } });
  assert.equal(old.status, 401);
  const oldLogin = await call('POST', '/account/login', { json: { password: PASSWORD } });
  assert.equal(oldLogin.status, 400);

  const fresh = await call('POST', '/account/bootstrap', { json: { password: 'brand new password' } });
  assert.equal(fresh.status, 200);
  const newToken = (await fresh.json()).data.token as string;

  const list = await (await call('GET', '/sync/list-user-files', {
    headers: { 'x-actual-token': newToken },
  })).json();
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].fileId, fileId);
  assert.ok(s.blobs.files.has(blobKey(fileId)));
});

test('reset-password is rate limited', async () => {
  const s = makeServer({ resetToken: 'secret-token' });
  await s.call('POST', '/account/bootstrap', { json: { password: PASSWORD } });
  const ip = '198.51.100.40';
  for (let i = 0; i < 5; i++) {
    const r = await s.call('POST', '/account/reset-password', { headers: { 'x-reset-token': 'guess' }, ip });
    assert.equal(r.status, 401);
  }
  const blocked = await s.call('POST', '/account/reset-password', {
    headers: { 'x-reset-token': 'secret-token' },
    ip,
  });
  assert.equal(blocked.status, 429);
  const needs = await (await s.call('GET', '/account/needs-bootstrap')).json();
  assert.equal(needs.data.bootstrapped, true);
});

test('SETUP_PASSWORD: unset leaves the server waiting for bootstrap', async () => {
  const s = makeServer();
  await s.server.bootstrapFromSecret();
  const needs = await (await s.call('GET', '/account/needs-bootstrap')).json();
  assert.equal(needs.data.bootstrapped, false);
});

test('SETUP_PASSWORD: bootstraps a fresh server and the password logs in', async () => {
  const s = makeServer({ setupPassword: PASSWORD });
  const before = await (await s.call('GET', '/account/needs-bootstrap')).json();
  assert.equal(before.data.bootstrapped, false);

  await s.server.bootstrapFromSecret();
  const after = await (await s.call('GET', '/account/needs-bootstrap')).json();
  assert.equal(after.data.bootstrapped, true);

  const login = await s.call('POST', '/account/login', { json: { password: PASSWORD } });
  assert.equal(login.status, 200);
  const again = await s.call('POST', '/account/bootstrap', { json: { password: 'x' } });
  assert.deepEqual(await again.json(), { status: 'error', reason: 'already-bootstrapped' });
});

test('SETUP_PASSWORD: never replaces an existing password', async () => {
  const s = makeServer({ setupPassword: 'the setup secret' });
  await s.call('POST', '/account/bootstrap', { json: { password: PASSWORD } });
  await s.server.bootstrapFromSecret();

  const original = await s.call('POST', '/account/login', { json: { password: PASSWORD } });
  assert.equal(original.status, 200);
  const secret = await s.call('POST', '/account/login', { json: { password: 'the setup secret' } });
  assert.equal(secret.status, 400);
});

test('SETUP_PASSWORD: an invalid value is ignored', async () => {
  const s = makeServer({ setupPassword: 123 as unknown as string });
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    await s.server.bootstrapFromSecret();
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
  const needs = await (await s.call('GET', '/account/needs-bootstrap')).json();
  assert.equal(needs.data.bootstrapped, false);
});
