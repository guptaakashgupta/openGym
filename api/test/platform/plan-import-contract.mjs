/* One set of plan-import cases, run against both runtimes' implementations: the API's
   (api/test/platform/plan-import.test.js, node --test) and the app's
   (frontend/src/platform/plan-import.test.js, vitest). Both use api/shared/plan-import.js with
   their own catalogue; identical results here are what "the same import rules" means.
   Exercise ids are from the shared catalogue: 0025 barbell bench press, 0043 barbell full squat,
   0251 chest dip (body weight), 3220 a cardio exercise. */
import assert from 'node:assert/strict';

const clone = x => structuredClone(x);

function sender() {
  return {
    unit: 'kg',
    week: { 1: ['r-push'], 3: ['r-legs', 'r-push'] },
    customEx: [{ id: 'cx-sled', n: 'Sled push', bp: 'upper legs', eq: 'sled', primaries: ['quadriceps'], custom: true }],
    routines: [
      { id: 'r-push', name: 'Push', emoji: '💪', ex: [
        { id: '0025', sets: 3, reps: 5, weight: 100, inc: 2.5, prog: 'linear', restSec: 180, warmupSets: 99, warmupRestSec: 60,
          intensifier: { type: 'dropset', count: 2, pct: 1 } },
        { id: '0251', sets: 3, reps: 8, bodyweight: true, intensifier: { type: 'restpause', totalReps: 20, restSec: 2 } },
        { id: 'does-not-exist', sets: 3, reps: 5 },
      ] },
      { id: 'r-legs', name: 'Legs', ex: [
        { id: '0043', sets: 5, reps: 5, weight: 140, pyramid: [10, 8, 6, 'max'], pyramidWeight: [100, 110, 120, 0], pyramidRest: [90, 90, 120, 0] },
        { id: 'cx-sled', sets: 4, mode: 'time', sec: 30, side: true, sideRestSec: 15, warmupRestOff: true },
        { id: '3220', sets: 1, min: 20, speed: 8 },
      ] },
    ],
  };
}

function recipient(unit) {
  return {
    unit,
    week: { 0: ['r-mine'], 1: ['r-mine'] },
    routines: [{ id: 'r-mine', name: 'Mine', ex: [{ id: '0025', sets: 1, reps: 1, weight: 60 }] }],
    customEx: [{ id: 'my-sled', n: 'sled PUSH', bp: 'upper legs', custom: true }],
    workouts: [{ id: 'w-done', d: '2026-10-01', entries: [{ id: '0025', sets: [{ w: 60, r: 5, done: true }] }] }],
  };
}

// `impl`: { buildPlanBundle, parsePlan, mergePlan } from one runtime.
export function planImportCases(impl) {
  const { buildPlanBundle, parsePlan, mergePlan } = impl;
  const counter = () => { let n = 0; return (kind, src) => `${kind}-${src}-${++n}`; };

  return {
    'prescriptions survive a round trip: rests, warm-ups (clamped), drop sets, rest-pause, pyramids, sides, cardio'() {
      const parsed = parsePlan(JSON.stringify(buildPlanBundle(sender(), 'Shared')), 'kg');
      const [push, legs] = parsed.routines;
      assert.equal(parsed.dropped, 1, 'the unknown exercise is dropped and counted');
      assert.deepEqual(push.ex[0], { id: '0025', sets: 3, reps: 5, weight: 100, prog: 'linear', inc: 2.5, restSec: 180, warmupRestSec: 60, warmupSets: 5,
        intensifier: { type: 'dropset', count: 2, pct: 5 } });
      assert.deepEqual(push.ex[1].intensifier, { type: 'restpause', totalReps: 20, restSec: 5 });
      assert.deepEqual(legs.ex[0].pyramid, [10, 8, 6, 'max']);
      assert.deepEqual(legs.ex[0].pyramidWeight, [100, 110, 120, 0]);
      assert.deepEqual(legs.ex[0].pyramidRest, [90, 90, 120, 0]);
      assert.deepEqual({ mode: legs.ex[1].mode, sec: legs.ex[1].sec, side: legs.ex[1].side, sideRestSec: legs.ex[1].sideRestSec, warmupRestOff: legs.ex[1].warmupRestOff },
        { mode: 'time', sec: 30, side: true, sideRestSec: 15, warmupRestOff: true });
      assert.deepEqual({ min: legs.ex[2].min, speed: legs.ex[2].speed }, { min: 20, speed: 8 });
      assert.equal(parsed.scheduledDays, 2);
    },

    'a kg plan arrives in pounds for a pound user'() {
      const parsed = parsePlan(buildPlanBundle(sender(), ''), 'lb');
      assert.equal(parsed.routines[0].ex[0].weight, 220.5);
      assert.equal(parsed.routines[0].ex[0].inc, 5.5);
      assert.deepEqual(parsed.routines[1].ex[0].pyramidWeight, [220.5, 242.5, 264.5, 0]);
      assert.equal(parsed.unit, 'lb');
      assert.equal(parsed.sourceUnit, 'kg');
    },

    'merging adds routines and reuses a same-named custom exercise; history and other routines are untouched'() {
      const s = recipient('kg');
      const before = clone(s);
      const r = mergePlan(s, parsePlan(buildPlanBundle(sender(), ''), 'kg'), {});
      assert.equal(r.routines, 2);
      assert.deepEqual(s.workouts, before.workouts);
      assert.deepEqual(s.routines[0], before.routines[0]);
      assert.deepEqual(s.week, before.week, 'no schedule asked for: the week is left alone');
      const legs = s.routines.find(x => x.id === r.routineMap['r-legs']);
      assert.equal(legs.ex[1].id, 'my-sled', 'a custom exercise with the same name and body part is reused');
      assert.equal(s.customEx.length, 1);
      assert.equal(r.customMap['cx-sled'], 'my-sled');
    },

    'with schedule, the week is replaced by the plan’s days, mapped to the new routines'() {
      const s = recipient('kg');
      const r = mergePlan(s, parsePlan(buildPlanBundle(sender(), ''), 'kg'), { schedule: true });
      assert.deepEqual(s.week, { 1: [r.routineMap['r-push']], 3: [r.routineMap['r-legs'], r.routineMap['r-push']] });
    },

    'a supplied id allocator makes merging deterministic and reports every mapping'() {
      const bundle = parsePlan(buildPlanBundle(sender(), ''), 'kg');
      const a = recipient('kg'); const b = recipient('kg');
      delete a.customEx; delete b.customEx;
      const ra = mergePlan(a, clone(bundle), { ids: counter() });
      const rb = mergePlan(b, clone(bundle), { ids: counter() });
      assert.deepEqual(a, b);
      assert.deepEqual(ra, rb);
      assert.deepEqual(Object.keys(ra.routineMap).sort(), ['r-legs', 'r-push']);
      assert.deepEqual(Object.keys(ra.customMap), ['cx-sled']);
      assert.ok(a.customEx.some(c => c.id === ra.customMap['cx-sled'] && c.custom === true));
    },

    'something that is not a plan, or names an unknown unit, is refused'() {
      for (const bad of ['{', '[]', JSON.stringify({ routines: [] }), JSON.stringify({ opengym_plan: 1, routines: [], unit: 'stone' })]) {
        assert.throws(() => parsePlan(bad, 'kg'));
      }
      assert.throws(() => parsePlan(buildPlanBundle(sender(), ''), 'stone'));
    },
  };
}
