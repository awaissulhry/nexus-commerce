import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from '../../../../lib/api/client'
import { ApiError } from '../../../../lib/api/errors'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { render, textOf } from '../../../../lib/record-thread/parts/testing'
import { canOf } from '../_demo/fixtures'
import { readOrderFiles, readPriceCheck, saveBrandPrices, type PriceCheck } from './api'
import { PRICE_CHECK, PRICE_FILES, priceWindowOf } from './fixtures'
import { decimalText, draftOf, minorOfTyped, pricePlanOf, saveHeldOf, saveRefusalOf, TOTAL_KEY, type PriceDraft } from './model'
import { PriceCheckBody } from './PriceCheckDialog'

/**
 * F-CP-114 (customer page plan C2d, C3; design 11-money §3.3, picture 21; review A3; lead pick "one editor, two doors"; the API's
 * B-CP-017): the ONE customer's-price editor — what it starts from, the bodies it sends (the row versions, one total row, a cleared
 * price removed), when Save is held and why, a refusal in words (409: read again, "Here they are now"), the window's states (reading,
 * failed, typing, changed meanwhile, a closed order held), the currency in words, and the door only with the price grain (money wall
 * "as Sales worker / as Production manager": no door, no call). The brand wall is the API's (the order's own party; B-CP-017's PG test).
 */

const t = createTranslator('en', messagesFor('en', ['orders']).orders!)
const [L1, L2, L3] = PRICE_CHECK.lines.map((line) => line.lineId) as [string, string, string]
const draft = (over: Partial<PriceDraft> = {}, lines: PriceDraft['lines'] = {}): PriceDraft => {
  const start = draftOf(PRICE_CHECK, 'en')
  return { ...start, ...over, lines: { ...start.lines, ...lines } }
}
const conflict = new ApiError('conflict', 409, 'conflict', 'stale', 'req-1', [{ path: 'body/rows/0/version', message: 'at version 3' }])
const invalid = (...paths: string[]) => new ApiError('invalid', 400, 'validation_failed', 'no', 'req-1', paths.map((path) => ({ path, message: 'x' })))

describe('F-CP-114: what the window starts from', () => {
  it('each line as the person would type it: a unit price, a line total, or nothing; the order total; Italian commas', () => {
    const start = draftOf(PRICE_CHECK, 'en')
    expect(start.lines[L1]).toEqual({ as: 'unit', value: '92' })
    expect(start.lines[L2]).toEqual({ as: 'unit', value: '95.5' })
    expect(start.lines[L3]).toEqual({ as: 'unit', value: '' })
    expect(start.total).toBe('')
    expect(draftOf(PRICE_CHECK, 'it').lines[L2]).toEqual({ as: 'unit', value: '95,5' })
    const lineTotal: PriceCheck = { ...PRICE_CHECK, lines: PRICE_CHECK.lines.map((line, index) => (index === 1 ? { ...line, row: { ...line.row!, unitPrice: null, netAmount: 955_000 } } : line)), total: { ...PRICE_CHECK.total, row: { ...PRICE_CHECK.lines[1]!.row!, id: 'tot', unitPrice: null, netAmount: 2_120_000 } } }
    expect(draftOf(lineTotal, 'it').lines[L2]).toEqual({ as: 'line', value: '9550,00' })
    expect(draftOf(lineTotal, 'en').total).toBe('21200.00')
  })
  it('where it comes from, the PO file and the note start from a row we typed — never from the customer\'s own portal row', () => {
    expect(draftOf(PRICE_CHECK, 'en')).toMatchObject({ source: 'CUSTOMER_PO', fileId: PRICE_FILES[0].id, note: 'PO 4471, page 2' })
    const portalOnly: PriceCheck = { ...PRICE_CHECK, lines: PRICE_CHECK.lines.map((line, index) => (index === 1 ? { ...line, row: null } : line)) }
    expect(draftOf(portalOnly, 'en')).toMatchObject({ source: 'CUSTOMER_PO', fileId: '', note: '' })
  })
  it('typed amounts in either language\'s way, exact to the cent (never a float)', () => {
    expect(minorOfTyped('92,50')).toBe(9250)
    expect(minorOfTyped('1.234,56')).toBe(123456)
    expect(minorOfTyped('1234.56')).toBe(123456)
    expect(minorOfTyped('0')).toBe(0)
    expect(minorOfTyped('12.345')).toBeNull()
    expect(minorOfTyped('abc')).toBeNull()
    expect(minorOfTyped('-5')).toBeNull()
    expect(decimalText('95.5', 'it')).toBe('95,5')
  })
})

describe('F-CP-114: the bodies Save sends (the row versions, one total row)', () => {
  it('a new price on a line without one: no version; a price typed over: the version read; both with where it came from', () => {
    const plan = pricePlanOf(PRICE_CHECK, draft({}, { [L3]: { as: 'unit', value: '15,75' }, [L2]: { as: 'unit', value: '96' } }))
    expect(plan.kind).toBe('save')
    if (plan.kind !== 'save') return
    expect(plan.body.currency).toBe('EUR')
    expect(plan.body.rows).toEqual([
      { lineId: L2, unitPrice: '96', source: 'CUSTOMER_PO', sourceFileId: PRICE_FILES[0].id, note: 'PO 4471, page 2', version: 2 },
      { lineId: L3, unitPrice: '15.75', source: 'CUSTOMER_PO', sourceFileId: PRICE_FILES[0].id, note: 'PO 4471, page 2' },
    ])
    expect(plan.body.remove).toEqual([])
    expect(plan.keys).toEqual([L2, L3])
  })
  it('a line total instead of a unit price; the customer\'s total for the whole order is ONE row with lineId null', () => {
    const plan = pricePlanOf(PRICE_CHECK, draft({ total: '21.180,00' }, { [L3]: { as: 'line', value: '630' } }))
    if (plan.kind !== 'save') throw new Error(plan.kind)
    expect(plan.body.rows.map((row) => ({ lineId: row.lineId, unitPrice: row.unitPrice, netAmount: row.netAmount }))).toEqual([
      { lineId: L3, unitPrice: undefined, netAmount: 63_000 },
      { lineId: null, unitPrice: undefined, netAmount: 2_118_000 },
    ])
    expect(plan.body.rows.filter((row) => row.lineId === null)).toHaveLength(1)
    expect(plan.keys).toEqual([L3, TOTAL_KEY])
  })
  it('a price cleared is removed at its version; the same values again send nothing (no audit, the window says so)', () => {
    const cleared = pricePlanOf(PRICE_CHECK, draft({}, { [L1]: { as: 'unit', value: '' } }))
    if (cleared.kind !== 'save') throw new Error(cleared.kind)
    expect(cleared.body.rows).toEqual([])
    expect(cleared.body.remove).toEqual([{ id: PRICE_CHECK.lines[0]!.row!.id, version: 1 }])
    expect(pricePlanOf(PRICE_CHECK, draft())).toEqual({ kind: 'nothing' })
    // "95.50" is the same price as the stored "95.5".
    expect(pricePlanOf(PRICE_CHECK, draft({}, { [L2]: { as: 'unit', value: '95.50' } }))).toEqual({ kind: 'nothing' })
  })
  it('typed by us: no PO file goes with it; only the PO file or the note changed: our rows again, never the portal\'s', () => {
    const office = pricePlanOf(PRICE_CHECK, draft({ source: 'OFFICE' }, { [L3]: { as: 'unit', value: '16' } }))
    if (office.kind !== 'save') throw new Error(office.kind)
    expect(office.body.rows.every((row) => row.source === 'OFFICE' && row.sourceFileId === null)).toBe(true)
    const noteOnly = pricePlanOf(PRICE_CHECK, draft({ note: 'PO 4471 rev. 2' }))
    if (noteOnly.kind !== 'save') throw new Error(noteOnly.kind)
    expect(noteOnly.body.rows).toEqual([{ lineId: L2, unitPrice: '95.5', source: 'CUSTOMER_PO', sourceFileId: PRICE_FILES[0].id, note: 'PO 4471 rev. 2', version: 2 }])
  })
  it('a value that is no amount is a problem at its line (nothing is sent)', () => {
    expect(pricePlanOf(PRICE_CHECK, draft({ total: 'abc' }, { [L3]: { as: 'unit', value: '1,2,3' } }))).toEqual({ kind: 'problems', problems: { [L3]: { key: 'priceCheck.notAmount' }, [TOTAL_KEY]: { key: 'priceCheck.notAmount' } } })
  })
})

describe('F-CP-114: Save held in words, a refusal in words', () => {
  const save = pricePlanOf(PRICE_CHECK, draft({}, { [L3]: { as: 'unit', value: '16' } }))
  it('saving, a closed order, no right to change orders, a value to fix, nothing changed — else it saves', () => {
    expect(saveHeldOf(PRICE_CHECK, save, true)).toEqual({ key: 'priceCheck.saving' })
    expect(saveHeldOf({ ...PRICE_CHECK, status: 'CANCELLED' }, save, false)).toEqual({ key: 'priceCheck.closed' })
    expect(saveHeldOf({ ...PRICE_CHECK, mayWrite: { allowed: false, why: 'x' } }, save, false)).toEqual({ key: 'held.noManage' })
    expect(saveHeldOf(PRICE_CHECK, { kind: 'problems', problems: {} }, false)).toEqual({ key: 'priceCheck.fixFirst' })
    expect(saveHeldOf(PRICE_CHECK, { kind: 'nothing' }, false)).toEqual({ key: 'priceCheck.nothing' })
    expect(saveHeldOf(PRICE_CHECK, save, false)).toBeNull()
  })
  it('409: the prices are read again — "Someone changed these prices meanwhile. Here they are now."', () => {
    expect(saveRefusalOf(conflict, [L3], 'EUR')).toEqual({ words: { key: 'priceCheck.stale' }, reread: true, fields: {} })
    expect(t('priceCheck.stale')).toBe('Someone changed these prices meanwhile. Here they are now.')
  })
  it('400 by place: the currency in words, a closed order (read again), a line\'s price and the PO file at their field', () => {
    expect(saveRefusalOf(invalid('body/currency'), [L3], 'EUR').words).toEqual({ key: 'priceCheck.currency', params: { currency: 'EUR' } })
    expect(saveRefusalOf(invalid('body'), [L3], 'EUR')).toMatchObject({ words: { key: 'priceCheck.closed' }, reread: true })
    expect(saveRefusalOf(invalid('body/rows/1/unitPrice', 'body/rows/0/sourceFileId'), [L2, L3], 'EUR').fields).toEqual({ [L3]: { key: 'priceCheck.refusedLine' }, file: { key: 'priceCheck.notAFile' } })
  })
  it('any other refusal says the orders\' own words (never the API\'s English)', () => {
    expect(saveRefusalOf(new ApiError('forbidden', 403, 'forbidden', 'Shown to people who see prices.'), [], 'EUR').words).toEqual({ key: 'problem.write.forbidden' })
    expect(saveRefusalOf(new Error('boom'), [], 'EUR').words).toEqual({ key: 'problem.write.internal' })
  })
})

describe('F-CP-114: the window\'s states', () => {
  const draw = (kind: Parameters<typeof priceWindowOf>[0], locale: (typeof LOCALES)[number] = 'en') => render(createElement(PriceCheckBody, { model: priceWindowOf(kind) }), locale)
  it('reading: skeleton rows (busy), never an empty table', () => {
    const html = draw('reading')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('nds-skeleton')
    expect(textOf(html)).not.toContain('Save prices')
  })
  it('failed: in words with Try again', () => {
    expect(textOf(draw('failed'))).toContain("Couldn't read the prices")
    expect(textOf(draw('failed'))).toContain('Try again')
  })
  it('typing: a row per line — Line, Pieces, Our unit price, the customer\'s price as, Without VAT — the PO file and the order total', () => {
    const text = textOf(draw('edit'))
    for (const words of ['Where it comes from', "From the customer's PO", 'Typed by us', 'PO file', 'Brand Alpha PO 4471.pdf', 'Line', 'Pieces', 'Our unit price', "Customer's price as", 'Without VAT', 'Unit price', 'Line total', "Customer's total for the whole order (optional)", 'Note']) expect(text, words).toContain(words)
    expect(text).toContain('1 · JKT-01 Rider jacket · Black')
    expect(text).toContain('From the portal')
    expect(text).toContain('€92.00')
    expect(draw('edit')).toContain('aria-label="PAT-05 Patch set · Red: the customer&#x27;s price without VAT"')
  })
  it('changed meanwhile: ONE banner "Here they are now" and the prices as they are now', () => {
    const html = draw('stale')
    expect(textOf(html)).toContain('Someone changed these prices meanwhile. Here they are now.')
    // F-CP-114 (end-check fix): banners counted by their root (a DS Banner also draws nds-banner-icon, -body, -desc inside it).
    expect(html.match(/class="nds-banner /g)?.length ?? 0).toBe(1)
  })
  it('a closed order keeps its prices: the words, the prices read only (no field to type in)', () => {
    const html = draw('closed')
    expect(textOf(html)).toContain('A closed or cancelled order keeps its prices.')
    expect(html).not.toContain('<input')
    expect(textOf(html)).toContain('€95.50')
  })
  it('the currency in words, and every word in both languages (no key left)', () => {
    expect(t('priceCheck.currency', { currency: 'EUR' })).toBe("The order is in EUR: type the customer's price in EUR.")
    for (const locale of LOCALES) {
      for (const kind of ['edit', 'stale', 'closed', 'reading', 'failed'] as const) expect(textOf(draw(kind, locale)), `${locale} ${kind}`).not.toMatch(/priceCheck\.|problem\.read\./)
      const words = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['priceCheck.edit', 'priceCheck.save', 'priceCheck.saving', 'priceCheck.nothing', 'priceCheck.fixFirst', 'priceCheck.notAmount', 'priceCheck.notAFile', 'priceCheck.refusedLine', 'priceCheck.typedByUs', 'priceCheck.fromPortal']) expect(words(key), `${locale} ${key}`).not.toBe(key)
      expect(words('priceCheck.title', { number: 'SO-1' }), locale).toContain('SO-1')
      expect(words('priceCheck.saved', { number: 'SO-1' }), locale).toContain('SO-1')
      expect(words('priceCheck.otherCurrency', { count: 2 }), locale).toContain('2')
    }
  })
})

describe('F-CP-114: the calls', () => {
  it('reads the order\'s check; saves with PUT at the versions read and ONE Idempotency-Key; the PO file from this order\'s files', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown; key?: string }> = []
    const api = {
      get: async (path: string) => {
        calls.push({ method: 'GET', path })
        return path.startsWith('/files') ? { files: [{ id: 'f1', originalName: 'PO.pdf', status: 'AVAILABLE' }, { id: 'f2', originalName: 'old.pdf', status: 'DELETED' }, { id: 'f3', originalName: 'x', status: 'AVAILABLE', locked: 'PRICED' }] } : PRICE_CHECK
      },
      request: async (method: string, path: string, options: { body: unknown; idempotencyKey?: string }) => (calls.push({ method, path, body: options.body, key: options.idempotencyKey }), PRICE_CHECK),
    } as unknown as ApiClient
    await readPriceCheck(api, PRICE_CHECK.orderId)
    const plan = pricePlanOf(PRICE_CHECK, draft({}, { [L3]: { as: 'unit', value: '16' } }))
    if (plan.kind !== 'save') throw new Error(plan.kind)
    await saveBrandPrices(api, PRICE_CHECK.orderId, plan.body, 'key-1')
    expect(calls[0]).toEqual({ method: 'GET', path: `/sales/orders/${PRICE_CHECK.orderId}/price-check` })
    expect(calls[1]).toMatchObject({ method: 'PUT', path: `/sales/orders/${PRICE_CHECK.orderId}/brand-prices`, key: 'key-1', body: plan.body })
    expect(await readOrderFiles(api, PRICE_CHECK.orderId)).toEqual([{ id: 'f1', name: 'PO.pdf' }])
  })
  it('the hook: one read on open, the key kept for the same body, a 409 reads again with the words, a save closes and hands the check over', () => {
    const hook = readFileSync(new URL('./use-price-check.ts', import.meta.url), 'utf8')
    expect(hook).toContain('readCheck(order.orderId, locale)')
    expect(hook).toContain('if (sent.current?.body !== body) sent.current = { body, key: newIdempotencyKey() }')
    expect(hook).toContain("if (refusal.reread) return readCheck(opened.orderId, locale, { tone: refusal.words.key === 'priceCheck.stale' ? 'warning' : 'danger', words: refusal.words })")
    expect(hook).toContain('onSaved.current?.(after)')
    // Its own api file: so/api.ts (the order lane's) holds none of these calls.
    expect(readFileSync(new URL('../api.ts', import.meta.url), 'utf8')).not.toMatch(/\/(price-check|brand-prices)`/)
  })
})

describe('F-CP-114: the door on the Work tab — only with the price grain (money wall: no door, no call)', () => {
  it('as Sales worker / as Production manager: the sheet offers no door (the hook gives it with the price grain only)', () => {
    expect({ ...canOf('sales'), price: false }.price).toBe(false)
    expect(canOf('manager').price).toBe(false)
    const sheet = readFileSync(new URL('../list/use-orders-sheet.ts', import.meta.url), 'utf8')
    // F-CP-114 / F-CP-141 (end-check fix): both doors only inside the price branch (F-CP-141 put the term's funnel first in it).
    const gate = sheet.indexOf('...(can.price\n      ? {')
    const branch = sheet.slice(gate, sheet.indexOf('\n      : {}),', gate))
    expect(gate).toBeGreaterThan(-1)
    expect(branch).toContain('onPriceCheck:')
    expect(branch).toContain('onPriceMatch:')
    expect(sheet.split('onPriceCheck:').length - 1).toBe(1)
    const view = readFileSync(new URL('../list/view/OrdersListView.tsx', import.meta.url), 'utf8')
    // Row ⋯ "Set customer's price…" only with the grain and the host's door; the Customer's price cell is the door (a button).
    expect(view).toContain("...(can.price && act()?.onPriceCheck ? [{ id: 'priceCheck', label: t('priceCheck.edit'), onSelect: () => act()?.onPriceCheck?.(data.id) }] : [])")
    expect(view).toContain('<button type="button" className="fw-pc-door" data-door="" title={label} aria-label={`${label}: ${amount}`} onClick={() => open(data.id)}>')
    expect(view).toContain("'a[data-door], button[data-door], button.fw-sheet-funnel, button[data-picture]'")
    // The ONE window, mounted by the sheet (the order page mounts the same one later: F-CP-142).
    expect(view).toContain('{model.priceCheck && <PriceCheckDialog model={model.priceCheck} actions={actions?.priceCheck} />}')
  })
  it('a save puts the new figures in the row where it stands (rows never jump) and says so', () => {
    const sheet = readFileSync(new URL('../list/use-orders-sheet.ts', import.meta.url), 'utf8')
    expect(sheet).toContain('brandPrice: check.total.brandPrice, priceMatch: check.total.priceMatch, priceDiff: check.total.priceDiff, priceNotEqualLines: check.total.priceNotEqualLines')
    expect(sheet).toContain("setNotice({ tone: 'success', words: { key: 'priceCheck.saved', params: { number: check.number } } })")
  })
  it('design cases on the Work tab: typing, changed meanwhile, a closed order; as Sales worker no window', async () => {
    const { designScreen } = await import('../../customers/record/fixtures')
    const ids = designScreen.cases.map((entry) => entry.id)
    for (const id of ['work-price-window', 'work-price-window-stale', 'work-price-window-closed', 'work-price-window-no-price']) expect(ids, id).toContain(id)
    const fixtures = readFileSync(new URL('../../customers/record/fixtures.ts', import.meta.url), 'utf8')
    expect(fixtures).toContain('work.priceWindow && work.price !== false ? { ...list, priceCheck: priceWindowOf(work.priceWindow) } : list')
  })
})
