/**
 * PES.7 — an image write clears its own refusal when it is retried (#708).
 *
 * 🔴 What makes this a test and not a restatement. The assertion runs `reportedWrite` — the SAME
 * function `useImageWorkspace.write()` calls — against the REAL ledger from `../saveState`, not a
 * local model of either. `apps/web` vitest is `environment: 'node'` with no jsdom, so the hook
 * cannot be rendered (`saveState.ts:19-34`); driving the pure half against the pure arithmetic is
 * what keeps this from asserting its own scaffolding and passing while the browser is wrong.
 *
 * The control is the second half of every case: the SAME sequence with the subject dropped — which
 * is exactly what the code did before this fix — must leave the header still counting. A test whose
 * negative arm cannot fail has not been shown to be a test.
 */
import { describe, expect, it } from 'vitest'

import {
  emptyLedger,
  ledgerPending,
  ledgerResolved,
  ledgerState,
  type SaveLedger,
} from '../saveState'
import { reportedWrite, writeSubject, type WriteReporterLike } from './imageWrites'
import type { ApiResult } from './api'

/**
 * The real reporter with the React taken out: `contracts.tsx:278-288` does exactly this — call the
 * ledger function, keep the result. If that hook's two lines change shape, this double is what has
 * to be re-read; it is deliberately three lines long so that stays cheap.
 */
function ledgerReporter() {
  let l: SaveLedger = emptyLedger
  const reporter: WriteReporterLike = {
    pending: (id, subject) => { l = ledgerPending(l, id, subject) },
    resolved: (id, ok, _msg, subject) => { l = ledgerResolved(l, id, ok, 1_000, subject) },
  }
  return {
    reporter,
    get ledger() { return l },
    /** What the header would render — the actual thing under test, not an internal field. */
    get state() { return ledgerState(l) },
    get unsaved() { return l.failed.size },
  }
}

const refused = <T,>(message = 'The server refused a change.'): (() => Promise<ApiResult<T>>) =>
  () => Promise.resolve({ ok: false, status: 409, message })
const accepted = <T,>(data: T): (() => Promise<ApiResult<T>>) =>
  () => Promise.resolve({ ok: true, data })

describe('an image write is filed under its subject (#708)', () => {
  it('a refusal then a success ON ONE ASSET leaves 0 unsaved', async () => {
    const h = ledgerReporter()
    const subject = writeSubject.asset('img_abc')

    const first = await reportedWrite(h.reporter, subject, refused<{ id: string }>())
    expect(first.ok).toBe(false)
    expect(h.unsaved).toBe(1)
    expect(h.state.kind).toBe('error')

    const second = await reportedWrite(h.reporter, subject, accepted({ id: 'img_abc' }))
    expect(second.ok).toBe(true)
    // The point of the whole change: the retry LANDED, so nothing is unsaved.
    expect(h.unsaved).toBe(0)
    expect(h.state).toEqual({ kind: 'saved', at: 1_000, count: 1 })
    expect(h.ledger.inFlight.size).toBe(0)
  })

  it('CONTROL — the same sequence WITHOUT a subject strands the failure (the defect)', async () => {
    // This is what `write()` did before #708: `pending(id)` with a fresh `img-N` every attempt, so
    // the retry could not match the attempt that failed. If this arm ever reaches 0, the mechanism
    // being tested above is not the mechanism doing the work.
    const h = ledgerReporter()
    const noSubject = async (run: () => Promise<ApiResult<unknown>>) => {
      const id = `img-${Math.random()}`
      h.reporter.pending(id)
      const res = await run()
      h.reporter.resolved(id, res.ok, res.ok ? undefined : res.message)
      return res
    }

    await noSubject(refused())
    await noSubject(accepted({ id: 'img_abc' }))
    expect(h.unsaved).toBe(1)          // the refusal is still counted after a successful retry
    expect(h.state.kind).toBe('error')
  })

  it('two refusals on the same asset count as ONE unsaved change, not a history of attempts', async () => {
    const h = ledgerReporter()
    const subject = writeSubject.asset('img_abc')
    await reportedWrite(h.reporter, subject, refused())
    await reportedWrite(h.reporter, subject, refused())
    expect(h.unsaved).toBe(1)
    await reportedWrite(h.reporter, subject, accepted(null))
    expect(h.unsaved).toBe(0)
  })

  it('keeps two different assets apart — one landing does not clear the other', async () => {
    const h = ledgerReporter()
    await reportedWrite(h.reporter, writeSubject.asset('img_a'), refused())
    await reportedWrite(h.reporter, writeSubject.asset('img_b'), refused())
    expect(h.unsaved).toBe(2)
    await reportedWrite(h.reporter, writeSubject.asset('img_a'), accepted(null))
    expect(h.unsaved).toBe(1)
    expect([...h.ledger.failed]).toEqual([writeSubject.asset('img_b')])
  })

  it('overlapping writes to ONE asset each clear their own in-flight row', async () => {
    // Why the attempt id stays unique while the subject repeats (`imageWrites.ts:36-43`): a delete
    // landing during a slow patch must not remove the patch from `inFlight`.
    const h = ledgerReporter()
    const subject = writeSubject.asset('img_abc')
    let releaseSlow: (r: ApiResult<null>) => void = () => {}
    const slow = new Promise<ApiResult<null>>((r) => { releaseSlow = r })

    const slowWrite = reportedWrite(h.reporter, subject, () => slow)
    await Promise.resolve()
    expect(h.ledger.inFlight.size).toBe(1)

    await reportedWrite(h.reporter, subject, accepted(null))
    // The fast one landed; the slow one is still out.
    expect(h.ledger.inFlight.size).toBe(1)
    expect(h.state.kind).toBe('saving')

    releaseSlow({ ok: true, data: null })
    await slowWrite
    expect(h.ledger.inFlight.size).toBe(0)
    expect(h.unsaved).toBe(0)
  })

  it('a surface subject is per surface, so two panels on one endpoint do not clear each other', async () => {
    const h = ledgerReporter()
    await reportedWrite(h.reporter, writeSubject.surface('amazon-matrix'), refused())
    await reportedWrite(h.reporter, writeSubject.surface('ebay-grid'), refused())
    expect(h.unsaved).toBe(2)
    await reportedWrite(h.reporter, writeSubject.surface('amazon-matrix'), accepted(null))
    expect([...h.ledger.failed]).toEqual([writeSubject.surface('ebay-grid')])
  })

  it('the three subject kinds cannot collide', () => {
    // `asset:x`, `upload:x` and `surface:x` are three different pieces of work with one name.
    const names = [writeSubject.asset('x'), writeSubject.upload('x'), writeSubject.surface('x')]
    expect(new Set(names).size).toBe(3)
  })

  it('an attempt id is never reused', () => {
    // The subject repeats; the attempt must not, or `inFlight` would lose a row it still holds.
    const h = ledgerReporter()
    const seen = new Set<string>()
    const rec: WriteReporterLike = { pending: (id) => { seen.add(id) }, resolved: () => {} }
    void reportedWrite(rec, writeSubject.asset('a'), accepted(null))
    void reportedWrite(rec, writeSubject.asset('a'), accepted(null))
    void reportedWrite(rec, writeSubject.asset('a'), accepted(null))
    expect(seen.size).toBe(3)
    expect(h.unsaved).toBe(0)
  })
})
