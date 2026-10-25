/* What a trainer reads of an assigned member: the visible workouts, field by field from an
   allowlist — never a spread of the stored object, so a field upstream adds tomorrow stays private
   until someone decides otherwise. Exercise ids from the built-in catalogue; a member's own custom
   exercise appears only as "custom" (its id and name are theirs). No notes, names, photos, body
   weight, targets, effort ratings, personal records or anything outside `workouts`. Progress is
   computed here from these workouts alone, never from lifetime summaries. */
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const seconds = s => {
  const total = (num(s?.min) || 0) * 60 + (num(s?.sec) || 0);
  return total > 0 ? total : undefined;
};
const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function projectSet(s) {
  if (!s || typeof s !== 'object') return null;
  const side = x => (x && typeof x === 'object' ? clean({ reps: num(x.r), load: num(x.w), seconds: seconds(x) }) : undefined);
  const sides = s.sides && typeof s.sides === 'object' ? clean({ L: side(s.sides.L), R: side(s.sides.R) }) : undefined;
  return clean({ reps: num(s.r), load: num(s.w), seconds: seconds(s), done: s.done === true, sides: sides && Object.keys(sides).length ? sides : undefined });
}

export function projectWorkouts(doc, visibleIds) {
  const custom = new Set((Array.isArray(doc?.customEx) ? doc.customEx : []).map(c => c?.id).filter(Boolean));
  const workouts = (Array.isArray(doc?.workouts) ? doc.workouts : [])
    .filter(w => w && typeof w.id === 'string' && visibleIds.has(w.id))
    .map(w => ({
      id: w.id,
      date: typeof w.d === 'string' ? w.d : null,
      exercises: (Array.isArray(w.entries) ? w.entries : []).filter(e => e && typeof e === 'object').map(e => {
        const isCustom = typeof e.id !== 'string' || custom.has(e.id);
        return { exerciseId: isCustom ? null : e.id, custom: isCustom, sets: (Array.isArray(e.sets) ? e.sets : []).map(projectSet).filter(Boolean) };
      }),
    }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const byExercise = new Map();
  for (const w of workouts) for (const e of w.exercises) {
    if (!e.exerciseId) continue;
    const loads = e.sets.filter(s => s.done && typeof s.load === 'number').map(s => s.load);
    if (!loads.length) continue;
    const p = byExercise.get(e.exerciseId) || { exerciseId: e.exerciseId, sessions: 0, bestLoad: 0, lastDate: null };
    p.sessions += 1;
    p.bestLoad = Math.max(p.bestLoad, ...loads);
    if (w.date && (!p.lastDate || w.date > p.lastDate)) p.lastDate = w.date;
    byExercise.set(e.exerciseId, p);
  }
  const unit = doc?.unit === 'lb' ? 'lb' : 'kg';
  return { unit, workouts, progress: [...byExercise.values()].sort((a, b) => a.exerciseId.localeCompare(b.exerciseId)) };
}
