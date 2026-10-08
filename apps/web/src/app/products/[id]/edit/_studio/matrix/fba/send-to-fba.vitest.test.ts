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
  OWNERS_DEFAULT, SEND_HELD, caseSteppers, casesMax, casesOf, choiceOf, createRequest, draftUrl, errorSentence, fetchSendDraft, hasAmazonListing, openPlans, ownersAsked,
  parseSendDraft, parseSide, postCancelPlan, postSendPlan, primaryOf, problemBanners, problemsOf, sendDescription, sendHeld, sendProductIds,
  skuBoxes, skuCheck, startForm, startLines, summarize, summaryLine, unitsMax, withCases, type SendForm,
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
})

describe('the dialog: defaults, table, counts and the button — the shared rules', () => {
  it('opens at 0 units, on the server\'s ready day and box, owners Seller; Create plan is held "Add units to send"', () => {
    const draft = draftOf()
    const form = startForm(draft)
    expect(form.lines).toEqual({ 'p-m': { productId: 'p-m', cases: [], looseUnits: 0 }, 'p-l': { productId: 'p-l', cases: [], looseUnits: 0 } })
    expect(form.readyToShipOn).toBe('2026-10-08')
    expect(form.mixedBox).toEqual(MIXED_BOX_DEFAULT)
    expect(form.owners).toEqual(OWNERS_DEFAULT)
    const summary = summarize(draft, form)
    expect(primaryOf(summary, null)).toEqual({ label: 'Create plan · 0 units', held: FBA_SEND_COPY.problem.noUnits })
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
    expect(primaryOf(summary, null)).toEqual({ label: 'Create plan · 29 units', held: null })
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

  it('refusals: the row\'s Check names its first one, the Banners group them by kind, Create plan is held with the first', () => {
    const draft = draftOf({ address: { missing: ['phoneNumber'], summary: null }, skus: [GALE_M, { ...GALE_L, unitWeightKg: null }] })
    const form = withLines(startForm(draft), { 'p-m': { cases: 5 }, 'p-l': { looseUnits: 2 } })
    const summary = summarize(draft, form)
    const banners = problemBanners(summary.problems)
    expect(banners.map((b) => b.code)).toEqual(['NO_ADDRESS', 'OVER_FREE_CASES', 'OVER_FREE', 'NO_UNIT_WEIGHT'])
    expect(banners[0]).toMatchObject({ tone: 'danger', title: FBA_SEND_COPY.problemTitle.NO_ADDRESS, messages: [FBA_SEND_COPY.problem.noAddress(['phoneNumber'], 'IT-MAIN')] })
    // The plan's problems sit under From / To; the SKUs' under the table.
    expect(banners.map((b) => b.whole)).toEqual([true, false, false, false])
    expect(primaryOf(summary, null).held).toBe(FBA_SEND_COPY.problem.noAddress(['phoneNumber'], 'IT-MAIN'))
    expect(skuCheck(summary, 'p-m', form.lines['p-m'])).toMatchObject({ tone: 'danger', text: FBA_SEND_COPY.problemTitle.OVER_FREE_CASES })
    expect(skuCheck(summary, 'p-l', form.lines['p-l'])).toMatchObject({ tone: 'danger', text: FBA_SEND_COPY.problemTitle.NO_UNIT_WEIGHT })
  })

  it('a warning (already in an open plan) is amber and holds nothing', () => {
    const draft = draftOf({ skus: [GALE_M, { ...GALE_L, openPlanUnits: 4 }] })
    const summary = summarize(draft, withLines(startForm(draft), { 'p-l': { looseUnits: 2 } }))
    expect(problemBanners(summary.problems)).toEqual([{ code: 'IN_OPEN_PLAN', title: FBA_SEND_COPY.problemTitle.IN_OPEN_PLAN, tone: 'warning', messages: [FBA_SEND_COPY.problem.inOpenPlan('GALE-L', 4)], whole: false }])
    expect(primaryOf(summary, null).held).toBeNull()
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
    expect(createRequest(unset, form)?.owners).toEqual({ prepOwner: 'AMAZON', labelOwner: 'SELLER' })
  })

  it('From / To changed: the new draft keeps what was typed for the SKUs still there', () => {
    const draft = draftOf()
    const typed = withLines(startForm(draft), { 'p-m': { cases: 2 }, 'p-l': { looseUnits: 4 } }).lines
    expect(startLines(draftOf({ skus: [GALE_L] }), typed)).toEqual({ 'p-l': { productId: 'p-l', cases: [], looseUnits: 4 } })
  })

  it('the request: From by code, the market, the day, ONLY the SKUs with units; the box only when changed', () => {
    const draft = draftOf()
    const form = withLines(startForm(draft), { 'p-l': { looseUnits: 5 } })
    expect(createRequest(draft, form)).toEqual({
      from: 'IT-MAIN', market: 'IT', readyToShipOn: '2026-10-08', lines: [{ productId: 'p-l', cases: [], looseUnits: 5 }], mixedBox: null, owners: null,
    })
    const box = { ...MIXED_BOX_DEFAULT, heightCm: 30 }
    expect(createRequest(draft, { ...form, mixedBox: box })?.mixedBox).toEqual(box)
    expect(createRequest(draftOf({ from: null }), form)).toBeNull()
  })

  it('the button while busy: reading holds it, creating says so', () => {
    const summary = summarize(draftOf(), withLines(startForm(draftOf()), { 'p-l': { looseUnits: 1 } }))
    expect(primaryOf(summary, 'reading')).toEqual({ label: 'Create plan · 1 unit', held: 'Reading the warehouse…' })
    expect(primaryOf(summary, 'creating')).toEqual({ label: 'Creating…', held: 'Creating…' })
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
    expect(createRequest(draft, zeroSix)?.lines).toEqual([{ productId: 'p-s', cases: [{ unitsPerCase: 12, cases: 1 }], looseUnits: 0 }])
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
  })

  it('POST plans: one Idempotency-Key per intent, the request as JSON; 202 → the plan id; 400 → the server\'s reasons', async () => {
    const calls: Array<{ url: string; key: string | null; body: unknown }> = []
    let answer: Response = new Response(JSON.stringify({ planId: 'plan-1' }), { status: 202 })
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, key: new Headers(init.headers).get(IDEMPOTENCY_KEY_HEADER), body: JSON.parse(String(init.body)) })
      return answer
    })
    const slot = new CommandKey(() => 'key-1')
    const req = createRequest(draftOf(), withLines(startForm(draftOf()), { 'p-l': { looseUnits: 2 } }))!
    expect(await postSendPlan(slot, req, { baseUrl: '' })).toEqual({ ok: true, planId: 'plan-1' })
    expect(calls).toEqual([{ url: '/api/fba/inbound/plans', key: 'key-1', body: req }])
    expect(slot.pending).toBeNull()

    answer = new Response(JSON.stringify({ ok: false, code: 'REFUSED', error: 'Not created', problems: [{ code: 'OVER_FREE', message: 'GALE-L: 99 units asked; 12 free at IT-MAIN', productId: 'p-l', blocking: true }, { bad: 1 }] }), { status: 400 })
    expect(await postSendPlan(slot, req, { baseUrl: '' })).toEqual({
      ok: false, message: 'Not created', problems: [{ code: 'OVER_FREE', message: 'GALE-L: 99 units asked; 12 free at IT-MAIN', productId: 'p-l', blocking: true }],
    })
    answer = new Response(JSON.stringify({ error: 'The same request is still running. Try again.' }), { status: 409 })
    const running = await postSendPlan(slot, req, { baseUrl: '' })
    expect(running.ok).toBe(false)
    expect(!running.ok && running.message).toContain('still running')
    // Still running: the key is kept, so the next press replays instead of making a second plan.
    expect(slot.pending).not.toBeNull()
  })

  it('no answer at all: the key is kept — pressing again cannot make a second plan', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch') })
    const slot = new CommandKey(() => 'key-2')
    await expect(postSendPlan(slot, createRequest(draftOf(), withLines(startForm(draftOf()), { 'p-l': { looseUnits: 1 } }))!, { baseUrl: '' })).rejects.toThrow('Failed to fetch')
    expect(slot.pending).toBe('key-2')
  })

  it('Undo = POST …/cancel on the created plan; a refusal says the server\'s sentence', async () => {
    const urls: string[] = []
    let answer = new Response(JSON.stringify({ id: 'plan-1', status: 'CANCELLED' }), { status: 200 })
    vi.stubGlobal('fetch', async (url: string) => { urls.push(url); return answer })
    expect(await postCancelPlan(new CommandKey(), 'plan-1', { baseUrl: '' })).toMatchObject({ ok: true, plan: { id: 'plan-1', status: 'CANCELLED' } })
    expect(urls).toEqual(['/api/fba/inbound/plans/plan-1/cancel'])
    answer = new Response(JSON.stringify({ ok: false, code: 'WRONG_STATE', error: 'A shipment is already marked Shipped' }), { status: 409 })
    expect(await postCancelPlan(new CommandKey(), 'plan-1', { baseUrl: '' })).toEqual({ ok: false, message: 'A shipment is already marked Shipped' })
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
