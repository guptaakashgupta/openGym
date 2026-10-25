/* Gyms, memberships and trainer assignments against real PostgreSQL: one active member gym per
   person, role rows per gym, assignments only between active memberships of one gym, and ending a
   membership ends its assignments in the same transaction without touching personal data. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testSchema } from '../storage/helpers.mjs';
import { createGym } from '../../platform/organisations.js';
import { addMembership, endMembership, activeMemberships, MembershipError } from '../../platform/memberships.js';
import { assignTrainer, endAssignment, activeAssignmentFor } from '../../platform/assignments.js';
import { provisionGym } from '../../scripts/pilot-gym.mjs';

async function setup(t) {
  const { pool } = await testSchema(t, { migrated: true });
  for (const id of ['own1', 'own2', 'tr1', 'tr2', 'mem1', 'mem2'])
    await pool.query('INSERT INTO users (id, name) VALUES ($1, $1)', [id]);
  const g1 = await createGym(pool, { name: 'Gym One' });
  const g2 = await createGym(pool, { name: 'Gym Two' });
  return { pool, g1, g2 };
}
const code = c => e => e instanceof MembershipError && e.code === c;

test('a person is an active member of one gym at a time', async t => {
  const { pool, g1, g2 } = await setup(t);
  await addMembership(pool, { gymId: g1.id, userId: 'mem1', role: 'member' });
  await assert.rejects(addMembership(pool, { gymId: g2.id, userId: 'mem1', role: 'member' }), code('member-elsewhere'));
  await assert.rejects(addMembership(pool, { gymId: g1.id, userId: 'mem1', role: 'member' }), code('already'));
});

test('two simultaneous joins to different gyms: exactly one succeeds', async t => {
  const { pool, g1, g2 } = await setup(t);
  const results = await Promise.allSettled([
    addMembership(pool, { gymId: g1.id, userId: 'mem1', role: 'member' }),
    addMembership(pool, { gymId: g2.id, userId: 'mem1', role: 'member' }),
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal((await activeMemberships(pool, 'mem1')).length, 1);
});

test('owners of different gyms, and an owner who also coaches, each hold separate role rows', async t => {
  const { pool, g1, g2 } = await setup(t);
  await addMembership(pool, { gymId: g1.id, userId: 'own1', role: 'owner' });
  await addMembership(pool, { gymId: g2.id, userId: 'own2', role: 'owner' });
  await addMembership(pool, { gymId: g1.id, userId: 'own1', role: 'trainer' });
  const roles = (await activeMemberships(pool, 'own1')).map(m => m.role).sort();
  assert.deepEqual(roles, ['owner', 'trainer']);
  await assert.rejects(addMembership(pool, { gymId: g1.id, userId: 'own1', role: 'owner' }), code('already'));
  await assert.rejects(addMembership(pool, { gymId: g1.id, userId: 'own1', role: 'admin' }), code('bad-role'));
});

test('a trainer can only be assigned members of the same gym, by role', async t => {
  const { pool, g1, g2 } = await setup(t);
  const m1 = await addMembership(pool, { gymId: g1.id, userId: 'mem1', role: 'member' });
  const t1 = await addMembership(pool, { gymId: g1.id, userId: 'tr1', role: 'trainer' });
  const t2 = await addMembership(pool, { gymId: g2.id, userId: 'tr2', role: 'trainer' });
  await assert.rejects(assignTrainer(pool, { gymId: g1.id, memberMembershipId: m1.id, trainerMembershipId: t2.id }), code('not-found'));
  await assert.rejects(assignTrainer(pool, { gymId: g2.id, memberMembershipId: m1.id, trainerMembershipId: t2.id }), code('not-found'));
  await assert.rejects(assignTrainer(pool, { gymId: g1.id, memberMembershipId: t1.id, trainerMembershipId: m1.id }), code('wrong-role'));
  const a = await assignTrainer(pool, { gymId: g1.id, memberMembershipId: m1.id, trainerMembershipId: t1.id });
  assert.equal((await activeAssignmentFor(pool, m1.id)).id, a.id);
});

test('the database itself refuses an assignment across gyms', async t => {
  const { pool, g1, g2 } = await setup(t);
  const m1 = await addMembership(pool, { gymId: g1.id, userId: 'mem1', role: 'member' });
  const t2 = await addMembership(pool, { gymId: g2.id, userId: 'tr2', role: 'trainer' });
  await assert.rejects(pool.query(
    "INSERT INTO trainer_assignments (id, gym_id, member_membership_id, trainer_membership_id) VALUES ('x', $1, $2, $3)",
    [g1.id, m1.id, t2.id]), /foreign key/);
});

test('reassigning ends the previous assignment; duplicate requests leave one active assignment', async t => {
  const { pool, g1 } = await setup(t);
  const m1 = await addMembership(pool, { gymId: g1.id, userId: 'mem1', role: 'member' });
  const t1 = await addMembership(pool, { gymId: g1.id, userId: 'tr1', role: 'trainer' });
  const t2 = await addMembership(pool, { gymId: g1.id, userId: 'tr2', role: 'trainer' });
  const first = await assignTrainer(pool, { gymId: g1.id, memberMembershipId: m1.id, trainerMembershipId: t1.id });
  await Promise.all([
    assignTrainer(pool, { gymId: g1.id, memberMembershipId: m1.id, trainerMembershipId: t2.id }),
    assignTrainer(pool, { gymId: g1.id, memberMembershipId: m1.id, trainerMembershipId: t2.id }),
  ]);
  const { rows } = await pool.query('SELECT trainer_membership_id, ended_at FROM trainer_assignments WHERE member_membership_id = $1 ORDER BY started_at', [m1.id]);
  assert.equal(rows.filter(r => r.ended_at === null).length, 1);
  assert.equal(rows.find(r => r.ended_at === null).trainer_membership_id, t2.id);
  assert.ok(rows.some(r => r.trainer_membership_id === t1.id && r.ended_at !== null), `first ${first.id} ended`);
  await endAssignment(pool, { gymId: g1.id, assignmentId: (await activeAssignmentFor(pool, m1.id)).id });
  assert.equal(await activeAssignmentFor(pool, m1.id), null);
});

test('ending a membership ends its assignments at once, keeps history and personal data, and frees the member', async t => {
  const { pool, g1, g2 } = await setup(t);
  await pool.query(`INSERT INTO member_states (user_id, document, revision) VALUES ('mem1', '{"_rev":3,"workouts":[{"id":"w"}]}', 3)`);
  const m1 = await addMembership(pool, { gymId: g1.id, userId: 'mem1', role: 'member' });
  const t1 = await addMembership(pool, { gymId: g1.id, userId: 'tr1', role: 'trainer' });
  await assignTrainer(pool, { gymId: g1.id, memberMembershipId: m1.id, trainerMembershipId: t1.id });
  await endMembership(pool, { gymId: g1.id, membershipId: m1.id });
  assert.equal(await activeAssignmentFor(pool, m1.id), null);
  const { rows } = await pool.query('SELECT ended_at FROM gym_memberships WHERE id = $1', [m1.id]);
  assert.ok(rows[0].ended_at);
  assert.equal((await pool.query("SELECT revision FROM member_states WHERE user_id = 'mem1'")).rows[0].revision, '3');
  await assert.rejects(assignTrainer(pool, { gymId: g1.id, memberMembershipId: m1.id, trainerMembershipId: t1.id }), code('not-found'));
  await addMembership(pool, { gymId: g2.id, userId: 'mem1', role: 'member' });
});

test('a trainer who leaves loses every assignment', async t => {
  const { pool, g1 } = await setup(t);
  const m1 = await addMembership(pool, { gymId: g1.id, userId: 'mem1', role: 'member' });
  const m2 = await addMembership(pool, { gymId: g1.id, userId: 'mem2', role: 'member' });
  const t1 = await addMembership(pool, { gymId: g1.id, userId: 'tr1', role: 'trainer' });
  await assignTrainer(pool, { gymId: g1.id, memberMembershipId: m1.id, trainerMembershipId: t1.id });
  await assignTrainer(pool, { gymId: g1.id, memberMembershipId: m2.id, trainerMembershipId: t1.id });
  await endMembership(pool, { gymId: g1.id, membershipId: t1.id });
  assert.equal(await activeAssignmentFor(pool, m1.id), null);
  assert.equal(await activeAssignmentFor(pool, m2.id), null);
});

test('ending a membership of another gym is refused', async t => {
  const { pool, g1, g2 } = await setup(t);
  const m1 = await addMembership(pool, { gymId: g1.id, userId: 'mem1', role: 'member' });
  await assert.rejects(endMembership(pool, { gymId: g2.id, membershipId: m1.id }), code('not-found'));
});

test('operator provisioning creates a gym and its owner, nothing more', async t => {
  const { pool } = await setup(t);
  await pool.query("UPDATE users SET account = '{}'::jsonb WHERE id = 'own1'");
  const { gym, owner } = await provisionGym(pool, { name: 'Iron Den', ownerUserId: 'own1' });
  assert.equal(owner.role, 'owner');
  assert.equal(owner.gymId, gym.id);
  const u = (await pool.query("SELECT account, disabled FROM users WHERE id = 'own1'")).rows[0];
  assert.deepEqual(u.account, {});
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM gym_memberships WHERE gym_id = $1", [gym.id])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM trainer_assignments')).rows[0].n, 0);
});

test('deleting an account removes its memberships and assignments', async t => {
  const { pool, g1 } = await setup(t);
  const m1 = await addMembership(pool, { gymId: g1.id, userId: 'mem1', role: 'member' });
  const t1 = await addMembership(pool, { gymId: g1.id, userId: 'tr1', role: 'trainer' });
  await assignTrainer(pool, { gymId: g1.id, memberMembershipId: m1.id, trainerMembershipId: t1.id });
  await pool.query("DELETE FROM users WHERE id = 'mem1'");
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM trainer_assignments')).rows[0].n, 0);
  assert.equal((await activeMemberships(pool, 'mem1')).length, 0);
});
