'use client'

import { useState } from 'react'

import { Button } from '../primitives'
import { ReviewChangesModal, type ReviewChange, type ReviewState } from '../patterns'

/*
 * 2026-10-10 — bid page DS lane: the ONE review dialog. Made-up changes. Verify:
 *  - "Review 3 changes" re-reads first ("Save waits"), then shows one table old → new; "Save 3 changes" is held until
 *    the tick (one change lets automation do more) — focus it: it says why;
 *  - Save → "Saving 1 of 3…" → Done: one line ("2 saved · 1 not saved"), a Result per change, Undo, Done;
 *  - "Read fails" shows "Save is held" with Try again; "With a problem" holds Save while the problem is listed;
 *  - Esc and the backdrop do nothing while saving. Light and dark, 390 px.
 */
const CHANGES: ReviewChange[] = [
  { id: 'a', where: 'Rule A', what: 'Mode', now: 'Ask me', next: 'Auto', raise: true },
  { id: 'b', where: 'Rule B', what: 'Mode', now: 'Auto', next: 'Watch' },
  { id: 'c', where: 'Rule C', what: 'Highest bid', now: '€1', next: '€0.5', note: 'Lower: nothing else changes' },
]

export function ReviewChangesModalExample() {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<ReviewState>({ phase: 'ready' })
  const [problems, setProblems] = useState<string[]>([])
  const [undoing, setUndoing] = useState(false)

  const start = (how: 'ok' | 'fail' | 'problem') => {
    setProblems(how === 'problem' ? ['Rule C: the highest bid must be above the lowest.'] : [])
    setState({ phase: 'reading' })
    setOpen(true)
    setTimeout(() => setState(how === 'fail' ? { phase: 'failed', error: 'Rule B could not be read again.' } : { phase: 'ready', conflicts: [{ label: 'Rule B · Mode', was: 'Ask me', now: 'Auto' }] }), 700)
  }
  const save = () => {
    let done = 0
    setState({ phase: 'saving', done })
    const tick = setInterval(() => {
      done += 1
      if (done < CHANGES.length) { setState({ phase: 'saving', done }); return }
      clearInterval(tick)
      setState({ phase: 'done', results: { a: { ok: true, words: 'Saved' }, b: { ok: true, words: 'Saved' }, c: { ok: false, words: 'Refused: changed by someone else' } } })
    }, 500)
  }

  return (
    <section id="review-changes-modal-example" style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--nds-space-8)' }}>
      <Button variant="primary" onClick={() => start('ok')}>Review 3 changes…</Button>
      <Button onClick={() => start('fail')}>Read fails</Button>
      <Button onClick={() => start('problem')}>With a problem</Button>
      <ReviewChangesModal
        open={open}
        onClose={() => setOpen(false)}
        changes={CHANGES}
        state={state}
        summary="Nexus only: rule settings are never sent to Amazon."
        problems={problems}
        onSave={save}
        onRetry={() => start('ok')}
        onUndo={() => { setUndoing(true); setTimeout(() => { setUndoing(false); setOpen(false) }, 600) }}
        undoing={undoing}
      />
    </section>
  )
}
