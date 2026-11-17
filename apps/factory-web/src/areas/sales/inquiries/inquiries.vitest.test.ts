import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
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
import { approvalsHref, CUSTOMER_REPLIES, incomingRowOf, LIST_TILES, mergePages, navIdsOf, numberWithCompany, placeOf, replyHref, replyWaiting, rowHref, THREAD_TYPE } from './model'
import { designScreen as paneScreen } from './view/pane/fixtures'

const owner = inquiriesCan(ROLE_PERMISSIONS.owner)
const words = (locale: (typeof LOCALES)[number]) => CATALOGUE[locale]['sales-inquiries']!

describe('who may do what, by the role templates', () => {
  it('sales answers, quotes and sees prices; a reader only reads (no price); the warehouse has no page', () => {
    const sales = inquiriesCan(ROLE_PERMISSIONS.sales)
    expect([sales.view, sales.manage, sales.quotes, sales.price]).toEqual([true, true, true, true])
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
    const sales = rows(ROLE_PERMISSIONS.sales)
    expect(sales.indexOf('/sales/incoming')).toBe(sales.indexOf('/sales/customers') + 1)
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
    // Approvals' review window reads approval tasks only: the door opens the waiting change requests (never a "not found" window).
    expect(rowHref('/w/DEMO', HOME_ADDRESS, CHANGE_ROW)).toBe(approvalsHref('/w/DEMO'))
    expect(approvalsHref('/w/DEMO')).toBe('/w/DEMO/home/approvals?kind=ORDER_CHANGE_REQUEST')
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
    expect(words('en')['catalogue.held.right']).toContain('Only sales can accept or refuse a catalogue order')
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
      const words = messagesFor(locale, ['sales-inquiries'])['sales-inquiries'] as Record<string, any>
      expect(Object.keys(words.decline.language).sort()).toEqual(['de', 'en', 'es', 'fr', 'it'])
      expect(words.decline.held.blank).toContain('…')
      expect(words.decline.blankHint).toContain('…')
    }
  })
})
// ---- end th-backend-g step 2
