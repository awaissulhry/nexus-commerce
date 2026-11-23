import { readFileSync } from 'node:fs' // F-SA-212
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
// F-CP-157 (end-check fix): a window draws its content inline here (the design cases' accept window is a DS Modal, which the
// server renderer never opens), as the portal's problem and approvals tests do.
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, subtitle, children, footer }: { open: boolean; title?: unknown; subtitle?: unknown; children?: unknown; footer?: unknown }) =>
    open ? createElement('section', { role: 'dialog' }, createElement('h2', null, title as never), createElement('p', null, subtitle as never), children as never, footer as never) : null
  return { ...actual, Modal }
})
import { DECLINE_REASONS, INQUIRY_REFUSALS, INQUIRY_SOURCES, INQUIRY_STATUSES, INQUIRY_TILES, LAWFUL_BASES, quotableLines } from '@nexus/factory-domain/sales/inquiries/rules'
// B-TH-235: what a request became (Sales › Reports' request figure opens this list with it).
import { REQUEST_OUTCOMES } from '@nexus/factory-domain/sales/inquiries/rules'
import { isFiltered, queryOf } from './model'
import { emptyDecline, hasBlank } from './model' // th-backend-g step 2 (declineHeld: in the list below)
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { listAddress, recordAddress } from '../../../lib/records/record-links'
import { permissionCheck } from '../../../lib/session/session'
import { OFFICE_PAGES, officeNavFor } from '../../../shell/nav/office-nav'
import { PROSPECT_VIEW, QUOTED_VIEW, ROLE_PERMISSIONS, ROWS, VIEW } from './demo/fixtures'
import { designScreen as listScreen } from './fixtures'
import {
  addressOf,
  addressText,
  assigneePhrase,
  bandCount,
  bulkReach,
  chipsOf,
  declineHeld,
  DESIGN_TILES,
  emptyLine,
  exportPhrases,
  fieldLines,
  filesPhrases,
  HOME_ADDRESS,
  inquiriesCan,
  KNOWN_RIGHTS,
  leftOutPhrases,
  lineBodyOf,
  lineProblem,
  messageReach,
  nextAfter,
  noticeKey,
  noticeLink,
  pageNotices,
  parsePrice,
  parseSizes,
  quotePreview,
  requestChanges,
  requestDraftOf,
  SAVED_ROWS,
  tileValue,
  verbHeld,
  waitingOf,
  workingTime,
  writeProblem,
} from './model'
import { designScreen as recordScreen } from './record/fixtures'
// B-TH-233: Incoming over every door.
import { CATALOGUE_RECORD, CATALOGUE_ROW, CHANGE_ROW, INCOMING_ROWS, listOf, repliesOf } from './demo/fixtures'
import { acceptBodyOf, acceptDraftOf, acceptHeld, catalogueHeld, catalogueMain, catalogueOutcome, refuseHeld } from './catalogue-model'
// ---- F-CP-157 ----
import { acceptDone, customWords, lineMapRowsOf, linesToMap, mapStylesOf, orderHeldOf, ownSizesOf, type AcceptDraft, type MapInto } from './catalogue-model'
import { JACKET_DETAIL, MAP_RECORD, MAP_STYLES } from './demo/fixtures'
// ---- end F-CP-157
import { approvalsHref, CUSTOMER_REPLIES, incomingRowOf, LIST_TILES, mergePages, navIdsOf, numberWithCompany, placeOf, replyHref, replyWaiting, rowHref, THREAD_TYPE } from './model'
import { designScreen as paneScreen } from './view/pane/fixtures'
// ---- F-SA-277: the Incoming list lifted for the customer's Quotes & incoming (pane 'host'; two lists apart) ----
import type { ListToolsTransport } from '../../../list-frame/tools/transport'
import { scopedTransport } from '../_shared/scoped-list-tools/ScopedListTools'
import { NO_FILTERS } from '../quotes/model'
import { quotesToolsQuery } from '../quotes/list/use-quotes-list'
import { fullPageHref, type ListAddress } from './model'
import type { InquiriesModel } from './view/InquiriesView'
import { incomingAddress, incomingFromQuery, incomingLocked, incomingMemory, incomingToolsQuery, INQUIRIES_LIST_KEY, rowPageHref } from './use-inquiries-list'
// ---- end F-SA-277

const owner = inquiriesCan(ROLE_PERMISSIONS.owner)
const words = (locale: (typeof LOCALES)[number]) => CATALOGUE[locale]['sales-inquiries']!

describe('who may do what, by the role templates', () => {
  // B-CP-011 (end-check fix): the Sales template sees no price (Owner O1, the money wall); the Owner names who does.
  it('sales answers and quotes, without prices; a reader only reads (no price); the warehouse has no page', () => {
    const sales = inquiriesCan(ROLE_PERMISSIONS.sales)
    expect([sales.view, sales.manage, sales.quotes, sales.price]).toEqual([true, true, true, false])
    const reader = inquiriesCan(ROLE_PERMISSIONS.reader)
    expect([reader.view, reader.manage, reader.quotes, reader.price]).toEqual([true, false, false, false])
    expect(inquiriesCan(ROLE_PERMISSIONS.warehouse).view).toBe(false)
  })
})

describe('the address: the API’s own filters, the inquiry open in its DetailModal', () => {
  it('reads and writes every term; the default tile is Open; nonsense is dropped', () => {
    const party = ROWS[0]!.party!.id
    const address = addressOf(new URLSearchParams(`tile=WAITING_US&source=PHONE&party=${party}&q=trousers&open=${VIEW.id}&tab=files&new=1`))
    expect(address).toEqual({ ...HOME_ADDRESS, tile: 'WAITING_US', source: 'PHONE', party, q: 'trousers', open: VIEW.id, tab: 'files', isNew: true })
    expect(addressOf(new URLSearchParams(addressText(address).slice(1)))).toEqual(address)
    expect(addressOf(new URLSearchParams('tile=NOPE&source=FAX&party=1&open=x&tab=zz'))).toEqual(HOME_ADDRESS)
    expect(addressText(HOME_ADDRESS)).toBe('')
    expect(addressOf(new URLSearchParams(`prospect=1&party=${party}`))).toMatchObject({ prospect: true, party: null })
  })

  it('the tiles and saved rows are the API’s own; a chip per filter, the tile’s too', () => {
    // B-TH-233: the saved rows are Incoming's own tiles (B-TH-039) and "Customer replies".
    for (const tile of [...DESIGN_TILES, ...SAVED_ROWS]) expect(LIST_TILES).toContain(tile)
    expect(chipsOf({ ...HOME_ADDRESS, tile: 'NEW', source: 'MAIL', q: 'x' }, null).map((chip) => chip.id)).toEqual(['tile', 'source', 'q'])
    expect(chipsOf(HOME_ADDRESS, null)).toEqual([])
  })

  it('an unknown count is "—", never 0', () => {
    expect(tileValue(null, 'NEW', false)).toBe('—')
    expect(tileValue({ counts: { NEW: null }, complete: true }, 'NEW', false)).toBe('—')
    expect(tileValue({ counts: { NEW: 3 }, complete: true }, 'NEW', true)).toBe('—')
    expect(tileValue({ counts: { NEW: 0 }, complete: true }, 'NEW', false)).toBe('0')
  })
})

describe('the queue', () => {
  it('waiting is said in working time; over a working day for us is amber by the one rule (B-TH-230), the customer never', () => {
    expect(workingTime(45)).toEqual({ key: 'time.minutes', params: { n: 45 } })
    expect(workingTime(135)).toEqual({ key: 'time.hours', params: { n: 2 } })
    expect(workingTime(620)).toEqual({ key: 'time.daysHours', params: { d: 1, h: 2 } })
    expect(waitingOf(ROWS[0]!)?.tone).toBe('warning')
    expect(waitingOf(ROWS[0]!)?.phrase.key).toBe('waiting.usOverdue')
    expect(waitingOf(ROWS[2]!)?.phrase.key).toBe('waiting.customer')
    expect(waitingOf(ROWS[2]!)?.tone).toBe('neutral')
    // The rule's edge: exactly one working day (480 working minutes) is not past it; one minute more is.
    expect(waitingOf({ waiting: { for: 'US', workingMinutes: 480, overdue: false } })?.tone).toBe('neutral')
    expect(waitingOf({ waiting: { for: 'US', workingMinutes: 481, overdue: true } })?.tone).toBe('warning')
    expect(waitingOf(ROWS[4]!)).toBeNull()
  })

  it('a verb is held before the click: the rule (closed, a prospect’s quote), the right, offline', () => {
    expect(verbHeld(ROWS[4]!, 'decline', owner, false)?.key).toBe('refusal.CLOSED')
    expect(verbHeld(ROWS[3]!, 'quote', owner, false)?.key).toBe('refusal.NEEDS_CUSTOMER')
    expect(verbHeld(ROWS[2]!, 'askInfo', owner, false)?.key).toBe('refusal.ALREADY_WAITING')
    expect(verbHeld(ROWS[0]!, 'quote', inquiriesCan(ROLE_PERMISSIONS.reader), false)).toEqual({ key: 'held.right', params: { right: 'right.sales.inquiries.manage' } })
    expect(verbHeld(ROWS[0]!, 'quote', owner, true)?.key).toBe('held.offline')
    expect(verbHeld(ROWS[0]!, 'quote', owner, false)).toBeNull()
  })

  it('a selection reaches its open inquiries; closed ones are left out; more than 100 is held', () => {
    // B-TH-233: the selection holds the rows' keys (`<kind>:<id>`), over Incoming rows.
    const rows = ROWS.map(incomingRowOf)
    const reach = bulkReach(rows, [rows[0]!.key, rows[4]!.key, rows[5]!.key])
    expect([reach.open.map((row) => row.id), reach.closed, reach.others, reach.held]).toEqual([[ROWS[0]!.id], 2, 0, null])
    expect(bulkReach(rows, [rows[4]!.key]).held?.key).toBe('bulk.noneOpen')
    const many = Array.from({ length: 101 }, (_, n) => incomingRowOf({ ...ROWS[0]!, id: `r${n}` }))
    expect(bulkReach(many, many.map((row) => row.key)).held?.key).toBe('bulk.tooMany')
  })

  it('after a decision the next inquiry opens (or the one before at the end)', () => {
    expect(nextAfter(['a', 'b', 'c'], 'b')).toBe('c')
    expect(nextAfter(['a', 'b', 'c'], 'c')).toBe('b')
    expect(nextAfter(['a'], 'a')).toBeNull()
  })

  it('the notices: the partial count first, prospects to match; a dismissed one stays away until its value changes', () => {
    const list = { rows: ROWS.map(incomingRowOf), complete: false }
    expect(pageNotices(list, new Set()).map((notice) => notice.key)).toEqual(['notice.partial', 'notice.prospects'])
    expect(pageNotices(list, new Set(['notice.partial:partial', 'notice.prospects:prospects:2'])).map((notice) => notice.key)).toEqual([])
    // B-TH-233: the list reads in pages: no "first 200 rows" notice any more, whatever the number of rows.
    expect(pageNotices({ rows: Array.from({ length: 250 }, (_, n) => incomingRowOf({ ...ROWS[4]!, id: `r${n}` })), complete: true }, new Set()).map((notice) => notice.key)).toEqual([])
  })
})

describe('the lines asked', () => {
  it('sizes typed as 50:5 52:10 (or =, x, commas); anything else does not read', () => {
    expect(parseSizes('50:5 52:10, 54=5')).toEqual({ '50': 5, '52': 10, '54': 5 })
    expect(parseSizes('50:5 XL')).toBeNull()
    expect(parseSizes('S:10 M:20 S:5')).toEqual({ S: 15, M: 20 })
    expect(parseSizes('')).toEqual({})
    expect(parseSizes('fifty')).toBeNull()
  })

  it('a line names a style or words; the pieces in all are the sum of the sizes', () => {
    expect(lineProblem(emptyLine())?.key).toBe('line.problem.styleOrWords')
    expect(lineProblem({ ...emptyLine(), description: 'Gloves', sizesText: 'S:x' })?.key).toBe('line.problem.sizes')
    expect(lineProblem({ ...emptyLine(), description: 'Gloves', sizesText: 'S:10 M:10', quantity: '25' })).toEqual({ key: 'line.problem.quantitySum', params: { total: 20 } })
    expect(lineProblem({ ...emptyLine(), description: 'Gloves', quantity: '40' })).toBeNull()
    expect(lineBodyOf({ ...emptyLine(), styleId: 's1', colourwayId: 'c1', sizes: { '50': 5, '52': 0 }, quantity: '5' })).toEqual({ styleId: 's1', colourwayId: 'c1', colourText: null, description: null, sizes: { '50': 5 }, quantity: null, note: null })
  })

  it('Make quote’s preview is the API’s own rule (quotableLines), its reasons said in our words', () => {
    const preview = quotePreview(VIEW)
    expect(preview.copied.map((line) => line.seq)).toEqual([10, 20])
    expect(preview.leftOut.map((line) => line.phrase.key)).toEqual(['leftOut.noColourway', 'leftOut.noStyle'])
    // The words follow the domain's reason for every kind of line it leaves out.
    const lines = [
      { seq: 10, styleId: null, colourwayId: null, description: 'x', note: null, sizes: {} },
      { seq: 20, styleId: 's', colourwayId: null, description: null, note: null, sizes: {} },
      { seq: 30, styleId: 's', colourwayId: 'c', description: null, note: null, sizes: {} },
    ]
    const domain = quotableLines(lines).leftOut
    expect(leftOutPhrases(domain, { copied: [], leftOut: [] }).map((phrase) => phrase.key)).toEqual(['leftOut.noStyle', 'leftOut.noColourway', 'leftOut.noSizes'])
    expect(leftOutPhrases([{ seq: 10, size: '56', reason: 'x' }], preview)).toEqual([{ key: 'leftOut.size', params: { n: 1, size: '56' } }])
  })
})

describe('the Request’s Apply sends only what changed', () => {
  it('nothing changed: nothing sent; a date, a target and a line: one body with the version', () => {
    expect(requestChanges(VIEW, requestDraftOf(VIEW), owner).body).toBeNull()
    const draft = { ...requestDraftOf(VIEW), wantedDate: '2027-01-27', targetPrice: '142,50', lines: [...requestDraftOf(VIEW).lines, { ...emptyLine(), description: 'Kidney belt', quantity: '20' }] }
    const changes = requestChanges(VIEW, draft, owner)
    expect(changes.problem).toBeNull()
    expect(changes.body).toMatchObject({ version: VIEW.version, wantedDate: '2027-01-27', targetUnitPrice: '142.50' })
    expect(changes.body?.lines).toHaveLength(5)
    expect(changes.count).toBe(3)
  })

  it('without the price right no price is sent; a price that does not read holds Apply', () => {
    const reader = inquiriesCan(ROLE_PERMISSIONS.reader)
    expect(requestChanges(VIEW, { ...requestDraftOf(VIEW), targetPrice: '99' }, reader).body).toBeNull()
    expect(requestChanges(VIEW, { ...requestDraftOf(VIEW), targetPrice: 'abc' }, owner).problem?.key).toBe('request.problem.price')
    expect(parsePrice('1.250,00')).toBe('1250.00')
    expect(parsePrice('1,250.00')).toBe('1250.00')
    expect(parsePrice('12.5')).toBe('12.5')
  })

  it('a prospect never gets its customer by Apply (B-TH-234: Make or match the customer, the check first); a closed inquiry only its note', () => {
    const typed = requestChanges(PROSPECT_VIEW, { ...requestDraftOf(PROSPECT_VIEW), contactId: 'c1' }, owner)
    expect(typed.body).toBeNull()
    expect('matchPartyId' in requestDraftOf(PROSPECT_VIEW)).toBe(false)
    const closed = requestChanges(QUOTED_VIEW, { ...requestDraftOf(QUOTED_VIEW), request: 'changed', note: 'A note' }, owner)
    expect(closed.body).toEqual({ version: QUOTED_VIEW.version, note: 'A note' })
  })
})

describe('Decline and refusals', () => {
  it('a reason; Other needs words; the message reaches the customer’s contact only', () => {
    expect(declineHeld({ reason: null, note: '', message: '' }, false)?.key).toBe('decline.held.reason')
    expect(declineHeld({ reason: 'OTHER', note: ' ', message: '' }, false)?.key).toBe('refusal.OTHER_NEEDS_WORDS')
    expect(declineHeld({ reason: 'PRICE', note: '', message: '' }, false)).toBeNull()
    expect(messageReach(VIEW, owner)).toMatchObject({ to: VIEW.contact!.email, via: 'MAIL', held: null })
    expect(messageReach(PROSPECT_VIEW, owner).held?.key).toBe('decline.message.prospect')
    expect(messageReach(VIEW, inquiriesCan(ROLE_PERMISSIONS.reader)).held?.key).toBe('held.right')
  })

  it('a refusal is said by its code; a stale version reads again; a 400 names its fields', () => {
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/NEEDS_CUSTOMER', message: 'x' }]), 'INQ-1')).toMatchObject({ key: 'refusal.NEEDS_CUSTOMER', params: { number: 'INQ-1' } })
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/UNHEARD_OF' }])).key).toBe('refusal.other')
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x')).stale).toBe(true)
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/items/1' }])).key).toBe('problem.staleSome')
    const invalid = writeProblem(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/lines/2/sizes' }, { path: 'body/prospect/email' }]))
    expect(fieldLines(invalid.paths)).toEqual([{ key: 'field.lineAt', params: { n: 3 } }, { key: 'field.prospect' }])
  })
})

describe('words and navigation', () => {
  it('every code, status, source, tile, reason, basis and right has words in both languages', () => {
    for (const locale of LOCALES) {
      const all = words(locale)
      for (const code of INQUIRY_REFUSALS) expect(all[`refusal.${code}`], `${locale} refusal.${code}`).toBeTruthy()
      for (const status of INQUIRY_STATUSES) expect(all[`status.${status}`], `${locale} status.${status}`).toBeTruthy()
      for (const source of INQUIRY_SOURCES) expect(all[`source.${source}`], `${locale} source.${source}`).toBeTruthy()
      for (const tile of LIST_TILES) expect(all[`tile.${tile}`], `${locale} tile.${tile}`).toBeTruthy() // B-TH-233: every saved row
      for (const tile of DESIGN_TILES) expect(all[`tile.hint.${tile}`], `${locale} tile.hint.${tile}`).toBeTruthy()
      for (const reason of DECLINE_REASONS) expect([all[`decline.${reason}`], all[`decline.hint.${reason}`]].every(Boolean), `${locale} decline.${reason}`).toBe(true)
      for (const basis of LAWFUL_BASES) expect(all[`basis.${basis}`], `${locale} basis.${basis}`).toBeTruthy()
      for (const right of KNOWN_RIGHTS) expect(all[`right.${right}`], `${locale} right.${right}`).toBeTruthy()
      for (const status of ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED']) expect(all[`quoteStatus.${status}`], `${locale} quoteStatus.${status}`).toBeTruthy()
      for (const verb of ['askInfoPortal', 'askInfoMail', 'resume', 'unassign']) expect(all[`done.${verb}`], `${locale} done.${verb}`).toBeTruthy()
    }
  })

  it('the page is built (Sales › Incoming, B-TH-216), in the navigation of the roles that read it; a request opens its full page', () => {
    expect(OFFICE_PAGES.has('/sales/incoming')).toBe(true)
    expect(OFFICE_PAGES.has('/sales/incoming/[id]')).toBe(true)
    expect(OFFICE_PAGES.has('/sales/inquiries')).toBe(false)
    expect(recordAddress({ type: 'Inquiry', id: 'i1' }, OFFICE_PAGES)).toBe('/sales/incoming/i1')
    // The API's list keeps its address; the page it opens is Incoming.
    expect(listAddress('/sales/inquiries', { tile: 'NEW' }, OFFICE_PAGES)).toBe('/sales/incoming?tile=NEW')
    const rows = (permissions: readonly string[]) => officeNavFor(permissionCheck([...permissions])).areas.flatMap((area) => (area.sections ?? []).flatMap((section) => section.items.map((item) => item.href)))
    expect(rows(ROLE_PERMISSIONS.sales)).toContain('/sales/incoming')
    expect(rows(ROLE_PERMISSIONS.reader)).toContain('/sales/incoming')
    // B-TH-014: the production manager reads it too.
    expect(rows(ROLE_PERMISSIONS.production)).toContain('/sales/incoming')
    expect(rows(ROLE_PERMISSIONS.warehouse)).not.toContain('/sales/incoming')
    // F-SA-210 (sales plan N1, pick P1): Sales opens on Orders, Incoming right after it.
    const sales = rows(ROLE_PERMISSIONS.sales)
    expect(sales.indexOf('/sales/incoming')).toBe(sales.indexOf('/sales/orders') + 1)
  })
})

// ── B-TH-216 (threads plan TH-1b): Sales › Incoming ──
describe('Sales › Incoming (B-TH-216)', () => {
  it('the five tiles are saved filters in the tree\'s order; a count not known is "—", never 0; the band says the Rows ▾ count in words', () => {
    expect([...DESIGN_TILES]).toEqual(['NEW', 'WAITING_US', 'WAITING_CUSTOMER', 'QUOTED_THIS_WEEK', 'MINE'])
    for (const tile of DESIGN_TILES) expect(INQUIRY_TILES).toContain(tile)
    const list = { counts: { NEW: 2, WAITING_US: null, OPEN: 41 }, complete: true }
    expect(tileValue(list, 'NEW', false)).toBe('2')
    expect(tileValue(list, 'WAITING_US', false)).toBe('—')
    expect(tileValue(list, 'MINE', false)).toBe('—')
    expect(tileValue(null, 'NEW', false)).toBe('—')
    expect(bandCount(list, 'OPEN', false)).toEqual({ key: 'band.count.OPEN', params: { count: 41 } })
    expect(bandCount(list, 'WAITING_US', false)).toEqual({ key: 'band.countUnknown' })
    expect(bandCount(list, 'OPEN', true)).toEqual({ key: 'band.countUnknown' })
    for (const locale of LOCALES) {
      const all = words(locale)
      for (const tile of LIST_TILES) expect(all[`band.count.${tile}`], `${locale} band.count.${tile}`).toContain('{count}')
    }
    expect(words('en')['band.count.OPEN']).toBe('{count} open')
    expect(words('en')['tile.WAITING_CUSTOMER']).toBe('Need info')
  })

  it('the State and Company cells narrow the list: both live in the address and as chips', () => {
    const company = '0190f0e2-1111-7000-8000-000000000001'
    const address = addressOf(new URLSearchParams(`tile=ALL&status=ASSIGNED&company=${company}`))
    expect(address).toMatchObject({ tile: 'ALL', status: 'ASSIGNED', company })
    expect(addressText(address)).toBe(`?tile=ALL&status=ASSIGNED&company=${company}`)
    expect(addressOf(new URLSearchParams('status=NOPE&company=x'))).toMatchObject({ status: null, company: null })
    expect(chipsOf(address, null, 'Demo Factory').map((chip) => chip.id)).toEqual(['tile', 'status', 'company'])
    expect(chipsOf(address, null, null).find((chip) => chip.id === 'company')?.label).toEqual({ key: 'chip.companyUnknown' })
  })

  it('the Owner cell names the office person (never "A colleague" when the API names them); Files are counted, never named', () => {
    expect(assigneePhrase({ assigneeId: 'u1', mine: false, assignee: { id: 'u1', name: 'Marco Demo' } } as never)).toEqual({ key: 'assignee.name', params: { name: 'Marco Demo' } })
    expect(assigneePhrase({ assigneeId: 'u1', mine: true, assignee: { id: 'u1', name: 'Alex Demo' } } as never)).toEqual({ key: 'assignee.nameMe', params: { name: 'Alex Demo' } })
    expect(assigneePhrase({ assigneeId: null, mine: false, assignee: null } as never)).toEqual({ key: 'assignee.nobody' })
    expect(filesPhrases({ fileCounts: null })).toBeNull()
    expect(filesPhrases({ fileCounts: { photos: 0, documents: 0 } })).toEqual([{ key: 'files.none' }])
    expect(filesPhrases({ fileCounts: { photos: 2, documents: 1 } })).toEqual([{ key: 'files.photos', params: { count: 2 } }, { key: 'files.documents', params: { count: 1 } }])
  })

  it('the production manager reads every request and holds every sales action with the reason (B-TH-014)', () => {
    const production = inquiriesCan(ROLE_PERMISSIONS.production)
    expect([production.view, production.manage, production.price]).toEqual([true, false, false])
    for (const verb of ['quote', 'assign', 'askInfo', 'decline'] as const) expect(verbHeld(ROWS[0]!, verb, production, false)).toEqual({ key: 'held.right', params: { right: 'right.sales.inquiries.manage' } })
    expect(words('en')['held.right']).toContain('Needs the sales permission')
  })

  it('Export ▾ is honest: every row of this view page by page (B-TH-233: no "first 200 rows"), the price left out without the grain', () => {
    expect(exportPhrases('OPEN', { price: true })).toEqual({ heading: { key: 'export.heading', params: { view: 'tile.OPEN' } }, note: { key: 'export.note' } })
    expect(exportPhrases('OPEN', { price: false }).note.key).toBe('export.notePrice')
    for (const locale of LOCALES) {
      expect(words(locale)['export.note'], locale).not.toContain('{count}')
      expect(words(locale)['notice.capped'], locale).toBeUndefined()
    }
    expect(words('en')['export.note']).toContain('page by page')
  })

  it('one notice at most, the most serious first: no request numbering, then the list facts, then mails to sort (each with its door)', () => {
    const list = { rows: ROWS.map(incomingRowOf), complete: false }
    const notices = pageNotices(list, new Set(), { numberingMissing: ['Demo Factory'], mailToSort: { count: 4, more: false } })
    expect(notices.map((notice) => notice.key)).toEqual(['notice.numbering', 'notice.partial', 'notice.prospects', 'notice.mail'])
    expect(noticeLink(notices[0]!, '/w/DEMO')).toEqual({ href: '/w/DEMO/admin/documents', label: { key: 'notice.numberingOpen' } })
    expect(noticeLink(notices[3]!, '/w/DEMO')?.href).toBe('/w/DEMO/home/mail-to-sort')
    expect(pageNotices(list, new Set([noticeKey(notices[0]!)]), { numberingMissing: ['Demo Factory'] })[0]!.key).toBe('notice.partial')
    expect(pageNotices({ rows: [], complete: true }, new Set(), { mailToSort: { count: 50, more: true } })).toEqual([{ key: 'notice.mailMore', params: { count: 50 }, tone: 'info', value: 'mail:50+' }])
  })

  it('a limited office person sees only what the read returned: tiles and the band count only those rows (W19, W30)', () => {
    // The page draws the API's counts as they are (the API counts in the reader's scope); it never adds rows of its own.
    const mine = { counts: { OPEN: 1, NEW: 1 }, complete: true }
    expect(bandCount(mine, 'OPEN', false)).toEqual({ key: 'band.count.OPEN', params: { count: 1 } })
    expect(tileValue(mine, 'NEW', false)).toBe('1')
  })
})
// ── end B-TH-216 ──

// B-TH-233: + kind, kindFacts, replies, recordType, catalogue (Incoming over every door). B-TH-234: + customer, task. B-TH-285: + addresses.
const LEFT_KEY = /\b(?:common|held|list|record|tile|new|tab|live|row|col|keys|notice|chip|status|source|waiting|time|assignee|bulk|right|refusal|problem|field|line|grid|mail|pack|files|quote|quoteStatus|leftOut|activity|dialog|assign|decline|lost|verb|done|closed|who|prospect|basis|request|noAccess|page|band|door|funnel|picture|peek|export|kind|kindFacts|replies|recordType|catalogue|customer|task|addresses)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [listScreen, recordScreen, paneScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
            .replace(/https?:\/\/[^"\s<]+/g, '')
            .replace(/data:[^"]+/g, '')
            .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '')
            .replace(/\b(?:sales|product|products|files|example|email|quotes|money|threads)\.[a-z]+(?:\.[a-z]+)?\b/g, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }
})

// ---- B-TH-235: Sales › Reports' request figure opens this list with the days the requests came and what each became ----------
describe('B-TH-235 the list reads the request figure’s doors: the days, what a request became, each a chip', () => {
  it('the address round-trips ?from=&to=&outcome=, drops anything else, and the API query names them', () => {
    const party = ROWS[0]!.party!.id
    const address = addressOf(new URLSearchParams(`tile=ALL&party=${party}&from=2026-11-09&to=2026-11-15&outcome=ORDERED`))
    expect(address).toEqual({ ...HOME_ADDRESS, tile: 'ALL', party, from: '2026-11-09', to: '2026-11-15', outcome: 'ORDERED' })
    expect(addressOf(new URLSearchParams(addressText(address).slice(1)))).toEqual(address)
    expect(queryOf(address)).toMatchObject({ tile: 'ALL', partyId: party, receivedFrom: '2026-11-09', receivedTo: '2026-11-15', outcome: 'ORDERED' })
    expect(addressOf(new URLSearchParams('from=9/11/2026&to=x&outcome=SHIPPED'))).toEqual(HOME_ADDRESS)
    expect(isFiltered({ ...HOME_ADDRESS, outcome: 'DECLINED' })).toBe(true)
    expect(isFiltered({ ...HOME_ADDRESS, from: '2026-11-01' })).toBe(true)
  })

  it('a chip says the days and what the requests became, in words; ✕ clears them', () => {
    const chips = chipsOf({ ...HOME_ADDRESS, tile: 'ALL', from: '2026-11-09', to: '2026-11-15', outcome: 'NOT_AN_ORDER' }, null)
    expect(chips.map((chip) => chip.id)).toEqual(['tile', 'received', 'outcome'])
    expect(chips[1]).toMatchObject({ label: { key: 'chip.received', params: { from: '2026-11-09', to: '2026-11-15' } }, clear: { from: null, to: null } })
    expect(chipsOf({ ...HOME_ADDRESS, from: '2026-11-09', to: '2026-11-09' }, null)[0]!.label).toEqual({ key: 'chip.receivedOn', params: { day: '2026-11-09' } })
    expect(chips[2]).toMatchObject({ label: { key: 'chip.outcome.NOT_AN_ORDER' }, clear: { outcome: null } })
    // B-TH-233: the catalogue is read flat (lib/i18n/messages flattenMessages): `chip.outcome.ORDERED`, never `chip.outcome` as an object.
    for (const locale of LOCALES) {
      const all = words(locale)
      for (const key of ['received', 'receivedOn', 'receivedFrom', 'receivedTo']) expect(typeof all[`chip.${key}`], `${locale} ${key}`).toBe('string')
      for (const outcome of REQUEST_OUTCOMES) expect(typeof all[`chip.outcome.${outcome}`], `${locale} ${outcome}`).toBe('string')
    }
  })
})
// ---- end B-TH-235

// ---- B-TH-233 (threads plan TH-3): Incoming over every door — row kinds, tiles from the one read, Customer replies -------------
describe('B-TH-233 Incoming over every door', () => {
  const ALEPH = '0190f0e2-aaaa-7000-8000-000000000001'

  it('each kind opens in its own place: a request and a catalogue order beside the list, a change request in Home › Approvals (W19, W27)', () => {
    const request = incomingRowOf(ROWS[0]!)
    expect([placeOf(request), placeOf(CATALOGUE_ROW), placeOf(CHANGE_ROW)]).toEqual(['request', 'catalogue', 'approvals'])
    expect(rowHref('/w/DEMO', HOME_ADDRESS, request)).toBe(`/w/DEMO/sales/incoming?open=${request.id}`)
    expect(rowHref('/w/DEMO', HOME_ADDRESS, CATALOGUE_ROW)).toBe(`/w/DEMO/sales/incoming?catalogue=${CATALOGUE_ROW.id}`)
    // F-CQ-103 (Q2-B1): Approvals opens one change request by its id — the door opens THAT request (`&open=`), never the kind's list.
    expect(rowHref('/w/DEMO', HOME_ADDRESS, CHANGE_ROW)).toBe(approvalsHref('/w/DEMO', CHANGE_ROW.opens.id))
    expect(approvalsHref('/w/DEMO', CHANGE_ROW.opens.id)).toBe(`/w/DEMO/home/approvals?kind=ORDER_CHANGE_REQUEST&open=${CHANGE_ROW.opens.id}`)
    // J / K and "after a decision, the next" walk only what opens beside the list.
    expect(navIdsOf(listOf(INCOMING_ROWS))).toEqual(INCOMING_ROWS.filter((row) => row.kind !== 'CHANGE_REQUEST').map((row) => row.id))
    // Each kind's own thread for its New messages.
    expect(THREAD_TYPE).toEqual({ REQUEST: 'Inquiry', CATALOGUE_ORDER: 'PortalOrderRequest', CHANGE_REQUEST: 'OrderChangeRequest' })
  })

  it('the address keeps the kind and the catalogue order open; a request wins over a catalogue order; a kind-named link opens it too', () => {
    const address = addressOf(new URLSearchParams(`tile=ALL&kind=CATALOGUE_ORDER&catalogue=${CATALOGUE_ROW.id}`))
    expect(address).toMatchObject({ tile: 'ALL', kind: 'CATALOGUE_ORDER', catalogue: CATALOGUE_ROW.id, open: null })
    expect(addressOf(new URLSearchParams(addressText(address).slice(1)))).toEqual(address)
    expect(addressOf(new URLSearchParams(`open=${VIEW.id}&catalogue=${CATALOGUE_ROW.id}`))).toMatchObject({ open: VIEW.id, catalogue: null })
    expect(addressOf(new URLSearchParams(`kind=CATALOGUE_ORDER&open=${CATALOGUE_ROW.id}`))).toMatchObject({ open: null, catalogue: CATALOGUE_ROW.id })
    expect(addressOf(new URLSearchParams('kind=NOPE&catalogue=x'))).toMatchObject({ kind: null, catalogue: null })
    expect(addressOf(new URLSearchParams('tile=CUSTOMER_REPLIES')).tile).toBe(CUSTOMER_REPLIES)
    expect(chipsOf({ ...HOME_ADDRESS, kind: 'CHANGE_REQUEST' }, null)).toEqual([{ id: 'kind', label: { key: 'chip.kind', params: { kind: 'kind.CHANGE_REQUEST' } }, clear: { kind: null } }])
    expect(isFiltered({ ...HOME_ADDRESS, kind: 'REQUEST' })).toBe(true)
    // The one read's query: the kind goes to the API; "Customer replies" reads Incoming's counts as Open does (its rows are conversations).
    expect(queryOf({ ...HOME_ADDRESS, kind: 'CATALOGUE_ORDER' })).toMatchObject({ tile: 'OPEN', kind: 'CATALOGUE_ORDER' })
    expect(queryOf({ ...HOME_ADDRESS, tile: CUSTOMER_REPLIES }).tile).toBe('OPEN')
    // B-TH-235's terms keep working on the one read.
    expect(queryOf({ ...HOME_ADDRESS, from: '2026-11-09', to: '2026-11-15', outcome: 'ORDERED' })).toMatchObject({ receivedFrom: '2026-11-09', receivedTo: '2026-11-15', outcome: 'ORDERED' })
  })

  it('the tiles and the band count from the one read, every kind the reader may see; Customer replies has its count (W27, W30)', () => {
    const list = listOf(INCOMING_ROWS)
    expect(tileValue(list, 'NEW', false)).toBe(String(list.counts.NEW))
    expect(list.counts.NEW).toBe(INCOMING_ROWS.filter((row) => ['NEW', 'SENT', 'OPEN'].includes(row.state)).length)
    expect(bandCount(list, CUSTOMER_REPLIES, false)).toEqual({ key: 'band.count.CUSTOMER_REPLIES', params: { count: list.counts.CUSTOMER_REPLIES! } })
    expect(bandCount({ counts: { CUSTOMER_REPLIES: null }, complete: true }, CUSTOMER_REPLIES, false)).toEqual({ key: 'band.countUnknown' })
    // A kind the reader may not see is counted by nobody here: the page draws the API's counts as they came.
    expect(tileValue({ counts: { NEW: 1 }, complete: true }, 'NEW', false)).toBe('1')
  })

  it('a request read as an Incoming row keeps its whole row; "Show more" adds pages, each row once', () => {
    const row = incomingRowOf(ROWS[4]!)
    expect(row).toMatchObject({ key: `REQUEST:${ROWS[4]!.id}`, kind: 'REQUEST', state: 'QUOTED', open: false, opens: { place: 'INCOMING', id: ROWS[4]!.id }, request: ROWS[4] })
    expect(row.stateWords.en).toBe('Quoted')
    const first = listOf(INCOMING_ROWS.slice(0, 4), true, 'c1')
    const second = listOf(INCOMING_ROWS.slice(3), true, null)
    expect(mergePages([first, second]).map((one) => one.key)).toEqual(INCOMING_ROWS.map((one) => one.key))
  })

  it('a selection over every kind: Assign and Decline reach the requests only, the others are counted and said', () => {
    const reach = bulkReach(INCOMING_ROWS, [INCOMING_ROWS[0]!.key, CATALOGUE_ROW.key, CHANGE_ROW.key])
    expect([reach.open.map((one) => one.id), reach.others]).toEqual([[ROWS[0]!.id], 2])
    expect(bulkReach(INCOMING_ROWS, [CATALOGUE_ROW.key, CHANGE_ROW.key]).held?.key).toBe('bulk.noneRequests')
    for (const locale of LOCALES) for (const key of ['bulk.reachOthers', 'bulk.noneRequests']) expect(words(locale)[key], `${locale} ${key}`).toBeTruthy()
  })

  it('list-F12: a reader of several companies reads the company code beside a number; one company the number alone', () => {
    expect(numberWithCompany('INQ-0042', 'CO2', true)).toBe('INQ-0042 · CO2')
    expect(numberWithCompany('INQ-0042', 'CO2', false)).toBe('INQ-0042')
    expect(numberWithCompany('INQ-0042', null, true)).toBe('INQ-0042')
  })

  it('Customer replies: each row opens its record at the message that waits; the page lists only what the read returned (W27, W30, W37)', () => {
    const page = repliesOf()
    const built = new Set(OFFICE_PAGES)
    const order = page.rows[0]!
    expect(replyHref('/w/DEMO', order, built)).toBe(`/w/DEMO/sales/orders/${order.recordId}?message=${order.lastMessage.id}`)
    // A record type without a page of its own opens its panels, still at the message.
    expect(replyHref('/w/DEMO', { ...order, recordType: 'DepositRequest', label: 'DR-1' }, built)).toBe(`/w/DEMO/records/DepositRequest/${order.recordId}?label=DR-1&company=${order.companyId}&message=${order.lastMessage.id}`)
    // The one waiting rule (amber past the rule's days) comes from the API; clock time is said when the company has no calendar.
    expect(replyWaiting(page.rows[1]!)).toEqual({ time: { key: 'time.days', params: { d: 5 } }, amber: true, clock: false })
    expect(replyWaiting({ waiting: { ...page.rows[2]!.waiting, calendar: false } }).clock).toBe(true)
    // Nothing of another customer is added by the page: it draws the rows and the count the API returned for this reader.
    const limited = repliesOf(page.rows.filter((row) => row.party.id === page.rows[2]!.party.id))
    expect(limited.rows.every((row) => row.party.id === page.rows[2]!.party.id)).toBe(true)
    expect(limited.count).toBe(limited.rows.length)
    for (const locale of LOCALES) for (const key of ['replies.tableLabel', 'replies.empty', 'replies.noRight', 'tile.CUSTOMER_REPLIES']) expect(words(locale)[key], `${locale} ${key}`).toBeTruthy()
  })

  it('a catalogue order: Accept as order is the main button; each action held in words; the production manager holds all (W08, W09)', () => {
    const owner233 = inquiriesCan(ROLE_PERMISSIONS.owner)
    expect(catalogueMain(CATALOGUE_RECORD, owner233)).toBe('order')
    expect(catalogueHeld(CATALOGUE_RECORD, 'order', owner233, false)).toBeNull()
    expect(catalogueHeld(CATALOGUE_RECORD, 'refuse', owner233, true)).toEqual({ key: 'held.offline' })
    const production = inquiriesCan(ROLE_PERMISSIONS.production)
    for (const action of ['order', 'quote', 'refuse'] as const) expect(catalogueHeld(CATALOGUE_RECORD, action, production, false)).toEqual({ key: 'catalogue.held.right', params: { right: 'right.orders.manage' } })
    expect(words('en')['catalogue.held.right']).toContain('Only sales can accept or refuse a portal order') // F-CP-157: "Portal order" (B-CP-077's words)
    expect(catalogueHeld(CATALOGUE_RECORD, 'quote', { orders: true, quotes: false }, false)).toEqual({ key: 'held.needs', params: { right: 'right.quotes.manage' } })
    expect(catalogueHeld({ ...CATALOGUE_RECORD, may: { order: false, quote: true, refuse: true } }, 'order', owner233, false)).toEqual({ key: 'held.notNow' })
    const withdrawn = { ...CATALOGUE_RECORD, request: { ...CATALOGUE_RECORD.request, status: 'WITHDRAWN' as const } }
    expect(catalogueHeld(withdrawn, 'order', owner233, false)).toEqual({ key: 'catalogue.held.WITHDRAWN' })
    expect(catalogueMain(withdrawn, owner233)).toBeNull()
    expect(catalogueOutcome(withdrawn)).toEqual({ key: 'catalogue.outcome.withdrawn' })
  })

  it('Accept as order sends the prices typed only with the price grain, the promise date only when changed; Refuse needs words', () => {
    const owner233 = inquiriesCan(ROLE_PERMISSIONS.owner)
    const draft = acceptDraftOf(CATALOGUE_RECORD, 'ORDER', owner233)
    expect(draft.prices[CATALOGUE_RECORD.request.lines[0]!.id]).toBe('38.000000')
    expect(acceptBodyOf(CATALOGUE_RECORD, draft, owner233)).toEqual({ version: 2, as: 'ORDER', lines: CATALOGUE_RECORD.request.lines.map((line) => ({ lineId: line.id, unitPrice: line.unitPriceShown })) })
    const noPrice = inquiriesCan(ROLE_PERMISSIONS.production)
    expect(acceptDraftOf(CATALOGUE_RECORD, 'ORDER', noPrice).prices[CATALOGUE_RECORD.request.lines[0]!.id]).toBe('')
    expect(acceptBodyOf(CATALOGUE_RECORD, { ...draft, promiseDate: '2027-02-05' }, noPrice)).toEqual({ version: 2, as: 'ORDER', promiseDate: '2027-02-05' })
    expect(acceptBodyOf(CATALOGUE_RECORD, { ...draft, as: 'QUOTE' }, owner233)).toEqual({ version: 2, as: 'QUOTE' })
    expect(acceptHeld(CATALOGUE_RECORD, { ...draft, prices: { [CATALOGUE_RECORD.request.lines[1]!.id]: 'abc' } }, owner233, false)).toEqual({ key: 'catalogue.accept.badPrice', params: { n: 2 } })
    expect(refuseHeld('  ', false)).toEqual({ key: 'catalogue.refuseHeld' })
    expect(refuseHeld('x'.repeat(1001), false)?.key).toBe('decline.held.long')
    expect(refuseHeld('We cannot make it before March.', false)).toBeNull()
  })

  it('a catalogue order this reader may not open reads "not found" in neutral words, never that it exists (W37)', () => {
    for (const locale of LOCALES) {
      const all = words(locale)
      for (const key of ['catalogue.notFound', 'catalogue.notFoundBody']) expect(all[key], `${locale} ${key}`).toBeTruthy()
      expect(`${all['catalogue.notFound']} ${all['catalogue.notFoundBody']}`).not.toMatch(/customer|brand|cliente|marchio/i)
    }
  })

  it('every kind, record type and catalogue state has words in both languages', () => {
    for (const locale of LOCALES) {
      const all = words(locale)
      for (const kind of ['REQUEST', 'CATALOGUE_ORDER', 'CHANGE_REQUEST']) for (const key of [`kind.${kind}`, `kind.plural.${kind}`, `kind.hint.${kind}`]) expect(all[key], `${locale} ${key}`).toBeTruthy()
      for (const state of ['DRAFT', 'ACCEPTED', 'REFUSED', 'WITHDRAWN']) expect(all[`catalogue.held.${state}`], `${locale} ${state}`).toBeTruthy()
      for (const kind of ['CHANGE', 'CANCEL']) expect(all[`kindFacts.change.${kind}`], `${locale} ${kind}`).toBeTruthy()
    }
    void ALEPH
  })
})
// ---- end B-TH-233

// ---- th-backend-g step 2 (B-TH-279: the dialogs' starting words come from the mail templates) ------------------------------------
describe('th-backend-g step 2: the decline’s message starts from the mail template; the reason goes where “…” stands', () => {
  it('a starting text with its blank holds Decline until the person writes the reason; their own text passes', () => {
    const draft = { ...emptyDecline, reason: 'CAPACITY' as const, send: true, message: 'Dear Ann,\nthank you for your request 7.\n\n…\n\nWe hope to work together another time.' }
    expect(hasBlank(draft.message)).toBe(true)
    expect(declineHeld(draft, false)).toEqual({ key: 'decline.held.blank' })
    expect(declineHeld({ ...draft, message: draft.message.replace('…', 'Our lines are full until March.') }, false)).toBeNull()
    // An ellipsis inside a sentence is the person's own writing, not the blank.
    expect(hasBlank('We will see… maybe in spring.')).toBe(false)
    // Not ticked: nothing goes, nothing holds for the blank.
    expect(declineHeld({ ...draft, send: false }, false)).toBeNull()
  })

  it('the decline words name the five languages and the blank, in Italian and English', () => {
    for (const locale of ['en', 'it'] as const) {
      // The catalogue is flat keys ("decline.language.de").
      const words = messagesFor(locale, ['sales-inquiries'])['sales-inquiries'] ?? {}
      expect(Object.keys(words).filter((key) => key.startsWith('decline.language.')).map((key) => key.slice('decline.language.'.length)).sort()).toEqual(['de', 'en', 'es', 'fr', 'it'])
      expect(words['decline.held.blank']).toContain('…')
      expect(words['decline.blankHint']).toContain('…')
    }
  })
})
// ---- end th-backend-g step 2

// ---- F-SA-212 (sales page plan N8, picks P13, P18): Incoming's Picture is the ONE picture part, with its file-kinds fallback -------
describe('Sales › Incoming mounts the ONE picture part (F-SA-212)', () => {
  const view = readFileSync(new URL('./view/InquiriesView.tsx', import.meta.url), 'utf8')
  const cells = readFileSync(new URL('./view/cells.tsx', import.meta.url), 'utf8')
  it('the cell with the file-kinds fallback, the pane\'s row 1 and the picture large come from lib/record-picture; one width, 76 px', () => {
    expect(view).toContain('source="request"')
    expect(view).toContain('source="portalOrder"') // F-CQ-103 (B-CQ-030): a portal order's garment, never a cart icon
    expect(view).toContain('fallback={files}')
    expect(view).toContain("useRecordPicture({ source: 'request'")
    expect(view).toContain('<PictureViewer')
    expect(view.match(/colId: 'picture', headerName: t\('col\.picture'\), minWidth: (\d+), maxWidth: (\d+)/g)?.every((line) => line.includes('minWidth: 76, maxWidth: 76'))).toBe(true)
  })
  it('the old copy is gone: no own cache, cell or viewer; the Files column keeps its own words', () => {
    for (const gone of ['SMALL_CACHE', 'useRequestPicture', 'PictureCell', 'PictureViewer']) expect(cells, gone).not.toContain(gone)
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['sales-inquiries'] ?? {}
      expect(Object.keys(words).filter((key) => key.startsWith('picture.')), locale).toEqual([])
      expect(words['files.photos_other'], locale).toBeTruthy()
    }
  })
})
// ---- end F-SA-212

// ---- F-SA-277 (sales page plan R5, P18; 11-customer-page §3.6): the ONE Incoming list (use-inquiries-list.ts), lifted for the
// customer's Quotes & incoming — a locked host's every read carries the customer, Sales › Incoming reads and writes as before, pane
// 'host' draws no SplitPane (the page's dock is the pane; a change request opens Home › Approvals as on Incoming), and the two lists
// of the tab keep their own terms. Pure helpers, sources and the design case drawn on the server: no DOM.
describe('F-SA-277: the Incoming list lifted — the locked container, the page unchanged, pane "host", two lists apart', () => {
  const LOCK = '0190f0e2-0000-7000-8000-00000000a1a1'
  const OTHER = '0190f0e2-0000-7000-8000-00000000b2b2'
  const at = (patch: Partial<ListAddress>): ListAddress => ({ ...HOME_ADDRESS, ...patch })
  const locked = { locked: { party: LOCK } }
  const docked = { locked: { party: LOCK }, pane: 'host' as const }
  const hook = readFileSync(new URL('./use-inquiries-list.ts', import.meta.url), 'utf8')
  const view = readFileSync(new URL('./view/InquiriesView.tsx', import.meta.url), 'utf8')
  const request = INCOMING_ROWS.find((row) => row.kind === 'REQUEST')!

  it('every read of a locked host carries the customer (Incoming\'s read, Customer replies, the tools\' query), never "prospects only"; Clear filters keeps it', () => {
    for (const address of [HOME_ADDRESS, at({ party: OTHER, q: 'jacket' }), at({ prospect: true }), at({ tile: CUSTOMER_REPLIES }), at({ tile: 'ALL', kind: 'CHANGE_REQUEST' })]) {
      const kept = incomingMemory(docked, address)
      expect(kept.party).toBe(LOCK)
      expect(queryOf(kept)).toMatchObject({ partyId: LOCK, prospect: false })
      expect(queryOf(incomingLocked(locked, address))).toMatchObject({ partyId: LOCK, prospect: false })
      expect(new URLSearchParams(incomingToolsQuery(locked, address)).get('party')).toBe(LOCK)
    }
    expect(hook).toContain("const repliesKey = JSON.stringify({ companyId: read.company, partyId: read.prospect ? null : read.party })")
    // "Clear filters" (HOME_ADDRESS) and a saved view naming another customer: the lock comes back.
    expect(incomingMemory(docked, { ...HOME_ADDRESS }).party).toBe(LOCK)
    expect(incomingFromQuery(docked, `tile=ALL&party=${OTHER}`)).toMatchObject({ tile: 'ALL', party: LOCK })
    // The view never counts it as a filter, draws no chip and no From switcher for it.
    expect(view).toContain('const narrowing = model.locked ? { ...model.address, party: null } : model.address')
    expect(view).toContain('{!model.locked && <CustomerSwitcher')
    expect(isFiltered({ ...incomingMemory(docked, HOME_ADDRESS), party: null })).toBe(false)
  })

  it('Sales › Incoming reads and writes as before: its own terms in the address, on its own path', () => {
    const address = at({ tile: 'ALL', party: OTHER, q: 'jacket', open: ROWS[0]!.id, tab: 'files' })
    expect(incomingLocked({}, address)).toBe(address)
    expect(incomingAddress('/w/DEMO/sales/incoming', address)).toBe(`/w/DEMO/sales/incoming${addressText(address)}`)
    expect(incomingAddress('/w/DEMO/sales/incoming', HOME_ADDRESS)).toBe('/w/DEMO/sales/incoming')
    const page = readFileSync(new URL('./InquiriesPage.tsx', import.meta.url), 'utf8')
    expect(page).toContain('useInquiriesList({ basePath: PAGE_PATH })')
    expect(page.split('\n').length).toBeLessThan(40)
    expect(hook).toContain('router.replace(incomingAddress(base, { ...addressRef.current, ...next }), { scroll: false })')
    expect(hook).toContain("companyPrefix(session.company?.code ?? '')")
    expect(hook).not.toContain('usePathname')
  })

  it('pane "host": no SplitPane and no reading pane — the list alone under the host\'s title; Enter and a link open the row\'s own page', () => {
    const base = listScreen.cases.find((item) => item.id === 'th3-233-catalogue')!.model as { model: InquiriesModel }
    const own = render(listScreen as DesignScreen<unknown>, base, 'en')
    expect(own).toMatch(/class="fw-split[ "]/)
    expect(own).toContain('fw-inq-listband')
    for (const locale of LOCALES) {
      const hosted = render(listScreen as DesignScreen<unknown>, { ...base, model: { ...base.model, address: { ...base.model.address, catalogue: null }, detail: null, catalogue: null, embedded: true, paneMode: 'host', locked: true } }, locale)
      expect(hosted, locale).not.toMatch(/class="fw-split[ "]/)
      expect(hosted, locale).not.toContain('fw-inq-listband')
      expect(hosted, locale).toContain('fw-inq-listcol')
      const html = hosted.replace(/https?:\/\/[^"\s<]+/g, '').replace(/data:[^"]+/g, '').replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '').replace(/\b(?:sales|product|products|files|example|email|quotes|money|threads)\.[a-z]+(?:\.[a-z]+)?\b/g, '')
      expect(html.match(LEFT_KEY)?.[0] ?? null, locale).toBeNull()
    }
    expect(view).toContain('{hostPane ? listColumn : (')
    expect(view).toContain('onOpen={(row) => (hostPane ? actions?.onOpen?.(row.id) : actions?.onOpenRow?.(row, false))}')
    // A request's door is its full page, any other kind its own place (Incoming's ⌘ rule); nothing opens beside the list in memory.
    expect(rowPageHref('/w/DEMO', request, at({ party: LOCK }))).toBe(fullPageHref('/w/DEMO', request.id, at({ party: LOCK })))
    expect(rowPageHref('/w/DEMO', CATALOGUE_ROW, at({ party: LOCK }))).toBe(rowHref('/w/DEMO', at({ party: LOCK }), CATALOGUE_ROW))
    expect(incomingMemory(docked, at({ open: request.id, tab: 'files' }))).toMatchObject({ open: null, catalogue: null, tab: 'request' })
    expect(incomingMemory(docked, at({ catalogue: CATALOGUE_ROW.id }))).toMatchObject({ open: null, catalogue: null })
  })

  it('a change request opens Home › Approvals on every host, before the host\'s row click (as on Incoming); a row\'s click docks its thread', () => {
    expect(placeOf(CHANGE_ROW)).toBe('approvals')
    expect(rowPageHref('/w/DEMO', CHANGE_ROW, at({ party: LOCK }))).toBe(approvalsHref('/w/DEMO', CHANGE_ROW.opens.id)) // F-CQ-103: that request
    const approvals = hook.indexOf("if (place === 'approvals') return newTab ? void window.open(approvalsHref(prefix, row.opens.id), '_blank', 'noopener') : router.push(approvalsHref(prefix, row.opens.id))")
    expect(approvals).toBeGreaterThan(0)
    expect(approvals).toBeLessThan(hook.indexOf('if (host.onRowClick) return host.onRowClick(row, newTab)'))
    expect(THREAD_TYPE.REQUEST).toBe('Inquiry')
    const tab = readFileSync(new URL('../customers/record/QuotesIncomingTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain("type: 'Quote', id: row.id, label: row.number, companyId: row.companyId")
    expect(tab).toContain('type: THREAD_TYPE[row.kind], id: row.id, label: row.number')
    // Each list only for who may read it.
    expect(tab).toContain("session.permissions.includes('quotes.view')")
    expect(tab).toContain("session.permissions.includes('sales.inquiries.view')")
  })

  it('the two lists of Quotes & incoming keep their own terms: typing in one never narrows the other; each frame\'s tools take its own', () => {
    const quotesTerms = quotesToolsQuery(locked, { ...NO_FILTERS, q: 'Q-7' })
    const incomingTerms = incomingToolsQuery(locked, incomingMemory(docked, HOME_ADDRESS))
    expect(new URLSearchParams(quotesTerms).get('q')).toBe('Q-7')
    expect(new URLSearchParams(incomingTerms).get('q')).toBeNull()
    expect(incomingTerms).toBe(`party=${LOCK}`)
    // A list in memory writes no address (the page's own `tab` stays); its frame reads a transport of its own terms only.
    expect(hook).toContain('if (memory) return setKept((now) => incomingMemory(lockHost, { ...now, ...next }))')
    const parent = { pageKey: null, query: 'q=Q-7&tab=quotes', linked: { view: 'view-1', export: 'job-1' }, goTo: () => undefined } as unknown as ListToolsTransport
    const scoped = scopedTransport(parent, { listKey: INQUIRIES_LIST_KEY, page: '/w/DEMO/sales/incoming', query: incomingTerms, goTo: () => undefined })
    expect(scoped.query).toBe(`party=${LOCK}`)
    expect(scoped.pageKey).toBe('sales.inquiries')
    expect(scoped.linked).toEqual({ view: null, export: null })
    const tab = readFileSync(new URL('../customers/record/QuotesIncomingTab.tsx', import.meta.url), 'utf8')
    expect(tab.match(/<ScopedListTools /g)?.length).toBe(2)
    expect(tab.match(/terms: 'memory'/g)?.length).toBe(2)
    expect(tab).toContain("pane: 'host'")
    expect(tab).toContain('listKey={QUOTES_LIST_KEY}')
    expect(tab).toContain('listKey={INQUIRIES_LIST_KEY}')
  })
})
// ---- end F-SA-277

// ---- F-CP-157 (customer page plan C5; the API's B-CP-077; lead note 3: no profile per person in v1): the office accept window maps
// each described / made-to-measure line to the style line(s) it is made into — held in words until mapped, the line map shown before
// Accept, a made-to-measure request accepted as a QUOTE only, the people never copied (only how many). Money wall M-CP-1 "as Sales
// worker": no price key in the body. Brand wall W-CP-3: the picker never offers another customer's own label.
describe('F-CP-157: the accept window maps the lines in the customer\'s words and made to measure', () => {
  const OWNER = inquiriesCan(ROLE_PERMISSIONS.owner)
  const SALES_WORKER = { ...inquiriesCan(ROLE_PERMISSIONS.sales), price: false } // the Sales role after B-CP-011
  const [described, mtm] = MAP_RECORD.request.customLines!
  const jacket = { styleId: JACKET_DETAIL.id, styleLabel: JACKET_DETAIL.code, colourwayId: JACKET_DETAIL.colourways[1]!.id }
  const into = (over: Partial<MapInto> = {}): MapInto => ({ key: `k-${Math.random()}`, styleId: null, styleLabel: null, colourwayId: null, sizesText: '', price: '', ...over })
  const withMap = (draft: AcceptDraft, map: Record<string, MapInto[]>): AcceptDraft => ({ ...draft, map: { ...(draft.map ?? {}), ...map } })
  const describedOnly = { ...MAP_RECORD, request: { ...MAP_RECORD.request, customLines: [described!], acceptMap: { lineIds: [described!.id], orderHeld: null } } }

  it('the window starts with one style line per line to map: the style the line names as a hint, never its colourway', () => {
    const draft = acceptDraftOf(MAP_RECORD, 'QUOTE', OWNER)
    expect(Object.keys(draft.map ?? {})).toEqual([described!.id, mtm!.id])
    expect(draft.map![described!.id]![0]).toMatchObject({ styleId: described!.style!.id, colourwayId: null })
    expect(draft.map![mtm!.id]![0]).toMatchObject({ styleId: null, colourwayId: null })
    expect(acceptDraftOf(CATALOGUE_RECORD, 'QUOTE', OWNER).map).toBeUndefined()
    expect(linesToMap(MAP_RECORD).map((line) => line.seq)).toEqual([3, 4])
  })

  it('held in words until every line is mapped, by place; a made-to-measure request is a quote only (the order held, the pane too)', () => {
    const quote = acceptDraftOf(MAP_RECORD, 'QUOTE', OWNER)
    expect(acceptHeld(MAP_RECORD, quote, OWNER, false)).toEqual({ key: 'catalogueMap.held.unmapped', params: { lines: '3, 4', count: 2 } })
    expect(acceptHeld(MAP_RECORD, withMap(quote, { [described!.id]: [into(jacket)] }), OWNER, false)).toEqual({ key: 'catalogueMap.held.unmapped', params: { lines: '4', count: 1 } })
    const order = acceptDraftOf(MAP_RECORD, 'ORDER', OWNER)
    expect(acceptHeld(MAP_RECORD, withMap(order, { [described!.id]: [into(jacket)], [mtm!.id]: [into({ ...jacket, sizesText: '50:1 52:2' })] }), OWNER, false)).toEqual({ key: 'catalogueMap.held.madeToMeasure', params: { lines: '4', count: 1 } })
    expect(catalogueHeld(MAP_RECORD, 'order', OWNER, false)).toEqual({ key: 'catalogueMap.held.madeToMeasure', params: { lines: '4', count: 1 } })
    expect(catalogueMain(MAP_RECORD, OWNER)).toBe('quote')
    expect(orderHeldOf(describedOnly)).toBeNull()
    expect(orderHeldOf({ ...describedOnly, request: { ...describedOnly.request, acceptMap: { lineIds: [described!.id], orderHeld: 'x' } } })).toEqual({ key: 'catalogueMap.held.quoteOnly' })
  })

  it('the sizes: the line\'s own (or its people\'s when each has one) for one style line; several need each one\'s; words by place', () => {
    const quote = acceptDraftOf(MAP_RECORD, 'QUOTE', OWNER)
    const mapped = (mtmInto: MapInto[], describedInto: MapInto[] = [into(jacket)]) => acceptHeld(MAP_RECORD, withMap(quote, { [described!.id]: describedInto, [mtm!.id]: mtmInto }), OWNER, false)
    // Line 4's people: one has no size yet (a sheet / later) — the office names the sizes.
    expect(mapped([into(jacket)])).toEqual({ key: 'catalogueMap.held.sizesOfPeople', params: { n: 4, pieces: 3 } })
    expect(mapped([into({ ...jacket, sizesText: '50:1 52:2' })])).toBeNull()
    expect(mapped([into({ ...jacket, sizesText: '50:x' })])).toEqual({ key: 'catalogueMap.held.badSizes', params: { n: 4 } })
    expect(mapped([into({ ...jacket, sizesText: '50:1 52:2' })], [into(jacket), into(jacket)])).toEqual({ key: 'catalogueMap.held.sizesOfEach', params: { n: 3 } })
    expect(mapped([into({ ...jacket, sizesText: '50:1 52:2' })], [into(jacket), into({ styleId: jacket.styleId })])).toEqual({ key: 'catalogueMap.held.half', params: { n: 3 } })
    expect(ownSizesOf(described!)).toEqual([{ size: '50', quantity: 10 }, { size: '52', quantity: 12 }, { size: '54', quantity: 8 }])
    expect(ownSizesOf({ ...mtm!, people: [{ size: '52' }, { size: '50' }, { size: '52' }] })).toEqual([{ size: '52', quantity: 2 }, { size: '50', quantity: 1 }])
    expect(ownSizesOf(mtm!)).toBeNull()
    const total = { ...described!, sizes: [], quantity: 30 }
    expect(acceptHeld({ ...describedOnly, request: { ...describedOnly.request, customLines: [total] } }, withMap(acceptDraftOf(describedOnly, 'ORDER', OWNER), { [described!.id]: [into(jacket)] }), OWNER, false)).toEqual({ key: 'catalogueMap.held.sizesOfTotal', params: { n: 3, pieces: 30 } })
  })

  it('the accept body: the map for a quote and an order; a unit price only for an ORDER with the price grain (as Sales worker: no price key)', () => {
    const quote = withMap(acceptDraftOf(MAP_RECORD, 'QUOTE', OWNER), { [described!.id]: [into(jacket)], [mtm!.id]: [into({ ...jacket, sizesText: '50:1 52:2' })] })
    expect(acceptBodyOf(MAP_RECORD, quote, OWNER)).toEqual({
      version: MAP_RECORD.request.version,
      as: 'QUOTE',
      map: [
        { lineId: described!.id, into: [{ styleId: jacket.styleId, colourwayId: jacket.colourwayId }] },
        { lineId: mtm!.id, into: [{ styleId: jacket.styleId, colourwayId: jacket.colourwayId, sizes: [{ size: '50', quantity: 1 }, { size: '52', quantity: 2 }] }] },
      ],
    })
    const order = withMap(acceptDraftOf(describedOnly, 'ORDER', OWNER), { [described!.id]: [into({ ...jacket, price: '139,00' })] })
    expect(acceptHeld(describedOnly, order, OWNER, false)).toBeNull()
    expect(acceptBodyOf(describedOnly, order, OWNER).map).toEqual([{ lineId: described!.id, into: [{ styleId: jacket.styleId, colourwayId: jacket.colourwayId, unitPrice: '139.00' }] }])
    const sales = withMap(acceptDraftOf(describedOnly, 'ORDER', SALES_WORKER), { [described!.id]: [into({ ...jacket, price: '139.00' })] })
    const body = acceptBodyOf(describedOnly, sales, SALES_WORKER)
    expect(JSON.stringify(body)).not.toMatch(/unitPrice|price/i)
    expect(body.map).toEqual([{ lineId: described!.id, into: [{ styleId: jacket.styleId, colourwayId: jacket.colourwayId }] }])
    // A request without such lines sends no map (the catalogue accept as before).
    expect(acceptBodyOf(CATALOGUE_RECORD, acceptDraftOf(CATALOGUE_RECORD, 'QUOTE', OWNER), OWNER)).toEqual({ version: 2, as: 'QUOTE' })
    expect(acceptHeld(describedOnly, withMap(acceptDraftOf(describedOnly, 'ORDER', OWNER), { [described!.id]: [into({ ...jacket, price: 'abc' })] }), OWNER, false)).toEqual({ key: 'catalogueMap.held.badPrice', params: { n: 3 } })
  })

  it('the line map before Accept: every request line in its order and what it becomes; "Not mapped yet" until it is', () => {
    const draft = withMap(acceptDraftOf(MAP_RECORD, 'QUOTE', OWNER), { [described!.id]: [into(jacket)] })
    const rows = lineMapRowsOf(MAP_RECORD, draft, 'en', (styleId) => (styleId === JACKET_DETAIL.id ? { status: 'ready', value: JACKET_DETAIL } : undefined))
    expect(rows.map((row) => row.n)).toEqual([1, 2, 3, 4])
    expect(rows[2]).toMatchObject({ kind: 'DESCRIBED', becomes: [`${JACKET_DETAIL.code} · SND · 50:10 52:12 54:8`] })
    expect(rows[2]!.asked).toContain('sand with black trims')
    expect(rows[3]).toMatchObject({ kind: 'MADE_TO_MEASURE', asked: 'Leather suit · black', becomes: [] })
    expect(rows[0]!.becomes[0]).toContain(CATALOGUE_RECORD.request.lines[0]!.style.code)
    expect(customWords(mtm!, 'it')).toBe('Tuta in pelle · black')
  })

  it('brand wall W-CP-3: the picker offers the open range and this customer\'s own label only; no person\'s name reaches the window', () => {
    const offered = mapStylesOf(MAP_STYLES, MAP_RECORD.request.party.id)
    expect(offered.some((style) => style.code === 'OTHER-LBL-01')).toBe(false)
    expect(offered.length).toBe(MAP_STYLES.length - 1)
    expect(mapStylesOf([{ ...MAP_STYLES[2]!, brand: { id: MAP_RECORD.request.party.id } }], MAP_RECORD.request.party.id)).toHaveLength(1)
    const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
    expect(api).toContain('people: z.array(z.object({ size: z.string().nullable() }))')
  })

  it('the receipt: what was made, the customer\'s logos carried (or not), the customer\'s prices taken over (price holders)', () => {
    const made = { as: 'QUOTE' as const, salesOrderId: null, quoteId: 'q1', number: 'QT-DEMO-00012', dropped: [{ seq: 3, size: '56', reason: 'x' }], warnings: [], lines: [], artwork: { carried: [{ sourceFileId: 'f1', name: 'logo.ai' }, { sourceFileId: 'f2', name: 'back.ai' }], notCarried: [] }, brandPrices: 0 }
    expect(acceptDone(made, 'RQ-1')).toEqual({
      phrase: { key: 'catalogue.done.quote', params: { made: 'QT-DEMO-00012', number: 'RQ-1' } },
      lines: [{ key: 'catalogue.done.droppedSize', params: { n: 3, size: '56' } }, { key: 'catalogueMap.done.logos', params: { count: 2, made: 'QT-DEMO-00012' } }],
      warn: true,
    })
    const order = acceptDone({ ...made, as: 'ORDER', dropped: [], artwork: { carried: [], notCarried: [{ sourceFileId: 'f3', name: 'x.ai', reason: 'gone' }] }, brandPrices: 2 }, 'RQ-1')
    expect(order.lines).toEqual([{ key: 'catalogueMap.done.logosNot', params: { count: 1 } }, { key: 'catalogueMap.done.brandPrices', params: { count: 2, made: 'QT-DEMO-00012' } }])
    expect(acceptDone({ ...made, dropped: [], artwork: { carried: [{ sourceFileId: 'f1', name: 'logo.ai' }], notCarried: [] } }, 'RQ-1').warn).toBe(false)
  })

  it('the "Portal order" word, and every new word in both languages (placeholders kept)', () => {
    expect(words('en')['catalogue.title']).toContain('Portal order')
    expect(words('it')['catalogue.title']).toContain('Ordine dal portale')
    const keys = ['title', 'hint', 'line', 'kind.DESCRIBED', 'kind.MADE_TO_MEASURE', 'pieces_one', 'pieces_other', 'people_one', 'people_other', 'peopleInSheet', 'ownSizes', 'noSizes', 'note', 'into', 'sizesHint', 'add', 'addMax', 'remove', 'noStylesRight', 'colourFirst', 'mapOrder', 'mapQuote', 'mapLabel', 'col.asked', 'col.becomes', 'notMapped', 'mtmHint', 'held.madeToMeasure_one', 'held.madeToMeasure_other', 'held.quoteOnly', 'held.unmapped_one', 'held.unmapped_other', 'held.half', 'held.tooMany', 'held.badSizes', 'held.sizesOfEach', 'held.sizesOfPeople', 'held.sizesOfTotal', 'held.badPrice', 'done.logos_one', 'done.logos_other', 'done.logosNot_one', 'done.logosNot_other', 'done.brandPrices_one', 'done.brandPrices_other']
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    for (const key of keys) {
      const en = words('en')[`catalogueMap.${key}`]
      const it = words('it')[`catalogueMap.${key}`]
      expect(en, `en ${key}`).toBeTruthy()
      expect(it, `it ${key}`).toBeTruthy()
      expect(holes(it!), key).toEqual(holes(en!))
    }
  })

  it('the design cases: as Owner the map and its held words; as Sales worker no price field (M-CP-1)', () => {
    const html = (id: string) => render(listScreen as DesignScreen<unknown>, listScreen.cases.find((item) => item.id === id)!.model, 'en')
    const owner = html('cp-157-accept-map')
    expect(owner).toContain('Lines to map')
    expect(owner).toContain('Not mapped yet')
    expect(owner).toContain('The line map: what the quote gets')
    expect(owner).not.toContain('OTHER-LBL-01')
    const order = html('cp-157-accept-map-order')
    expect(order).toContain('Unit price')
    const sales = html('cp-157-accept-map-sales')
    expect(sales).toContain('Lines to map')
    expect(sales).not.toContain('Unit price')
  })
})
// ---- end F-CP-157

// ---- F-CQ-103 (customer page › Quotes & incoming, 10-design §3.2, §4.3; settles C6, C7, C8, C29, C33): the ONE Incoming list's host
// face — some kinds in every read and in the file's terms, the two new saved rows with their words, Most urgent first ranked on ONE page
// (held in words with more), the chips cell per kind, the selection words that count only what an act runs on, live changes of this
// customer only (never a draft's), and the door of a change request (that request) only for who answers it.
import { bulkActs, incomingWhereOf, rankedRows, rankHeld, urgencyFactsOf } from './model'
import { incomingLiveCounts } from './use-inquiries-list'
import type { IncomingRow as IncomingRowT } from './api'

describe('F-CQ-103: the Incoming list — kinds, To answer and Ended, Most urgent first, the chips cell', () => {
  const LOCK = '0190f0e2-0000-7000-8000-00000000a1a1'
  const hook = readFileSync(new URL('./use-inquiries-list.ts', import.meta.url), 'utf8')
  const view = readFileSync(new URL('./view/InquiriesView.tsx', import.meta.url), 'utf8')
  const row = (patch: Partial<IncomingRowT>, waiting: Partial<IncomingRowT['waiting']> = {}): IncomingRowT => ({ ...incomingRowOf(ROWS[0]!), ...patch, waiting: { ...incomingRowOf(ROWS[0]!).waiting, ...waiting } })

  it('the host\'s kinds go in every read and in the file\'s terms (no change request in the tab\'s file); Sales › Incoming unchanged', () => {
    const address = incomingMemory({ locked: { party: LOCK }, pane: 'host' }, HOME_ADDRESS)
    expect(new URLSearchParams(incomingToolsQuery({ locked: { party: LOCK }, kinds: ['REQUEST', 'CATALOGUE_ORDER'] }, address)).get('kinds')).toBe('REQUEST,CATALOGUE_ORDER')
    expect(incomingToolsQuery({ locked: { party: LOCK } }, address)).toBe(`party=${LOCK}`)
    expect(hook).toContain('...(kinds ? { kinds } : {}) /* F-CQ-103 */')
    // The order is not a file term (it ranks the screen's one page): never written into the tools' query.
    expect(incomingToolsQuery({ locked: { party: LOCK } }, { ...address, rank: 'urgent' })).toBe(`party=${LOCK}`)
    // Kind ▾ offers the host's kinds only and says why change requests are not here.
    expect(view).toContain('(model.kinds ?? INCOMING_KINDS).map((kind) =>')
    expect(view).toContain("{t('list.kindNotHere')}")
  })

  it('To answer and Ended are saved rows with their words, hints and band counts in both languages (C8)', () => {
    expect(SAVED_ROWS).toContain('TO_ANSWER')
    expect(SAVED_ROWS).toContain('ENDED')
    expect(SAVED_ROWS.indexOf('TO_ANSWER')).toBe(1)
    for (const locale of LOCALES) {
      const all = words(locale)
      for (const tile of ['TO_ANSWER', 'ENDED']) {
        expect(all[`tile.${tile}`], `${locale} tile.${tile}`).toBeTruthy()
        expect(all[`tile.hint.${tile}`], `${locale} tile.hint.${tile}`).toBeTruthy()
        expect(all[`band.count.${tile}`], `${locale} band.count.${tile}`).toContain('{count}')
      }
    }
    expect(bandCount({ counts: { TO_ANSWER: 3 }, complete: true }, 'TO_ANSWER', false)).toEqual({ key: 'band.count.TO_ANSWER', params: { count: 3 } })
    // The host's own saved row is not a filter: no chip of its own, no "Clear filters" for it (the band's door chip says it).
    expect(view).toContain('const narrowed = model.homeTile && narrowing.tile === model.homeTile ? { ...narrowing, tile: DEFAULT_TILE } : narrowing')
    expect(hook).toContain('onClearFilters: () => go({ ...HOME_ADDRESS, ...(hostTile ? { tile: hostTile } : {}) })')
  })

  it('Most urgent first ranks one page: overdue on us, then on us, then for the customer, then closed; held in words with more pages (C7)', () => {
    const closed = row({ id: 'r-closed', open: false, receivedAt: '2026-11-20T08:00:00.000Z' }, { for: null, workingMinutes: null, overdue: false })
    const customer = row({ id: 'r-customer', open: true }, { for: 'CUSTOMER', workingMinutes: 2000, overdue: false })
    const us = row({ id: 'r-us', open: true }, { for: 'US', workingMinutes: 200, overdue: false })
    const late = row({ id: 'r-late', open: true }, { for: 'US', workingMinutes: 900, overdue: true })
    const rows = [closed, customer, us, late]
    expect(rankedRows(rows, 'urgent', true).map((one) => one.id)).toEqual(['r-late', 'r-us', 'r-customer', 'r-closed'])
    expect(rankedRows(rows, 'urgent', false).map((one) => one.id)).toEqual(rows.map((one) => one.id))
    expect(rankedRows(rows, 'arrival', true).map((one) => one.id)).toEqual(rows.map((one) => one.id))
    expect(urgencyFactsOf(late)).toMatchObject({ waitsOnUs: true, overdue: true, workingMinutes: 900 })
    expect(rankHeld('urgent', { next: 'cursor' })).toEqual({ key: 'rank.held' })
    expect(rankHeld('urgent', { next: null })).toBeNull()
    expect(rankHeld('arrival', { next: 'cursor' })).toBeNull()
    // The order is an address term of Sales › Incoming (kept), never a filter.
    expect(addressOf(new URLSearchParams('rank=urgent')).rank).toBe('urgent')
    expect(addressOf(new URLSearchParams('rank=sideways')).rank).toBeUndefined()
    expect(isFiltered({ ...HOME_ADDRESS, rank: 'urgent' })).toBe(false)
    for (const locale of LOCALES) for (const key of ['rank.label', 'rank.arrival', 'rank.urgent', 'rank.held', 'rank.rule']) expect(words(locale)[key], `${locale} ${key}`).toBeTruthy()
  })

  it('the chips per kind: waiting on us with its working time (amber past a day), for the customer, what it became, why it ended (C6, C29)', () => {
    const request = ROWS[0]!
    const of = (patch: Partial<typeof request>, waiting: Partial<IncomingRowT['waiting']> = {}) => incomingWhereOf({ ...incomingRowOf({ ...request, ...patch }), waiting: { ...incomingRowOf({ ...request, ...patch }).waiting, ...waiting } }, 'Seed Customer One').chips
    const fresh = of({ status: 'NEW', source: 'MAIL' }, { for: 'US', workingMinutes: 120, overdue: false })
    expect(fresh[0]).toMatchObject({ key: 'where.us', params: { state: 'status.NEW' }, nested: { age: { key: 'time.hours', params: { n: 2 } } }, look: 'pill' })
    expect(of({ status: 'ASSIGNED', source: 'MAIL' }, { for: 'US', workingMinutes: 1200, overdue: true })[0]!.tone).toBe('warning')
    expect(of({ status: 'NEED_INFO', source: 'MAIL' }, { for: 'CUSTOMER', workingMinutes: 480, overdue: false })[0]).toMatchObject({ key: 'where.customer', params: { state: 'status.NEED_INFO', customer: 'Seed Customer One' } })
    expect(of({ status: 'NEW', source: 'MAIL' }, { for: 'US', workingMinutes: null, overdue: false })[0]!.key).toBe('where.usNoAge')
    expect(of({ status: 'QUOTED', source: 'MAIL', quote: { id: 'q-1', number: 'SEED-QT-0012' } }, { for: null, workingMinutes: null })[0]).toMatchObject({ key: 'where.quoted', door: { kind: 'quote', id: 'q-1' } })
    expect(of({ status: 'DECLINED', source: 'MAIL', declineReason: 'NOT_AN_ORDER' }, { for: null, workingMinutes: null })[0]!.key).toBe('decline.NOT_AN_ORDER')
    expect(of({ status: 'DECLINED', source: 'MAIL', declineReason: 'CAPACITY' }, { for: null, workingMinutes: null })[0]).toMatchObject({ key: 'where.weDeclined', params: { reason: 'decline.CAPACITY' } })
    expect(of({ status: 'WITHDRAWN', source: 'MAIL' }, { for: null, workingMinutes: null })[0]).toMatchObject({ key: 'where.withdrawnBy', params: { customer: 'Seed Customer One' } })
    // From the portal and open: what the customer reads (the portal's own words), dashed; production's answer is the one fact.
    const portal = incomingWhereOf({ ...incomingRowOf({ ...request, status: 'NEW', source: 'PORTAL' }) }, 'Seed Customer One', { key: 'production.cell.OK' }).chips
    expect(portal.map((chip) => chip.key).slice(1)).toEqual(['where.production', 'where.customerSees'])
    expect(portal.find((chip) => chip.key === 'where.production')).toMatchObject({ tone: 'success', look: 'tag' })
    expect(portal.find((chip) => chip.key === 'where.customerSees')).toMatchObject({ look: 'dashed', own: { state: { en: 'Sent' } } })
    // A portal order: waiting on us; moved to a quote (never "Confirmed": Q2-B8); confirmed as an order.
    const sent = incomingWhereOf({ ...CATALOGUE_ROW, catalogueOrder: { ...CATALOGUE_ROW.catalogueOrder!, status: 'SENT' } }, 'Seed Customer One').chips
    expect(sent[0]!.params).toMatchObject({ state: 'kind.CATALOGUE_ORDER' })
    expect(sent.at(-1)).toMatchObject({ key: 'where.customerSees', look: 'dashed', own: { state: { en: 'Request sent' } } })
    const moved = incomingWhereOf({ ...CATALOGUE_ROW, catalogueOrder: { ...CATALOGUE_ROW.catalogueOrder!, status: 'ACCEPTED', salesOrder: null, quote: { id: 'q-2', number: 'SEED-QT-0014' } } }, 'Seed Customer One').chips
    expect(moved[0]).toMatchObject({ key: 'where.portalMoved', params: { number: 'SEED-QT-0014' } })
    for (const one of [...INCOMING_ROWS, CATALOGUE_ROW, CHANGE_ROW]) {
      const cell = incomingWhereOf(one, 'Seed Customer One')
      expect(cell.chips.length).toBeLessThanOrEqual(3)
      expect(JSON.stringify(cell)).not.toMatch(/targetUnitPrice|amount/)
    }
    for (const locale of LOCALES) {
      const all = words(locale)
      for (const key of ['us', 'usNoAge', 'customer', 'customerNoAge', 'quoted', 'ordered', 'weDeclined', 'withdrawnBy', 'production', 'customerSees', 'portalConfirmed', 'portalMoved', 'portalState', 'portalRefused', 'portalWithdrawn', 'kindState', 'foldWanted', 'styles_one', 'styles_other', 'pieces_one', 'pieces_other']) expect(all[`where.${key}`], `${locale} where.${key}`).toBeTruthy()
      expect(all['col.where'], locale).toBeTruthy()
    }
    expect(words('it')['where.us']).toContain('tocca a noi') // C29
  })

  it('the selection words count only what an act runs on: no open request ticked → why in words, no act drawn ("Assign 0" never)', () => {
    expect(bulkActs(bulkReach(INCOMING_ROWS, [CATALOGUE_ROW.key, CHANGE_ROW.key]))).toBe(false)
    expect(bulkActs(bulkReach(INCOMING_ROWS, [incomingRowOf(ROWS[0]!).key]))).toBe(true)
    expect(view).toContain('{!bulkActs(reach) ? say(reach.held) :')
    expect(view).toContain('{bulkActs(reach) && (')
  })

  it('a customer\'s tab counts only its own live changes, never a draft\'s; the change request\'s door only for who answers it (P0-B7)', () => {
    expect(incomingLiveCounts({ type: 'inquiry.changed', fields: { inquiryId: 'i-1', partyId: LOCK } }, LOCK, false)).toBe(true)
    expect(incomingLiveCounts({ type: 'inquiry.changed', fields: { inquiryId: 'i-2', partyId: 'another' } }, LOCK, false)).toBe(false)
    expect(incomingLiveCounts({ type: 'inquiry.received', fields: { inquiryId: 'i-3', partyId: null } }, LOCK, false)).toBe(false)
    expect(incomingLiveCounts({ type: 'portal_order_request.draft_changed', fields: { requestId: 'd-1' } }, null, false)).toBe(false)
    expect(incomingLiveCounts({ type: 'portal_order_request.sent', fields: { requestId: 'p-1', partyId: 'another' } }, null, false)).toBe(true)
    expect(incomingLiveCounts({ type: 'thread.message_posted', fields: {} }, null, true)).toBe(true)
    expect(incomingLiveCounts({ type: 'thread.message_posted', fields: {} }, null, false)).toBe(false)
    expect(view).toContain("...(place === 'approvals' ? (m.can.orders ? [{ id: 'open'")
  })
})
// ---- end F-CQ-103

// ---- F-CQ-201 / 203 / 204 (customer page › Quotes & incoming, 10-design §6.2, §7, §8; settles C2, C10, C30; the lead's decision on W1):
// the Incoming list's acts on both hosts — the bar, Assign N / Decline N with their plan and a refusal that names each request, the
// row ⋯ hidden without the right, the request's and the portal order's OWN windows opened in place on a host whose dock is the pane,
// the file keeping the chips cell's waiting and production facts, the Italian "preventivo".
import { bulkRefusalsOf } from './model'

describe('F-CQ-201 / 203 / 204: the Incoming list acts', () => {
  const view = readFileSync(new URL('./view/InquiriesView.tsx', import.meta.url), 'utf8')
  const hook = readFileSync(new URL('./use-inquiries-list.ts', import.meta.url), 'utf8')

  it('a refused Assign / Decline names the requests it was about (body/items/<i>), each once (Q4-B4)', () => {
    const items = [{ inquiryId: ROWS[0]!.id }, { inquiryId: ROWS[1]!.id }]
    const refused = new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/items/1', message: 'x' }, { path: 'body/items/1/version' }])
    expect(bulkRefusalsOf(refused, items, ROWS)).toEqual([{ key: 'bulk.refusedOne', params: { number: ROWS[1]!.number } }])
    expect(bulkRefusalsOf(new ApiError('conflict', 409, 'conflict', 'x'), items, ROWS)).toEqual([])
    expect(bulkRefusalsOf(new Error('x'), items, ROWS)).toEqual([])
    expect(hook).toContain('const lines = bulk ? bulkRefusalsOf(error, itemsOf(bulk.ids), list?.rows ?? []) : []')
    // The plan before the click, in the window: what it runs on, the other kinds left out.
    expect(hook).toContain('const preview: BulkPreview = { runs: open.length, others: picked.length - open.length }')
  })

  it('the row ⋯: the request\'s next steps only with the right (never held for it), no key letter in a label; a portal order\'s own verbs', () => {
    expect(view).toContain('...(request && isOpen(request.status) && m.can.manage')
    expect(view).toContain("...(m.can.quotes ? [verbItem(data, request, 'quote', `${t('verb.quote')}…`)] : [])")
    expect(view).toContain("verbItem(data, request, 'lost', t('verb.lost'))")
    expect(view).not.toContain("t('verb.quoteKey')")
    expect(view).toContain("data.kind === 'CATALOGUE_ORDER' && data.catalogueOrder?.status === 'SENT' && m.can.orders")
    // Mark as lost and Make order held by the state, Make order also by its right (the rule keeps it).
    expect(verbHeld({ ...ROWS[0]!, status: 'LOST' }, 'lost', owner, false)).toEqual({ key: 'refusal.CLOSED', params: { number: ROWS[0]!.number } })
    expect(verbHeld(ROWS[0]!, 'order', { ...owner, orders: false }, false)).toEqual({ key: 'held.right', params: { right: 'right.orders.manage' } })
  })

  it('on a host whose dock is the pane a row\'s verb opens its OWN window here (read once, nothing after it closes); Ask for info = the ask window with one (C2)', () => {
    expect(hook).toContain('inquiryId: address.open ?? verbTarget,')
    expect(hook).toContain("if (verb === 'askInfo') return many.open(incomingActOf('askInfo', api, [recordOf(row)]), [recordOf(row)])")
    expect(hook).toContain('requestId: address.catalogue ?? catalogueTarget?.id ?? null,')
    expect(view).toContain('{hostPane && model.verb && model.verb.loaded.status === \'ready\' && <RecordDialogs model={model.verb} view={model.verb.loaded.value} actions={actions?.record} />}')
    expect(view).toContain('<CatalogueDialogs model={model.catalogueVerb}')
    const pane = readFileSync(new URL('./view/pane/catalogue/CataloguePane.tsx', import.meta.url), 'utf8')
    expect(pane).toContain('export function CatalogueDialogs(')
    const container = readFileSync(new URL('./use-catalogue-order.tsx', import.meta.url), 'utf8')
    expect(container).toContain("else actions.onAccept?.(pending === 'order' ? 'ORDER' : 'QUOTE')")
  })

  it('Add task to N: the ONE batch window (records Inquiry / PortalOrderRequest), Assign to starts on "Me" (C19)', () => {
    // cq fx2 W-07: the words by the records' kind (requests, portal orders, or both).
    expect(view).toContain("words: { ns: 'before-order', prefix: taskWordsOf(model.tasks.records) /* cq fx2 W-07: the records' own kind */ }")
    expect(view).toContain("defaultAssignee: 'me'")
    expect(hook).toContain('tasks.open(rows.map((row) => ({ type: THREAD_TYPE[row.kind], id: row.id, label: row.number, supervisor: null })))')
  })

  it('the file keeps the waiting and production facts by default (screen = file: they are in the chips cell) — never lost', () => {
    expect(view).toContain("{ key: 'waitingHours', label: t('col.waiting') }")
    expect(view).toContain("{ key: 'production', label: t('production.col') }")
    expect(view.match(/context: \{ exportWith: whereExport \}/g)?.length).toBe(2)
    expect(view).not.toContain("colId: 'waitingHours'")
    expect(view).not.toContain("colId: 'production'")
  })

  it('the words in both languages; Italian "Accetta come preventivo" (C30), the true decline words (Q4-B5)', () => {
    for (const locale of LOCALES) {
      const all = words(locale)
      for (const key of ['row.makeOrder', 'row.assign', 'row.decline', 'row.addTask', 'bulk.plan_one', 'bulk.plan_other', 'bulk.planOthers_one', 'bulk.planOthers_other', 'bulk.refusedOne']) expect(all[key], `${locale} ${key}`).toBeTruthy()
    }
    expect(words('it')['catalogue.acceptQuote']).toBe('Accetta come preventivo')
    expect(words('it')['catalogue.acceptQuoteTitle']).toContain('preventivo')
    expect(words('it')['catalogue.acceptQuoteHint']).toContain('Un preventivo in bozza')
    expect(words('en')['decline.message.many']).toContain('tells its customer it was declined')
  })
})
// ---- end F-CQ-201 / 203 / 204
