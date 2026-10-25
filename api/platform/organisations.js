/* Gyms (organisations). Created by the platform operator (scripts/pilot-gym.mjs); a gym's name and
   status are runtime configuration, not a build. */
import crypto from 'node:crypto';
import { transaction } from '../storage/postgres.js';

export const newId = prefix => prefix + '_' + crypto.randomBytes(12).toString('base64url');

// Runs `fn` in a transaction on a pool, or directly on a client already inside one, so services
// compose into one atomic operation.
export const inTx = (db, fn) => (db.release ? fn(db) : transaction(db, fn));

export async function createGym(db, { name }) {
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!clean || clean.length > 80) throw new Error('a gym needs a name of 1 to 80 characters');
  const id = newId('g');
  const { rows } = await db.query('INSERT INTO gyms (id, name) VALUES ($1, $2) RETURNING id, name, status', [id, clean]);
  return rows[0];
}

export async function getGym(db, id) {
  const { rows } = await db.query('SELECT id, name, status FROM gyms WHERE id = $1', [id]);
  return rows[0] || null;
}
