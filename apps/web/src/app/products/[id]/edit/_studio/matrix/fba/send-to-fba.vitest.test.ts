import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FBA_SEND_COPY, MIXED_BOX_DEFAULT, sendSummary, type FbaSendDraft, type FbaSendSku } from '@nexus/shared/fba-send'

import { CommandKey, IDEMPOTENCY_KEY_HEADER } from '@/lib/command-key'
import { fbaPlanInvalidations } from '@/lib/sync/use-listing-events'

import { MatrixSelectionActions } from '../MatrixSelectionActions'
import type { MatrixRead } from '../contract'
import { isFbaPlanEvent } from './plansDrawer'
import {
  OWNERS_DEFAULT, SEND_HELD, addPrimaryOf, addedUnits, caseSteppers, casesMax, casesOf, choiceOf, deleteDraft, draftAddRequest, draftLinesOf, draftPlans,
  draftSendRequest, draftUndoRequest, draftUpdateRequest, draftUrl, errorSentence, fbaPageHref, fetchSendDraft, footerLinks, hasAmazonListing, openPlans,
  ownersAsked, parseLines, parseSendDraft, parseSide, patchDraft, postDraftAdd, postSendDraft, problemBanners, problemsOf, sendDescription, sendHeld,
  sendPrimaryOf, sendProductIds, skuBoxes, skuCheck, startForm, startLines, summarize, summaryLine, underWayPlans, unitsMax, withCases, type SendForm,
} from './sendToFba'

/**
 * Send to FBA (Step 4 part E1, Owner 2026-10-07): the Matrix toolbar's `Send to FBA…`, its ONE dialog's model (defaults,
 * table, counts, refusals, the request) on the shared rules, the three routes it calls, and the bridge that turns the
 * server's `fba.plan_changed` into the stock re-read the Matrix and the plans drawer listen to.
 */

const sku = (over: Partial<FbaSendSku> & Pick<FbaSendSku, 'productId' | 'sku'>): FbaSendSku => ({
  msku: over.sku, caseSizes: [], unitWeightKg: 0.9, unit: { lengthCm: 30, widthCm: 20, heightCm: 10 },
  name: '', onHand: 50, free: 50, freeSealed: [], freeLoose: 50, prepOwner: 'SELLER', labelOwner: 'SELLER', openPlanUnits: 0, ...over,
})
const GALE_M = sku({ productId: 'p-m', sku: 'GALE-M', caseSizes: [{ unitsPerCase: 12, case: { lengthCm: 60, widthCm: 40, heightCm: 35, weightKg: 14.5 } }], free: 48, freeSealed: [{ unitsPerCase: 12, cases: 4 }], freeLoose: 0 })
// Two case sizes: 2×12 + 1×6 sealed and free, 3 loose (39 units).
const GALE_S = sku({
  productId: 'p-s', sku: 'GALE-S', free: 39, freeLoose: 3,
  caseSizes: [{ unitsPerCase: 6, case: { lengthCm: 30, widthCm: 40, heightCm: 35, weightKg: 7.4 } }, { unitsPerCase: 12, case: { lengthCm: 60, widthCm: 40, heightCm: 35, weightKg: 14.5 } }],
  freeSealed: [{ unitsPerCase: 12, cases: 2 }, { unitsPerCase: 6, cases: 1 }],
})
const GALE_L = sku({ productId: 'p-l', sku: 'GALE-L', free: 12, freeLoose: 12 })
const draftOf = (over: Partial<FbaSendDraft> = {}): FbaSendDraft => ({
  from: { id: 'loc-1', code: 'IT-MAIN', name: 'Main warehouse', town: 'Rimini', country: 'IT', isDefault: true },
  locations: [{ id: 'loc-1', code: 'IT-MAIN', name: 'Main warehouse', town: 'Rimini', country: 'IT', isDefault: true }],
  market: 'IT',
  markets: [{ code: 'IT', marketplaceId: 'APJ6JRA9NG5V4', name: 'Amazon IT', accountId: 'acc-1' }],
  readyToShipOn: '2026-10-08',
  today: '2026-10-07',
  address: { missing: [], summary: 'Main warehouse, Rimini' },
  mixedBox: { ...MIXED_BOX_DEFAULT },
  skus: [GALE_M, GALE_L],
  draftId: null,
  lines: [],
  ...over,
})
/** `cases: 2` = two cases of 12 (GALE-M's one size); a list names the sizes. */
const withLines = (form: SendForm, lines: Record<string, { cases?: number | Array<{ unitsPerCase: number; cases: number }>; looseUnits?: number }>): SendForm => ({
  ...form,
  lines: {
    ...form.lines,
    ...Object.fromEntries(Object.entries(lines).map(([id, l]) => [id, {
      productId: id,
      cases: Array.isArray(l.cases) ? l.cases : l.cases ? [{ unitsPerCase: 12, cases: l.cases }] : [],
      looseUnits: l.looseUnits ?? 0,
    }])),
  },
})

describe('the toolbar: who is sent and when it is offered', () => {
  const rows = [{ id: 'root', isParent: true }, { id: 'a', isParent: false }, { id: 'b', isParent: false }, { id: 'c', isParent: false }]

  it('the ticked variations in grid order; a ticked parent sends every variation; a parent alone never', () => {
    expect(sendProductIds([{ id: 'c', isParent: false }, { id: 'a', isParent: false }], rows)).toEqual(['a', 'c'])
    expect(sendProductIds([{ id: 'root', isParent: true }], rows)).toEqual(['a', 'b', 'c'])
    expect(sendProductIds([{ id: 'root', isParent: true }, { id: 'b', isParent: false }], rows)).toEqual(['a', 'b', 'c'])
    // A family with no variation sends its one row.
    expect(sendProductIds([{ id: 'solo', isParent: true }], [{ id: 'solo', isParent: true }])).toEqual(['solo'])
  })

  it('held while loading, with nothing to send, or over 200 SKUs; the hover line counts the SKUs', () => {
    expect(sendHeld({ loading: true, productIds: ['a'] })).toBe(SEND_HELD.loading)
    expect(sendHeld({ loading: false, productIds: [] })).toBe(SEND_HELD.none)
    expect(sendHeld({ loading: false, productIds: Array.from({ length: 201 }, (_, i) => `p${i}`) })).toBe(SEND_HELD.tooMany)
    expect(sendHeld({ loading: false, productIds: ['a'] })).toBeNull()
    expect(sendDescription(1, false)).toBe('1 SKU to Amazon FBA')
    expect(sendDescription(6, true)).toBe('The whole family: 6 SKUs to Amazon FBA')
  })

  it('offered only for a family on Amazon (a listed Amazon market or an Amazon listing on a row)', () => {
    const coord = (key: string, channel: string, listed: number | null) => ({ key, channel, connected: true, listed }) as MatrixRead['coordinates'][number]
    expect(hasAmazonListing(null)).toBe(false)
    expect(hasAmazonListing({ coordinates: [coord('EBAY:IT', 'EBAY', 3)], rows: [] })).toBe(false)
    expect(hasAmazonListing({ coordinates: [coord('AMAZON:IT', 'AMAZON', 2)], rows: [] })).toBe(true)
    expect(hasAmazonListing({ coordinates: [coord('AMAZON:IT', 'AMAZON', null)], rows: [{ id: 'a', cells: { 'AMAZON:IT': { listingId: 'l1' } } } as never] })).toBe(true)
    expect(hasAmazonListing({ coordinates: [coord('AMAZON:IT', 'AMAZON', 0)], rows: [{ id: 'a', cells: {} } as never] })).toBe(false)
  })

  it('the button: "Send to FBA…", held = aria-disabled + its reason (never a silent disabled); absent when not offered', () => {
    const html = (sendToFba: Parameters<typeof MatrixSelectionActions>[0]['sendToFba']) =>
      renderToStaticMarkup(createElement(MatrixSelectionActions, { onEdit: () => undefined, editHeld: null, stockSource: null, sendToFba }))
    expect(html(null)).not.toContain(FBA_SEND_COPY.open)
    const ready = html({ description: '2 SKUs to Amazon FBA', held: null, onSelect: () => undefined })
    expect(ready).toContain(FBA_SEND_COPY.open)
    expect(ready).toContain('title="2 SKUs to Amazon FBA"')
    const held = html({ description: 'x', held: SEND_HELD.loading, onSelect: () => undefined })
    expect(held).toContain('aria-disabled="true"')
    expect(held).toContain(`title="${SEND_HELD.loading}"`)
    expect(held).not.toMatch(/\sdisabled=""/)
  })

  it('the open plans of the family, from the Matrix read (an older server: none)', () => {
    expect(openPlans(null)).toEqual([])
    expect(openPlans({ fbaPlans: undefined })).toEqual([])
    expect(openPlans({ fbaPlans: [{ id: 'a', name: 'A', status: 'QUEUED', units: 3 }, { id: 'b', name: 'B', status: 'CANCELLED', units: 2 }] }).map((p) => p.id)).toEqual(['a'])
  })

  it('drafts and plans under way apart: a draft is open but holds nothing (the FBA cell\'s "in Nexus plan" skips it)', () => {
    const read = { fbaPlans: [
      { id: 'd', name: 'Draft', status: 'DRAFT' as const, units: 18 },
      { id: 'q', name: 'Q', status: 'READY_TO_SHIP' as const, units: 6 },
      { id: 'c', name: 'C', status: 'CLOSED' as const, units: 4 },
    ] }
    expect(openPlans(read).map((p) => p.id)).toEqual(['d', 'q'])
    expect(underWayPlans(read).map((p) => p.id)).toEqual(['q'])
    expect(draftPlans(read).map((p) => p.id)).toEqual(['d'])
  })

  it('the footer links open the FBA shipments page: the draft, then the shipments under way', () => {
    expect(footerLinks(null)).toEqual([])
    const one = footerLinks({ fbaPlans: [{ id: 'd', name: 'Draft', status: 'DRAFT', units: 18 }, { id: 'q', name: 'Q', status: 'READY_TO_SHIP', units: 6 }] })
    expect(one).toEqual([
      { key: 'draft', label: 'FBA draft · 18 units', href: '/fulfillment/outbound/fba?plan=d', title: FBA_SEND_COPY.openPage },
      { key: 'shipments', label: 'FBA shipment · Ready to ship', href: '/fulfillment/outbound/fba?plan=q', title: FBA_SEND_COPY.openPage },
    ])
    const many = footerLinks({ fbaPlans: [{ id: 'a', name: 'A', status: 'QUEUED', units: 3 }, { id: 'b', name: 'B', status: 'LABELS', units: 2 }] })
    expect(many).toEqual([{ key: 'shipments', label: 'FBA shipments · 2', href: '/fulfillment/outbound/fba?view=active', title: FBA_SEND_COPY.openPage }])
    expect(fbaPageHref()).toBe('/fulfillment/outbound/fba')
    expect(fbaPageHref({ view: 'drafts', plan: 'x' })).toBe('/fulfillment/outbound/fba?view=drafts&plan=x')
  })
})

describe('the dialog: defaults, table, counts and the button — the shared rules', () => {
  it('opens at 0 units, on the server\'s ready day and box, owners Seller; Add to draft is held "Add units to send"', () => {
    const draft = draftOf()
    const form = startForm(draft)
    expect(form.lines).toEqual({ 'p-m': { productId: 'p-m', cases: [], looseUnits: 0 }, 'p-l': { productId: 'p-l', cases: [], looseUnits: 0 } })
    expect(form.readyToShipOn).toBe('2026-10-08')
    expect(form.mixedBox).toEqual(MIXED_BOX_DEFAULT)
    expect(form.owners).toEqual(OWNERS_DEFAULT)
    const summary = summarize(draft, form)
    expect(addPrimaryOf(summary, draft, form, null)).toEqual({ label: 'Add to draft · 0 units', held: FBA_SEND_COPY.problem.noUnits })
    // "Nothing to send" is the button's reason, never a red Banner on a fresh dialog.
    expect(problemBanners(summary.problems)).toEqual([])
  })

  it('2 sealed cases + 5 loose units: the counts, the boxes per SKU and the mixed line come from sendSummary', () => {
    const draft = draftOf()
    const form = withLines(startForm(draft), { 'p-m': { cases: 2 }, 'p-l': { looseUnits: 5 } })
    const summary = summarize(draft, form)
    expect(summary).toEqual(sendSummary(draft, choiceOf(draft, form)))
    expect(summary.units).toBe(29)
    expect(summary.boxes).toBe(3)
    expect(sendPrimaryOf(summary, null)).toEqual({ label: 'Send to Amazon · 29 units', held: null })
    // The ONE summary line (Owner): the shared numbers in words.
    expect(summaryLine(summary)).toBe(`2 SKUs · 29 units · 3 boxes · ${FBA_SEND_COPY.weight(summary.weightKg)}`)
    expect(summaryLine({ skus: 1, units: 1, boxes: 1, weightKg: 2.1 })).toBe('1 SKU · 1 unit · 1 box · 2.1 kg')
    expect(skuBoxes(summary.plan, 'p-m')).toBe('2')
    expect(skuBoxes(summary.plan, 'p-l')).toBe('1 mixed')
    expect(skuBoxes(summary.plan, 'nobody')).toBe('—')
    expect(summary.mixedLine).toBe('Loose units go in 1 mixed box · 60 × 40 × 40 cm')
    expect(skuCheck(summary, 'p-m', form.lines['p-m'])).toEqual({ tone: 'success', text: 'Ready', message: null })
    expect(skuCheck(summary, 'p-l', { productId: 'p-l', cases: [], looseUnits: 0 })).toBeNull()
  })

  it('a SKU with cases AND loose units shows both box kinds', () => {
    const draft = draftOf({ skus: [{ ...GALE_M, freeLoose: 10, free: 58 }, GALE_L] })
    const form = withLines(startForm(draft), { 'p-m': { cases: 1, looseUnits: 3 } })
    expect(skuBoxes(summarize(draft, form).plan, 'p-m')).toBe('1 + 1 mixed')
  })

  it('the steppers: Cases only with a case size, up to the free sealed cases; Units up to the free units', () => {
    expect(caseSteppers(GALE_M)).toEqual([{ unitsPerCase: 12, max: 4 }])
    expect(casesMax(GALE_M, 12)).toBe(4)
    expect(caseSteppers(GALE_L)).toEqual([])
    expect(unitsMax(GALE_L)).toBe(12)
    expect(unitsMax({ free: -3 })).toBe(0)
  })

  it('refusals: the row\'s Check names its first one, the Banners group them by kind, Send to Amazon is held with the first', () => {
    const draft = draftOf({ address: { missing: ['phoneNumber'], summary: null }, skus: [GALE_M, { ...GALE_L, unitWeightKg: null }] })
    const form = withLines(startForm(draft), { 'p-m': { cases: 5 }, 'p-l': { looseUnits: 2 } })
    const summary = summarize(draft, form)
    const banners = problemBanners(summary.problems)
    expect(banners.map((b) => b.code)).toEqual(['NO_ADDRESS', 'OVER_FREE_CASES', 'OVER_FREE', 'NO_UNIT_WEIGHT'])
    expect(banners[0]).toMatchObject({ tone: 'danger', title: FBA_SEND_COPY.problemTitle.NO_ADDRESS, messages: [FBA_SEND_COPY.problem.noAddress(['phoneNumber'], 'IT-MAIN')] })
    // The plan's problems sit under From / To; the SKUs' under the table.
    expect(banners.map((b) => b.whole)).toEqual([true, false, false, false])
    expect(sendPrimaryOf(summary, null).held).toBe(FBA_SEND_COPY.problem.noAddress(['phoneNumber'], 'IT-MAIN'))
    expect(skuCheck(summary, 'p-m', form.lines['p-m'])).toMatchObject({ tone: 'danger', text: FBA_SEND_COPY.problemTitle.OVER_FREE_CASES })
    expect(skuCheck(summary, 'p-l', form.lines['p-l'])).toMatchObject({ tone: 'danger', text: FBA_SEND_COPY.problemTitle.NO_UNIT_WEIGHT })
  })

  it('a warning (already in an open plan) is amber and holds nothing', () => {
    const draft = draftOf({ skus: [GALE_M, { ...GALE_L, openPlanUnits: 4 }] })
    const summary = summarize(draft, withLines(startForm(draft), { 'p-l': { looseUnits: 2 } }))
    expect(problemBanners(summary.problems)).toEqual([{ code: 'IN_OPEN_PLAN', title: FBA_SEND_COPY.problemTitle.IN_OPEN_PLAN, tone: 'warning', messages: [FBA_SEND_COPY.problem.inOpenPlan('GALE-L', 4)], whole: false }])
    expect(sendPrimaryOf(summary, null).held).toBeNull()
    expect(skuCheck(summary, 'p-l', { productId: 'p-l', cases: [], looseUnits: 2 })).toMatchObject({ tone: 'warning' })
  })

  it('a mixed box over 63.5 cm is refused (EU limit) and no mixed box is built', () => {
    const draft = draftOf()
    const form = withLines({ ...startForm(draft), mixedBox: { ...MIXED_BOX_DEFAULT, lengthCm: 70 } }, { 'p-l': { looseUnits: 3 } })
    const summary = summarize(draft, form)
    expect(summary.blocking.map((p) => p.code)).toContain('BOX_OVER_LIMIT')
    expect(summary.mixedBoxes).toBe(0)
    expect(parseSide('63,5')).toBe(63.5)
    expect(parseSide('')).toBeNull()
    expect(parseSide('-2')).toBeNull()
  })

  it('Prep by / Labels by are asked only when a SKU has "not set", and sent only then', () => {
    const set = draftOf()
    expect(ownersAsked(set)).toBe(false)
    expect(choiceOf(set, startForm(set)).owners).toBeNull()
    const unset = draftOf({ skus: [GALE_M, { ...GALE_L, labelOwner: null }] })
    expect(ownersAsked(unset)).toBe(true)
    const form = { ...withLines(startForm(unset), { 'p-l': { looseUnits: 1 } }), owners: { prepOwner: 'AMAZON' as const, labelOwner: 'SELLER' as const } }
    expect(draftAddRequest(unset, form)?.owners).toEqual({ prepOwner: 'AMAZON', labelOwner: 'SELLER' })
  })

  it('From / To changed: the new draft keeps what was typed for the SKUs still there', () => {
    const draft = draftOf()
    const typed = withLines(startForm(draft), { 'p-m': { cases: 2 }, 'p-l': { looseUnits: 4 } }).lines
    expect(startLines(draftOf({ skus: [GALE_L] }), typed)).toEqual({ 'p-l': { productId: 'p-l', cases: [], looseUnits: 4 } })
  })

  it('Add to draft: From by code, the market, the day, the SKUs with units; the box only when changed; no From → none', () => {
    const draft = draftOf()
    const form = withLines(startForm(draft), { 'p-l': { looseUnits: 5 } })
    expect(draftAddRequest(draft, form)).toEqual({
      from: 'IT-MAIN', market: 'IT', readyToShipOn: '2026-10-08', lines: [{ productId: 'p-l', cases: [], looseUnits: 5 }], mixedBox: null, owners: null,
    })
    const box = { ...MIXED_BOX_DEFAULT, heightCm: 30 }
    expect(draftAddRequest(draft, { ...form, mixedBox: box })?.mixedBox).toEqual(box)
    expect(draftAddRequest(draftOf({ from: null }), form)).toBeNull()
    expect(addedUnits(draftAddRequest(draft, form)!)).toBe(5)
  })

  it('the dialog starts from the open draft\'s numbers; a SKU set back to 0 leaves the draft; Undo puts the old numbers back', () => {
    const draft = draftOf({ draftId: 'd1', lines: [{ productId: 'p-m', cases: [{ unitsPerCase: 12, cases: 1 }], looseUnits: 2 }] })
    const form = startForm(draft)
    expect(form.lines['p-m']).toEqual({ productId: 'p-m', cases: [{ unitsPerCase: 12, cases: 1 }], looseUnits: 2 })
    expect(form.lines['p-l']).toEqual({ productId: 'p-l', cases: [], looseUnits: 0 })
    // GALE-M back to 0 (out of the draft), GALE-L 3 loose (in): GALE-L at 0 before is not sent as a removal.
    const typed = withLines(form, { 'p-m': { cases: 0, looseUnits: 0 }, 'p-l': { looseUnits: 3 } })
    const req = draftAddRequest(draft, typed)!
    expect(req.lines).toEqual([{ productId: 'p-m', cases: [], looseUnits: 0 }, { productId: 'p-l', cases: [], looseUnits: 3 }])
    expect(addPrimaryOf(summarize(draft, typed), draft, typed, null).held).toBeNull()
    // Only removing is still a change: the button is not held at 0 units then.
    const onlyOut = withLines(form, { 'p-m': { cases: 0, looseUnits: 0 } })
    expect(addPrimaryOf(summarize(draft, onlyOut), draft, onlyOut, null)).toEqual({ label: 'Add to draft · 0 units', held: null })
    expect(draftUndoRequest(draft, req)).toEqual({
      from: 'IT-MAIN', market: 'IT',
      lines: [{ productId: 'p-m', cases: [{ unitsPerCase: 12, cases: 1 }], looseUnits: 2 }, { productId: 'p-l', cases: [], looseUnits: 0 }],
    })
  })

  it('Add to draft is held only by what a draft cannot keep; every other problem stays for "Send to Amazon"', () => {
    const draft = draftOf()
    const over = withLines(startForm(draft), { 'p-l': { looseUnits: 99 } })
    const summary = summarize(draft, over)
    expect(summary.held).toBe('GALE-L: 99 units asked; 12 free at IT-MAIN')
    expect(addPrimaryOf(summary, draft, over, null)).toEqual({ label: 'Add to draft · 99 units', held: null })
    expect(sendPrimaryOf(summary, null)).toEqual({ label: 'Send to Amazon · 99 units', held: 'GALE-L: 99 units asked; 12 free at IT-MAIN' })
    const noAccount = draftOf({ markets: [] })
    const f = withLines(startForm(noAccount), { 'p-l': { looseUnits: 1 } })
    expect(addPrimaryOf(summarize(noAccount, f), noAccount, f, null).held).toBe('No Amazon account sells in IT')
  })

  it('the buttons while busy: reading holds them, adding / saving / sending say so', () => {
    const draft = draftOf()
    const form = withLines(startForm(draft), { 'p-l': { looseUnits: 1 } })
    const summary = summarize(draft, form)
    expect(addPrimaryOf(summary, draft, form, 'reading')).toEqual({ label: 'Add to draft · 1 unit', held: 'Reading the warehouse…' })
    expect(addPrimaryOf(summary, draft, form, 'adding')).toEqual({ label: 'Adding…', held: 'Adding…' })
    expect(sendPrimaryOf(summary, 'saving')).toEqual({ label: 'Send to Amazon · 1 unit', held: 'Saving the draft…' })
    expect(sendPrimaryOf(summary, 'sending')).toEqual({ label: 'Sending…', held: 'Sending…' })
  })

  it('the page saves every SKU of the draft, 0s too; Send carries the day, the box when changed and the owners when asked', () => {
    const draft = draftOf()
    const form = withLines(startForm(draft), { 'p-m': { cases: [{ unitsPerCase: 12, cases: 1 }] } })
    expect(draftLinesOf(draft, form)).toEqual([
      { productId: 'p-m', cases: [{ unitsPerCase: 12, cases: 1 }], looseUnits: 0 }, { productId: 'p-l', cases: [], looseUnits: 0 },
    ])
    expect(draftUpdateRequest(draft, form)).toEqual({ lines: draftLinesOf(draft, form), readyToShipOn: '2026-10-08', mixedBox: null })
    expect(draftSendRequest(draft, form)).toEqual({ readyToShipOn: '2026-10-08', mixedBox: null })
    const unset = draftOf({ skus: [{ ...GALE_L, prepOwner: null }] })
    expect(draftSendRequest(unset, startForm(unset)).owners).toEqual(OWNERS_DEFAULT)
  })
})

describe('several case sizes: one Cases stepper per size', () => {
  it('one stepper per size, biggest first, each up to that size\'s free sealed cases', () => {
    expect(caseSteppers(GALE_S)).toEqual([{ unitsPerCase: 12, max: 2 }, { unitsPerCase: 6, max: 1 }])
    expect(casesMax(GALE_S, 6)).toBe(1)
    expect(casesMax(GALE_S, 8)).toBe(0)
  })

  it('a stepper changes its own size only; the line keeps the sizes biggest first', () => {
    const line = withCases(withCases({ productId: 'p-s', cases: [], looseUnits: 3 }, 6, 1), 12, 2)
    expect(line).toEqual({ productId: 'p-s', cases: [{ unitsPerCase: 12, cases: 2 }, { unitsPerCase: 6, cases: 1 }], looseUnits: 3 })
    expect(casesOf(line, 12)).toBe(2)
    expect(casesOf(line, 6)).toBe(1)
    expect(casesOf(undefined, 6)).toBe(0)
    expect(withCases(line, 12, 0).cases).toEqual([{ unitsPerCase: 12, cases: 0 }, { unitsPerCase: 6, cases: 1 }])
  })

  it('the counts, the boxes and the request: cases of both sizes, the 0s left out of the request', () => {
    const draft = draftOf({ skus: [GALE_S, GALE_L] })
    const form = withLines(startForm(draft), { 'p-s': { cases: [{ unitsPerCase: 12, cases: 2 }, { unitsPerCase: 6, cases: 1 }], looseUnits: 0 } })
    const summary = summarize(draft, form)
    expect(summary).toMatchObject({ units: 30, cases: 3, caseBoxes: 3, held: null })
    expect(skuBoxes(summary.plan, 'p-s')).toBe('3')
    expect(skuCheck(summary, 'p-s', form.lines['p-s'])).toEqual({ tone: 'success', text: 'Ready', message: null })
    const zeroSix = withLines(startForm(draft), { 'p-s': { cases: [{ unitsPerCase: 12, cases: 1 }, { unitsPerCase: 6, cases: 0 }] } })
    expect(draftAddRequest(draft, zeroSix)?.lines).toEqual([{ productId: 'p-s', cases: [{ unitsPerCase: 12, cases: 1 }], looseUnits: 0 }])
  })

  it('more cases of one size than free: that size is named, the other size is fine', () => {
    const draft = draftOf({ skus: [GALE_S] })
    const summary = summarize(draft, withLines(startForm(draft), { 'p-s': { cases: [{ unitsPerCase: 12, cases: 1 }, { unitsPerCase: 6, cases: 2 }] } }))
    expect(problemBanners(summary.problems)).toEqual([{
      code: 'OVER_FREE_CASES', title: FBA_SEND_COPY.problemTitle.OVER_FREE_CASES, tone: 'danger', whole: false,
      messages: [FBA_SEND_COPY.problem.overFreeCases('GALE-S', 6, 2, 1, 'IT-MAIN')],
    }])
  })

  it('the Free column names the free cases of each size', () => {
    expect(FBA_SEND_COPY.free(GALE_S.free, GALE_S.freeSealed)).toBe('39 · 2×12 + 1×6')
    expect(FBA_SEND_COPY.free(GALE_M.free, GALE_M.freeSealed)).toBe('48 · 4 cases')
  })

  it('the draft reads every size and its free sealed cases, biggest first; a size named twice is dropped', () => {
    const d = parseSendDraft({ skus: [{
      productId: 'p-s', sku: 'GALE-S',
      caseSizes: [{ unitsPerCase: 6, case: { lengthCm: 30, widthCm: 40, heightCm: 35, weightKg: 7.4 } }, { unitsPerCase: 12, case: null }, { unitsPerCase: 6, case: null }],
      freeSealed: [{ unitsPerCase: 6, cases: 1 }, { unitsPerCase: 12, cases: 2 }],
    }] })
    expect(d.skus[0].caseSizes).toEqual([{ unitsPerCase: 12, case: null }, { unitsPerCase: 6, case: { lengthCm: 30, widthCm: 40, heightCm: 35, weightKg: 7.4 } }])
    expect(d.skus[0].freeSealed).toEqual([{ unitsPerCase: 12, cases: 2 }, { unitsPerCase: 6, cases: 1 }])
  })
})

describe('the routes', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('GET send-draft: the ticked ids, From and To; the answer read; a missing route says it is not ready', async () => {
    expect(draftUrl('https://api', { productIds: ['a', 'b'], from: 'IT-MAIN', market: 'DE' })).toBe('https://api/api/fba/inbound/send-draft?productIds=a%2Cb&from=IT-MAIN&market=DE')
    expect(draftUrl('', { productIds: ['a'] })).toBe('/api/fba/inbound/send-draft?productIds=a')
    expect(draftUrl('', { productIds: [], planId: 'd1' })).toBe('/api/fba/inbound/send-draft?planId=d1')
    const seen: string[] = []
    const ok = (async (url: string) => { seen.push(url); return new Response(JSON.stringify(draftOf()), { status: 200 }) }) as unknown as typeof fetch
    const draft = await fetchSendDraft({ productIds: ['p-m', 'p-l'] }, { fetchImpl: ok, baseUrl: '' })
    expect(seen).toEqual(['/api/fba/inbound/send-draft?productIds=p-m%2Cp-l'])
    expect(draft).toEqual(draftOf())
    const missing = (async () => new Response('{"message":"Route GET:/api/fba/inbound/send-draft not found"}', { status: 404 })) as unknown as typeof fetch
    await expect(fetchSendDraft({ productIds: ['a'] }, { fetchImpl: missing, baseUrl: '' })).rejects.toThrow('Send to FBA is not ready on this server yet (HTTP 404)')
    const refused = (async () => new Response('{"ok":false,"code":"REFUSED","error":"Choose one of your active warehouses as From"}', { status: 400 })) as unknown as typeof fetch
    await expect(fetchSendDraft({ productIds: ['a'] }, { fetchImpl: refused, baseUrl: '' })).rejects.toThrow('Choose one of your active warehouses as From')
    expect(() => parseSendDraft({ nope: true })).toThrow()
  })

  it('a draft with missing optional parts reads as "none", never a guess', () => {
    const d = parseSendDraft({ skus: [{ productId: 'x', sku: 'X', caseSizes: [{ unitsPerCase: 0 }, 'no'], freeSealed: 3, unitWeightKg: -1, prepOwner: 'ME' }] })
    expect(d).toMatchObject({ from: null, locations: [], markets: [], market: 'IT', mixedBox: MIXED_BOX_DEFAULT, address: { missing: [], summary: null } })
    expect(d.skus[0]).toMatchObject({ msku: null, caseSizes: [], freeSealed: [], unitWeightKg: null, prepOwner: null, free: 0 })
    expect(d).toMatchObject({ draftId: null, lines: [] })
    expect(parseLines([{ productId: 'a', cases: [{ unitsPerCase: 6, cases: 1 }, { unitsPerCase: 12, cases: 2 }], looseUnits: 3 }, { productId: 'a' }, 'x', { productId: 'b', looseUnits: -2 }]))
      .toEqual([{ productId: 'a', cases: [{ unitsPerCase: 12, cases: 2 }, { unitsPerCase: 6, cases: 1 }], looseUnits: 3 }, { productId: 'b', cases: [], looseUnits: 0 }])
  })

  it('POST drafts: the request as JSON; 200 → the draft id; 400 → the server\'s reasons', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    let answer: Response = new Response(JSON.stringify({ planId: 'd1' }), { status: 200 })
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : null })
      return answer
    }) as unknown as typeof fetch
    const req = draftAddRequest(draftOf(), withLines(startForm(draftOf()), { 'p-l': { looseUnits: 2 } }))!
    expect(await postDraftAdd(req, { baseUrl: '', fetchImpl })).toEqual({ ok: true, planId: 'd1' })
    expect(calls).toEqual([{ url: '/api/fba/inbound/drafts', method: 'POST', body: req }])
    answer = new Response(JSON.stringify({ ok: false, code: 'REFUSED', error: 'Not saved', problems: [{ code: 'UNKNOWN_SKU', message: 'x: not one of the SKUs', productId: 'x', blocking: true }] }), { status: 400 })
    expect(await postDraftAdd(req, { baseUrl: '', fetchImpl })).toEqual({
      ok: false, message: 'Not saved', problems: [{ code: 'UNKNOWN_SKU', message: 'x: not one of the SKUs', productId: 'x', blocking: true }],
    })
  })

  it('PATCH a draft (409 DRAFT_EXISTS keeps its code), DELETE a draft', async () => {
    const calls: Array<{ url: string; method: string }> = []
    let answer: Response = new Response(JSON.stringify({ id: 'd1', status: 'DRAFT' }), { status: 200 })
    const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, method: String(init.method) }); return answer }) as unknown as typeof fetch
    expect(await patchDraft('d1', { readyToShipOn: '2026-10-09' }, { baseUrl: '', fetchImpl })).toMatchObject({ ok: true, plan: { id: 'd1', status: 'DRAFT' } })
    answer = new Response(JSON.stringify({ ok: false, code: 'DRAFT_EXISTS', error: 'There is already a draft from IT-MAIN to Amazon DE' }), { status: 409 })
    expect(await patchDraft('d1', { market: 'DE' }, { baseUrl: '', fetchImpl })).toEqual({
      ok: false, message: 'There is already a draft from IT-MAIN to Amazon DE', code: 'DRAFT_EXISTS', problems: [],
    })
    answer = new Response(JSON.stringify({ ok: true }), { status: 200 })
    expect(await deleteDraft('d1', { baseUrl: '', fetchImpl })).toEqual({ ok: true })
    answer = new Response(JSON.stringify({ ok: false, code: 'WRONG_STATE', error: 'Only a draft can be deleted' }), { status: 409 })
    expect(await deleteDraft('d1', { baseUrl: '', fetchImpl })).toEqual({ ok: false, message: 'Only a draft can be deleted' })
    expect(calls).toEqual([
      { url: '/api/fba/inbound/plans/d1', method: 'PATCH' }, { url: '/api/fba/inbound/plans/d1', method: 'PATCH' },
      { url: '/api/fba/inbound/plans/d1', method: 'DELETE' }, { url: '/api/fba/inbound/plans/d1', method: 'DELETE' },
    ])
  })

  it('Send to Amazon: one Idempotency-Key per intent; 202 → the plan id; 400 → the reasons; no answer keeps the key', async () => {
    const calls: Array<{ url: string; key: string | null; body: unknown }> = []
    let answer: Response = new Response(JSON.stringify({ planId: 'd1' }), { status: 202 })
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, key: new Headers(init.headers).get(IDEMPOTENCY_KEY_HEADER), body: JSON.parse(String(init.body)) })
      return answer
    })
    const slot = new CommandKey(() => 'key-1')
    const req = { readyToShipOn: '2026-10-09', mixedBox: null }
    expect(await postSendDraft(slot, 'd1', req, { baseUrl: '' })).toEqual({ ok: true, planId: 'd1' })
    expect(calls).toEqual([{ url: '/api/fba/inbound/plans/d1/send', key: 'key-1', body: req }])
    expect(slot.pending).toBeNull()
    answer = new Response(JSON.stringify({ ok: false, code: 'REFUSED', error: 'Not sent', problems: [{ code: 'OVER_FREE', message: 'GALE-L: 99 units asked; 12 free at IT-MAIN', productId: 'p-l', blocking: true }] }), { status: 400 })
    expect(await postSendDraft(slot, 'd1', req, { baseUrl: '' })).toEqual({
      ok: false, message: 'Not sent', problems: [{ code: 'OVER_FREE', message: 'GALE-L: 99 units asked; 12 free at IT-MAIN', productId: 'p-l', blocking: true }],
    })
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch') })
    const kept = new CommandKey(() => 'key-2')
    await expect(postSendDraft(kept, 'd1', req, { baseUrl: '' })).rejects.toThrow('Failed to fetch')
    expect(kept.pending).toBe('key-2')
  })

  it('error sentences and problems are read defensively', () => {
    expect(errorSentence(null, 500, 'The plan was not created')).toBe('The plan was not created (HTTP 500)')
    expect(errorSentence({ ok: false, code: 'NOT_BUILT', error: 'Not built yet' }, 501, 'x')).toBe('Not built yet')
    expect(errorSentence(null, 501, 'x')).toBe('Send to FBA is not ready on this server yet (HTTP 501)')
    expect(problemsOf({ problems: 'no' })).toEqual([])
  })
})

describe('live: the server\'s fba.plan_changed reaches the Matrix and the plans drawer', () => {
  it('one narrow stock re-read per product of the plan, marked fba-plan with the plan id (the drawer\'s matcher takes it)', () => {
    const out = fbaPlanInvalidations({ planId: 'plan-1', status: 'WAITING_FOR_CHOICE', step: 'CONFIRM', productIds: ['a', 'b', 'a', 7] })
    expect(out).toEqual([
      { type: 'inventory.stock_changed', id: 'a', meta: { source: 'sse', subtype: 'fba-plan', planId: 'plan-1', status: 'WAITING_FOR_CHOICE', step: 'CONFIRM', productId: 'a' } },
      { type: 'inventory.stock_changed', id: 'b', meta: { source: 'sse', subtype: 'fba-plan', planId: 'plan-1', status: 'WAITING_FOR_CHOICE', step: 'CONFIRM', productId: 'b' } },
    ])
    for (const e of out) expect(isFbaPlanEvent(e)).toBe(true)
    // Never the broad 'stock.adjusted' (about 20 stock pages re-read whole grids on it).
    expect(out.every((e) => e.type === 'inventory.stock_changed')).toBe(true)
  })

  it('a plan with no product still reaches the drawer; no plan id is nothing', () => {
    expect(fbaPlanInvalidations({ planId: 'plan-2', status: 'CANCELLED', step: null, productIds: [] })).toEqual([
      { type: 'inventory.stock_changed', id: 'plan-2', meta: { source: 'sse', subtype: 'fba-plan', planId: 'plan-2', status: 'CANCELLED', step: null } },
    ])
    expect(fbaPlanInvalidations({ status: 'QUEUED', productIds: ['a'] })).toEqual([])
  })
})
