// One assigned client's gym workouts and progress, as the server projects them
// (api/platform/workout-projection.js): fetched when shown and on Refresh, never stored. A refusal
// or a lost connection replaces the data with the reason, so nothing stale stays on screen.
import React, { useCallback, useEffect, useState } from 'react'
import { t } from '../lib/i18n.js'
import { EXIDX } from '../lib/exercises.js'
import { exerciseNameFor } from '../lib/i18n-core.js'
import { clientWorkouts } from './api.js'
import { describeError } from './ui-errors.js'

const exName = e => (e.custom ? t('Custom exercise') : EXIDX[e.exerciseId] ? exerciseNameFor(EXIDX[e.exerciseId]) : e.exerciseId)
const setLine = (s, unit) => [s.reps != null && `${s.reps} ×`, s.load != null && `${s.load} ${unit}`, s.seconds != null && `${s.seconds} s`]
  .filter(Boolean).join(' ') + (s.done ? '' : ` (${t('not done')})`)

export default function ClientProgress({ client }) {
  const [view, setView] = useState(null)
  const [problem, setProblem] = useState(null)
  const load = useCallback(async () => {
    try { setView(await clientWorkouts(client.membershipId)); setProblem(null) }
    catch (e) { setView(null); setProblem(describeError(e)) }
  }, [client.membershipId])
  useEffect(() => { load() }, [load])

  return (
    <section>
      <h2>{client.name}</h2>
      <button onClick={load}>{t('Refresh')}</button>
      {problem && <p role="alert">{problem.message}</p>}
      {!problem && !view && <p className="muted">{t('Loading…')}</p>}
      {view && <>
        {!view.workouts.length && <p className="muted">{t('No gym workouts yet.')}</p>}
        {view.progress.map(p => (
          <p key={p.exerciseId}>{exName(p)}: {t('best {0} {1} over {2} sessions', p.bestLoad, view.unit, p.sessions)}</p>
        ))}
        {view.workouts.map(w => (
          <div key={w.id} className="card">
            <h3>{w.date}</h3>
            {w.exercises.map((e, i) => <p key={i}>{exName(e)} — {e.sets.map(s => setLine(s, view.unit)).join(', ')}</p>)}
          </div>
        ))}
      </>}
    </section>
  )
}
