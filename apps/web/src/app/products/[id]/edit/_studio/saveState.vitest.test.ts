/**
 * PES.1 — the in-flight guard and the header's save state (parity 8.19 + the SaveIndicator contract).
 *
 * Split evidence, per hub ruling #101. PES.2's browser pass witnessed the LIVE half: the guard inert
 * at zero pending after a real confirmed write, the listener chain delivering, the filters firing and
 * `preventDefault` taking effect (through a `window.confirm` stub — the real dialog BLOCKS
 * automation). What is asserted here is the half that races API latency in a browser: which save
 * state produces which decision.
 */

import { describe, expect, it } from 'vitest'

import {
  describeSaveState,
  emptyLedger,
  guardIsArmed,
  leaveConfirmMessage,
  ledgerCleared,
  ledgerPending,
  ledgerResolved,
  ledgerState,
  pendingWrites,
  shouldInterceptLeave,
  type LeaveAttempt,
  type SaveLedger,
} from './saveState'
import type { StudioSaveState } from './types'

const clock = () => '12:41'

describe('what arms the guard', () => {
  it('is inert with nothing in flight', () => {
    expect(guardIsArmed({ kind: 'idle' })).toBe(false)
    expect(guardIsArmed({ kind: 'saved', at: 1, count: 9 })).toBe(false)
    expect(guardIsArmed({ kind: 'saving', pending: 0 })).toBe(false)
  })

  it('arms while writes are in flight, at any count', () => {
    expect(guardIsArmed({ kind: 'saving', pending: 1 })).toBe(true)
    expect(pendingWrites({ kind: 'saving', pending: 40 })).toBe(40)
  })

  it('🔴 STAYS armed after a refusal that left other writes in flight', () => {
    // The original guard checked `kind === 'saving'` and so went inert the moment anything failed —
    // exactly when an operator is most likely to navigate away. A refusal is not a report that the
    // others landed.
    const afterRefusal: StudioSaveState = { kind: 'error', failed: 1, pending: 3, message: 'Refused.' }
    expect(guardIsArmed(afterRefusal)).toBe(true)
    expect(pendingWrites(afterRefusal)).toBe(3)
  })

  it('is inert once a refusal is the ONLY thing left', () => {
    expect(guardIsArmed({ kind: 'error', failed: 2, pending: 0, message: 'Refused.' })).toBe(false)
  })
})

describe('which clicks are interrupted', () => {
  const leaving: LeaveAttempt = {
    pending: 2,
    defaultPrevented: false,
    button: 0,
    metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    anchorTarget: null,
    href: '/products',
    dest: { origin: 'http://localhost:3000', pathname: '/products' },
    currentOrigin: 'http://localhost:3000',
    currentPathname: '/products/abc/edit/studio',
  }

  it('interrupts a plain in-app navigation while writes are in flight', () => {
    expect(shouldInterceptLeave(leaving)).toBe(true)
  })

  it('never interrupts when nothing is in flight', () => {
    expect(shouldInterceptLeave({ ...leaving, pending: 0 })).toBe(false)
  })

  it('interrupts for an unsaved editor draft even before it has started a request', () => {
    expect(shouldInterceptLeave({ ...leaving, pending: 0, blocked: true })).toBe(true)
    expect(leaveConfirmMessage(0, 'Save or discard changes in the open editor before publishing.'))
      .toBe('Product changes are unsaved or unconfirmed. Leave anyway and lose them?')
    expect(leaveConfirmMessage(0, 'Resolve unsaved changes before publishing: SKU is locked.'))
      .toBe('Product changes are unsaved or unconfirmed. Leave anyway and lose them?')
  })

  it.each(['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const)(
    'lets a %s-click through — it opens a NEW tab and leaves this one, and its writes, alone',
    (mod) => expect(shouldInterceptLeave({ ...leaving, [mod]: true })).toBe(false),
  )

  it('lets target="_blank" through for the same reason', () => {
    expect(shouldInterceptLeave({ ...leaving, anchorTarget: '_blank' })).toBe(false)
  })

  it('🔴 does NOT fire on the studio\'s own controls', () => {
    // A scope chip or a tab is a navigation to the SAME pathname. Without this exemption the guard
    // would challenge the operator for changing a chip, which is not leaving anything.
    expect(shouldInterceptLeave({
      ...leaving,
      dest: { origin: 'http://localhost:3000', pathname: '/products/abc/edit/studio' },
    })).toBe(false)
  })

  it('leaves a cross-origin link to beforeunload', () => {
    expect(shouldInterceptLeave({
      ...leaving,
      dest: { origin: 'https://amazon.it', pathname: '/dp/B0' },
    })).toBe(false)
  })

  it('ignores non-navigations: a non-anchor click, a hash, an empty href, a middle-click, an already-handled event', () => {
    expect(shouldInterceptLeave({ ...leaving, href: null, dest: null })).toBe(false)
    expect(shouldInterceptLeave({ ...leaving, href: '#panel' })).toBe(false)
    expect(shouldInterceptLeave({ ...leaving, href: '' })).toBe(false)
    expect(shouldInterceptLeave({ ...leaving, button: 1 })).toBe(false)
    expect(shouldInterceptLeave({ ...leaving, defaultPrevented: true })).toBe(false)
    expect(shouldInterceptLeave({ ...leaving, dest: null })).toBe(false)
  })

  it('names the number at stake, plural-correct', () => {
    expect(leaveConfirmMessage(1)).toBe('1 change is still saving. Leave anyway and lose it?')
    expect(leaveConfirmMessage(4)).toBe('4 changes are still saving. Leave anyway and lose them?')
  })
})

describe('what the header says', () => {
  it('🔴 idle is NOT "Saved" — nothing has been written this session', () => {
    const d = describeSaveState({ kind: 'idle' }, clock)
    expect(d.text).toBe('Autosave on')
    expect(d.text).not.toMatch(/saved/i)
  })

  it('counts what is in flight while saving', () => {
    expect(describeSaveState({ kind: 'saving', pending: 3 }, clock).text).toBe('Saving 3…')
  })

  it('saving → saved carries the clock and the session count', () => {
    const d = describeSaveState({ kind: 'saved', at: 0, count: 1 }, clock)
    expect(d.kind).toBe('saved')
    expect(d.text).toBe('Saved 12:41')
    expect(d).toHaveProperty('title', '1 change saved this session')
    expect(describeSaveState({ kind: 'saved', at: 0, count: 12 }, clock)).toHaveProperty(
      'title', '12 changes saved this session',
    )
  })

  it('a refusal reports the failure AND what is still out there, in the server\'s own words', () => {
    const d = describeSaveState(
      { kind: 'error', failed: 1, pending: 3, message: 'SKU is locked on a live listing.' },
      clock,
    )
    expect(d.text).toBe('1 change not saved · 3 in flight')
    // Verbatim: rewording a refusal gives the operator two explanations for one event.
    expect(d).toHaveProperty('title', 'SKU is locked on a live listing.')
  })

  it('drops the in-flight clause when nothing is left in flight', () => {
    expect(describeSaveState({ kind: 'error', failed: 2, pending: 0, message: 'x' }, clock).text)
      .toBe('2 changes not saved')
  })
})

/* ── the save ledger (#693) ─────────────────────────────────────────────────────────────────
 *
 * The four cases the hub named, plus the regression that produced the ruling. These drive the SAME
 * functions `useSaveMachine` calls — the hook is now wiring — because vitest here is node-only and
 * a test that re-derived the arithmetic beside the hook would assert its own scaffolding.
 *
 * `writeId` is shaped as `masterWrite.ts:87` builds it: `${rowId}:${Date.now()}`, a NEW id per
 * attempt. That is the whole defect, so the tests must not use stable ids.
 */
describe('SaveLedger — the header counts rows with unsaved work NOW, not attempts', () => {
  const ROW_A = 'cmokmy3a40078pm0p1fvnu523'
  const ROW_B = 'cmokmy3a40079pm0p1fvnu524'
  const w = (rowId: string, n: number) => `${rowId}:${1788350000000 + n}`

  /** One attempt: pending → resolved, as the sheet does it. */
  const attempt = (l: SaveLedger, rowId: string, n: number, ok: boolean): SaveLedger =>
    ledgerResolved(ledgerPending(l, w(rowId, n), rowId), w(rowId, n), ok, 1788350000000 + n, rowId)

  it('🔴 REGRESSION: two failed attempts on ONE row count as ONE, not two', () => {
    // Measured on screen before the fix: the header said "2 changes not saved" with one refused
    // cell, because each attempt minted a new writeId and the set only grew.
    let l = attempt(emptyLedger, ROW_A, 1, false)
    l = attempt(l, ROW_A, 2, false)
    expect(l.failed.size).toBe(1)
    expect(ledgerState(l)).toMatchObject({ kind: 'error', failed: 1 })
  })

  it('(1) a refusal then a SUCCESS on the same row leaves nothing unsaved', () => {
    let l = attempt(emptyLedger, ROW_A, 1, false)
    expect(ledgerState(l).kind).toBe('error')
    l = attempt(l, ROW_A, 2, true) // the operator retypes and it lands — a NEW writeId
    expect(l.failed.size).toBe(0)
    expect(ledgerState(l)).toMatchObject({ kind: 'saved', count: 1 })
  })

  it('(2) a refusal then Reload-confirm leaves nothing unsaved, and claims no save', () => {
    const l = attempt(emptyLedger, ROW_A, 1, false)
    const after = ledgerCleared(l, [ROW_A])
    expect(after.failed.size).toBe(0)
    // 🔴 `idle`, never `saved`: discarding work is not a save, and the count must not invent one.
    expect(ledgerState(after)).toEqual({ kind: 'idle' })
    expect(after.savedCount).toBe(0)
  })

  it('discarding an unconfirmed save clears only that subject’s pending acknowledgement', () => {
    const ledger = ledgerPending(ledgerPending(emptyLedger, 'a-write', ROW_A), 'b-write', ROW_B)
    const after = ledgerCleared(ledger, [ROW_A])
    expect([...after.inFlight]).toEqual(['b-write'])
    expect([...after.subjects]).toEqual([['b-write', ROW_B]])
    expect(after.savedCount).toBe(0)
  })

  it('(3) two rows refused, one fixed → 1', () => {
    let l = attempt(emptyLedger, ROW_A, 1, false)
    l = attempt(l, ROW_B, 2, false)
    expect(l.failed.size).toBe(2)
    l = attempt(l, ROW_A, 3, true)
    expect(ledgerState(l)).toMatchObject({ kind: 'error', failed: 1 })
    expect([...l.failed]).toEqual([ROW_B])
  })

  it('(4) a refusal on A and a success on B still reports 1 — B does not absolve A', () => {
    let l = attempt(emptyLedger, ROW_A, 1, false)
    l = attempt(l, ROW_B, 2, true)
    expect(ledgerState(l)).toMatchObject({ kind: 'error', failed: 1 })
    expect([...l.failed]).toEqual([ROW_A])
  })

  it('clearing a row that never failed changes nothing', () => {
    const l = attempt(emptyLedger, ROW_A, 1, false)
    expect(ledgerCleared(l, [ROW_B]).failed.size).toBe(1)
  })

  it('a save keeps ITS OWN timestamp when a later clear settles the state', () => {
    // The lie this prevents: "Saved 14:52" for a save that happened at 14:39.
    let l = attempt(emptyLedger, ROW_B, 5, true)
    const landedAt = l.lastSavedAt
    l = attempt(l, ROW_A, 6, false)
    const after = ledgerCleared(l, [ROW_A])
    expect(ledgerState(after)).toEqual({ kind: 'saved', at: landedAt, count: 1 })
  })

  it('an in-flight write still counts as pending beside a refusal', () => {
    let l = attempt(emptyLedger, ROW_A, 1, false)
    l = ledgerPending(l, w(ROW_B, 2), ROW_B)
    expect(ledgerState(l)).toMatchObject({ kind: 'error', failed: 1, pending: 1 })
  })

  it('a caller with no subject is counted per write — the old behaviour, deliberately kept', () => {
    // The image workspace and the channel sheet pass no subject yet; their failures accumulate
    // per attempt until they do. Pinned so the change is visible when they adopt it.
    let l = ledgerResolved(ledgerPending(emptyLedger, 'img-1'), 'img-1', false, 1)
    l = ledgerResolved(ledgerPending(l, 'img-2'), 'img-2', false, 2)
    expect(l.failed.size).toBe(2)
  })
})
