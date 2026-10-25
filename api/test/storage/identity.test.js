/* Accounts and passkey credentials behind one repository contract, run against both stores: the
   file store (upstream's db.json arrays) and PostgreSQL. Name and e-mail rules are upstream's
   (server.js nameTaken/emailTaken): a name is claimed only by a profile that holds a password, an
   e-mail by any profile, and the two share one namespace. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testSchema, testDatabaseUrl } from './helpers.mjs';
import { createPool } from '../../storage/postgres.js';
import { fileIdentityStore } from '../../storage/identity-file.js';
import { postgresIdentityStore } from '../../storage/identity-postgres.js';
import { IdentityConflictError } from '../../storage/identity.js';

const PW = { h: 'scrypt$hash', set: '2026-10-01T00:00:00.000Z' };
const user = (id, extra = {}) => ({ id, name: 'Name ' + id, created: '2026-10-01T00:00:00.000Z', ...extra });
const cred = (id, userId, extra = {}) => ({ id, userId, publicKey: 'pk-' + id, counter: 0, transports: ['internal'], created: '2026-10-01T00:00:00.000Z', lastUsed: '2026-10-01T00:00:00.000Z', ...extra });

const adapters = {
  file: async () => {
    const db = { users: [], creds: [] };
    let saves = 0;
    return { store: fileIdentityStore({ db, save: () => { saves++; } }), fresh: null, saves: () => saves };
  },
  postgres: async t => {
    const { pool, schema } = await testSchema(t, { migrated: true });
    return {
      store: postgresIdentityStore(pool),
      // A second pool is a second process: it must see committed changes, never a cache.
      fresh: () => { const p = createPool(testDatabaseUrl(), { searchPath: schema }); t.after(() => p.end()); return postgresIdentityStore(p); },
    };
  },
};

const conflict = field => err => err instanceof IdentityConflictError && err.field === field;

for (const [kind, make] of Object.entries(adapters)) {
  test(`${kind}: an account round-trips with its password record and fields the store does not know`, async t => {
    const { store } = await make(t);
    const u = user('a', { pw: PW, email: 'a@x.io', sv: 2, invitedBy: 'CODE', coach: { consent: { agreedAt: 1 } }, someFutureField: [1, { x: 2 }] });
    await store.createUser(structuredClone(u));
    assert.deepEqual(await store.getUser('a'), u);
    assert.equal(await store.getUser('nobody'), null);
  });

  test(`${kind}: absent optional fields stay absent`, async t => {
    const { store } = await make(t);
    await store.createUser(user('a'));
    assert.deepEqual(await store.getUser('a'), user('a'));
  });

  test(`${kind}: a password-holding name is unique after folding; a passkey-only profile does not claim it`, async t => {
    const { store } = await make(t);
    await store.createUser(user('a', { name: 'Sam', pw: PW }));
    await assert.rejects(store.createUser(user('b', { name: ' SAM ', pw: PW })), conflict('name'));
    await store.createUser(user('c', { name: 'Sam' }));
    assert.equal((await store.findPasswordHolderByName('sam')).id, 'a');
  });

  test(`${kind}: an e-mail is unique and shares the namespace with names`, async t => {
    const { store } = await make(t);
    await store.createUser(user('a', { pw: PW, email: 'a@x.io' }));
    await assert.rejects(store.createUser(user('b', { email: 'a@x.io' })), conflict('email'));
    await assert.rejects(store.createUser(user('c', { name: 'A@X.io', pw: PW })), conflict('name'));
    await store.createUser(user('d', { name: 'd@x.io', pw: PW, email: 'd@x.io' }));   // one profile may use its own address as its name
    assert.equal((await store.findPasswordHolderByEmail('a@x.io')).id, 'a');
    assert.equal(await store.isEmailTaken('a@x.io', 'a'), false);
    assert.equal(await store.isEmailTaken('a@x.io', 'z'), true);
    assert.equal(await store.isNameTaken('a@x.io', 'z'), true);
    assert.equal(await store.isNameTaken('d@x.io', 'd'), false);
  });

  test(`${kind}: two concurrent registrations of one name: exactly one succeeds`, async t => {
    const { store } = await make(t);
    const results = await Promise.allSettled([
      store.createUser(user('a', { name: 'Kim', pw: PW })),
      store.createUser(user('b', { name: 'kim', pw: PW })),
    ]);
    assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled', 'rejected']);
    assert.equal((await store.listUsers()).length, 1);
  });

  test(`${kind}: a duplicate credential id is refused and the account created with it is not kept`, async t => {
    const { store } = await make(t);
    await store.createUser(user('a'), { credential: cred('k1', 'a') });
    await assert.rejects(store.createUser(user('b'), { credential: cred('k1', 'b') }), conflict('credential'));
    assert.equal(await store.getUser('b'), null);
    await assert.rejects(store.addCredential(cred('k1', 'a')), conflict('credential'));
    assert.deepEqual((await store.listCredentials('a')).map(c => c.id), ['k1']);
  });

  test(`${kind}: credentials keep every upstream field and update in place`, async t => {
    const { store } = await make(t);
    await store.createUser(user('a'));
    const c = cred('k1', 'a', { backedUp: true, deviceType: 'multiDevice' });
    await store.addCredential(structuredClone(c));
    assert.deepEqual(await store.findCredential('k1'), c);
    await store.updateCredential('k1', x => ({ ...x, counter: 7, lastUsed: '2026-10-02T00:00:00.000Z' }));
    assert.deepEqual(await store.findCredential('k1'), { ...c, counter: 7, lastUsed: '2026-10-02T00:00:00.000Z' });
    assert.equal(await store.removeCredential('k1'), true);
    assert.equal(await store.findCredential('k1'), null);
  });

  test(`${kind}: setting a password onto a name another profile holds is refused and changes nothing`, async t => {
    const { store } = await make(t);
    await store.createUser(user('a', { name: 'Sam', pw: PW }));
    await store.createUser(user('b', { name: 'Sam' }));
    await assert.rejects(store.updateUser('b', u => ({ ...u, pw: PW })), conflict('name'));
    assert.equal((await store.getUser('b')).pw, undefined);
  });

  test(`${kind}: removing a password releases the name`, async t => {
    const { store } = await make(t);
    await store.createUser(user('a', { name: 'Sam', pw: PW }));
    await store.updateUser('a', ({ pw, ...u }) => u);
    await store.createUser(user('b', { name: 'Sam', pw: PW }));
    assert.equal((await store.findPasswordHolderByName('sam')).id, 'b');
  });

  test(`${kind}: disabling and a session-version bump are visible to the next read`, async t => {
    const { store, fresh } = await make(t);
    await store.createUser(user('a', { sv: 1 }));
    const after = await store.updateUser('a', u => ({ ...u, disabled: true, sv: 2 }));
    assert.equal(after.sv, 2);
    for (const s of [store, ...(fresh ? [fresh()] : [])]) {
      const u = await s.getUser('a');
      assert.equal(u.disabled, true);
      assert.equal(u.sv, 2);
    }
    await store.updateUser('a', ({ disabled, ...u }) => u);
    assert.equal('disabled' in (await store.getUser('a')), false);
  });

  test(`${kind}: updating an unknown account answers null`, async t => {
    const { store } = await make(t);
    assert.equal(await store.updateUser('nobody', u => u), null);
  });

  test(`${kind}: the id of an account cannot be changed by an update`, async t => {
    const { store } = await make(t);
    await store.createUser(user('a'));
    await assert.rejects(store.updateUser('a', u => ({ ...u, id: 'b' })), /id/);
  });

  test(`${kind}: deleting an account removes its credentials and frees its identifiers`, async t => {
    const { store } = await make(t);
    await store.createUser(user('a', { name: 'Sam', pw: PW, email: 's@x.io' }), { credential: cred('k1', 'a') });
    await store.addCredential(cred('k2', 'a'));
    await store.createUser(user('b'), { credential: cred('k3', 'b') });
    assert.equal(await store.deleteUser('a'), true);
    assert.equal(await store.getUser('a'), null);
    assert.deepEqual(await store.listCredentials('a'), []);
    assert.equal(await store.findCredential('k1'), null);
    assert.ok(await store.findCredential('k3'));
    await store.createUser(user('c', { name: 'sam', pw: PW, email: 's@x.io' }));
    assert.equal(await store.deleteUser('a'), false);
  });

  test(`${kind}: a guarded removal checks and removes atomically, so two removals never take the last passkey`, async t => {
    const { store } = await make(t);
    await store.createUser(user('a'), { credential: cred('k1', 'a') });
    await store.addCredential(cred('k2', 'a'));
    const lastOne = (creds, u) => (creds.length <= 1 && !u.pw ? { code: 'last-way-in' } : null);
    const results = await Promise.all([
      store.removeCredentialChecked('a', 'k1', lastOne),
      store.removeCredentialChecked('a', 'k2', lastOne),
    ]);
    assert.deepEqual(results.map(r => r.ok ? 'ok' : r.code).sort(), ['last-way-in', 'ok']);
    assert.equal((await store.listCredentials('a')).length, 1);
    assert.equal((await store.removeCredentialChecked('a', 'missing', () => null)).code, 'not-found');
    await store.createUser(user('b'), { credential: cred('k9', 'b') });
    assert.equal((await store.removeCredentialChecked('a', 'k9', () => null)).code, 'not-found', 'another account’s passkey');
  });

  test(`${kind}: listUsers returns every account`, async t => {
    const { store } = await make(t);
    await store.createUser(user('a'));
    await store.createUser(user('b', { disabled: true }));
    assert.deepEqual((await store.listUsers()).map(u => u.id).sort(), ['a', 'b']);
  });
}

test('file: every mutation is saved, and a refused one is not', async () => {
  const { store, saves } = await adapters.file();
  await store.createUser(user('a', { name: 'Sam', pw: PW }));
  const n = saves();
  await assert.rejects(store.createUser(user('b', { name: 'sam', pw: PW })));
  assert.equal(saves(), n);
  await store.updateUser('a', u => ({ ...u, sv: 3 }));
  assert.equal(saves(), n + 1);
});
