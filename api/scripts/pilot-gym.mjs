/* Operator provisioning: a new gym and its owner. Either the owner's existing account becomes the
   owner (--owner), or an owner invitation is printed once for them to sign up with
   (--owner-invite). Grants no workout access, no trainer assignment and no upstream admin role.

   Usage: DATABASE_URL=postgres://… node scripts/pilot-gym.mjs --name "Gym name" (--owner <user id> | --owner-invite) */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createPool } from '../storage/postgres.js';
import { createGym, inTx } from '../platform/organisations.js';
import { addMembership } from '../platform/memberships.js';
import { createInvitation } from '../platform/invitations.js';

export function provisionGym(db, { name, ownerUserId }) {
  return inTx(db, async client => {
    const gym = await createGym(client, { name });
    const owner = await addMembership(client, { gymId: gym.id, userId: ownerUserId, role: 'owner' });
    return { gym, owner };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { name: { type: 'string' }, owner: { type: 'string' }, 'owner-invite': { type: 'boolean' } } });
  if (!process.env.DATABASE_URL || !values.name || !!values.owner === !!values['owner-invite']) {
    console.error('usage: DATABASE_URL=… node scripts/pilot-gym.mjs --name "Gym name" (--owner <user id> | --owner-invite)');
    process.exit(1);
  }
  const pool = createPool(process.env.DATABASE_URL);
  try {
    if (values.owner) {
      const { gym, owner } = await provisionGym(pool, { name: values.name, ownerUserId: values.owner });
      console.log(`gym ${gym.id} "${gym.name}", owner membership ${owner.id}`);
    } else {
      const gym = await createGym(pool, { name: values.name });
      const { token, invitation } = await createInvitation(pool, { gymId: gym.id, role: 'owner', createdBy: null });
      // Shown once; only its hash is stored. Hand it to the owner over a channel you trust.
      console.log(`gym ${gym.id} "${gym.name}", owner invitation ${invitation.id} until ${invitation.expiresAt.toISOString()}`);
      console.log(`token: ${token}`);
    }
  } finally { await pool.end(); }
}
