import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { URGENCY_LOCK_REASON_MAX, URGENCY_OFFICE_BATCH_MAX } from '@nexus/factory-domain/production-brand/urgency'
import { ApiError } from '../../../lib/api/errors'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { CARD_LIMITS, urgencyDialogHeld, urgencyOutcomeOf, urgencyProblemOf, type UrgencyTarget } from './model'

/**
 * F-CW-302 (customer Work tab plan §4; lead settles S7, S14) — the urgency window (Set to regular… · Lock… · Unlock…), MOVED as it is
 * from the work order's Customer card (F-PR-05b) with these cases: its dialog rules, its outcome (PW-10), its refusals, its one write
 * with a fresh code. Two screens mount the ONE window — the work order's Customer card and the Orders sheet — and neither copies it.
 * Made-up orders only.
 */

const ORDER: UrgencyTarget = { id: 'order-1', number: 'SEED-SO-0042', customerRef: null }

describe('F-CW-302 — the urgency window, moved as it is (F-PR-05b)', () => {
  it('the dialog: a reason the customer reads for Set to regular and Lock (one line, ≤ 500); Unlock needs none', () => {
    expect(CARD_LIMITS).toEqual({ reason: URGENCY_LOCK_REASON_MAX, orders: URGENCY_OFFICE_BATCH_MAX })
    expect(urgencyDialogHeld('regular', '  ', false)).toEqual({ key: 'customerCard.urgency.held.reason' })
    expect(urgencyDialogHeld('lock', 'a\nb', false)).toEqual({ key: 'customerCard.urgency.held.line' })
    expect(urgencyDialogHeld('lock', 'x'.repeat(501), false)).toEqual({ key: 'customerCard.urgency.held.long', params: { count: 500 } })
    expect(urgencyDialogHeld('regular', 'Capacity', false)).toBeNull()
    expect(urgencyDialogHeld('unlock', '', false)).toBeNull()
    expect(urgencyDialogHeld('unlock', '', true)).toEqual({ key: 'held.busy' })
  })

  it('PW-10: the result names only the orders that were asked; any other row (or one not reached) is counted, never named', () => {
    const answer = {
      results: [
        { orderId: ORDER.id, number: ORDER.number, customerRef: null, outcome: 'DONE' as const, done: true, words: null, urgency: 'REGULAR' as const },
        { orderId: 'someone-else', number: 'SO-OTHER-1', customerRef: null, outcome: 'NO_RIGHT' as const, done: false, words: { en: 'Not yours', it: 'Non tuo' }, urgency: null },
      ],
      notFound: 2,
      replayed: false,
    }
    const outcome = urgencyOutcomeOf('regular', answer, [ORDER])
    expect(outcome).toEqual({ act: 'regular', done: [ORDER.number], notDone: [], notShown: 3 })
    expect(JSON.stringify(outcome)).not.toContain('SO-OTHER-1')
  })

  it('refusals in the window’s words', () => {
    expect(urgencyProblemOf(new ApiError('forbidden', 403, 'forbidden', 'x'))).toEqual({ key: 'customerCard.urgency.problem.forbidden' })
    expect(urgencyProblemOf(new ApiError('conflict', 409, 'conflict', 'x'))).toEqual({ key: 'customerCard.urgency.problem.conflict' })
    expect(urgencyProblemOf(new Error('x'))).toEqual({ key: 'customerCard.urgency.problem.failed' })
  })

  it('the writes are the API’s routes; the hook asks the host’s step-up (one step-up modal per page) and stays quiet when its code dialog is closed', () => {
    const api = readFileSync(join(__dirname, 'api.ts'), 'utf8')
    expect(api).toContain("'/production/brand-orders/urgency/regular'")
    expect(api).toContain("'/production/brand-orders/urgency/unlock'")
    expect(api).toContain('/production/brands/${encodeURIComponent(partyId)}/urgency')
    const hook = readFileSync(join(__dirname, 'use-urgency-override.ts'), 'utf8')
    expect(hook).toContain("guard('stepUp.urgencySentence'")
    // Either host's step-up hook rejects with an error of this name: the window says nothing then.
    expect(hook).toContain("error instanceof Error && error.name === 'StepUpCancelled'")
    for (const host of ['../../quality/_shared/hooks.ts', '../../sales/orders/hooks.ts']) expect(readFileSync(join(__dirname, host), 'utf8'), host).toContain("override name = 'StepUpCancelled'")
    // The sentence is in each host's own step-up catalogue.
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['production-work-orders'])['production-work-orders'] ?? {})
      expect(t('stepUp.urgencySentence'), locale).not.toBe('stepUp.urgencySentence')
    }
  })

  // ---- F-PR-16 (the browser walk): Enter sends only from the send button
  it('Enter in the reason field sends nothing: the dialog’s field sits in no form (Lock… and ⌘↵ send)', () => {
    // The DS Modal draws only in a browser: the window's own source is read (the walk checked the screen).
    const source = readFileSync(join(__dirname, 'view', 'UrgencyOverrideDialog.tsx'), 'utf8')
    expect(source).not.toContain('<form')
    expect(source).toContain('className="fw-pr-dialog"')
    expect(source).toContain('aria-keyshortcuts="Meta+Enter Control+Enter"')
  })
  // ---- end F-PR-16

  it('every word of the window and its outcome is the card’s own catalogue, in both languages (one set of words for one window)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['production']).production!)
      const params = { numbers: 'SEED-SO-0042', count: 2, number: 'SEED-SO-0042', why: 'x', po: 'PO-1' }
      for (const act of ['regular', 'lock', 'unlock'] as const)
        for (const key of [`customerCard.dialog.title.${act}`, `customerCard.dialog.go.${act}`, `customerCard.dialog.body.${act}`, `customerCard.urgency.outcome.${act}`, `customerCard.urgency.act.${act}`, `customerCard.urgency.notice.${act}`]) expect(t(key, params), `${locale} ${key}`).not.toBe(key)
      for (const key of ['customerCard.dialog.reason', 'customerCard.dialog.reasonHint', 'customerCard.dialog.alsoLock', 'customerCard.dialog.stepUp', 'customerCard.po', 'customerCard.urgency.outcome.none', 'customerCard.urgency.outcome.notDone', 'customerCard.urgency.outcome.unchanged', 'customerCard.urgency.outcome.notShown', 'common.cancel', 'common.dismiss', 'held.busy'])
        expect(t(key, params), `${locale} ${key}`).not.toBe(key)
    }
  })
})
