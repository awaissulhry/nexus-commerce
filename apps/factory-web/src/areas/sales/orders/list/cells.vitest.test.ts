import { existsSync, readFileSync } from 'node:fs' // F-SA-212
import { createElement } from 'react' // F-CP-140
import { renderToStaticMarkup } from 'react-dom/server' // F-CP-140
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { cellValueOf, editFieldOf, fieldsForList, IN_CELL_TYPES, storedOfCell } from '../../../../list-frame/custom/model'
import type { ListField } from '../../../../list-frame/tools/transport'
import { valueProblemKey } from '../../../../list-frame/w2b/model'
import { LIST_ROWS, canOf } from '../_demo/fixtures'
import type { OrderRow } from '../api'
import { NAMESPACE } from './sheet/model'
import { heldCell, orderEditOf } from './view/OrdersListView'
import { I18nProvider } from '../../../../lib/i18n/provider' // F-CP-107 (cp-fx16)

/**
 * B-TH-245 (threads plan TH-4, picture 27; features SHEET.brand-fields-F03 edit a custom value in a cell, -F08 Edit N,
 * O-SAL-ORD-LIST.grid-F26; wall W17, W19): the sheet's cells that edit — the order note and the custom values (TEXT, NUMBER, DATE,
 * SELECT, YES_NO) through the API's `sales.orders` bulk target, a version clash said in words, Edit N with its preview; the order's
 * lines never; a field for one customer never on another customer's row, and on a list of every customer not even a column.
 */

const t = createTranslator('en', messagesFor('en', ['orders']).orders!)
const s = createTranslator('en', messagesFor('en', [NAMESPACE])[NAMESPACE]!)
const lists = createTranslator('en', messagesFor('en', ['lists']).lists!)
const ALPHA = LIST_ROWS[0]!.partyId
const other = LIST_ROWS.find((row) => row.partyId !== ALPHA)!
const field = (over: Partial<ListField> = {}): ListField => ({ code: 'hang_tag', columnId: 'cf:hang_tag', type: 'TEXT', labelIt: 'Cartellino', labelEn: 'Hang tag', unit: null, companyId: null, partyId: null, options: [], ...over })
const words = { notThisCustomer: lists('custom.notThisCustomer'), yes: lists('custom.yes'), no: lists('custom.no') }
const spec = (over: Partial<ListField>, held?: (row: OrderRow) => string | null) =>
  editFieldOf<OrderRow>(field(over), { valueOf: () => null, partyOf: (row) => row.partyId, ...(held ? { held } : {}), label: 'x', words }, 'en')

describe('the order\'s own cells: the note — the lines never', () => {
  const edit = orderEditOf({ can: canOf('sales') }, s, (row) => heldCell(row, t, s), () => undefined)
  it('only the office note edits (no units, lines, promise or money cell)', () => {
    expect(Object.keys(edit.fields)).toEqual(['note'])
    expect(edit.fields.note).toMatchObject({ kind: 'text', nullable: true, maxLength: 2000 })
    expect(edit.bulk?.noun).toEqual({ one: 'order', other: 'orders' })
    expect(edit.versionOf(LIST_ROWS[0]!)).toBe(LIST_ROWS[0]!.version)
  })
  it('a closed or cancelled order keeps every cell, said in words; an open one edits', () => {
    const closed = LIST_ROWS.find((row) => row.status === 'CLOSED')!
    expect(edit.fields.note!.held?.(closed)).toBe('A Closed order never changes.')
    expect(edit.fields.note!.held?.(LIST_ROWS[0]!)).toBeNull()
  })
  it('without orders.manage every cell reads only (Edit N held with the reason)', () => {
    expect(orderEditOf({ can: canOf('manager') }, s, () => null, () => undefined).held).toBe('Changing the cells needs the right to change orders.')
    expect(edit.held).toBeNull()
  })
})

describe('custom values in their cells (SHEET.brand-fields-F03, -F08)', () => {
  it('TEXT, NUMBER, DATE, SELECT and YES_NO edit in a cell; money, multi-select, person, link and file open the order', () => {
    expect([...IN_CELL_TYPES]).toEqual(['TEXT', 'NUMBER', 'DATE', 'SELECT', 'YES_NO'])
    expect(spec({ type: 'TEXT' })?.kind).toBe('text')
    expect(spec({ type: 'NUMBER' })?.kind).toBe('number')
    expect(spec({ type: 'DATE' })?.kind).toBe('date')
    expect(spec({ type: 'YES_NO' })).toMatchObject({ kind: 'choice', choices: ['YES', 'NO'], choiceLabels: { YES: 'Yes', NO: 'No' } })
    for (const type of ['MONEY', 'MULTI_SELECT', 'PERSON', 'LINK', 'FILE']) expect(spec({ type }), type).toBeNull()
  })
  it('a select offers its active values; a deactivated one keeps its words on the rows that hold it', () => {
    const select = spec({ type: 'SELECT', options: [{ code: 'GIFT', labelIt: 'Regalo', labelEn: 'Gift box', active: true }, { code: 'OLD', labelIt: 'Vecchia', labelEn: 'Old box', active: false }] })!
    expect(select.choices).toEqual(['GIFT'])
    expect(select.choiceLabels).toEqual({ GIFT: 'Gift box', OLD: 'Old box' })
  })
  it('W17: a field for one customer is held on another customer\'s row (in words that name no one), editable on its own', () => {
    const alphaOnly = spec({ partyId: ALPHA })!
    expect(alphaOnly.held?.(other)).toBe(words.notThisCustomer)
    expect(alphaOnly.held?.(LIST_ROWS[0]!)).toBeNull()
    // The list's own reason (a closed order) comes first.
    const closed = LIST_ROWS.find((row) => row.status === 'CLOSED')!
    expect(spec({}, (row) => heldCell(row, t, s))!.held?.(closed)).toBe('A Closed order never changes.')
  })
  it('on a list of every customer a field for one customer is no column at all; on its customer\'s sheet it is', () => {
    const fields = [field(), field({ code: 'alpha_box', columnId: 'cf:alpha_box', partyId: ALPHA })]
    expect(fieldsForList(fields, null, true).map((entry) => entry.code)).toEqual(['hang_tag'])
    expect(fieldsForList(fields, ALPHA, true).map((entry) => entry.code)).toEqual(['hang_tag', 'alpha_box'])
    expect(fieldsForList(fields, null, false)).toHaveLength(2)
  })
  it('a cell holds what the target takes (YES / NO, a code, a number, a day) and gives it back as stored', () => {
    expect(cellValueOf({ type: 'YES_NO' }, { value: true, wordsIt: null, wordsEn: null })).toBe('YES')
    expect(cellValueOf({ type: 'YES_NO' }, { value: false, wordsIt: null, wordsEn: null })).toBe('NO')
    expect(cellValueOf({ type: 'SELECT' }, { value: 'GIFT', wordsIt: 'Regalo', wordsEn: 'Gift box' })).toBe('GIFT')
    expect(cellValueOf({ type: 'NUMBER' }, { value: 12.5, wordsIt: null, wordsEn: null })).toBe(12.5)
    expect(cellValueOf({ type: 'TEXT' }, undefined)).toBeNull()
    expect(storedOfCell({ type: 'YES_NO' }, 'YES')).toBe(true)
    expect(storedOfCell({ type: 'YES_NO' }, 'NO')).toBe(false)
    expect(storedOfCell({ type: 'DATE' }, '2026-12-01')).toBe('2026-12-01')
    expect(storedOfCell({ type: 'TEXT' }, null)).toBeNull()
  })
  it('a number cell says its own problem (never "not one of the choices")', () => {
    expect(valueProblemKey({ kind: 'number' }, 'abc')).toBe('edit.problem.number')
    expect(valueProblemKey({ kind: 'number' }, 12.5)).toBeNull()
  })
})

describe('the clash and the words', () => {
  it('a cell changed by someone else meanwhile: refused "changed since", in both languages (never overwritten)', () => {
    for (const locale of LOCALES) {
      expect(CATALOGUE[locale].lists?.['edit.refusal.stale'], locale).toBeTruthy()
      expect(CATALOGUE[locale].lists?.['edit.problem.number'], locale).toBeTruthy()
      expect(CATALOGUE[locale].lists?.['custom.notThisCustomer'], locale).toBeTruthy()
      for (const key of ['cells.final', 'cells.nounOne', 'cells.nounOther', 'cells.noManage']) expect(CATALOGUE[locale][NAMESPACE]?.[key], `${locale} ${key}`).toBeTruthy()
    }
  })
})

// ---- F-SA-212 (sales page plan N8, picks P13, P18): the Picture cell, the phone card and the picture large are the ONE part -----
describe('the Orders sheet mounts the ONE picture part (F-SA-212)', () => {
  const view = readFileSync(new URL('./view/OrdersListView.tsx', import.meta.url), 'utf8')
  const parts = readFileSync(new URL('./sheet/parts.tsx', import.meta.url), 'utf8')
  const css = readFileSync(new URL('./sheet/sheet.css', import.meta.url), 'utf8')
  it('the cell (76 px column, the cell size), the phone card\'s aside (the phone size) and the viewer come from lib/record-picture', () => {
    expect(view).toContain("from '../../../../../lib/record-picture/view/RecordPicture'")
    expect(view).toContain('size="cell"')
    expect(view).toContain('size="phone"')
    expect(view).toContain("picture: { role: 'aside' as const, draw: picture }")
    expect(view).toContain("{ colId: 'picture', headerName: s('col.picture'), minWidth: 76, maxWidth: 76")
    expect(view).toContain('read={input.latest.current.actions?.readPictures}')
  })
  it('the old copy is gone: no own cache, thumb or viewer, no thumb or viewer styles, no word set of its own', () => {
    for (const gone of ['SMALL_CACHE', 'useSmallPicture', 'PictureThumb', 'export function PictureViewer']) expect(parts, gone).not.toContain(gone)
    expect(css).not.toMatch(/\.fw-sheet-(thumb|viewer)/)
    for (const locale of LOCALES) expect(Object.keys(CATALOGUE[locale][NAMESPACE] ?? {}).filter((key) => key.startsWith('picture.')), locale).toEqual([])
    expect(existsSync(new URL('../../../../lib/record-picture/view/RecordPicture.tsx', import.meta.url))).toBe(true)
  })
})
// ---- end F-SA-212

// ---- F-SA-275 (sales page plan N5 / N2, picks R5, P10, P4; 11-customer-page §3.5; the API's B-SA-070): the production columns —
// Where it is, Waiting on, Supervisor (opt-in on Sales › Orders); a reader without workorders.view never gets a supervisor mark guessed.
describe('F-SA-275: the production columns', () => {
  const production = (over: Partial<NonNullable<OrderRow['production']>> = {}): NonNullable<OrderRow['production']> => ({ stage: 'SEWING', stageSince: '2026-11-10', health: 'AT_RISK', waitingOn: null, since: null, held: false, supervisorMark: 'SOMEONE_ELSE', openRequests: 0, openIssues: 0, withheld: [], ...over })
  const base = LIST_ROWS[0]!
  const withPart = (over: Partial<NonNullable<OrderRow['production']>> = {}, rest: Partial<OrderRow> = {}): OrderRow => ({ ...base, production: production(over), ...rest })

  it('the API row parses its production part, and an answer without it stays valid', async () => {
    const { orderRowSchema } = await import('../api')
    expect(orderRowSchema.parse({ ...base, production: production() }).production?.stage).toBe('SEWING')
    expect(orderRowSchema.parse(base).production).toBeUndefined()
  })
  it('Where it is: the stage and the health; no stage kept → the status; not read → nothing guessed', async () => {
    const { whereLineOf, piecesLineOf, HEALTH_CHIP } = await import('./sheet/model')
    expect(whereLineOf(withPart())).toEqual({ kind: 'stage', stage: 'SEWING', health: 'AT_RISK', held: false })
    expect(whereLineOf(withPart({ stage: null }))).toEqual({ kind: 'status' })
    expect(whereLineOf(base)).toEqual({ kind: 'unread' })
    expect(HEALTH_CHIP).toEqual({ LATE: 'LATE', AT_RISK: 'AT_RISK', NO_DATE: 'NOT_PROMISED', ON_TRACK: 'ON_TIME' })
    // This order's own pieces; a site that does not scan sewing says so (never 0); none in work yet; not read: no line.
    expect(piecesLineOf({ progress: { inWork: 300, cut: 300, sewn: 120, finished: 0 } })).toEqual({ key: 'where.sewn', params: { done: 120, total: 300 } })
    expect(piecesLineOf({ progress: { inWork: 300, cut: 300, sewn: null, finished: null } })).toEqual({ key: 'parts.stage.sewingNotCounted', production: true })
    expect(piecesLineOf({ progress: null })).toEqual({ key: 'progress.none' })
    expect(piecesLineOf({})).toBeNull()
  })
  it('Waiting on: a request first, then a reply that waits, then who acts next; the keeper\'s "us" beside a request is said once', async () => {
    const { waitingItemsOf, answerHrefOf } = await import('./sheet/model')
    const row = withPart({ openRequests: 1, waitingOn: 'US', since: '2026-11-17T08:00:00Z' })
    expect(waitingItemsOf(row).map((item) => item.kind)).toEqual(['request'])
    const marked = waitingItemsOf(row, { requestIds: ['req-1', 'req-2'], replySince: '2026-11-18T08:00:00Z' })
    expect(marked).toEqual([{ kind: 'request', count: 2, requestId: 'req-1' }, { kind: 'reply', since: '2026-11-18T08:00:00Z' }])
    expect(waitingItemsOf(withPart({ waitingOn: 'SUPPLIER', since: '2026-11-16T08:00:00Z' }))).toEqual([{ kind: 'keeper', on: 'SUPPLIER', since: '2026-11-16T08:00:00Z' }])
    expect(waitingItemsOf(withPart())).toEqual([])
    expect(waitingItemsOf(base)).toEqual([])
    // Answer request…: the host's review window (the customer page's door), else the order's Changes tab.
    const request = { kind: 'request' as const, count: 1, requestId: 'req-1' }
    expect(answerHrefOf('/w/acme', { id: 'o1' }, request, (id) => `/w/acme/sales/customers/p?tab=work&open=${id}`)).toBe('/w/acme/sales/customers/p?tab=work&open=req-1')
    expect(answerHrefOf('/w/acme', { id: 'o1' }, request, null)).toBe('/w/acme/sales/orders/o1?tab=changes')
  })
  it('Supervisor: the mark only — held when the reader\'s workorders.view does not reach the order (never guessed, never a name)', async () => {
    const { supervisorCellOf } = await import('./sheet/model')
    expect(supervisorCellOf(withPart({ supervisorMark: 'ME' }))).toEqual({ kind: 'mark', mark: 'ME' })
    expect(supervisorCellOf(withPart({ supervisorMark: null, openIssues: null, withheld: ['supervisorMark', 'openIssues'] }))).toEqual({ kind: 'withheld' })
    expect(supervisorCellOf(base)).toEqual({ kind: 'unread' })
  })
  it('the columns are the sheet\'s own (opt-in), named by the export source\'s ids (screen = file), read only while shown', () => {
    const view = readFileSync(new URL('./view/OrdersListView.tsx', import.meta.url), 'utf8')
    const source = readFileSync(new URL('../../../../../../factory-api/src/platform/exports/sources/sales-orders.ts', import.meta.url), 'utf8')
    for (const id of ['whereItIs', 'waitingOn', 'supervisor']) {
      expect(view, id).toContain(`later({ colId: '${id}'`)
      expect(source, id).toMatch(new RegExp(`\\b${id}: \\{`))
    }
    const hook = readFileSync(new URL('./use-orders-sheet.ts', import.meta.url), 'utf8')
    expect(hook).toContain('PRODUCTION_COLUMNS.includes(id)')
    expect(hook).toContain('production: productionShown')
    // The row's ⋯: Add task… (when the host offers it) and Answer request… while a request waits.
    expect(view).toContain("s('row.addTask')")
    expect(view).toContain("s('row.answer')")
  })
  it('every word in both languages (no key left); the marks are the supervisor catalogue\'s own (R9: no new synonym)', () => {
    for (const locale of LOCALES) {
      const sheet = createTranslator(locale, messagesFor(locale, [NAMESPACE])[NAMESPACE]!)
      for (const key of ['col.whereItIs', 'col.whereItIsHint', 'col.waitingOn', 'col.waitingOnHint', 'col.supervisor', 'col.supervisorHint', 'waiting.request', 'waiting.answerTip', 'row.addTask', 'row.answer', 'held.workorders']) expect(sheet(key, { number: 'SO-1' }), `${locale} ${key}`).not.toBe(key)
      expect(sheet('where.sewn', { done: 120, total: 300 }), locale).toMatch(/120.*300/)
      expect(sheet('waiting.reply', { time: '4 h' }), locale).toContain('4 h')
      expect(sheet('waiting.more', { count: 1 }), locale).toContain('1')
      const marks = createTranslator(locale, messagesFor(locale, ['production-supervisor'])['production-supervisor']!)
      for (const mark of ['ME', 'SOMEONE_ELSE', 'NOT_SET']) expect(marks(`mark.${mark}`), `${locale} ${mark}`).not.toBe(`mark.${mark}`)
    }
    expect(createTranslator('en', messagesFor('en', [NAMESPACE])[NAMESPACE]!)('where.sewn', { done: 120, total: 300 })).toBe('120 of 300 sewn')
  })
})
// ---- end F-SA-275

// ---- F-CP-107 (cp-fx16; oo-walk 15 b): the same fact never twice in one row — the customer page's All orders showed "Waiting for a
// yes" in Status AND in Where it is (a row with no stage kept draws the order's status there, F-SA-275).
describe('F-CP-107 (cp-fx16): Where it is never repeats the Status the row shows', () => {
  const textOfHtml = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim()
  const part = (over: Partial<NonNullable<OrderRow['production']>> = {}): NonNullable<OrderRow['production']> => ({ stage: null, stageSince: null, health: null, waitingOn: null, since: null, held: false, supervisorMark: 'NOT_SET', openRequests: 0, openIssues: 0, withheld: [], ...over })
  const waiting: OrderRow = { ...LIST_ROWS[0]!, number: 'SEED-SO-W39-01', status: 'PENDING_APPROVAL', progress: null, production: part() }
  const draw = async (row: OrderRow, statusShown?: boolean) => {
    const { WhereItIsCell } = await import('./sheet/parts')
    const cell = createElement(WhereItIsCell, { row, t, s, ...(statusShown === undefined ? {} : { statusShown }) })
    return textOfHtml(renderToStaticMarkup(createElement(I18nProvider, { locale: 'en', messages: {} }, cell)))
  }

  it('no stage kept, Status on screen: only this order\'s pieces ("Not in work yet"), "—" while not read; Status hidden: the status stays', async () => {
    expect(await draw(waiting, true)).toBe('Not in work yet')
    expect(await draw({ ...waiting, progress: undefined }, true)).toBe('—')
    // Status hidden (Customise, a view without it): the fact is never lost — the status pill, then the pieces (as before).
    expect(await draw(waiting, false)).toBe('Waiting for a yes Not in work yet')
    expect(await draw(waiting)).toBe('Waiting for a yes Not in work yet')
    // A row with a stage keeps its stage and pieces whatever Status does; a row not read stays "—".
    const sewing: OrderRow = { ...waiting, status: 'IN_PRODUCTION', progress: { inWork: 300, cut: 300, sewn: 120, finished: 0 }, production: part({ stage: 'SEWING', health: 'ON_TRACK' }) }
    expect(await draw(sewing, true)).toBe(await draw(sewing, false))
    expect(await draw(sewing, true)).toContain('120 of 300 sewn')
    expect(await draw({ ...waiting, production: undefined }, true)).toBe('—')
  })

  it('the view tells the cell whether Status is on screen: the frame\'s shown columns (a person\'s Customise wins), until then the preset', async () => {
    const { statusShownOf } = await import('./view/OrdersListView')
    expect(statusShownOf(null)).toBe(true) // Sales › Orders: Status is the sheet's own column
    expect(statusShownOf({ shown: ['picture', 'number', 'status', 'whereItIs'] })).toBe(true)
    expect(statusShownOf({ shown: ['picture', 'number', 'whereItIs'] })).toBe(false) // In production
    const view = readFileSync(new URL('./view/OrdersListView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("setShowsStatus(ids.includes('status'))")
    expect(view).toContain('actions?.onShownColumns?.(ids)') // B-TH-244 still told
    expect(view).toContain('statusShown={statusShown')
  })
})
// ---- end F-CP-107 (cp-fx16)

// ---- F-CP-140 (customer page plan C2d; design 11-money §3.1; review G1): the Price check cell and the Difference — three states,
// never "Equal" without the customer's price; a mark beside each word (never colour alone); a signed difference in words.
describe('F-CP-140: the Price check cell and the Difference', () => {
  const words = (locale: (typeof LOCALES)[number]) => createTranslator(locale, messagesFor(locale, ['orders']).orders!)
  const en = words('en')
  const draw = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node)
  const textOfHtml = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim()

  it('the three states as the cell draws them (pure)', async () => {
    const { priceMatchCellOf } = await import('./price-check-columns')
    expect(priceMatchCellOf({ priceMatch: 'EQUAL', priceNotEqualLines: 0 })).toEqual({ state: 'EQUAL', tone: 'neutral', words: { key: 'priceCheck.EQUAL' } })
    expect(priceMatchCellOf({ priceMatch: 'NOT_EQUAL', priceNotEqualLines: 2 })).toEqual({ state: 'NOT_EQUAL', tone: 'danger', words: { key: 'priceCheck.NOT_EQUAL' }, lines: { key: 'priceCheck.lines', params: { count: 2 } } })
    // A known difference of the whole order with no line apart (a total row only): Not equal, no line count.
    expect(priceMatchCellOf({ priceMatch: 'NOT_EQUAL', priceNotEqualLines: 0 })).toMatchObject({ state: 'NOT_EQUAL', lines: null })
    expect(priceMatchCellOf({ priceMatch: 'NO_BRAND_PRICE' })).toEqual({ state: 'NO_BRAND_PRICE', words: { key: 'priceCheck.NO_BRAND_PRICE' } })
    // No check on the row (a reader without the price grain, an older answer): nothing — never "Equal", never a guess.
    expect(priceMatchCellOf({})).toBeNull()
  })

  it('Equal: a neutral DS Tag with the Equal mark; Not equal: a danger Tag with the EqualNot mark and "{count} lines" under it', async () => {
    const { PriceMatchCell } = await import('./view/PriceMatchCell')
    const equal = draw(createElement(PriceMatchCell, { row: { priceMatch: 'EQUAL', priceNotEqualLines: 0 }, t: en }))
    expect(equal).toContain('nds-tag neutral')
    expect(equal).toContain('lucide-equal')
    expect(textOfHtml(equal)).toBe('Equal')
    const differ = draw(createElement(PriceMatchCell, { row: { priceMatch: 'NOT_EQUAL', priceNotEqualLines: 2 }, t: en }))
    expect(differ).toContain('nds-tag danger')
    expect(differ).toContain('lucide-equal-not')
    expect(textOfHtml(differ)).toBe('Not equal 2 lines')
    expect(textOfHtml(draw(createElement(PriceMatchCell, { row: { priceMatch: 'NOT_EQUAL', priceNotEqualLines: 1 }, t: en })))).toBe('Not equal 1 line')
  })

  it('"— No customer price yet" is plain text (the DS Tag has no plain tone: review G1), never a Tag, never "Equal"', async () => {
    const { PriceMatchCell } = await import('./view/PriceMatchCell')
    const none = draw(createElement(PriceMatchCell, { row: { priceMatch: 'NO_BRAND_PRICE' }, t: en }))
    expect(none).not.toContain('nds-tag')
    expect(textOfHtml(none)).toBe('— No customer price yet')
    expect(textOfHtml(none)).not.toMatch(/\bEqual\b/)
    expect(draw(createElement(PriceMatchCell, { row: {}, t: en }))).toBe('')
  })

  it('a funnel only where the host narrows by the check (its words per state); without one the words stand alone', async () => {
    const { PriceMatchCell } = await import('./view/PriceMatchCell')
    const plain = draw(createElement(PriceMatchCell, { row: { priceMatch: 'NOT_EQUAL', priceNotEqualLines: 2 }, t: en }))
    expect(plain).not.toContain('fw-sheet-funnel')
    const funnel = draw(createElement(PriceMatchCell, { row: { priceMatch: 'NOT_EQUAL', priceNotEqualLines: 2 }, t: en, onNarrow: () => undefined }))
    expect(funnel).toContain('fw-sheet-funnel')
    expect(funnel).toContain('title="Show only the orders whose prices differ"')
    const none = draw(createElement(PriceMatchCell, { row: { priceMatch: 'NO_BRAND_PRICE' }, t: en, onNarrow: () => undefined }))
    expect(none).toContain("title=\"Show only the orders without the customer&#x27;s price\"")
  })

  it('the Difference: our price − the customer\'s, + we ask more, − we ask less (a true minus sign), 0 plain, unknown —', async () => {
    const { priceDiffOf, signedMoney } = await import('./price-check-columns')
    const { PriceDiffCell } = await import('./view/PriceMatchCell')
    expect(priceDiffOf({ priceDiff: 6000 })).toEqual({ sign: 'more', minor: 6000, words: { key: 'priceCheck.more' } })
    expect(priceDiffOf({ priceDiff: -1000 })).toEqual({ sign: 'less', minor: 1000, words: { key: 'priceCheck.less' } })
    expect(priceDiffOf({ priceDiff: 0 })).toEqual({ sign: 'same', minor: 0, words: null })
    expect(priceDiffOf({ priceDiff: null })).toBeNull()
    expect(signedMoney(priceDiffOf({ priceDiff: 6000 }), 'EUR', 'en')).toBe('+€60.00')
    expect(signedMoney(priceDiffOf({ priceDiff: -1000 }), 'EUR', 'en')).toBe('−€10.00')
    expect(signedMoney(priceDiffOf({ priceDiff: 0 }), 'EUR', 'en')).toBe('€0.00')
    expect(signedMoney(priceDiffOf({ priceDiff: null }), 'EUR', 'en')).toBe('—')
    expect(textOfHtml(draw(createElement(PriceDiffCell, { row: { priceDiff: 6000, currency: 'EUR' }, t: en, locale: 'en' })))).toBe('+€60.00 we ask more')
    expect(textOfHtml(draw(createElement(PriceDiffCell, { row: { priceDiff: -1000, currency: 'EUR' }, t: en, locale: 'en' })))).toBe('−€10.00 we ask less')
    expect(textOfHtml(draw(createElement(PriceDiffCell, { row: { priceDiff: null, currency: 'EUR' }, t: en, locale: 'en' })))).toBe('—')
    // No price grain: the field is absent, the cell draws nothing (never 0).
    expect(draw(createElement(PriceDiffCell, { row: { currency: 'EUR' }, t: en, locale: 'en' }))).toBe('')
  })

  it('every word in both languages, the line count in pairs', () => {
    for (const locale of LOCALES) {
      const t = words(locale)
      for (const key of ['priceCheck.EQUAL', 'priceCheck.NOT_EQUAL', 'priceCheck.NO_BRAND_PRICE', 'priceCheck.more', 'priceCheck.less', 'priceCheck.filter.EQUAL', 'priceCheck.filter.NOT_EQUAL', 'priceCheck.filter.NO_BRAND_PRICE']) expect(t(key), `${locale} ${key}`).not.toBe(key)
      expect(t('priceCheck.lines', { count: 1 }), locale).toMatch(/^1 /)
      expect(t('priceCheck.lines', { count: 3 }), locale).toMatch(/^3 /)
      expect(t('priceCheck.NO_BRAND_PRICE'), locale).not.toMatch(/equal|uguale/i)
    }
    expect(words('it')('priceCheck.NOT_EQUAL')).toBe('Diverso')
    expect(words('it')('priceCheck.lines', { count: 2 })).toBe('2 righe')
  })
})
// ---- end F-CP-140
