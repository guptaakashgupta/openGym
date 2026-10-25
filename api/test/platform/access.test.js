/* Principals are resolved from stored identity and current memberships/assignments, never from
   anything the client sends; a role in one gym says nothing about another. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testSchema } from '../storage/helpers.mjs';
import { createGym } from '../../platform/organisations.js';
import { addMembership, endMembership } from '../../platform/memberships.js';
import { assignTrainer, endAssignment } from '../../platform/assignments.js';
import { resolvePrincipal, requireGymRole, assignedClient } from '../../platform/access.js';
import { PlatformError } from '../../platform/errors.js';

async function setup(t) {
  const { pool } = await testSchema(t, { migrated: true });
  for (const id of ['own', 'tr', 'mem', 'out']) await pool.query('INSERT INTO users (id, name) VALUES ($1, $1)', [id]);
  const a = await createGym(pool, { name: 'A' });
  const b = await createGym(pool, { name: 'B' });
  const own = await addMembership(pool, { gymId: a.id, userId: 'own', role: 'owner' });
  const tr = await addMembership(pool, { gymId: a.id, userId: 'tr', role: 'trainer' });
  const mem = await addMembership(pool, { gymId: a.id, userId: 'mem', role: 'member' });
  return { pool, a, b, own, tr, mem };
}
const status = s => e => e instanceof PlatformError && e.status === s;

test('a principal carries only current memberships', async t => {
  const { pool, a, mem } = await setup(t);
  assert.deepEqual((await resolvePrincipal(pool, 'mem')).memberships.map(m => [m.gymId, m.role]), [[a.id, 'member']]);
  await endMembership(pool, { gymId: a.id, membershipId: mem.id });
  assert.deepEqual((await resolvePrincipal(pool, 'mem')).memberships, []);
  assert.deepEqual((await resolvePrincipal(pool, 'out')).memberships, []);
});

test('a gym the caller has no role in is not found; a gym they have another role in is forbidden', async t => {
  const { pool, a, b } = await setup(t);
  const owner = await resolvePrincipal(pool, 'own');
  assert.equal(requireGymRole(owner, a.id, 'owner').role, 'owner');
  assert.throws(() => requireGymRole(owner, b.id, 'owner'), status(404));
  const member = await resolvePrincipal(pool, 'mem');
  assert.throws(() => requireGymRole(member, a.id, 'owner'), status(403));
  const outsider = await resolvePrincipal(pool, 'out');
  assert.throws(() => requireGymRole(outsider, a.id, 'owner'), status(404));
});

test('a trainer sees a client only while assigned, both memberships active', async t => {
  const { pool, a, tr, mem } = await setup(t);
  await assert.rejects(assignedClient(pool, 'tr', mem.id), status(404));
  const asg = await assignTrainer(pool, { gymId: a.id, memberMembershipId: mem.id, trainerMembershipId: tr.id });
  assert.equal((await assignedClient(pool, 'tr', mem.id)).memberUserId, 'mem');
  await assert.rejects(assignedClient(pool, 'own', mem.id), status(404), 'owning the gym is not coaching the member');
  await endAssignment(pool, { gymId: a.id, assignmentId: asg.id });
  await assert.rejects(assignedClient(pool, 'tr', mem.id), status(404));
});
