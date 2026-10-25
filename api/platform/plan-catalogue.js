/* The shared plan-import rules (api/shared/plan-import.js) with the API's catalogue: the exercise
   list generated from the app's dataset for the Coach (coach/core/library-data.js). Ids are taken
   as written — a bundle the app built already carries canonical ids — and a plan the server
   cannot fully resolve is refused by the caller, never silently trimmed. */
import { EXERCISES } from '../coach/core/library-data.js';
import { createPlanImport } from '../shared/plan-import.js';

// The same equipment the app treats as carrying no load (frontend/src/lib/exercises.js).
const BODYWEIGHT_EQ = new Set(['body weight', 'band', 'resistance band']);
const BY_ID = new Map(EXERCISES.map(e => [e.id, e]));

export const serverCatalogue = {
  exists: id => BY_ID.has(id),
  isBuiltIn: id => BY_ID.has(id),
  isCardio: id => BY_ID.get(id)?.bp === 'cardio',
  isBodyweightEq: id => BODYWEIGHT_EQ.has(BY_ID.get(id)?.eq),
  canonical: id => id,
};

export function serverPlanImport({ newId } = {}) {
  return createPlanImport({
    t: s => s,
    catalogue: serverCatalogue,
    newId: newId || (() => { throw new Error('the server merges plans with explicit ids only'); }),
    today: () => new Date().toISOString().slice(0, 10),
  });
}
