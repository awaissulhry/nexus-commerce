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
import type { BusinessDate } from '@nexus/factory-domain/core/time' // F-MS-104
import { productionWordsFor } from '../../../../lib/production/words' // F-MS-104

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
  // F-CW-202 (S9): Edit N is an act — without orders.manage it is not drawn (it was shown held); the cells keep their words.
  it('without orders.manage every cell reads only, held in words, and Edit N is not drawn', () => {
    const reader = orderEditOf({ can: canOf('manager') }, s, () => null, () => undefined)
    expect(reader.held).toBe('Changing the cells needs the right to change orders.')
    expect(reader.bulk).toBeUndefined()
    expect(edit.held).toBeNull()
    expect(edit.bulk).toBeDefined()
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
  // F-CW-102: no deposit asked on this made-up row (an open one would be the cell's third chip: its own tests are below).
  const waiting: OrderRow = { ...LIST_ROWS[0]!, number: 'SEED-SO-W39-01', status: 'PENDING_APPROVAL', deposit: { state: 'NOT_NEEDED', dueDate: null }, progress: null, production: part() }
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

  // F-OM-305 (B-OM-020, S3 #1857): a difference accepted by hand — one rule with the server (its "Not equal" filter leaves it out).
  it('accepted by hand: an info "Not equal" Tag with "Accepted by hand" under it, no funnel; its words for the copy and the file', async () => {
    const { priceMatchCellOf, priceCheckText } = await import('./price-check-columns')
    const { PriceMatchCell } = await import('./view/PriceMatchCell')
    expect(priceMatchCellOf({ priceMatch: 'NOT_EQUAL', priceNotEqualLines: 1, priceAccepted: true })).toEqual({ state: 'ACCEPTED', tone: 'info', words: { key: 'priceCheck.NOT_EQUAL' }, accepted: { key: 'moneyTab.price.tag.accepted' }, lines: { key: 'priceCheck.lines', params: { count: 1 } } })
    expect(priceMatchCellOf({ priceMatch: 'NOT_EQUAL', priceNotEqualLines: 1, priceAccepted: false })!.state).toBe('NOT_EQUAL')
    // Only a "Not equal" can be accepted: an equal row stays Equal whatever the flag says.
    expect(priceMatchCellOf({ priceMatch: 'EQUAL', priceAccepted: true })!.state).toBe('EQUAL')
    const html = draw(createElement(PriceMatchCell, { row: { priceMatch: 'NOT_EQUAL', priceNotEqualLines: 1, priceAccepted: true }, t: en, onNarrow: () => undefined }))
    expect(html).toContain('nds-tag info')
    expect(html).not.toContain('fw-sheet-funnel')
    expect(textOfHtml(html)).toBe('Not equal Accepted by hand · 1 line')
    for (const locale of LOCALES) expect(words(locale)('moneyTab.price.tag.accepted'), locale).not.toBe('moneyTab.price.tag.accepted')
    expect(textOfHtml(draw(createElement(PriceMatchCell, { row: { priceMatch: 'NOT_EQUAL', priceNotEqualLines: 1, priceAccepted: true }, t: words('it') })))).toBe('Diverso Accettata a mano · 1 riga')
    const row = { priceMatch: 'NOT_EQUAL', priceNotEqualLines: 1, priceAccepted: true } as Parameters<typeof priceCheckText>[1]
    expect(priceCheckText('priceMatch', row, en, 'en')).toBe('Not equal · Accepted by hand · 1 line')
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

// ---- F-MS-104 (set the stage by hand, 04 §5; R17; the API's B-MS-006): the list's "set by hand" mark — part of the stage (the dense
// cell keeps the stage and the health), the hidden words and the DS Tooltip (no name, no reason in a list), amber after 7 days with
// "check it" in words (never the colour alone), and the phone line "Sewing (by hand) · At risk". Without a hand stage: unchanged.
describe('F-MS-104: a stage set by hand in Where it is', () => {
  const TODAY = '2026-11-20' as BusinessDate
  const part = (over: Partial<NonNullable<OrderRow['production']>> = {}): NonNullable<OrderRow['production']> => ({ stage: 'SEWING', stageSince: '2026-11-10', health: 'AT_RISK', waitingOn: null, since: null, held: false, supervisorMark: 'SOMEONE_ELSE', openRequests: 0, openIssues: 0, withheld: [], ...over })
  const row = (over: Partial<NonNullable<OrderRow['production']>> = {}, rest: Partial<OrderRow> = {}): OrderRow => ({ ...LIST_ROWS[0]!, status: 'IN_PRODUCTION', production: part(over), ...rest })
  const set = (since: string) => ({ stageByHand: { since } })
  const textOfHtml = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim()
  const markupOf = async (r: OrderRow, locale: (typeof LOCALES)[number] = 'en') => {
    const { WhereItIsCell } = await import('./sheet/parts')
    const words = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
    const sheet = createTranslator(locale, messagesFor(locale, [NAMESPACE])[NAMESPACE]!)
    return renderToStaticMarkup(createElement(I18nProvider, { locale, messages: {} }, createElement(WhereItIsCell, { row: r, t: words, s: sheet })))
  }
  const wordsOf = (locale: (typeof LOCALES)[number]) => {
    const words = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
    const pw = productionWordsFor(locale)
    return { status: (status: string) => words(`status.${status}`), stage: (stage: string) => pw(`parts.stage.${stage}`), health: (chip: string) => pw(`parts.health.${chip}`), byHand: (stage: string) => words('list.byHand.phone', { stage }) }
  }
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

  it('the API row parses stageByHand (since when it was set); null and an older answer without it stay valid', async () => {
    const { orderRowSchema } = await import('../api')
    expect(orderRowSchema.parse(row(set('2026-11-18T09:00:00.000Z'))).production?.stageByHand).toEqual({ since: '2026-11-18T09:00:00.000Z' })
    expect(orderRowSchema.parse(row({ stageByHand: null })).production?.stageByHand).toBeNull()
    expect(orderRowSchema.parse(row()).production?.stageByHand).toBeUndefined()
  })

  it('whereLineOf: the stage keeps its place and gains the mark; amber from 7 days (company days); without it no new key', async () => {
    const { whereLineOf } = await import('./sheet/model')
    expect(whereLineOf(row(set('2026-11-18T09:00:00.000Z')), TODAY)).toEqual({ kind: 'stage', stage: 'SEWING', health: 'AT_RISK', held: false, byHand: { old: false } })
    expect(whereLineOf(row(set('2026-11-14T09:00:00.000Z')), TODAY)).toMatchObject({ byHand: { old: false } }) // 6 days
    expect(whereLineOf(row(set('2026-11-13T09:00:00.000Z')), TODAY)).toMatchObject({ byHand: { old: true } }) // 7 days
    expect(whereLineOf(row(set('2026-11-13')), TODAY)).toMatchObject({ byHand: { old: true } }) // a day, as an answer may send it
    // No hand stage (null, or an answer before it): exactly the line of F-SA-275, no `byHand` key at all.
    expect(whereLineOf(row({ stageByHand: null }), TODAY)).toStrictEqual({ kind: 'stage', stage: 'SEWING', health: 'AT_RISK', held: false })
    expect(whereLineOf(row(), TODAY)).toStrictEqual({ kind: 'stage', stage: 'SEWING', health: 'AT_RISK', held: false })
    // No stage kept, or not read: the hand changes nothing.
    expect(whereLineOf(row({ stage: null, ...set('2026-11-18T09:00:00.000Z') }), TODAY)).toEqual({ kind: 'status' })
  })

  it('the phone line (and the grid value): "Sewing (by hand) · At risk" / "Confezione (a mano) · A rischio"; without it as before', async () => {
    const { whereTextOf } = await import('./sheet/model')
    expect(whereTextOf(row(set('2026-11-18T09:00:00.000Z')), wordsOf('en'), TODAY)).toBe('Sewing (by hand) · At risk')
    expect(whereTextOf(row(set('2026-11-18T09:00:00.000Z')), wordsOf('it'), TODAY)).toBe('Confezione (a mano) · A rischio')
    expect(whereTextOf(row({ ...set('2026-11-18T09:00:00.000Z'), health: null }), wordsOf('en'), TODAY)).toBe('Sewing (by hand)')
    expect(whereTextOf(row(), wordsOf('en'), TODAY)).toBe('Sewing · At risk')
    expect(whereTextOf(row({ stage: null }), wordsOf('en'), TODAY)).toBe('In production')
    expect(whereTextOf(LIST_ROWS[0]!, wordsOf('en'), TODAY)).toBe('')
    // The view says the line through the model (one rule), with the list's own words.
    const view = readFileSync(new URL('./view/OrdersListView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('whereTextOf(row, {')
    expect(view).toContain("t('list.byHand.phone', { stage })")
  })

  it('the cell: the 12 px hand right after the stage (aria-hidden), the hidden words, the DS Tooltip; the pieces line stays', async () => {
    const markup = await markupOf(row(set(daysAgo(1)), { progress: { inWork: 300, cut: 300, sewn: 120, finished: 0 } }))
    expect(markup).toMatch(/<b>Sewing<\/b><span class="nds-tooltip"[^>]*><span class="fw-sheet-hand" data-by-hand="">/)
    const svg = markup.match(/<svg[^>]*lucide-hand[^>]*>/)?.[0] ?? ''
    expect(svg).toContain('width="12"')
    expect(svg).toContain('aria-hidden="true"')
    expect(markup).toContain('<span class="nds-vh">set by hand</span>')
    expect(textOfHtml(markup)).toContain('120 of 300 sewn')
    // The dense cell keeps two marks: the stage (with its hand) and the health; the hand is no chip of its own.
    expect(markup).not.toMatch(/nds-tag[^"]*"[^>]*>[^<]*(by hand|a mano)/)
    // 7 days or more: amber, and the words say "check it" (never the colour alone).
    const old = await markupOf(row(set(daysAgo(9))))
    expect(old).toContain('class="fw-sheet-hand old" data-by-hand="old"')
    expect(old).toContain('<span class="nds-vh">set by hand 7 or more days ago: check it</span>')
    const italian = await markupOf(row(set(daysAgo(1))), 'it')
    expect(italian).toContain('<span class="nds-vh">impostata a mano</span>')
    expect(italian).toContain('<b>Confezione</b>')
  })

  it('without a hand stage the cell is drawn exactly as before (F-SA-275 and cp-fx16 stay)', async () => {
    const plain = row({}, { progress: { inWork: 300, cut: 300, sewn: 120, finished: 0 } })
    const before = await markupOf(plain)
    expect(before).not.toContain('fw-sheet-hand')
    expect(textOfHtml(before)).not.toMatch(/by hand/i)
    expect(await markupOf(row({ stageByHand: null }, { progress: { inWork: 300, cut: 300, sewn: 120, finished: 0 } }))).toBe(before)
    expect(textOfHtml(before)).toContain('120 of 300 sewn')
  })

  it('the amber is the warning token in the sheet\'s own styles (no new raw colour); the Work tab draws this same cell', () => {
    const css = readFileSync(new URL('./sheet/sheet.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.fw-sheet-hand\.old \{\s*color: var\(--nds-warning\);/)
    const block = css.slice(css.indexOf('.fw-sheet-hand {'), css.indexOf('.fw-sheet-hand.old'))
    expect(block).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i)
    const work = readFileSync(new URL('../../customers/record/view/WorkTab.tsx', import.meta.url), 'utf8')
    expect(work).toContain("from '../../../orders/list/view/OrdersListView'")
  })

  it('every word in both languages: the hidden words, the tip (who and why live on the order), the amber words, the phone line', () => {
    for (const locale of LOCALES) {
      const words = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['list.byHand.mark', 'list.byHand.oldMark', 'list.byHand.tip', 'list.byHand.oldTip', 'list.byHand.phone']) expect(words(key, { days: 7, stage: 'X' }), `${locale} ${key}`).not.toBe(key)
      expect(words('list.byHand.oldMark', { days: 7 }), locale).toContain('7')
      expect(words('list.byHand.phone', { stage: 'X' }), locale).toMatch(/^X \(/)
    }
    const en = createTranslator('en', messagesFor('en', ['orders']).orders!)
    const italian = createTranslator('it', messagesFor('it', ['orders']).orders!)
    expect([en('list.byHand.mark'), en('list.byHand.tip'), en('list.byHand.phone', { stage: 'Sewing' })]).toEqual(['set by hand', 'Set by hand — the order says who and why', 'Sewing (by hand)'])
    expect([italian('list.byHand.mark'), italian('list.byHand.tip'), italian('list.byHand.phone', { stage: 'Confezione' })]).toEqual(['impostata a mano', "Impostata a mano — l'ordine dice chi e perché", 'Confezione (a mano)'])
  })
})
// ---- end F-MS-104

// ---- F-CW-102 (customer Work tab plan §1; 10-design §3.5; lead settles S3, S6, S7, S13, S15, S31, S33, S38; the API's B-CW-010…015,
// B-CW-020): the row's chips — the shared sheet's cells, the same on the customer's Work tab, Sales › Orders and Sales › Made to
// measure. Where it is: chip 1 the stage (the order's real status word where no stage is "now"), chip 2 only Late / At risk, chip 3
// the ONE thing that stops it; line 2 this order's own pieces. Customer urgency: the customer's own mark as its chip says it, read
// only, our Priority beside it when it is not Normal. New messages: a count bubble.
describe('F-CW-102: the row\'s chips', () => {
  const TODAY = '2026-11-23'
  const DAY = TODAY as BusinessDate
  const part = (over: Partial<NonNullable<OrderRow['production']>> = {}): NonNullable<OrderRow['production']> => ({ stage: 'SEWING', stageSince: '2026-11-10', health: 'ON_TRACK', waitingOn: null, since: null, held: false, supervisorMark: 'ME', openRequests: 0, openIssues: 0, withheld: [], ...over })
  const base: OrderRow = { ...LIST_ROWS[0]!, number: 'SEED-SO-0009', status: 'IN_PRODUCTION', deposit: { state: 'PAID', dueDate: null }, units: 244, shippedUnits: 0, daysLate: null }
  const row = (over: Partial<OrderRow> = {}, production: Partial<NonNullable<OrderRow['production']>> = {}): OrderRow => ({ ...base, production: part(production), ...over })
  const textOfHtml = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim()
  const wordsFor = (locale: (typeof LOCALES)[number]) => ({ t: createTranslator(locale, messagesFor(locale, ['orders']).orders!), s: createTranslator(locale, messagesFor(locale, [NAMESPACE])[NAMESPACE]!), d: createTranslator(locale, messagesFor(locale, ['sales-orders-depth'])['sales-orders-depth']!), l: createTranslator(locale, messagesFor(locale, ['last-message'])['last-message']!) })
  type WhereProps = Parameters<typeof import('./sheet/parts').WhereItIsCell>[0]
  type UrgencyProps = Parameters<typeof import('./sheet/parts').CustomerUrgencyCell>[0]
  const where = async (r: OrderRow, props: Partial<WhereProps> = {}, locale: (typeof LOCALES)[number] = 'en') => {
    const { WhereItIsCell } = await import('./sheet/parts')
    const { t: words, s: sheet } = wordsFor(locale)
    return renderToStaticMarkup(createElement(I18nProvider, { locale, messages: {} }, createElement(WhereItIsCell, { row: r, t: words, s: sheet, today: TODAY, now: Date.parse('2026-11-23T10:00:00Z'), ...props })))
  }
  const urgency = async (r: OrderRow, props: Partial<UrgencyProps> = {}, locale: (typeof LOCALES)[number] = 'en') => {
    const { CustomerUrgencyCell } = await import('./sheet/parts')
    const { s: sheet, d } = wordsFor(locale)
    return renderToStaticMarkup(createElement(CustomerUrgencyCell, { row: r, s: sheet, d, ...props }))
  }

  it('the API row parses every new field, and an older answer without them stays valid (the web never waits)', async () => {
    const { orderRowSchema } = await import('../api')
    const now = orderRowSchema.parse({
      ...base,
      reaccept: true,
      deposit: { state: 'NOT_NEEDED', dueDate: null, extraOpenDue: '2026-11-25' },
      progress: { inWork: 200, cut: 180, sewn: 152, finished: 24, ordered: 244 },
      customerUrgencyState: { state: 'URGENT', urgentRank: 2, locked: false, requestId: null },
      production: { ...part(), readyNow: 24, openIssuesSince: '2026-11-21T08:00:00.000Z' },
    })
    expect([now.reaccept, now.deposit.extraOpenDue, now.progress?.ordered, now.customerUrgencyState?.urgentRank, now.production?.readyNow, now.production?.openIssuesSince]).toEqual([true, '2026-11-25', 244, 2, 24, '2026-11-21T08:00:00.000Z'])
    const older = orderRowSchema.parse({ ...base, production: part(), progress: { inWork: 200, cut: 180, sewn: 152, finished: 24 } })
    expect([older.reaccept, older.deposit.extraOpenDue, older.progress?.ordered, older.customerUrgencyState, older.production?.readyNow, older.production?.openIssuesSince]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined])
    expect(orderRowSchema.parse({ ...base, customerUrgencyState: null }).customerUrgencyState).toBeNull()
    expect(orderRowSchema.safeParse({ ...base, customerUrgencyState: { state: 'RUSH', urgentRank: 1, locked: false, requestId: null } }).success).toBe(false)
  })

  it('chip 1 — the stage of an order in production (Preparing while none is kept), "Ready to ship", else the order\'s real status word', async () => {
    const { stageChipOf } = await import('./sheet/model')
    expect(stageChipOf(row(), DAY)).toEqual({ kind: 'stage', stage: 'SEWING', phase: 'IN_PRODUCTION' })
    expect(stageChipOf(row({}, { stage: 'PREPARING' }), DAY)).toEqual({ kind: 'stage', stage: 'PREPARING', phase: 'NOT_STARTED' })
    expect(stageChipOf(row({}, { stage: null }), DAY)).toEqual({ kind: 'stage', stage: 'PREPARING', phase: 'NOT_STARTED' }) // S38
    expect(stageChipOf(row({}, { stageByHand: { since: '2026-11-22T09:00:00.000Z' } }), DAY)).toEqual({ kind: 'stage', stage: 'SEWING', phase: 'IN_PRODUCTION', byHand: { old: false } })
    expect(stageChipOf(row({}, { stageByHand: { since: '2026-11-10T09:00:00.000Z' } }), DAY)).toMatchObject({ byHand: { old: true } })
    expect(stageChipOf(row({ status: 'READY' }, { stage: 'READY' }), DAY)).toEqual({ kind: 'stage', stage: 'READY', phase: 'READY' })
    // The status decides the group (the domain's one rule): a confirmed order whose kept row says a stage is still "Confirmed".
    expect(stageChipOf(row({ status: 'CONFIRMED' }, { stage: 'QUALITY' }), DAY)).toEqual({ kind: 'status', status: 'CONFIRMED', phase: 'NOT_SENT' })
    expect(stageChipOf(row({ status: 'PENDING_APPROVAL' }, { stage: null }), DAY)).toEqual({ kind: 'status', status: 'PENDING_APPROVAL', phase: 'NOT_SENT' })
    expect(stageChipOf(row({ status: 'PARTLY_SHIPPED', units: 114, shippedUnits: 40 }), DAY)).toEqual({ kind: 'status', status: 'PARTLY_SHIPPED', phase: 'SHIPPED', shipped: { shipped: 40, units: 114 } })
    for (const [status, phase] of [['SHIPPED', 'SHIPPED'], ['DELIVERED', 'DONE'], ['CLOSED', 'DONE'], ['CANCELLED', 'CANCELLED']] as const) expect(stageChipOf(row({ status }, { stage: null, health: null }), DAY), status).toEqual({ kind: 'status', status, phase })
    // Not read (the production part comes with the column): nothing is guessed.
    expect(stageChipOf(base, DAY)).toBeNull()
  })

  it('chip 2 — the health only when something is wrong: Late or At risk; never "On track", never "No date yet"', async () => {
    const { healthChipOf } = await import('./sheet/model')
    expect(healthChipOf(row({}, { health: 'LATE' }))).toBe('LATE')
    expect(healthChipOf(row({}, { health: 'AT_RISK' }))).toBe('AT_RISK')
    for (const health of ['ON_TRACK', 'NO_DATE', null] as const) expect(healthChipOf(row({}, { health })), String(health)).toBeNull()
    expect(healthChipOf(base)).toBeNull()
    const html = textOfHtml(await where(row()))
    expect(html).not.toMatch(/On track|No date yet/)
  })

  it('chip 3 — the ONE thing that stops it, the first that applies: credit · the factory review · a deposit · a new yes · on hold · a request · a reply · who it waits on', async () => {
    const { stopChipOf } = await import('./sheet/model')
    const everything = row(
      { status: 'CONFIRMED', waits: ['CREDIT_HOLD', 'MEASUREMENTS'], deposit: { state: 'OPEN', dueDate: '2026-11-25' }, reaccept: true },
      { held: true, openRequests: 1, waitingOn: 'BRAND', since: '2026-11-20T10:00:00Z' },
    )
    const mark = { requestIds: ['req-1'], replySince: '2026-11-23T06:00:00Z' }
    const kinds: string[] = []
    let current: OrderRow = everything
    // Take the first reason away each time: the next one shows — the order of the reasons, pinned.
    const steps: Array<(r: OrderRow) => OrderRow> = [
      (r) => ({ ...r, waits: ['MEASUREMENTS'] }),
      (r) => ({ ...r, waits: null }),
      (r) => ({ ...r, deposit: { state: 'NOT_NEEDED', dueDate: null, extraOpenDue: '2026-11-25' } }),
      (r) => ({ ...r, deposit: { state: 'NOT_NEEDED', dueDate: null, extraOpenDue: null } }),
      (r) => ({ ...r, reaccept: false }),
      (r) => ({ ...r, production: { ...r.production!, held: false } }),
    ]
    kinds.push(stopChipOf(current, mark, TODAY)!.kind)
    for (const step of steps) {
      current = step(current)
      const chip = stopChipOf(current, mark, TODAY)!
      kinds.push(chip.kind === 'deposit' && chip.extra ? 'deposit-extra' : chip.kind)
    }
    expect(kinds).toEqual(['credit', 'review', 'deposit', 'deposit-extra', 'reaccept', 'held', 'request'])
    // Then a reply that waits, then who it waits on; "Waiting on us" alone is no chip; nothing: no chip.
    const quiet = { ...current, production: { ...current.production!, openRequests: 0 } }
    expect(stopChipOf(quiet, { replySince: '2026-11-23T06:00:00Z' }, TODAY)).toEqual({ kind: 'reply', since: '2026-11-23T06:00:00Z' })
    expect(stopChipOf(quiet, null, TODAY)).toEqual({ kind: 'keeper', on: 'BRAND', since: '2026-11-20T10:00:00Z' })
    expect(stopChipOf({ ...quiet, production: { ...quiet.production!, waitingOn: 'US' } }, null, TODAY)).toBeNull()
    expect(stopChipOf({ ...quiet, production: { ...quiet.production!, waitingOn: null } }, null, TODAY)).toBeNull()
    // A plain wait for a yes is chip 1's own word (no third chip repeats it).
    expect(stopChipOf(row({ status: 'PENDING_APPROVAL', waits: ['REQUEST_PENDING'] }, { stage: null, health: null }), null, TODAY)).toBeNull()
    // A deposit: due, overdue once its day passed (the gate's and an extra one alike); the request names what its door opens.
    expect(stopChipOf(row({ deposit: { state: 'OPEN', dueDate: '2026-11-25' } }), null, TODAY)).toEqual({ kind: 'deposit', due: '2026-11-25', overdue: false, extra: false })
    expect(stopChipOf(row({ deposit: { state: 'OPEN', dueDate: '2026-11-20' } }), null, TODAY)).toEqual({ kind: 'deposit', due: '2026-11-20', overdue: true, extra: false })
    expect(stopChipOf(row({ deposit: { state: 'NOT_NEEDED', dueDate: null, extraOpenDue: '2026-11-20' } }), null, TODAY)).toEqual({ kind: 'deposit', due: '2026-11-20', overdue: true, extra: true })
    expect(stopChipOf(row({}, { openRequests: 2 }), { requestIds: ['req-7', 'req-8'] }, TODAY)).toEqual({ kind: 'request', count: 2, requestId: 'req-7' })
  })

  it('nothing is "now" after production: no stage, no health, no stop — only a request still to answer stays (it does wait on us)', async () => {
    const { stopChipOf } = await import('./sheet/model')
    for (const status of ['SHIPPED', 'DELIVERED', 'CLOSED', 'CANCELLED'] as const) {
      const done = row({ status, deposit: { state: 'OPEN', dueDate: '2026-11-01' }, reaccept: true, units: 64, shippedUnits: 64 }, { stage: null, health: null, held: false, waitingOn: null })
      expect(stopChipOf(done, null, TODAY), status).toBeNull()
      expect(stopChipOf({ ...done, production: { ...done.production!, openRequests: 1 } }, null, TODAY), status).toEqual({ kind: 'request', count: 1, requestId: null })
    }
    const shipped = textOfHtml(await where(row({ status: 'SHIPPED', units: 64, shippedUnits: 64 }, { stage: null, health: null })))
    expect(shipped).toBe('Shipped 64 of 64 shipped')
    expect(textOfHtml(await where(row({ status: 'CLOSED', units: 36, shippedUnits: 36 }, { stage: null, health: null })))).toBe('Closed 36 of 36 shipped')
    expect(textOfHtml(await where(row({ status: 'CANCELLED', units: 12, shippedUnits: 0 }, { stage: null, health: null })))).toBe('Cancelled Nothing shipped')
  })

  it('line 2 — this order\'s own pieces: "Sewn 152 of 244 · 24 ready now" (of the pieces ORDERED, S13); no "cut"; the words of each state', async () => {
    const { piecesPartsOf, piecesLineOf } = await import('./sheet/model')
    const made = row({ progress: { inWork: 200, cut: 180, sewn: 152, finished: 24, ordered: 244 } }, { readyNow: 24 })
    expect(piecesPartsOf(made, DAY)).toEqual([{ kind: 'words', words: { key: 'where.sewnOf', params: { sewn: 152, ordered: 244 } } }, { kind: 'words', words: { key: 'where.readyNow', params: { count: 24 } }, strong: true }])
    expect(textOfHtml(await where(made))).toBe('Sewing Sewn 152 of 244 · 24 ready now')
    expect(textOfHtml(await where(made, {}, 'it'))).toBe('Confezione Cuciti 152 di 244 · 24 pronti ora')
    expect(textOfHtml(await where(made))).not.toMatch(/cut/i)
    // Nothing ready: no "ready now" part; an older answer without `ordered` keeps "of the pieces in work"; none in work yet; not read.
    expect(piecesPartsOf(row({ progress: { inWork: 120, cut: 0, sewn: 0, finished: 0, ordered: 120 } }, { stage: 'PREPARING', readyNow: 0 }), DAY)).toEqual([{ kind: 'words', words: { key: 'where.sewnOf', params: { sewn: 0, ordered: 120 } } }])
    expect(piecesLineOf({ progress: { inWork: 300, cut: 300, sewn: 120, finished: 0 } })).toEqual({ key: 'where.sewn', params: { done: 120, total: 300 } })
    expect(piecesPartsOf(row({ status: 'CONFIRMED', progress: null }), DAY)).toEqual([{ kind: 'words', words: { key: 'progress.none' } }])
    expect(piecesPartsOf(row(), DAY)).toEqual([])
    // A partly shipped order starts with its open lines' stage (S38); what left says how much of it went.
    const partly = row({ status: 'PARTLY_SHIPPED', units: 114, shippedUnits: 40, progress: { inWork: 114, cut: 114, sewn: 90, finished: 64, ordered: 114 } }, { readyNow: 24 })
    expect(piecesPartsOf(partly, DAY).map((entry) => (entry.kind === 'stage' ? entry.stage : entry.words.key))).toEqual(['SEWING', 'where.sewnOf', 'where.readyNow'])
    expect(textOfHtml(await where(partly))).toBe('Partly shipped · 40 of 114 Sewing · Sewn 90 of 114 · 24 ready now')
    expect(piecesPartsOf(row({ status: 'SHIPPED', units: 64, shippedUnits: 64 }), DAY)).toEqual([{ kind: 'words', words: { key: 'list.shipped', params: { shipped: 64, units: 64 }, orders: true } }])
    expect(piecesPartsOf(row({ status: 'CANCELLED', units: 12, shippedUnits: 0 }), DAY)).toEqual([{ kind: 'words', words: { key: 'where.nothingShipped' } }])
    expect(piecesPartsOf(row({ status: 'CANCELLED', units: 12, shippedUnits: 4 }), DAY)).toEqual([{ kind: 'words', words: { key: 'list.shipped', params: { shipped: 4, units: 12 }, orders: true } }])
  })

  it('the cell: each chip whole with its mark, the door of chip 3, the pieces under them; a dense cell keeps the chip\'s head', async () => {
    const late = row({ daysLate: 3, deposit: { state: 'OPEN', dueDate: '2026-11-25' }, progress: { inWork: 200, cut: 180, sewn: 152, finished: 24, ordered: 244 } }, { health: 'LATE', readyNow: 24 })
    const html = await where(late, { prefix: '/w/DEMO' })
    expect(html).toContain('class="fw-sheet-wi"')
    expect(html).toContain('nds-pill info fw-sheet-st')
    expect(html).toContain('lucide-scissors') // the group's mark (In production), never colour alone
    expect(html).toContain('nds-tag warning fw-sheet-stop')
    expect(textOfHtml(html)).toBe('Sewing Late · 3 d Deposit open · due 25/11/2026 Sewn 152 of 244 · 24 ready now')
    // The pieces stay in the cell's tooltip (when three chips need two lines the pieces line gives way: the row keeps its height).
    expect(html).toContain('title="Sewn 152 of 244 · 24 ready now"')
    const css = readFileSync(new URL('./sheet/chips.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.fw-sheet-wi \{[^}]*flex-wrap: wrap;[^}]*max-height: 43px;[^}]*overflow: hidden;/)
    expect(css).toMatch(/\.fw-sheet-wi-pcs \{\s*flex-basis: 100%;/)
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i) // tokens only
    // Dense (beside the dock): the chip's head stays whole, its tail and its mark go to its tooltip.
    const dense = await where(late, { prefix: '/w/DEMO', dense: true })
    expect(textOfHtml(dense)).toBe('Sewing Late · 3 d Deposit open Sewn 152 of 244 · 24 ready now')
    expect(dense).toContain('title="Deposit open · due 25/11/2026"')
    expect(dense).toContain('class="fw-sheet-wi is-dense"')
    expect(textOfHtml(await where(row({ deposit: { state: 'OPEN', dueDate: '2026-11-20' } }), { dense: true }))).toBe('Sewing Deposit overdue')
    expect(await where(row({ deposit: { state: 'OPEN', dueDate: '2026-11-20' } }))).toContain('nds-tag danger fw-sheet-stop')
    expect(textOfHtml(await where(row({ deposit: { state: 'NOT_NEEDED', dueDate: null, extraOpenDue: '2026-11-25' } })))).toBe('Sewing Extra deposit open · due 25/11/2026')
    expect(textOfHtml(await where(row({ deposit: { state: 'OPEN', dueDate: '2026-11-20' } })))).toBe('Sewing Deposit overdue · 20/11/2026')
    // On hold: a door to the order's Production tab; a request: its review (the host's door, else the order's Changes tab).
    const held = await where(row({}, { held: true }), { prefix: '/w/DEMO' })
    expect(held).toContain(`href="/w/DEMO/sales/orders/${base.id}?tab=production"`)
    expect(textOfHtml(held)).toBe('Sewing On hold')
    const asked = await where(row({}, { openRequests: 1 }), { prefix: '/w/DEMO', mark: { requestIds: ['req-1'] }, doorHref: (id: string) => `/w/DEMO/sales/customers/p?tab=work&open=${id}` })
    expect(asked).toContain('href="/w/DEMO/sales/customers/p?tab=work&amp;open=req-1"')
    expect(textOfHtml(asked)).toBe('Sewing Request to answer')
    expect(await where(row({}, { openRequests: 1 }), { prefix: '/w/DEMO' })).toContain(`href="/w/DEMO/sales/orders/${base.id}?tab=changes"`)
    // Who it waits on, with since when; outlined (told by its words).
    const waits = await where(row({}, { waitingOn: 'BRAND', since: '2026-11-20T10:00:00Z' }))
    expect(textOfHtml(waits)).toBe('Sewing Waiting on customer · 3 d')
    expect(waits).toContain('fw-sheet-stop is-dash')
    expect(textOfHtml(await where(row({}, { waitingOn: 'BRAND', since: '2026-11-20T10:00:00Z' }), {}, 'it'))).toBe('Confezione Tocca al cliente · 3 g')
    expect(textOfHtml(await where(row({ status: 'PENDING_APPROVAL', waits: ['CREDIT_HOLD'], progress: null }, { stage: null, health: null })))).toBe('Waiting for a yes Waits for credit Not in work yet')
    expect(textOfHtml(await where(row({ reaccept: true })))).toBe("Sewing Waits for the customer's new yes")
  })

  // ---- cw fx5 (the walk fix wave: W-29, W-13, W-6) ----
  it('walk W-29: with the Waiting on column on screen, chip 3 never repeats it — a request, a reply, who acts next; what else stops the order stays', async () => {
    const { stopChipOf } = await import('./sheet/model')
    const asked = row({}, { openRequests: 1 })
    const mark = { requestIds: ['req-1'] }
    expect(stopChipOf(asked, mark, TODAY)).toEqual({ kind: 'request', count: 1, requestId: 'req-1' })
    expect(stopChipOf(asked, mark, TODAY, true)).toBeNull()
    expect(stopChipOf(row({}, { waitingOn: 'BRAND', since: '2026-11-20T10:00:00Z' }), null, TODAY, true)).toBeNull()
    // Credit, measurements, a deposit, a new yes and a hold are not the Waiting on column's: they stay chip 3.
    expect(stopChipOf(row({ status: 'PENDING_APPROVAL', waits: ['CREDIT_HOLD'] }), null, TODAY, true)).toEqual({ kind: 'credit' })
    expect(stopChipOf(row({ deposit: { state: 'NOT_NEEDED', dueDate: null, extraOpenDue: '2026-11-25' } }, { openRequests: 1 }), mark, TODAY, true)).toMatchObject({ kind: 'deposit', extra: true })
    expect(stopChipOf(row({}, { held: true }), null, TODAY, true)).toEqual({ kind: 'held' })
    expect(textOfHtml(await where(asked, { prefix: '/w/DEMO', mark }))).toBe('Sewing Request to answer')
    expect(textOfHtml(await where(asked, { prefix: '/w/DEMO', mark, waitingShown: true }))).toBe('Sewing')
    const view = readFileSync(new URL('./view/OrdersListView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("setShowsWaiting(ids.includes('waitingOn'))") // the frame tells which columns are on screen (a person's Customise wins)
    expect(view).toContain('waitingShown={waitingShown && !phone')
  })

  it('walk W-13: the phone card takes the cell in two halves — the chips (they wrap freely) and the pieces line (it wraps, never cut)', async () => {
    const late = row({ daysLate: 3, deposit: { state: 'OPEN', dueDate: '2026-11-25' }, progress: { inWork: 200, cut: 180, sewn: 152, finished: 24, ordered: 244 } }, { health: 'LATE', readyNow: 24 })
    const chips = await where(late, { prefix: '/w/DEMO', half: 'chips' })
    expect(chips).toContain('class="fw-sheet-wi is-card"')
    expect(textOfHtml(chips)).toBe('Sewing Late · 3 d Deposit open · due 25/11/2026')
    const pieces = await where(late, { half: 'pieces' })
    expect(pieces).toContain('class="fw-sheet-wi-pcs is-wrap"')
    expect(textOfHtml(pieces)).toBe('Sewn 152 of 244 · 24 ready now')
    // Nothing to say: nothing drawn (never a dash on the card).
    expect(await where({ ...late, production: undefined }, { half: 'chips' })).toBe('')
    expect(await where({ ...late, production: undefined }, { half: 'pieces' })).toBe('')
    const css = readFileSync(new URL('./sheet/chips.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.fw-sheet-wi\.is-card \{\s*max-height: none;/)
    expect(css).toMatch(/\.fw-sheet-wi-pcs\.is-wrap \{[^}]*white-space: normal;/)
    const view = readFileSync(new URL('./view/OrdersListView.tsx', import.meta.url), 'utf8')
    // Host-only: the customer's own page; the other two hosts keep their card and the frame's own door.
    expect(view).toContain('const workCard = !!model.locked?.party && !!model.preset')
    expect(view).toContain("customerUrgency: { role: 'hidden' as const },")
    expect(view).toContain('cardDoor: !workCard && model.active.cardDoor && actions?.onCardThread')
  })

  it('walk W-6: beside the dock the chips stand closer (the sheet\'s own css, tokens only) so two chips and the pieces line fit', () => {
    const css = readFileSync(new URL('./sheet/chips.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.fw-sheet-wi\.is-dense \{\s*column-gap: var\(--nds-space-3\);/)
    expect(css).toMatch(/\.fw-sheet-wi\.is-dense > \.nds-pill \{[^}]*padding-left: var\(--nds-space-6\);[^}]*padding-right: var\(--nds-space-6\);/)
    expect(css).toMatch(/\.fw-sheet-wi\.is-dense > \.nds-tag,\s*\.fw-sheet-wi\.is-dense > \.fw-sheet-chip-door > \.nds-tag \{[^}]*padding-left: var\(--nds-space-6\);/)
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i)
  })
  // ---- end cw fx5

  it('Customer urgency — the customer\'s own mark as its chip says it, read only; our Priority beside it when it is not Normal', async () => {
    const { urgencyChipOf, priorityChipOf } = await import('./sheet/model')
    const state = (over: Partial<NonNullable<OrderRow['customerUrgencyState']>>) => ({ customerUrgencyState: { state: 'REGULAR' as const, urgentRank: null, locked: false, requestId: null, ...over } })
    expect(urgencyChipOf(row(state({ state: 'URGENT', urgentRank: 2 })))).toEqual({ state: 'URGENT', rank: 2 })
    expect(urgencyChipOf(row(state({ state: 'ASKED', requestId: 'req-9' })))).toEqual({ state: 'ASKED', requestId: 'req-9' })
    expect(urgencyChipOf(row(state({ state: 'SET_BACK', locked: true })))).toEqual({ state: 'SET_BACK', locked: true })
    expect(urgencyChipOf(row(state({})))).toBeNull() // Regular: nothing
    expect(urgencyChipOf(row({ customerUrgencyState: null, customerUrgency: 'URGENT' }))).toBeNull() // none counts (the switch off): no chip at all
    // An older answer without the state: "Urgent" / nothing from the old mark — no place, no "asked", no lock.
    expect(urgencyChipOf(row({ customerUrgency: 'URGENT' }))).toEqual({ state: 'URGENT', rank: null })
    expect(urgencyChipOf(row({ customerUrgency: 'REGULAR' }))).toBeNull()
    expect(urgencyChipOf(row())).toBeNull()
    // Our priority: only when not Normal, and only while the order is still ours to make.
    const priority = (level: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT') => ({ priority: { level, number: 1, urgentReason: null } })
    expect((['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const).map((level) => priorityChipOf(row(priority(level))))).toEqual(['LOW', null, 'HIGH', 'URGENT'])
    expect(priorityChipOf(row({ ...priority('URGENT'), status: 'SHIPPED' }))).toBeNull()
    expect(priorityChipOf(row())).toBeNull()

    // The words (S6, S31): "Urgent 2" under the header; "Urgent (customer) 2" where no header names it; Italian always "(cliente)".
    expect(textOfHtml(await urgency(row({ ...state({ state: 'URGENT', urgentRank: 2 }), ...priority('URGENT') })))).toBe('Urgent 2 Priority: Top')
    expect(textOfHtml(await urgency(row(state({ state: 'URGENT', urgentRank: 2 })), { bare: true }))).toBe('Urgent (customer) 2')
    expect(textOfHtml(await urgency(row(state({ state: 'URGENT', urgentRank: 2 })), {}, 'it'))).toBe('Urgente (cliente) 2')
    expect(textOfHtml(await urgency(row(state({ state: 'URGENT', urgentRank: 2 })), { bare: true }, 'it'))).toBe('Urgente (cliente) 2')
    expect(textOfHtml(await urgency(row({ customerUrgency: 'URGENT' })))).toBe('Urgent')
    expect(textOfHtml(await urgency(row({ customerUrgency: 'URGENT' }), {}, 'it'))).toBe('Urgente (cliente)')
    expect(textOfHtml(await urgency(row(state({ state: 'ASKED' }))))).toBe('Urgent – asked')
    expect(await urgency(row(state({ state: 'ASKED' })))).toContain('is-dash')
    expect(textOfHtml(await urgency(row(state({ state: 'SET_BACK' }))))).toBe('Set to regular by us')
    expect(await urgency(row(state({ state: 'SET_BACK', locked: true })))).toContain('lucide-lock')
    expect(await urgency(row(state({ state: 'SET_BACK' })))).not.toContain('lucide-lock')
    expect(textOfHtml(await urgency(row(state({ state: 'SET_BACK' })), {}, 'it'))).toBe('Riportato a normale da noi')
    expect(textOfHtml(await urgency(row(priority('HIGH'))))).toBe('Priority: High')
    expect(textOfHtml(await urgency(row(priority('LOW')), {}, 'it'))).toBe('Priorità: Bassa')
    expect(textOfHtml(await urgency(row(priority('URGENT')), {}, 'it'))).toBe('Priorità: Massima')
    // Never a bare "Top" under the header "Customer urgency" (S31); with the Priority column on screen the chip leaves the cell.
    expect(textOfHtml(await urgency(row(priority('URGENT'))))).not.toBe('Top')
    expect(await urgency(row(priority('URGENT')), { priorityShown: true })).toBe('')
    expect(await urgency(row())).toBe('') // Regular, Normal: an empty cell
    // Read only: no funnel, no button, no link in the cell (our acts are in the row's ⋯).
    const cell = await urgency(row({ ...state({ state: 'ASKED', requestId: 'req-9' }), ...priority('HIGH') }))
    expect(cell).not.toMatch(/<button|<a |fw-sheet-funnel/)
    // F-CW-302 (S7): "Urgent – asked" is a DOOR to the request that waits on us when the host gives its address — the review window
    // in place on the customer's Work tab, the order's Changes tab elsewhere; still no button and no funnel (our acts: the row's ⋯).
    const door = await urgency(row(state({ state: 'ASKED', requestId: 'req-9' })), { askedHref: '/office/sales/orders/o-1?tab=changes' })
    for (const part of ['<a ', 'class="fw-sheet-chip-door"', 'data-door=""', 'href="/office/sales/orders/o-1?tab=changes"']) expect(door, part).toContain(part)
    expect(textOfHtml(door)).toBe('Urgent – asked')
    expect(door).not.toMatch(/<button|fw-sheet-funnel/)
    // Only that state is a door: an Urgent or a set-back order with the address given draws no link.
    expect(await urgency(row(state({ state: 'URGENT', urgentRank: 2 })), { askedHref: '/x' })).not.toContain('<a ')
    const view = readFileSync(new URL('./view/OrdersListView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('<CustomerUrgencyCell row={data} s={s} d={d} bare={phone} priorityShown={priorityShown} askedHref={askedHrefOf(prefix, data, latest.current.model.doorHref)')
    expect(view).not.toContain("act()?.onExtra?.({ customerUrgency")
  })

  it('New messages — a count bubble ("99+" past 99) with the shared cell\'s words and doors; nothing new: an empty cell that says so', async () => {
    const { NewMessagesBubble } = await import('./sheet/parts')
    const { l } = wordsFor('en')
    const draw = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(NewMessagesBubble, { record: 'SEED-SO-0009', href: '/w/DEMO/sales/orders/o1?thread=new', l, ...props } as never))
    const linked = draw({ unread: { newCount: 2, lastAt: '2026-11-23T09:42:00.000Z' } })
    expect(textOfHtml(linked)).toBe('2')
    expect(linked).toMatch(/^<a /)
    expect(linked).toContain('class="fw-sheet-msgs"')
    expect(linked).toContain('href="/w/DEMO/sales/orders/o1?thread=new"')
    expect(linked).toContain('aria-label="2 new messages on SEED-SO-0009: open the thread at the first new one"')
    expect(textOfHtml(draw({ unread: { newCount: 120, lastAt: null } }))).toBe('99+')
    // On a page with a dock the bubble is a button that docks the order's thread (⌘ / Ctrl keeps the new tab: the shared dockClick).
    const docked = draw({ unread: { newCount: 1, lastAt: null }, onOpen: () => undefined })
    expect(docked).toContain('<button type="button" class="fw-sheet-msgs"')
    expect(docked).toContain('data-door=""')
    // Nothing new, or not counted: no bubble, the words for a screen reader.
    for (const unread of [undefined, { newCount: 0, lastAt: null }]) expect(draw({ unread })).toBe('<span class="nds-vh">No new messages</span>')
    // A narrow column of a host's set: the header is the message mark, the column's name stays its accessible name (S33).
    const { MessagesHeader } = await import('./sheet/parts')
    const header = renderToStaticMarkup(createElement(MessagesHeader, { displayName: 'New messages' }))
    expect(header).toContain('lucide-message-square')
    expect(header).toContain('<span class="nds-vh">New messages</span>')
    const view = readFileSync(new URL('./view/OrdersListView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("...(narrowMessages ? { headerComponentParams: { innerHeaderComponent: MessagesHeader }, suppressHeaderMenuButton: true, cellClass: 'fw-sheet-tight', headerClass: 'fw-sheet-tight' } : {})")
    expect(view).toContain('const narrowMessages = (model.preset?.max?.newMessages ?? Number.POSITIVE_INFINITY) <= 64')
  })

  it('the same fact never twice in a row: the lateness tag beside the promise only while Where it is is not on screen; no Customer column on a customer\'s own page', () => {
    const view = readFileSync(new URL('./view/OrdersListView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("{!whereShown && data.daysLate !== null && data.daysLate > 0 && <Tag tone=\"danger\">{t('list.daysLate', { count: data.daysLate })}</Tag>}")
    expect(view).toContain("setShowsWhere(ids.includes('whereItIs'))")
    expect(view).toContain("setShowsPriority(ids.includes('priority'))")
    expect(view).toContain("...(model.locked?.party ? [] : [{ colId: 'customer', headerName: t('col.customer'), field: 'partyName', minWidth: 112, flex: 1.2, cellRenderer: CustomerCell }]),")
    // The phone card: the customer's urgency is a line of the card (its own draw: nothing to say, no line).
    expect(view).toContain("customerUrgency: { role: 'field' as const, draw: urgency }, // F-CW-102")
  })

  it('every new word of the row in both languages (no key left); the header is "Customer urgency" / "Urgenza cliente" (S6)', () => {
    for (const locale of LOCALES) {
      const { s: sheet } = wordsFor(locale)
      for (const key of ['col.customerUrgency', 'col.customerUrgencyHint', 'urgency.URGENT', 'urgency.bare', 'urgency.ASKED', 'urgency.SET_BACK', 'urgency.rankTip', 'urgency.askedTip', 'urgency.lockedTip', 'urgency.priorityTip', 'where.nothingShipped', 'stop.depositOverdue', 'stop.depositExtra', 'stop.reaccept']) expect(sheet(key), `${locale} ${key}`).not.toBe(key)
      expect(sheet('urgency.rank', { rank: 2 }), locale).toContain('2')
      expect(sheet('urgency.bareRank', { rank: 2 }), locale).toContain('2')
      expect(sheet('urgency.priority', { level: 'X' }), locale).toContain('X')
      expect(sheet('where.sewnOf', { sewn: 152, ordered: 244 }), locale).toMatch(/152.*244/)
      for (const count of [1, 24]) expect(sheet('where.readyNow', { count }), `${locale} ${count}`).toMatch(new RegExp(`^${count} `))
      expect(sheet('stop.heldTip', { number: 'SO-1' }), locale).toContain('SO-1')
      // cw fx5 (walk W-12): the Deposit pill itself says "Extra deposit open" (chip 3's own words) over the open deposit's own "due …" line.
      expect(sheet('stop.depositExtra'), locale).not.toBe('stop.depositExtra')
      expect(wordsFor(locale).t('list.depositDue', { date: '25 Nov' }), locale).toContain('25 Nov')
      expect(sheet('chips.urgency', { urgency: 'X' }), locale).toContain('X')
    }
    expect([wordsFor('en').s('col.customerUrgency'), wordsFor('it').s('col.customerUrgency')]).toEqual(['Customer urgency', 'Urgenza cliente'])
    // "Urgente" alone is the planner's rush word: the customer's chip always says whose it is in Italian.
    expect(wordsFor('it').s('urgency.URGENT')).toBe('Urgente (cliente)')
    expect([wordsFor('it').s('where.readyNow', { count: 1 }), wordsFor('it').s('where.readyNow', { count: 24 })]).toEqual(['1 pronto ora', '24 pronti ora'])
  })
})
// ---- end F-CW-102


// ---- F-CW-303 (customer Work tab plan §4; 10-design §6 W2, W3, W6): the Waiting on cell says what WE asked and still wait for —
// "Asked production · 2 d" (the order's open production issues, since the oldest) and, on the customer's page, "Asked <customer> ·
// 3 d" (the page's own asks read, joined by order in its marks); the receipts name each order as a button that shows its thread.
describe('F-CW-303: what we asked and still wait for; the receipts\' order names', () => {
  const NOW = Date.parse('2026-11-23T10:00:00Z')
  const part = (over: Partial<NonNullable<OrderRow['production']>> = {}): NonNullable<OrderRow['production']> => ({ stage: 'SEWING', stageSince: '2026-11-10', health: 'ON_TRACK', waitingOn: null, since: null, held: false, supervisorMark: 'ME', openRequests: 0, openIssues: 0, withheld: [], ...over })
  const row = (production: Partial<NonNullable<OrderRow['production']>> = {}): OrderRow => ({ ...LIST_ROWS[0]!, partyName: 'Seed Racing', production: part(production) })
  const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  const cell = async (r: OrderRow, mark: Parameters<typeof import('./sheet/parts').WaitingOnCell>[0]['mark'] = null, locale: (typeof LOCALES)[number] = 'en') => {
    const { WaitingOnCell } = await import('./sheet/parts')
    return text(renderToStaticMarkup(createElement(I18nProvider, { locale, messages: {} }, createElement(WaitingOnCell, { row: r, mark, prefix: '/office', s: createTranslator(locale, messagesFor(locale, [NAMESPACE])[NAMESPACE]!), now: NOW }))))
  }

  it('the two new kinds, after what waits on US and before who acts next; a withheld or zero count says nothing', async () => {
    const { waitingItemsOf } = await import('./sheet/model')
    expect(waitingItemsOf(row({ openIssues: 2, openIssuesSince: '2026-11-21T10:00:00Z' }))).toEqual([{ kind: 'askedProduction', count: 2, since: '2026-11-21T10:00:00Z' }])
    expect(waitingItemsOf(row({ openIssues: 1 }))).toEqual([{ kind: 'askedProduction', count: 1, since: null }]) // an older answer without the day
    expect(waitingItemsOf(row({ openIssues: 0, openIssuesSince: null }))).toEqual([])
    expect(waitingItemsOf(row({ openIssues: null, withheld: ['openIssues'] }))).toEqual([]) // not this reader's to know: never guessed
    expect(waitingItemsOf(row(), { askedSince: '2026-11-20T10:00:00Z' })).toEqual([{ kind: 'askedCustomer', since: '2026-11-20T10:00:00Z' }])
    // The order: a request to answer, a reply that waits, what we asked of production, of the customer, then who acts next.
    const all = waitingItemsOf(row({ openRequests: 1, openIssues: 1, openIssuesSince: '2026-11-21T10:00:00Z', waitingOn: 'SUPPLIER', since: '2026-11-16T08:00:00Z' }), { requestIds: ['req-1'], replySince: '2026-11-22T08:00:00Z', askedSince: '2026-11-20T10:00:00Z' })
    expect(all.map((item) => item.kind)).toEqual(['request', 'reply', 'askedProduction', 'askedCustomer', 'keeper'])
    // The keeper's "waiting on the customer" while our ask of the customer waits IS that ask: said once.
    expect(waitingItemsOf(row({ waitingOn: 'BRAND', since: '2026-11-19T08:00:00Z' }), { askedSince: '2026-11-20T10:00:00Z' }).map((item) => item.kind)).toEqual(['askedCustomer'])
    expect(waitingItemsOf(row({ waitingOn: 'BRAND', since: '2026-11-19T08:00:00Z' })).map((item) => item.kind)).toEqual(['keeper'])
  })

  it('the cell: "Asked production · 2 d", "Asked Seed Racing · 3 d", "+1 more"; no day known: "Asked production"', async () => {
    expect(await cell(row({ openIssues: 1, openIssuesSince: '2026-11-21T10:00:00Z' }))).toBe('Asked production · 2 d')
    expect(await cell(row({ openIssues: 1 }))).toBe('Asked production')
    expect(await cell(row(), { askedSince: '2026-11-20T10:00:00Z' })).toBe('Asked Seed Racing · 3 d')
    expect(await cell(row({ openIssues: 1, openIssuesSince: '2026-11-23T07:00:00Z' }), { askedSince: '2026-11-20T10:00:00Z' })).toBe('Asked production · 3 h +1 more')
    expect(await cell(row({ openIssues: 1, openIssuesSince: '2026-11-21T10:00:00Z' }), null, 'it')).toBe('Chiesto alla produzione · 2 g')
    expect(await cell(row(), { askedSince: '2026-11-20T10:00:00Z' }, 'it')).toBe('Chiesto a Seed Racing · 3 g')
    expect(await cell(row())).toBe('—')
    for (const locale of LOCALES) {
      const sheet = createTranslator(locale, messagesFor(locale, [NAMESPACE])[NAMESPACE]!)
      for (const key of ['waiting.askedProduction', 'waiting.askedProductionNow', 'waiting.askedCustomer', 'receipt.showThread', 'bar.askProductionThen']) expect(sheet(key, { time: '2 d', customer: 'Seed Racing', number: 'SEED-SO-0009' }), `${locale} ${key}`).not.toBe(key)
    }
  })

  it('the customer page joins its asks by order in the marks: the oldest open ask on an ORDER; other records and closed asks mark nothing', async () => {
    const { marksOf } = await import('../../customers/record/use-customer-work')
    const ask = (id: string, type: string, createdAt: string, status: 'OPEN' | 'DONE' | 'CANCELLED' = 'OPEN') => ({ record: { type, id, label: id }, status, createdAt })
    expect(marksOf(null, null, [ask('o1', 'SalesOrder', '2026-11-21T09:00:00Z'), ask('o1', 'SalesOrder', '2026-11-19T09:00:00Z'), ask('o2', 'SalesOrder', '2026-11-20T09:00:00Z', 'DONE'), ask('q1', 'Quote', '2026-11-18T09:00:00Z')])).toEqual({ o1: { askedSince: '2026-11-19T09:00:00Z' } })
    // Beside the other marks of the same order; without the asks read (no right): as before.
    expect(marksOf([{ id: 'r1', orderId: 'o1', askedAt: '2026-11-17T09:00:00Z', waitingOn: 'US' }] as never, null, [ask('o1', 'SalesOrder', '2026-11-19T09:00:00Z')])).toEqual({ o1: { requestIds: ['r1'], askedSince: '2026-11-19T09:00:00Z' } })
    expect(marksOf(null, null)).toEqual({})
    const hook = readFileSync(new URL('../../customers/record/use-customer-work.ts', import.meta.url), 'utf8')
    expect(hook).toContain('const marks = useMemo(() => marksOf(requests?.items ?? null, replies?.rows ?? null, asked?.items ?? null), [requests, replies, asked])')
    // Sales › Orders and Made to measure read no asks: their rows never say "Asked <customer>".
    for (const host of ['./OrdersPage.tsx', '../../mtm/MtmPage.tsx', './use-orders-sheet.ts']) expect(readFileSync(new URL(host, import.meta.url), 'utf8'), host).not.toMatch(/askedSince|listPartnerRequests/)
  })

  it('a receipt names each order as a button that shows its thread — by a host callback; the window stays open (source)', () => {
    const hook = readFileSync(new URL('./use-orders-sheet.ts', import.meta.url), 'utf8')
    // The customer's page docks the order (its own row click); elsewhere the order opens in a new tab — never a page hop under an open window.
    expect(hook).toContain('if (host.onRowClick && row) return host.onRowClick(row, false)')
    expect(hook).toContain("window.open(`${prefix}/sales/orders/${encodeURIComponent(id)}`, '_blank', 'noopener')")
    expect(hook).toContain("note: { ...note.actions, onRecord: (record) => (record.type === 'SalesOrder' ? showOrder(record.id) : undefined) },")
    expect(hook).toContain('replyMany: { ...replyMany.actions, onOrder: showOrder /* F-CW-303 */ }, // F-SA-282')
    const reply = readFileSync(new URL('./view/ReplyManyDialog.tsx', import.meta.url), 'utf8')
    expect(reply).toContain("<Button size=\"sm\" variant=\"link\" title={s('receipt.showThread', { number: line.label })} onClick={() => actions.onOrder?.(line.id)}>")
    // Production's own Note window: the name is a button only where a host gives the callback — its own pages pass none (as before).
    const note = readFileSync(new URL('../../../production/_shared/notes/view/NoteDialog.tsx', import.meta.url), 'utf8')
    expect(note).toContain('<Button size="sm" variant="link" onClick={() => actions.onRecord?.(recordOfLine(line.key))}>')
    expect(note).toContain('<b>{line.label}</b>')
    expect(note).toContain('{model.preset?.hint && <p className="fw-pnt-hint">{model.preset.hint}</p>}')
    // "Ask production about N…" says what the rows then show.
    expect(readFileSync(new URL('./view/OrdersListView.tsx', import.meta.url), 'utf8')).toContain("hint: s('bar.askProductionThen') /* F-CW-303 */ }),")
  })
})
// ---- end F-CW-303

// ---- F-CW-304 (customer Work tab plan §4): after each act the orders it named are read again WHERE THEY STAND — rows never jump
// under the reader (the sheet stands in "Most urgent first": a silent reload of the whole list re-sorted it); dead parts are out.
describe('F-CW-304: rows never jump after an act; nothing unused stays (source)', () => {
  const hook = readFileSync(new URL('./use-orders-sheet.ts', import.meta.url), 'utf8')
  const view = readFileSync(new URL('./view/OrdersListView.tsx', import.meta.url), 'utf8')

  it('every act of the bar reads only its own orders again, by id, and puts each where it stands', () => {
    // The ONE in-place read: by id, fifty at a time; a row that left the view is greyed until "N updates · Show" (placeRow).
    expect(hook).toContain('listOrders(api, { ids: ids.slice(at, at + 50), production: productionShown, progress: progressShown, limit: 50 })')
    expect(hook).toContain('for (const fresh of page.orders) placeRow(fresh.id, () => fresh, fresh.status)')
    expect(hook).toContain('const assign = useAssignSupervisor(api, () => rereadInPlace(acted.current.assign))')
    expect(hook).toContain('const note = useNoteDialog(api, { can: noteCan, onDone: () => rereadInPlace(acted.current.note) })')
    expect(hook).toContain('rereadInPlace(task.records.map((record) => record.id))')
    expect(hook).toContain('const replyMany = useReplyMany(api, session.permissions, () => rereadInPlace(acted.current.reply)')
    expect(hook).toContain('const ship = useShipTogether(api, session.permissions, rereadInPlace)')
    expect(hook).toContain('const urgencyAgain = () => rereadInPlace(urgencyAsked.current)')
    // The orders are the open window's own targets.
    expect(hook).toContain('if (assign.model) acted.current.assign = assign.model.targets.map((target) => target.orderId)')
    expect(hook).toContain('if (note.model) acted.current.note = note.model.targets.salesOrders.map((record) => record.id)')
    expect(hook).toContain('if (replyMany.model) acted.current.reply = replyMany.model.targets.map((target) => target.id)')
    // No act reloads the whole list silently any more: the one silent reload left is the board's own (a live change of its counts).
    expect(hook.match(/load\(true\)/g)).toHaveLength(1)
    expect(hook).toContain('const rereadBoard = useCoalesced(() => void load(true), 900)')
  })

  it('dead parts are out: the toolbar link (the band holds that door) and the table-wide set (the tab\'s rooms decide)', () => {
    const model = readFileSync(new URL('./list-model.ts', import.meta.url), 'utf8')
    for (const source of [view, model, readFileSync(new URL('../../customers/record/view/WorkTab.tsx', import.meta.url), 'utf8')]) expect(source).not.toMatch(/toolbarLink|tableWide/)
    expect(view).toContain("export function withPreset(column: ColDef<OrderRow>, preset: OrdersListModel['preset'] | null, wide: boolean, label?: (column: string, room: 'wider' | 'widest') => string): ColDef<OrderRow> {")
  })
})
// ---- end F-CW-304
