import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DECLINE_REASONS, INQUIRY_REFUSALS, INQUIRY_SOURCES, INQUIRY_STATUSES, INQUIRY_TILES, LAWFUL_BASES, quotableLines } from '@nexus/factory-domain/sales/inquiries/rules'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { listAddress, recordAddress } from '../../../lib/records/record-links'
import { permissionCheck } from '../../../lib/session/session'
import { OFFICE_PAGES, officeNavFor } from '../../../shell/nav/office-nav'
import { MAIL_DRAFT, PROSPECT_VIEW, QUOTED_VIEW, ROLE_PERMISSIONS, ROWS, VIEW } from './demo/fixtures'
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
  draftFromMail,
  emptyLine,
  emptyNewDraft,
  exportPhrases,
  fieldLines,
  filesPhrases,
  fromMailBodyOf,
  HOME_ADDRESS,
  inquiriesCan,
  KNOWN_RIGHTS,
  leftOutPhrases,
  lineBodyOf,
  lineProblem,
  messageReach,
  newBodyOf,
  newDraftHeld,
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
    for (const tile of [...DESIGN_TILES, ...SAVED_ROWS]) expect(INQUIRY_TILES).toContain(tile)
    expect(chipsOf({ ...HOME_ADDRESS, tile: 'NEW', source: 'MAIL', q: 'x' }, null).map((chip) => chip.id)).toEqual(['tile', 'source', 'q'])
    expect(chipsOf(HOME_ADDRESS, null)).toEqual([])
  })

  it('an unknown count is "—", never 0', () => {
    expect(tileValue(null, 'NEW', false)).toBe('—')
    expect(tileValue({ rows: [], counts: { NEW: null }, complete: true }, 'NEW', false)).toBe('—')
    expect(tileValue({ rows: [], counts: { NEW: 3 }, complete: true }, 'NEW', true)).toBe('—')
    expect(tileValue({ rows: [], counts: { NEW: 0 }, complete: true }, 'NEW', false)).toBe('0')
  })
})

describe('the queue', () => {
  it('waiting is said in working time; over a working day for us is the danger tone', () => {
    expect(workingTime(45)).toEqual({ key: 'time.minutes', params: { n: 45 } })
    expect(workingTime(135)).toEqual({ key: 'time.hours', params: { n: 2 } })
    expect(workingTime(620)).toEqual({ key: 'time.daysHours', params: { d: 1, h: 2 } })
    expect(waitingOf(ROWS[0]!)?.tone).toBe('danger')
    expect(waitingOf(ROWS[2]!)?.phrase.key).toBe('waiting.customer')
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
    const reach = bulkReach(ROWS, [ROWS[0]!.id, ROWS[4]!.id, ROWS[5]!.id])
    expect([reach.open.map((row) => row.id), reach.closed, reach.held]).toEqual([[ROWS[0]!.id], 2, null])
    expect(bulkReach(ROWS, [ROWS[4]!.id]).held?.key).toBe('bulk.noneOpen')
    const many = Array.from({ length: 101 }, (_, n) => ({ ...ROWS[0]!, id: `r${n}` }))
    expect(bulkReach(many, many.map((row) => row.id)).held?.key).toBe('bulk.tooMany')
  })

  it('after a decision the next inquiry opens (or the one before at the end)', () => {
    expect(nextAfter(['a', 'b', 'c'], 'b')).toBe('c')
    expect(nextAfter(['a', 'b', 'c'], 'c')).toBe('b')
    expect(nextAfter(['a'], 'a')).toBeNull()
  })

  it('the notices: the partial count first, prospects to match; a dismissed one stays away until its value changes', () => {
    const list = { rows: ROWS, counts: {}, complete: false }
    expect(pageNotices(list, 200, new Set()).map((notice) => notice.key)).toEqual(['notice.partial', 'notice.prospects'])
    expect(pageNotices(list, 200, new Set(['notice.partial:partial', 'notice.prospects:prospects:2'])).map((notice) => notice.key)).toEqual([])
    expect(pageNotices(list, 6, new Set(['notice.partial:partial'])).map((notice) => notice.key)).toEqual(['notice.capped', 'notice.prospects'])
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

  it('a prospect matched to a customer sends the party once and clears the prospect; a closed inquiry only its note', () => {
    const match = requestChanges(PROSPECT_VIEW, { ...requestDraftOf(PROSPECT_VIEW), matchPartyId: 'p1', contactId: 'c1' }, owner)
    expect(match.body).toEqual({ version: PROSPECT_VIEW.version, partyId: 'p1', prospect: null, contactId: 'c1' })
    const closed = requestChanges(QUOTED_VIEW, { ...requestDraftOf(QUOTED_VIEW), request: 'changed', note: 'A note' }, owner)
    expect(closed.body).toEqual({ version: QUOTED_VIEW.version, note: 'A note' })
  })
})

describe('New inquiry and Make an inquiry from a mail', () => {
  it('held until the customer (or a prospect) and the request are said; the body is what the API takes', () => {
    expect(newDraftHeld(emptyNewDraft(), owner, false, false)?.key).toBe('new.held.customer')
    expect(newDraftHeld({ ...emptyNewDraft(), who: 'prospect' }, owner, false, false)?.key).toBe('prospect.problem.who')
    const draft = { ...emptyNewDraft(), partyId: 'p1', contactId: 'c1', request: ' 60 trousers ', targetPrice: '38', assignToMe: true }
    expect(newDraftHeld(draft, owner, false, false)).toBeNull()
    expect(newBodyOf(draft, 'co1', owner, 'me')).toEqual({ companyId: 'co1', source: 'PHONE', partyId: 'p1', contactId: 'c1', request: '60 trousers', targetUnitPrice: '38', currency: 'EUR', assigneeId: 'me' })
    const prospect = { ...emptyNewDraft(), who: 'prospect' as const, prospect: { name: '', company: 'Demo Club', email: '', phone: '' }, request: 'Jackets' }
    expect(newBodyOf(prospect, 'co1', owner, null)).toMatchObject({ prospect: { company: 'Demo Club', name: null, lawfulBasis: 'CONTRACT' } })
  })

  it('from a mail: the sender’s customer, the mail’s words, its version, its attachments as the tech pack', () => {
    const draft = { ...draftFromMail(MAIL_DRAFT), techPackFileIds: [MAIL_DRAFT.attachments[0]!.id] }
    expect(draft).toMatchObject({ who: 'customer', partyId: MAIL_DRAFT.party!.id, contactId: MAIL_DRAFT.contactId })
    expect(newDraftHeld({ ...draft, request: '' }, owner, false, true)).toBeNull()
    expect(fromMailBodyOf(draft, MAIL_DRAFT, 4, owner, null, 'co1')).toMatchObject({ version: 4, partyId: MAIL_DRAFT.party!.id, techPackFileIds: [MAIL_DRAFT.attachments[0]!.id] })
    expect(fromMailBodyOf(draft, MAIL_DRAFT, 4, owner, null, 'co1')).not.toHaveProperty('companyId')
  })
})

describe('Decline and refusals', () => {
  it('a reason; Other needs words; the message reaches the customer’s contact only', () => {
    expect(declineHeld({ reason: null, note: '', message: '' }, false)?.key).toBe('decline.held.reason')
    expect(declineHeld({ reason: 'OTHER', note: ' ', message: '' }, false)?.key).toBe('refusal.OTHER_NEEDS_WORDS')
    expect(declineHeld({ reason: 'PRICE', note: '', message: '' }, false)).toBeNull()
    expect(messageReach(VIEW, owner)).toEqual({ to: VIEW.contact!.email, held: null })
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
      for (const tile of INQUIRY_TILES) expect(all[`tile.${tile}`], `${locale} tile.${tile}`).toBeTruthy()
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
    const list = { rows: [...ROWS], counts: { NEW: 2, WAITING_US: null, OPEN: 41 }, complete: true }
    expect(tileValue(list, 'NEW', false)).toBe('2')
    expect(tileValue(list, 'WAITING_US', false)).toBe('—')
    expect(tileValue(list, 'MINE', false)).toBe('—')
    expect(tileValue(null, 'NEW', false)).toBe('—')
    expect(bandCount(list, 'OPEN', false)).toEqual({ key: 'band.count.OPEN', params: { count: 41 } })
    expect(bandCount(list, 'WAITING_US', false)).toEqual({ key: 'band.countUnknown' })
    expect(bandCount(list, 'OPEN', true)).toEqual({ key: 'band.countUnknown' })
    for (const locale of LOCALES) {
      const all = words(locale)
      for (const tile of INQUIRY_TILES) expect(all[`band.count.${tile}`], `${locale} band.count.${tile}`).toContain('{count}')
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

  it('Export ▾ is honest: the first 200 rows of this view, the price left out without the grain', () => {
    expect(exportPhrases('OPEN', 200, { price: true })).toEqual({ heading: { key: 'export.heading', params: { view: 'tile.OPEN', count: 200 } }, note: { key: 'export.note', params: { count: 200 } } })
    expect(exportPhrases('OPEN', 200, { price: false }).note.key).toBe('export.notePrice')
    expect(words('en')['export.note']).toContain('first {count} rows')
  })

  it('one notice at most, the most serious first: no request numbering, then the list facts, then mails to sort (each with its door)', () => {
    const list = { rows: [...ROWS], counts: {}, complete: false }
    const notices = pageNotices(list, 200, new Set(), { numberingMissing: ['Demo Factory'], mailToSort: { count: 4, more: false } })
    expect(notices.map((notice) => notice.key)).toEqual(['notice.numbering', 'notice.partial', 'notice.prospects', 'notice.mail'])
    expect(noticeLink(notices[0]!, '/w/DEMO')).toEqual({ href: '/w/DEMO/admin/documents', label: { key: 'notice.numberingOpen' } })
    expect(noticeLink(notices[3]!, '/w/DEMO')?.href).toBe('/w/DEMO/home/mail-to-sort')
    expect(pageNotices(list, 200, new Set([noticeKey(notices[0]!)]), { numberingMissing: ['Demo Factory'] })[0]!.key).toBe('notice.partial')
    expect(pageNotices({ rows: [], counts: {}, complete: true }, 200, new Set(), { mailToSort: { count: 50, more: true } })).toEqual([{ key: 'notice.mailMore', params: { count: 50 }, tone: 'info', value: 'mail:50+' }])
  })

  it('a limited office person sees only what the read returned: tiles and the band count only those rows (W19, W30)', () => {
    // The page draws the API's counts as they are (the API counts in the reader's scope); it never adds rows of its own.
    const mine = { rows: ROWS.filter((one) => one.party?.id === ROWS[0]!.party?.id), counts: { OPEN: 1, NEW: 1 }, complete: true }
    expect(bandCount(mine, 'OPEN', false)).toEqual({ key: 'band.count.OPEN', params: { count: 1 } })
    expect(tileValue(mine, 'NEW', false)).toBe('1')
  })
})
// ── end B-TH-216 ──

const LEFT_KEY = /\b(?:common|held|list|record|tile|new|tab|live|row|col|keys|notice|chip|status|source|waiting|time|assignee|bulk|right|refusal|problem|field|line|grid|mail|pack|files|quote|quoteStatus|leftOut|activity|dialog|assign|decline|lost|verb|done|closed|who|prospect|basis|request|noAccess|page|band|door|funnel|picture|peek|export)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

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
