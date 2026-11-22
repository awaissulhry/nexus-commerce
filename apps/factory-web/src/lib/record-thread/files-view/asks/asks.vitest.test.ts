import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { LOCALES } from '../../../i18n/locales'
import { createTranslator, messagesFor } from '../../../i18n/messages'
import { render, textOf } from '../../parts/testing'
import type { FileAsk, OrderFilesRead } from '../model'
import {
  askBody,
  askDoorsOf,
  askDraftHeld,
  askOrder,
  askRefusalOf,
  asksBandOf,
  serverWords,
  dayAfter,
  newAskDraft,
  reassignKindsOf,
  shownRows,
  wheresOf,
  whoBody,
  whoHeld,
  whoKindsOf,
  windowBody,
  windowHeld,
  withWho,
  workOrdersFor,
} from './asks'
import { useAsksAnswer } from './view/AsksBody' // fx5w (W-03)
import { ASK_WINDOW_STATE, asksState, withAsks } from './fixtures'
import { AsksBody } from './view/AsksBody'
import { AskWindows } from './view/AskWindows'
import { OrderFilesBody, UploadDialog } from '../view/FilesView'

// The DS Modal opens only in a browser (after hydration, in a portal): here it draws in place, so a window's words are read.
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, subtitle, children, footer }: { open: boolean; title?: unknown; subtitle?: unknown; children?: unknown; footer?: unknown }) =>
    open ? createElement('section', { role: 'dialog' }, createElement('h2', null, title as never), createElement('p', null, subtitle as never), children as never, footer as never) : null
  return { ...actual, Modal }
})

/**
 * F-OF-201 … F-OF-203 (order FILES tab W2; 10-design §4, §6; 13-backend B-OF-031…033) — "Waiting for files" and "Ask for a file…" on the
 * contract before S2 lands: the band's order and what it counts, each row's doors, the draft's rules (a floor ask lands on a work order,
 * never priced, never body data; no "who sees it"), the windows' bodies at the ask's version, refusals in words, both languages.
 */

const READ: OrderFilesRead = withAsks({
  order: { id: 'so-seed-0002', number: 'SEED-SO-0002' },
  groups: [
    {
      key: 'LINES',
      words: { en: 'Lines & artwork', it: 'Righe e grafiche' },
      files: [{ id: 'pattern-50', name: 'SEED-JKT-02 pattern size 50.pdf', kind: 'DOCUMENT', category: null, contentType: 'application/pdf', sizeBytes: 2048, versionNo: 1, at: '2026-11-21T16:05:00Z', from: { type: 'SalesOrderLine', id: 'line-1', label: 'SEED-SO-0002 · 1' }, line: { id: 'line-1', seq: 1 }, audience: 'OFFICE_ONLY', bodyData: false, alsoOn: [], alsoOnOther: 0, inThread: null }],
      leftOut: 0,
      measurementsLeftOut: 0,
    },
  ],
  total: 1,
  truncated: false,
})
const asks = READ.asks!
const byId = (id: string): FileAsk => asks.find((one) => one.id === id)!

describe('F-OF-201: the band — its order, what it counts, its answer', () => {
  it('asked of the reader first, then what arrived, then the most late; a priced ask without words is counted, never a row; the portal asks last', () => {
    const band = asksBandOf(READ)!
    expect(band.rows.map((row) => row.ask.id)).toEqual(['ask-mine', 'ask-arrived', 'ask-late', 'portal-1'])
    expect(band.counted).toEqual({ priced: 1, outside: 1 })
    expect(band.answer).toEqual([
      { key: 'band.answer.asked', params: { count: 3 } },
      { key: 'band.answer.arrived', params: { count: 1 } },
      { key: 'band.answer.late', params: { count: 1 } },
      { key: 'band.answer.mine', params: { count: 1 } },
      { key: 'band.answer.portal', params: { count: 1 } },
    ])
    expect([byId('ask-arrived'), byId('ask-late')].sort(askOrder).map((one) => one.id)).toEqual(['ask-arrived', 'ask-late'])
  })

  it('no `asks` in the read (S2 not landed): no band at all; five rows, then "Show N more"', () => {
    expect(asksBandOf({ ...READ, asks: undefined })).toBeNull()
    const rows = Array.from({ length: 7 }, (_, n) => ({ kind: 'ask' as const, ask: { ...byId('ask-late'), id: `a${n}` } }))
    expect(shownRows(rows, false)).toMatchObject({ more: 2 })
    expect(shownRows(rows, false).shown).toHaveLength(5)
    expect(shownRows(rows, true)).toMatchObject({ more: 0 })
  })
})

describe('F-OF-203: each row\'s doors (≤ 3 with the ⋯; a right missing hides; the scan holds Accept with words)', () => {
  it('arrived: Accept… · Ask again… (Accept held while a sent file is being checked); asked of me: Upload for this ask; of others: Ask for an update', () => {
    expect(askDoorsOf(byId('ask-arrived'), { readOnly: false }).buttons).toEqual([{ door: 'accept', held: null }, { door: 'again', held: null }])
    const held = { ...byId('ask-arrived'), answered: { ...byId('ask-arrived').answered!, held: 1 } }
    expect(askDoorsOf(held, { readOnly: false }).buttons[0]).toEqual({ door: 'accept', held: 'held.checking' })
    expect(askDoorsOf(byId('ask-mine'), { readOnly: false }).buttons).toEqual([{ door: 'upload', held: null }])
    const late = askDoorsOf(byId('ask-late'), { readOnly: false })
    expect(late.buttons).toEqual([{ door: 'chase', held: null }])
    expect(late.menu.map((door) => door.door)).toEqual(['change', 'reassign', 'cancel', 'uploadFor', 'copyLink'])
  })

  it('without the right to change: no chase, no change, reassign or cancel (hidden); Read-only: only Copy link', () => {
    const noRight = { ...byId('ask-late'), may: { answer: false, decide: false, change: false } }
    expect(askDoorsOf(noRight, { readOnly: false })).toEqual({ buttons: [], menu: [{ door: 'copyLink', held: null }] })
    expect(askDoorsOf(byId('ask-arrived'), { readOnly: true })).toEqual({ buttons: [], menu: [{ door: 'copyLink', held: null }] })
    const arrivedNoDecide = { ...byId('ask-arrived'), may: { answer: false, decide: false, change: false } }
    expect(askDoorsOf(arrivedNoDecide, { readOnly: false }).buttons).toEqual([{ door: 'check', held: null }])
  })
})

describe('F-OF-202: the "Ask for a file…" draft', () => {
  const choices = asksState().choices
  it('a floor "who" lands on a work order (the order and a line held with words), never priced, never body data', () => {
    expect(wheresOf('FLOOR_TEAM', choices)).toEqual([
      { where: 'SALES_ORDER', held: 'ask.floorWhere' },
      { where: 'SALES_ORDER_LINE', held: 'ask.floorWhere' },
      { where: 'WORK_ORDER', held: null },
    ])
    expect(wheresOf('PERSON', choices).every((one) => one.held === null)).toBe(true)
    expect(wheresOf('CUSTOMER', choices)).toEqual([{ where: 'SALES_ORDER', held: null }])
    const floor = withWho({ ...newAskDraft('2026-11-25'), priced: true, bodyData: true }, 'FLOOR_TEAM', choices)
    expect(floor).toMatchObject({ where: 'WORK_ORDER', workOrderId: 'wo-41', priced: false, bodyData: false, pick: null })
    expect(whoHeld('STEP', { workOrders: [] })).toBe('ask.noWorkOrder')
    expect(whoHeld('PERSON', { workOrders: [] })).toBeNull()
  })

  it('a list the reader may not read hides its kind (a right missing); the customer only with its right', () => {
    expect(whoKindsOf(choices, { askCustomer: true })).toEqual(['PERSON', 'OFFICE_ROLE', 'FLOOR_TEAM', 'FLOOR_ROLE', 'STEP', 'CUSTOMER'])
    expect(whoKindsOf({ ...choices, officeRoles: { state: 'hidden', items: [] }, floorRoles: { state: 'hidden', items: [] } }, { askCustomer: false })).toEqual(['PERSON', 'FLOOR_TEAM', 'STEP'])
  })

  it('what holds it: words 3–500, a pick, where it goes, a step for "whoever works a step", the due day', () => {
    const draft = newAskDraft('2026-11-25')
    expect(askDraftHeld(draft)).toBe('ask.held.words')
    expect(askDraftHeld({ ...draft, words: 'Pattern PDF' })).toBe('ask.held.pick')
    expect(askDraftHeld({ ...draft, words: 'Pattern PDF', pick: 'user-carlo', where: 'SALES_ORDER_LINE' })).toBe('ask.held.where')
    expect(askDraftHeld({ ...draft, words: 'Photos', who: 'STEP', where: 'WORK_ORDER', workOrderId: 'wo-41' })).toBe('ask.held.step')
    expect(askDraftHeld({ ...draft, words: 'Pattern PDF', pick: 'user-carlo', dueOn: '' })).toBe('ask.held.due')
    expect(askDraftHeld({ ...draft, words: 'Pattern PDF', pick: 'user-carlo' })).toBeNull()
    expect(askDraftHeld({ ...draft, who: 'CUSTOMER' })).toBeNull()
  })

  it('the body the command takes: one addressee by id, the target, never a "who sees it"', () => {
    const body = askBody({ ...newAskDraft('2026-11-20'), words: ' Photos of step 3 ', fileKind: 'PHOTO', who: 'FLOOR_TEAM', pick: 'team-sewing', where: 'WORK_ORDER', workOrderId: 'wo-41', stepId: 'op-3' })
    expect(body).toEqual({ words: 'Photos of step 3', fileKind: 'PHOTO', target: { type: 'WORK_ORDER', workOrderId: 'wo-41', operationId: 'op-3' }, who: { kind: 'FLOOR_TEAM', teamId: 'team-sewing' }, dueOn: '2026-11-20' })
    expect(JSON.stringify(body)).not.toMatch(/visib|audience|sees/i)
    expect(askBody({ ...newAskDraft('2026-11-25'), words: 'Pattern', who: 'OFFICE_ROLE', pick: 'role-pattern', where: 'SALES_ORDER_LINE', lineId: 'line-1', priced: true })).toMatchObject({ target: { type: 'SALES_ORDER_LINE', lineId: 'line-1' }, who: { kind: 'OFFICE_ROLE', roleId: 'role-pattern' }, priced: true })
    expect(whoBody('PERSON', 'user-carlo')).toEqual({ kind: 'PERSON', userId: 'user-carlo' })
    expect(whoBody('STEP', null)).toEqual({ kind: 'STEP' })
    expect(dayAfter('2026-11-22', 3)).toBe('2026-11-25')
  })
})

describe('F-OF-203: the windows — what holds them, their bodies at the ask\'s version, refusals in words', () => {
  it('Ask again and Cancel need a reason (3–500); Reassign a pick (a floor ask stays on the floor); Accept waits for the scan', () => {
    expect(windowHeld({ kind: 'again', askId: 'ask-arrived', reason: 'no', dueOn: '2026-11-25' }, null)).toBe('win.why.held')
    expect(windowHeld({ kind: 'cancel', askId: 'ask-late', reason: 'The customer withdrew it' }, null)).toBeNull()
    expect(windowHeld({ kind: 'reassign', askId: 'ask-late', who: 'FLOOR_ROLE', pick: null, reason: '' }, null)).toBe('ask.held.pick')
    expect(windowHeld({ kind: 'accept', askId: 'ask-arrived', share: false }, { answered: { ...byId('ask-arrived').answered!, held: 1 } })).toBe('held.checking')
    expect(reassignKindsOf(byId('ask-late'), asksState().choices)).toEqual(['FLOOR_TEAM', 'FLOOR_ROLE', 'STEP'])
    expect(reassignKindsOf(byId('ask-mine'), asksState().choices)).toEqual(['PERSON', 'OFFICE_ROLE'])
  })

  it('every body carries the ask\'s version', () => {
    const ask = { version: 4 }
    expect(windowBody({ kind: 'again', askId: 'a', reason: ' Wrong size ', dueOn: '2026-11-25' }, ask)).toEqual({ version: 4, reason: 'Wrong size' })
    expect(windowBody({ kind: 'reassign', askId: 'a', who: 'PERSON', pick: 'user-paola', reason: '' }, ask)).toEqual({ version: 4, who: { kind: 'PERSON', userId: 'user-paola' } })
    expect(windowBody({ kind: 'change', askId: 'a', words: 'Pattern PDF, size 52', dueOn: '2026-11-26' }, ask)).toEqual({ version: 4, words: 'Pattern PDF, size 52', dueOn: '2026-11-26' })
    expect(windowBody({ kind: 'accept', askId: 'a', share: true }, ask)).toEqual({ version: 4 })
  })

  it('refusals (S2 #1881: the code in `fileAsk/<CODE>`): the server\'s words — its English as sent, its Italian with the name read back', () => {
    expect(askRefusalOf({ kind: 'conflict', code: 'NOBODY_WITH_ROLE', detail: 'Nobody with this role can see this order.' }, 'en')).toEqual({ key: 'refusal.server', params: { words: 'Nobody with this role can see this order.' } })
    expect(askRefusalOf({ kind: 'conflict', code: 'PERSON_CANNOT_SEE', detail: 'Carlo Prova cannot see this order.' }, 'it')).toEqual({ key: 'refusal.server', params: { words: "Carlo Prova non può vedere quest'ordine." } })
    expect(serverWords('TOO_MANY_PEOPLE', '23 people have this role: pick one person.', 'it')).toBe('23 persone hanno questo ruolo: scegline una.')
    expect(serverWords('FILES_HELD', '2 files are still being checked by the virus scan: accept once the check is done.', 'it')).toBe('2 file sono ancora in verifica antivirus: accetta quando la verifica è finita.')
    expect(askRefusalOf({ kind: 'invalid', code: 'STEP_NEEDS_STEP', detail: 'Pick the step whose worker is asked.' }, 'it')).toEqual({ key: 'refusal.server', params: { words: 'Scegli la fase di cui chiedi a chi la lavora.' } })
    expect(askRefusalOf({ kind: 'conflict', code: null, detail: null })).toEqual({ key: 'refusal.stale' })
    expect(askRefusalOf({ kind: 'invalid', code: null, detail: 'words: too short' })).toEqual({ key: 'refusal.words', params: { detail: 'words: too short' } })
    expect(askRefusalOf({ kind: 'forbidden', code: null, detail: null })).toEqual({ key: 'refusal.forbidden' })
    expect(askRefusalOf(null)).toEqual({ key: 'refusal.failed' })
    const api = readFileSync(new URL('../../../../areas/_shared/record-thread/file-asks-api.ts', import.meta.url), 'utf8')
    expect(api).toContain("issuePath(one).startsWith('fileAsk/')")
  })
})

describe('F-OF-201 … F-OF-203 drawn: the band, the windows, the upload for an ask — in both languages, no worker named', () => {
  it('the rows: what, where it lands, who (a team, a role, a person), For you, late, the states; the counted line; no key on screen', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['file-asks'])['file-asks']!)
      const text = textOf(render(createElement(AsksBody, { read: READ, state: asksState(), customer: 'Seed Customer One' }), locale))
      for (const words of ['Pattern PDF, size 50, with seam allowances', 'Sewing team', 'Pattern maker', 'Carlo Prova', t('row.forYou'), t('row.late', { count: 2 }), t('state.ARRIVED'), t('state.portal'), t('band.counted.priced', { count: 1 }), t('band.counted.outside', { count: 1 }), t('act.accept'), t('act.chase'), t('act.upload')]) expect(text, `${locale}: ${words}`).toContain(words)
      expect(text).not.toMatch(/\b(band|row|state|act|held|ask|refusal)\.[a-zA-Z]/)
    }
  })

  it('the address\'s ask is marked; Read-only reads every row with no door', () => {
    const marked = render(createElement(AsksBody, { read: READ, state: { ...asksState(), focus: 'ask-late' }, customer: null }))
    expect(marked).toMatch(/class="fw-ask-row[^"]*is-marked"[^>]*id="ask-ask-late"/)
    const readOnly = textOf(render(createElement(AsksBody, { read: READ, state: asksState({ can: { ask: false, askCustomer: false, share: false, closed: false, readOnly: true } }), customer: null })))
    for (const never of ['Accept…', 'Ask for an update', 'Upload for this ask']) expect(readOnly, never).not.toContain(never)
  })

  it('"Ask for a file…": what · what it is · who uploads it · where it goes · due · prices · measurement sheet — no "who sees it"', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['file-asks'])['file-asks']!)
      const text = textOf(render(createElement(AskWindows, { read: READ, state: ASK_WINDOW_STATE, customer: 'Seed Customer One', orderLabel: 'SEED-SO-0002' }), locale))
      for (const words of [t('ask.title'), t('ask.what'), t('ask.who'), t('ask.whoKind.FLOOR_TEAM'), t('ask.whoKind.STEP'), t('ask.whoKind.CUSTOMER'), t('ask.pick.OFFICE_ROLE'), t('ask.whereKind.WORK_ORDER'), t('ask.due'), t('ask.send'), t('ask.never')]) expect(text, `${locale}: ${words}`).toContain(words)
      const v = createTranslator(locale, messagesFor(locale, ['record-thread-files-view'])['record-thread-files-view']!)
      expect(text).not.toContain(v('upload.who'))
    }
    // A floor "who": prices and the sheet held with words.
    const floor = asksState({ window: { kind: 'ask', draft: { ...newAskDraft('2026-11-20'), words: 'Photos', who: 'FLOOR_TEAM', pick: 'team-sewing', where: 'WORK_ORDER', workOrderId: 'wo-41' } } })
    const text = textOf(render(createElement(AskWindows, { read: READ, state: floor, customer: null, orderLabel: 'SEED-SO-0002' })))
    for (const words of ['The floor never gets files with prices.', 'A measurement sheet never goes to the floor.', 'A floor ask always lands on a work order']) expect(text).toContain(words)
  })

  it('Accept: the files that came with Open; "Share with <customer>" only for files.manage; held while a file is checked', () => {
    const owner = textOf(render(createElement(AskWindows, { read: READ, state: asksState({ window: { kind: 'accept', askId: 'ask-arrived', share: false } }), customer: 'Seed Customer One', orderLabel: 'SEED-SO-0002' })))
    expect(owner).toContain('Open SEED-JKT-02 pattern size 50.pdf')
    expect(owner).toContain('Share with Seed Customer One')
    const sales = textOf(render(createElement(AskWindows, { read: READ, state: asksState({ can: { ask: true, askCustomer: false, share: false, closed: false, readOnly: false }, window: { kind: 'accept', askId: 'ask-arrived', share: false } }), customer: 'Seed Customer One', orderLabel: 'SEED-SO-0002' })))
    expect(sales).not.toContain('Share with Seed Customer One')
  })

  it('the order\'s thread window draws the band above the files; a file that came for an ask says "For an ask — check it"', () => {
    const html = render(createElement(OrderFilesBody, { model: { read: READ, problem: null, selected: [], canShare: true, asks: asksState() }, party: { name: 'Seed Customer One' }, place: 'window' }))
    expect(textOf(html)).toContain('Waiting for files')
    expect(textOf(html)).toContain('For an ask — check it')
    expect(html).toContain('is-asked')
    // The tab draws the band in its own section (FilesTab), never inside the body.
    expect(textOf(render(createElement(OrderFilesBody, { model: { read: READ, problem: null, selected: [], canShare: true, asks: asksState() }, party: null, place: 'tab' })))).not.toContain('Waiting for files')
  })

  it('"Upload for this ask": the asker\'s words on top, where it lands, "Send for this ask"', () => {
    const text = textOf(render(createElement(UploadDialog, { ask: { files: [], kind: 'DOCUMENT', audience: 'OFFICE', kinds: ['DOCUMENT', 'PHOTO'], audiences: ['OFFICE'], places: [{ key: 'ask:a', record: { type: 'SalesOrderLine', id: 'line-1' }, kind: 'line', what: 'Line 1 · SEED-JKT-02 Black', audiences: ['OFFICE'] }], place: 'ask:a', forAsk: { id: 'a', words: 'Pattern PDF, size 50', by: 'Alex Demo', dueOn: '2026-11-25', target: 'Line 1 · SEED-JKT-02 Black' } }, party: null, busy: false, onAdd: () => undefined })))
    expect(text).toContain('Alex Demo asks: “Pattern PDF, size 50”')
    expect(text).toContain('Send for this ask')
    expect(text).not.toContain('Where it goes')
  })

  it('the code: the tab draws the band beside the files; the container mounts the asks once; an ask\'s upload answers the ask', () => {
    const tab = readFileSync(new URL('../../../../areas/sales/orders/record/view/FilesTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain("<div className={`fw-of-z${asks ? ' has-asks' : ''}`}>")
    expect(tab).toContain("const askParam = useSearchParams()?.get('ask') ?? null")
    const container = readFileSync(new URL('../../../../areas/_shared/record-thread/use-order-files.ts', import.meta.url), 'utf8')
    expect(container.match(/useFileAsks\(api, \{/g)).toHaveLength(1)
    expect(container).toContain('if (result.ask.forAsk && result.fileIds.length > 0) void asks.answer(result.ask.forAsk.id, result.fileIds)')
    expect(container).toContain('ask: read?.asks !== undefined && (read?.may ? read.may.ask : (input.canAsk ?? false)),')
    const css = readFileSync(new URL('./view/asks.css', import.meta.url), 'utf8')
    expect(css).toContain('@container pt (min-width: 1200px)')
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,6}\b/)
  })
})


// ---- fx5w (the look-only walk): W-03 "Nothing is asked" once · W-04 work orders by status · W-08 a role's reach · W-09 prices · W-16 held ----
describe('fx5w — the walk\'s gaps in "Waiting for files" and "Ask for a file…"', () => {
  const EMPTY: OrderFilesRead = { order: { id: 'so-2', number: 'SEED-SO-0002' }, groups: [], total: 0, truncated: false, asks: [], customerAsks: [] }

  it('W-03: nothing asked is said once — the section\'s one line (with the way to ask for a reader who may), no body', () => {
    function Answer({ state }: { state: ReturnType<typeof asksState> }) {
      return createElement('p', null, useAsksAnswer(EMPTY, state))
    }
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['file-asks'])['file-asks']!)
      expect(textOf(render(createElement(Answer, { state: asksState() }), locale))).toBe(t('band.empty'))
      expect(textOf(render(createElement(Answer, { state: asksState({ can: { ask: false, askCustomer: false, share: false, closed: false, readOnly: true } }) }), locale))).toBe(t('band.emptyRead'))
      expect(render(createElement(AsksBody, { read: EMPTY, state: asksState(), customer: null }), locale)).toBe('')
    }
  })

  it('W-04: a floor "who" lands only on a released, unfinished work order; an office "who" on any but cancelled or closed; no status: all', () => {
    const orders = [{ id: 'wo-draft', number: 'WO-1', siteId: 's', status: 'DRAFT' }, { id: 'wo-live', number: 'WO-2', siteId: 's', status: 'IN_PROGRESS' }, { id: 'wo-done', number: 'WO-3', siteId: 's', status: 'COMPLETED' }, { id: 'wo-closed', number: 'WO-4', siteId: 's', status: 'CLOSED' }, { id: 'wo-old', number: 'WO-5', siteId: 's' }]
    expect(workOrdersFor(orders, true).map((one) => one.id)).toEqual(['wo-live', 'wo-old'])
    expect(workOrdersFor(orders, false).map((one) => one.id)).toEqual(['wo-draft', 'wo-live', 'wo-done', 'wo-old'])
    const choices = { ...asksState().choices, workOrders: orders }
    expect(withWho({ ...newAskDraft('2026-11-25'), workOrderId: 'wo-draft' }, 'FLOOR_TEAM', choices).workOrderId).toBe('wo-live')
    expect(whoHeld('FLOOR_TEAM', { workOrders: [orders[0]!, orders[2]!] })).toBe('ask.noWorkOrder')
    const floor = asksState({ choices, window: { kind: 'ask', draft: { ...newAskDraft('2026-11-25'), words: 'Photos of the collar seam', who: 'FLOOR_TEAM', pick: 'team-sewing', where: 'WORK_ORDER', workOrderId: 'wo-live' } } })
    const html = render(createElement(AskWindows, { read: READ, state: floor, customer: null, orderLabel: 'SEED-SO-0002' }))
    expect(html).toContain('>WO-2<')
    for (const gone of ['>WO-1<', '>WO-3<', '>WO-4<']) expect(html, gone).not.toContain(gone)
  })

  it('W-08: an office role says how many people it reaches on the order (plural words); without the number, its name only', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['file-asks'])['file-asks']!)
      const state = asksState({ choices: { ...asksState().choices, officeRoles: { state: 'ready', items: [{ id: 'role-pattern', name: 'Pattern maker', reach: 1 }, { id: 'role-plan', name: 'Planner', reach: 3 }, { id: 'role-x', name: 'Buyer' }] } }, window: { kind: 'ask', draft: { ...newAskDraft('2026-11-25'), who: 'OFFICE_ROLE' } } })
      const text = textOf(render(createElement(AskWindows, { read: READ, state, customer: null, orderLabel: 'SEED-SO-0002' }), locale))
      expect(text).toContain(t('ask.reach', { name: 'Pattern maker', count: 1 }))
      expect(text).toContain(t('ask.reach', { name: 'Planner', count: 3 }))
      expect(text).toContain('Buyer')
      expect(t('ask.reach', { name: 'X', count: 1 })).not.toBe(t('ask.reach', { name: 'X', count: 2 }).replace('2', '1'))
    }
  })

  it('W-09: "This file shows prices" is not offered to a reader without the price grain; W-16: a held choice looks held; W-07: the window\'s class', () => {
    const p = createTranslator('en', messagesFor('en', ['record-files'])['record-files']!)
    const ask = (prices: boolean | undefined) => render(createElement(AskWindows, { read: READ, state: { ...ASK_WINDOW_STATE, can: { ...ASK_WINDOW_STATE.can, ...(prices === undefined ? {} : { prices }) } }, customer: null, orderLabel: 'SEED-SO-0002' }))
    expect(textOf(ask(false))).not.toContain(p('priced.tick'))
    expect(textOf(ask(true))).toContain(p('priced.tick'))
    expect(textOf(ask(undefined))).toContain(p('priced.tick'))
    const floor = render(createElement(AskWindows, { read: READ, state: asksState({ window: { kind: 'ask', draft: { ...newAskDraft('2026-11-25'), who: 'FLOOR_TEAM', where: 'WORK_ORDER', workOrderId: 'wo-41' } } }), customer: null, orderLabel: 'SEED-SO-0002' }))
    expect(floor).toMatch(/class="nds-radiocard row is-held"/)
    const view = readFileSync(new URL('./view/AskWindows.tsx', import.meta.url), 'utf8')
    expect(view).toContain('className="fw-ask-modal"')
    expect(view).toContain('rows={2} honourRows')
    const css = readFileSync(new URL('./view/asks.css', import.meta.url), 'utf8')
    expect(css).toContain('.nds-modal.md.fw-ask-modal { width: min(760px')
    expect(css).toContain('.fw-ask-cards.is-who { grid-template-columns: repeat(3, minmax(0, 1fr)); }')
  })
})
