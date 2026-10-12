'use client'

import { useState } from 'react'

import { Button, Input } from '../primitives'
import { Field } from '../components'
import { ReviewChangesModal, type ReviewChange, type ReviewState } from '../patterns'

/*
 * 2026-10-10 — bid page DS lane: the ONE review dialog. Made-up changes. Verify:
 *  - "Review 3 changes" re-reads first ("Save waits"), then shows one table old → new; "Save 3 changes" is held until
 *    the tick (one change lets automation do more) — focus it: it says why;
 *  - Save → "Saving 1 of 3…" → Done: one line ("2 saved · 1 not saved"), a Result per change, Undo, Done;
 *  - "Read fails" shows "Save is held" with Try again; "With a problem" holds Save while the problem is listed;
 *  - Esc and the backdrop do nothing while saving. Light and dark, 390 px.
 *  - 2026-10-12 "With a form" (`lead`): a form above the table — the value takes the focus, every key works the New column
 *    out again, Save is held with "Type a percent" until one is typed (`leadHeld`), Enter sends nothing; once done the
 *    form is gone.
 */
/** "With a form": three bids raised by the percent typed above the table. */
const BIDS = [{ id: 'k1', what: 'rain jacket', cents: 40 }, { id: 'k2', what: 'race jacket', cents: 55 }, { id: 'k3', what: 'leather jacket', cents: 120 }]
const euro = (cents: number) => `€${(cents / 100).toFixed(2)}`

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
  const [withForm, setWithForm] = useState(false)
  const [pct, setPct] = useState('')
  const percent = /^\d{1,3}$/.test(pct.trim()) && Number(pct) > 0 ? Number(pct) : null
  const raised: ReviewChange[] = BIDS.map((b) => ({ id: b.id, what: b.what, now: euro(b.cents), next: percent === null ? '—' : euro(Math.round(b.cents * (1 + percent / 100))) }))

  const start = (how: 'ok' | 'fail' | 'problem') => {
    setWithForm(false)
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
  const openForm = () => { setWithForm(true); setPct(''); setProblems([]); setState({ phase: 'ready' }); setOpen(true) }
  const sendForm = () => {
    setState({ phase: 'saving' })
    setTimeout(() => setState({ phase: 'done', results: Object.fromEntries(BIDS.map((b) => [b.id, { ok: true, words: 'Sent' }])) }), 600)
  }

  return (
    <section id="review-changes-modal-example" style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--nds-space-8)' }}>
      <Button variant="primary" onClick={() => start('ok')}>Review 3 changes…</Button>
      <Button onClick={() => start('fail')}>Read fails</Button>
      <Button onClick={() => start('problem')}>With a problem</Button>
      <Button onClick={openForm}>With a form</Button>
      <ReviewChangesModal
        open={open}
        onClose={() => setOpen(false)}
        changes={withForm ? raised : CHANGES}
        state={state}
        title={withForm ? 'Change 3 bids' : undefined}
        summary={withForm ? 'Sends to Amazon now.' : 'Nexus only: rule settings are never sent to Amazon.'}
        lead={withForm ? (
          <form aria-label="Change bid" noValidate onSubmit={(e) => e.preventDefault()} style={{ width: 'min(100%, 160px)' }}>
            <Field label="Raise by">
              <Input size="sm" suffix="%" inputMode="decimal" placeholder="10" value={pct} onChange={(e) => setPct(e.target.value)} data-autofocus />
            </Field>
          </form>
        ) : undefined}
        leadHeld={withForm && percent === null ? 'Type a percent' : null}
        saveLabel={withForm ? 'Send 3 bids' : undefined}
        doneVerb={withForm ? 'sent' : undefined}
        problems={problems}
        onSave={withForm ? sendForm : save}
        onRetry={() => start('ok')}
        onUndo={() => { setUndoing(true); setTimeout(() => { setUndoing(false); setOpen(false) }, 600) }}
        undoing={undoing}
      />
    </section>
  )
}
