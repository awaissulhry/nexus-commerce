import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { render, textOf } from '../../../../lib/record-thread/parts/testing'
import { AMEND_PREVIEW, LINE_BLK, LINE_RED, order } from '../_demo/fixtures'
import type { AmendPreview } from '../api'
import { autoReasonOf, customerLocaleOf, customerQuestionOf, EMPTY_HISTORY, feeProblem, removeLine, savedNotice, setCell } from './lines-draft'
import { AUTOMATIC_REASONS } from '@nexus/factory-domain/sales/amendments/reasons'
import type { ReviewState } from './lines-tab-model'
import { ReviewSave } from './view/lines/ReviewSave'
import { SaveBar } from './view/lines/SaveBar'

// The DS Modal draws into a portal once hydrated, never on the server: here it draws in place (as lines-held.vitest.test.ts does).
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, children, footer }: { open: boolean; title?: unknown; children?: unknown; footer?: unknown }) => (open ? createElement('section', { role: 'dialog', 'data-modal': '' }, createElement('h2', null, title as never), children as never, footer as never) : null)
  return { ...actual, Modal }
})

/**
 * F-OL-03 (Order LINES lane; 10-design-tab §11, §12, §15): the save bar ("{n} changes not saved · Undo last edit · Discard · Review and
 * save…"), the ONE Review window (Why optional, ONE tick, no money for Sales — not even which way the total moved), the notice after a
 * save, and the container's wiring (only my changed lines sent, the ask after a ticked save, a 409 said inside the window). Made-up data.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const production = order('IN_PRODUCTION')
const draft = removeLine(setCell(EMPTY_HISTORY, production, LINE_BLK, '50', 3), production, LINE_RED).draft
const preview = (over: Partial<AmendPreview> = {}): AmendPreview => ({ ...AMEND_PREVIEW, ok: true, problems: [], amountChanges: true, totalUp: true, ...over })
const review = (over: Partial<ReviewState> = {}): ReviewState => ({ phase: 'ready', key: 'k', preview: preview(), problem: null, why: null, words: '', ask: null, tell: { words: '', chosen: null }, extraOutcome: null, fee: '', changedMeanwhile: false, ...over })

describe('F-OL-03: the notice after a save and the fee of a priced change', () => {
  it('"Saved · WO changed · waiting for production" and "the customer is asked" — never an amendment number or an amount', () => {
    expect(savedNotice({ applied: [], waiting: [] }, null)).toEqual({ key: 'save.done.plain', params: {} })
    // F-OC-304: where the ask really went — by e-mail, or in the portal only — said once it went.
    expect(savedNotice({ applied: [{ changeId: 'c', workOrderId: 'w', number: 'WO-00021', route: 'APPLY_TO_DRAFT' as never, reprint: false }], waiting: [] }, 'email', 'Brand Alpha')).toEqual({ key: 'changesTab.saved.changedEmail', params: { changed: 'WO-00021', customer: 'Brand Alpha' } })
    expect(savedNotice({ applied: [], waiting: [] }, 'portal', 'Brand Alpha')).toEqual({ key: 'changesTab.saved.plainPortal', params: { customer: 'Brand Alpha' } })
    const both = savedNotice({ applied: [{ changeId: 'c', workOrderId: 'w', number: null, route: 'APPLY_TO_DRAFT' as never, reprint: false }], waiting: [{ changeId: 'd', workOrderId: 'v', number: 'WO-00022', words: { it: 'x', en: 'x' } }] }, null)
    expect(both).toEqual({ key: 'save.done.both', params: { changed: 'WO-…', waits: 'WO-00022' } })
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const which of ['plain', 'changed', 'waits', 'both']) {
        expect(t(`save.done.${which}`, { changed: 'WO-1', waits: 'WO-2' }), `${locale} ${which}`).not.toMatch(/save\.done|\{/)
        for (const reach of ['Email', 'Portal']) expect(t(`changesTab.saved.${which}${reach}`, { changed: 'WO-1', waits: 'WO-2', customer: 'Brand Alpha' }), `${locale} ${which}${reach}`).not.toMatch(/changesTab|\{/)
      }
    }
  })

  it('a reason nobody typed (the server\'s automatic words, ol-s1) is said in the reader\'s words; a typed one as typed', () => {
    expect(autoReasonOf(AUTOMATIC_REASONS.amend)).toEqual({ key: 'lines.autoReason.amend' })
    expect(autoReasonOf(AUTOMATIC_REASONS.close)).toEqual({ key: 'lines.autoReason.close' })
    expect(autoReasonOf('Il cliente vuole due giacche in più.')).toBeNull()
    expect(autoReasonOf(null)).toBeNull()
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const kind of Object.keys(AUTOMATIC_REASONS)) expect(t(`lines.autoReason.${kind}`), `${locale} ${kind}`).not.toBe(`lines.autoReason.${kind}`)
    }
  })

  it('a change fee may be empty or 0 (B-OL-016), at most 2 decimals', () => {
    expect(feeProblem('')).toBe(false)
    expect(feeProblem('0')).toBe(false)
    expect(feeProblem('25,50')).toBe(false)
    expect(feeProblem('2,555')).toBe(true)
    expect(feeProblem('-1')).toBe(true)
  })
})

describe('F-OL-03: the save bar', () => {
  it('"{n} changes not saved" with "Undo last edit" inside the message, Discard, "Review and save…" (en, it); nothing while the draft is empty', () => {
    const en = render(createElement(SaveBar, { order: production, draft, canUndo: true, held: null, saving: false }), 'en')
    for (const words of ['2 changes not saved', 'Undo last edit', 'Discard', 'Review and save…']) expect(textOf(en), words).toContain(words)
    const it = render(createElement(SaveBar, { order: production, draft, canUndo: true, held: null, saving: false }), 'it')
    for (const words of ['2 modifiche non salvate', "Annulla l'ultimo passo", 'Rivedi e salva…']) expect(textOf(it), words).toContain(words)
    expect(textOf(render(createElement(SaveBar, { order: production, draft: EMPTY_HISTORY.draft, canUndo: false, held: null, saving: false }), 'en'))).not.toContain('Review and save')
  })

  it('a hold is said on "Review and save…" in words (never a dim button without them)', () => {
    const html = render(createElement(SaveBar, { order: production, draft, canUndo: false, held: 'BLK · Nero, size 50: 1 already shipped — raise it to 1', saving: false }), 'en')
    expect(html).toContain('aria-description="BLK · Nero, size 50: 1 already shipped — raise it to 1"')
  })
})

describe('F-OL-03: Review and save — one window, the money wall, ONE tick, Why optional', () => {
  const draw = (seesPrices: boolean, over: Partial<ReviewState> = {}, locale: 'en' | 'it' = 'en') => render(createElement(ReviewSave, { order: seesPrices ? production : { ...production, netAmount: undefined, vatAmount: undefined, grossAmount: undefined }, draft, review: review(over), seesPrices, freeze: null, floors: {}, portalGone: false, saving: false }), locale)

  it('the Owner: what changes per line, the total before → after, Why (optional) with its quick picks, the tick on (the total goes up)', () => {
    const text = textOf(draw(true))
    for (const words of ['Review and save · SO-2026-0088', 'What changes', '50: 2 → 3', 'Removed — closes with fewer pieces: work orders make it', 'Why (optional)', 'Customer asked', 'Our mistake', 'Production', 'Other…', 'Ask Moto Demo S.r.l. to accept the new order', 'Ticked because the total goes up', 'Back', 'Save changes']) expect(text, words).toContain(words)
    expect(draw(true)).toMatch(/<input(?=[^>]*type="checkbox")(?=[^>]*checked="")[^>]*>/)
  })

  it('Sales: pieces only, "the amount changes" — no amount, no currency, never which way; the tick on whenever the amount changes', () => {
    const html = draw(false, { preview: preview({ totalUp: undefined }) })
    const text = textOf(html)
    expect(text).toContain('Pieces 14 → 9 (−5)')
    expect(text).toContain('The amount changes')
    expect(text).toContain('Ticked because the amount changes')
    expect(text).not.toMatch(/€|EUR|goes up|goes down/)
    expect(text).not.toMatch(/\d+[.,]\d{2}/)
  })

  it('reading: Save changes held "Working out what changes…"; someone saved meanwhile: said at the top (en, it)', () => {
    expect(draw(true, { phase: 'reading', preview: null })).toContain('aria-description="Working out what changes…"')
    expect(textOf(draw(true, { changedMeanwhile: true }))).toContain('The order changed meanwhile: your changes are kept, the rest is new. Check again.')
    expect(textOf(draw(true, { changedMeanwhile: true }, 'it'))).toContain("L'ordine è cambiato nel frattempo")
  })

  it('every new word exists in both languages (no key on screen)', () => {
    for (const locale of LOCALES) {
      const html = draw(true, {}, locale)
      expect(html).not.toMatch(/\b(?:review|save|lines|lineMenu)\.[a-zA-Z.]+/)
    }
  })
})

describe('F-OL-03: the container — only my changes sent, the ask after a ticked save, a 409 said in the window, two people', () => {
  it('the sources say it', () => {
    const hook = read('./use-lines-draft.ts')
    expect(hook).toContain('lines: bodyLinesOf(historyRef.current.draft, order)')
    expect(hook).toContain('askCustomer: ask }, idempotency)')
    // F-OC-201 (R1, L5): flipped — the ask was made on the ORDER (`recordType: 'SalesOrder'`), which the server refuses ("A revised order
    // is asked on SalesOrderAmendment."), and a priced change asked nobody. Now ONE helper asks on the revision the save made, a plain
    // change with the tick and a priced change always.
    expect(hook).not.toContain("recordType: 'SalesOrder'")
    expect(hook).toContain('const target = askTargetOf(done)')
    // F-OC-304: the ask is awaited (it never throws: a failure is its own banner) so the notice says where it went.
    expect(hook).toContain('const reach = ask && target ? await askCustomer(target, customerQuestionOf(value, question), value) : null')
    expect(hook).toContain("savedNotice(done.workOrders, reach?.reach ?? null, value.party?.legalName ?? '')")
    expect(hook).toContain('const reach = await askRevisedOrder(api, value, amendmentId, question, { quotes: can.viewQuotes })')
    expect(read('./revised-order-ask.ts')).toContain("recordType: 'SalesOrderAmendment'")
    expect(hook).toContain("if (words.key === 'problem.write.moved')")
    expect(hook).toContain('const rebased = rebaseDraft(base, order, historyRef.current.draft)')
    // The draft empties before the answered order lands: my own save is never "rebased".
    expect(hook.indexOf('setHistory(EMPTY_HISTORY)')).toBeLessThan(hook.indexOf('return done.order'))
    const container = read('./OrderRecord.tsx')
    expect(container).toContain('const linesDraft = useLinesDraft({')
    expect(container).toContain('linesTab: linesDraft.model, // F-OL-03')
    expect(container).toContain('linesTab: linesDraft.actions, // F-OL-03')
    const tab = read('./view/LinesTab.tsx')
    expect(tab).toContain('<SaveBar order={order} draft={draft}')
    expect(tab).toContain('<ReviewSave order={order} draft={draft}')
    // ⌘S is the DS bar's own; the leave-page guard is the bar's too.
    expect(read('./view/lines/SaveBar.tsx')).toContain('saveShortcut')
  })
})

// ---- F-OL-08 (Order LINES lane): the customer reads the default question in THEIR language, in the portal's words ----
describe('F-OL-08: the REVISED_ORDER question — the words typed, else the default in the order\'s language (the portal\'s "voi")', () => {
  it('none typed: the order\'s language, whatever the office person reads; typed: as typed', () => {
    const italian = customerQuestionOf({ language: 'it', number: 'SO-2026-0088' }, '   ')
    expect(italian).toBe("Controllate le modifiche all'ordine SO-2026-0088 e accettate il nuovo ordine.")
    // The portal's register (voi), never the office's "tu".
    expect(italian).not.toMatch(/\b(?:Controlla|accetta)\b/)
    expect(customerQuestionOf({ language: 'en', number: 'SO-2026-0088' }, '')).toBe('Please check the changes to order SO-2026-0088 and accept the new order.')
    // A language the portal does not speak: Italian, as the ask itself is sent.
    expect(customerLocaleOf({ language: 'de' })).toBe('it')
    expect(customerQuestionOf({ language: 'en', number: 'SO-2026-0088' }, ' Le nuove taglie vanno bene? ')).toBe('Le nuove taglie vanno bene?')
  })

  it('the window sends only what was typed; the container picks the default in the customer\'s language and sends that language', () => {
    const review = read('./view/lines/ReviewSave.tsx')
    expect(review).toContain('question: review.tell.words.trim() })')
    expect(review).not.toContain("t('review.question'")
    const hook = read('./use-lines-draft.ts')
    expect(hook).toContain('customerQuestionOf(value, question)')
    expect(hook).toContain('language: customerLocaleOf(value) })')
  })
})
// ---- end F-OL-08
