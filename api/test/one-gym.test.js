/* Pilot rule on top of upstream trainers: one active gym per member
   (docs/plans/2026-11-26-adopt-upstream-trainers.md section 4). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrgStore } from '../trainers/org-store.js';
import { TRAINER_DEFAULTS } from '../trainers/scopes.js';

test('one gym: a second gym is refused by join and by a gym trainer, a private trainer is not; leaving frees', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-one-'));
  const org = createOrgStore({ file: path.join(dir, 'org.json') });
  const a = org.createGym({ name: 'FitBox' });
  const b = org.createGym({ name: 'IronHouse' });
  org.setStaff(b.id, 'tb', 'trainer', true);
  org.setFreeTrainer('free', true);
  const gymCode = gid => org.createCode({ ownerId: 'lead', kind: 'gym', gymId: gid }).code;
  const trainerCode = gid => org.createCode({ ownerId: gid ? 'tb' : 'free', gymId: gid }).code;
  const other = e => e.status === 409 && e.code === 'other-gym';

  org.joinGym({ memberId: 'm', code: org.findCode(gymCode(a.id)) });
  const join = gymCode(b.id);
  assert.throws(() => org.joinGym({ memberId: 'm', code: org.findCode(join) }), other);
  assert.ok(org.findCode(join), 'a refused join spends no use');
  const viaTrainer = trainerCode(b.id);
  assert.throws(() => org.connect({ memberId: 'm', code: org.findCode(viaTrainer), scopes: TRAINER_DEFAULTS }), other);
  assert.ok(org.findCode(viaTrainer));
  assert.equal(org.memberRecord('m').grants.length, 1, 'only the first gym\'s lead row; nothing from the refused ones');

  org.connect({ memberId: 'm', code: org.findCode(trainerCode(null)), scopes: TRAINER_DEFAULTS });
  assert.deepEqual(org.memberRecord('m').memberships.map(x => x.gymId), [a.id], 'a private trainer adds no gym');

  // Joining the same gym again keeps upstream's answer.
  assert.throws(() => org.joinGym({ memberId: 'm', code: org.findCode(gymCode(a.id)) }), e => e.code === 'already-member');

  org.leaveGym('m', a.id);
  org.connect({ memberId: 'm', code: org.findCode(viaTrainer), scopes: TRAINER_DEFAULTS });
  assert.ok(org.membership(b.id, 'm'), 'after leaving, a gym trainer brings the new gym');
  assert.throws(() => org.joinGym({ memberId: 'm', code: org.findCode(gymCode(a.id)) }), other);

  // OIDC claims for two gyms: the first is kept, the second skipped, sign-in does not fail.
  assert.deepEqual(org.syncClaimRoles('n', { memberOf: [a.id, b.id] }).memberOf, [a.id]);
  fs.rmSync(dir, { recursive: true, force: true });
});
