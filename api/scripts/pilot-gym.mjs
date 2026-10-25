/* Operator provisioning: a new gym and its owner's membership, in one transaction. The owner's
   account must already exist (they sign up first). Grants no workout access, no trainer
   assignment and no upstream admin role.

   Usage: DATABASE_URL=postgres://… node scripts/pilot-gym.mjs --name "Gym name" --owner <user id> */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createPool } from '../storage/postgres.js';
import { createGym, inTx } from '../platform/organisations.js';
import { addMembership } from '../platform/memberships.js';

export function provisionGym(db, { name, ownerUserId }) {
  return inTx(db, async client => {
    const gym = await createGym(client, { name });
    const owner = await addMembership(client, { gymId: gym.id, userId: ownerUserId, role: 'owner' });
    return { gym, owner };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { name: { type: 'string' }, owner: { type: 'string' } } });
  if (!process.env.DATABASE_URL || !values.name || !values.owner) {
    console.error('usage: DATABASE_URL=… node scripts/pilot-gym.mjs --name "Gym name" --owner <user id>');
    process.exit(1);
  }
  const pool = createPool(process.env.DATABASE_URL);
  try {
    const { gym, owner } = await provisionGym(pool, { name: values.name, ownerUserId: values.owner });
    console.log(`gym ${gym.id} "${gym.name}", owner membership ${owner.id}`);
  } finally { await pool.end(); }
}
