import { defineDesignScreen } from '../design/design-screen'
import { BRAND_ALPHA, BRAND_BETA, type BrandFixture } from '../testing/two-brands'
import type { RecordFile } from './attachments/model'
import type { CardContext } from './card/model'
import { DEMO_NOW, demoThread, OFFICE_PEOPLE } from './demo-data'
import type { RecordThreadModel } from './RecordThread'
import { ThreadCase, type ThreadCaseModel } from './ThreadCase'
// B-TH-300: the docked thread's bands.
import { DEMO_FILE_SOURCES, DEMO_FILES, DEMO_FILES_PARTY } from './files/fixtures'
import { demoHead } from './head/fixtures'
import type { HeadModel } from './head/model'
import type { SavedRepliesModel } from './helpers/model'

/**
 * SCR-006-thread — RecordThread v1 (B-TH-212; pictures 1–5 in one column): the feed, the cards and the box for Incoming's reading
 * pane and the request's full page. Made-up data (the brand-wall helpers' brands, the design kit's people). Cases: the full page,
 * the reading pane (SplitPane, 35 : 65), a reply with To / Cc, the send check, a link to one message, loading, no permission, a
 * closed thread, and Brand Beta's copy (the brand wall). Light / dark and 375 / 1440 / 1920 from the frame.
 * B-TH-300 (pictures 6–11, PL1, PL4): the DOCKED thread — the Head with Activity's doors, the files line, the feed and the box with
 * Saved replies — in a stand-in record frame (40 % beside the body from 1280 px; the phone's full page with its short head below 720).
 */

const recordFiles = (brand: BrandFixture): RecordFile[] => [
  { id: 'r1', name: 'label-sketch.jpg', sizeBytes: 820_000, contentType: 'image/jpeg', shared: true, available: true },
  { id: 'r2', name: brand.fileName, sizeBytes: 240_000, contentType: 'application/pdf', shared: true, available: true },
  { id: 'r3', name: 'cost-sheet-v3.xlsx', sizeBytes: 96_000, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', shared: false, available: true },
]

function threadOf(brand: BrandFixture, more: Partial<CardContext> = {}): RecordThreadModel {
  const contacts = [brand.contact, brand.portalPerson].map((person) => ({ name: person.name, email: person.email }))
  return {
    title: `${brand.numbers.request} · ${brand.tradeName}`,
    feed: { state: 'ready', messages: demoThread(brand), events: [], context: { partyName: brand.tradeName, canReadFiles: true, canReply: true, ...more }, more: false, older: 'idle', now: DEMO_NOW },
    composer: {
      context: { recordType: 'Inquiry', recordLabel: brand.numbers.request, party: { name: brand.tradeName }, can: { post: true, email: true, manage: true }, people: OFFICE_PEOPLE },
      draft: { mode: 'note', body: '', forFloor: false },
      notes: [],
      sending: false,
      files: [],
      recordFiles: recordFiles(brand),
      canUpload: true,
      canShare: true,
      canPick: true,
      to: [{ address: brand.contact.email, name: brand.contact.name, kind: 'PARTY', organisation: brand.tradeName }],
      cc: [],
      subject: `Re: ${brand.numbers.request}`,
      contacts,
    },
  }
}

const ALPHA = threadOf(BRAND_ALPHA)

const REPLIES: SavedRepliesModel = {
  status: 'ready',
  language: 'en',
  replies: [
    { id: 'r-1', name: 'Sample on its way', language: 'en', shared: true },
    { id: 'r-2', name: 'Campione in arrivo', language: 'it', shared: true },
    { id: 'r-3', name: 'Delivery date moved', language: 'en', shared: false },
  ],
}

/**
 * The docked thread of a sales order (B-TH-300) as the design cases draw it: the order's title, the Head (who answers next, the
 * counts, View, the width, the "⋯" with Activity's doors), the order's files and Saved replies. SCR-039 docks it on the order.
 */
export function dockedThread(brand: BrandFixture = BRAND_ALPHA, head: Partial<HeadModel> = {}, fill = false): ThreadCaseModel {
  const base = threadOf(brand)
  return {
    thread: {
      ...base,
      title: `${brand.numbers.order} · ${brand.tradeName}`,
      composer: { ...base.composer, context: { ...base.composer.context, recordType: 'SalesOrder', recordLabel: brand.numbers.order }, subject: `Re: ${brand.numbers.order}` },
    },
    // Brand Beta's copy carries none of Brand Alpha's made-up counts or files (the brand wall, B-TH-203); a copy of Brand Alpha under
    // another name (SCR-039's customer) gets the same counts and files in its own name.
    docked: {
      head: demoHead({ record: brand.numbers.order, party: { name: brand.tradeName, role: 'customer' }, counts: brand.key === 'alpha' ? renamed(demoHead().counts, brand) : {}, ...head }),
      files: brand.key === 'alpha' ? renamed(DEMO_FILES, brand) : [],
      party: DEMO_FILES_PARTY,
      replies: REPLIES,
      sources: DEMO_FILE_SOURCES,
    },
    fill,
  }
}
/** Brand Alpha's made-up words said with another made-up customer's (its name, its tech pack's file name). */
function renamed<T>(value: T, brand: BrandFixture): T {
  if (brand === BRAND_ALPHA) return value
  const text = JSON.stringify(value).split(BRAND_ALPHA.fileName).join(brand.fileName).split(BRAND_ALPHA.tradeName).join(brand.tradeName)
  return JSON.parse(text) as T
}
// ---- B-TH-257…264 (TH-6 part A): the docked thread of ANY record page in the design cases (the rule of picture 38) ----------------
/** A record page's docked thread for a design case: its type, its number as the band names it, and its party (none: notes only). */
export interface RecordDockedInput {
  /** The thread's record type ("SampleRound", "PurchaseOrder" …): the box's context. */
  readonly recordType: string
  /** The record's number as its band shows it ("SR-2026-0007"). */
  readonly record: string
  /** The record's party, made-up ("Brand Alpha", "Pelli Demo S.p.A."), with whom it is to us; null: a record with notes only. */
  readonly party: { readonly name: string; readonly role: 'customer' | 'supplier' | 'partner' } | null
}

/**
 * The docked thread of any record (B-TH-257…264): the Head (who answers next, the counts, View, the width, the "⋯" with Activity's
 * doors — R-ACT), the record's files line, the feed and the box, in the record's own number and its own party's name. A record
 * without a party (a price list, a change order, a stock count) shows the office's notes only: no mail, no "Reply to", no files of a
 * party. Brand Beta's words never appear in Brand Alpha's copy (the made-up party's name replaces Brand Alpha's everywhere).
 */
export function recordDockedThread(input: RecordDockedInput, head: Partial<HeadModel> = {}): ThreadCaseModel {
  const name = input.party?.name ?? BRAND_ALPHA.tradeName
  // The made-up party's own words everywhere: its name, and its own file's name (never Brand Alpha's in another party's thread).
  const brand: BrandFixture = { ...BRAND_ALPHA, legalName: name, tradeName: name, fileName: input.party ? `${name} tech pack.pdf` : BRAND_ALPHA.fileName, numbers: { ...BRAND_ALPHA.numbers, order: input.record } }
  const base = dockedThread(brand, head, true)
  const party = input.party
  if (party) {
    return {
      ...base,
      thread: { ...base.thread, composer: { ...base.thread.composer, context: { ...base.thread.composer.context, recordType: input.recordType, recordLabel: input.record } } },
      docked: base.docked && { ...base.docked, head: { ...base.docked.head, party: { name: party.name, role: party.role } }, party: base.docked.party && { ...base.docked.party, role: party.role } },
    }
  }
  const feed = base.thread.feed
  return {
    ...base,
    thread: {
      ...base.thread,
      title: input.record,
      feed: feed.state === 'ready' ? { ...feed, messages: feed.messages.filter((message) => message.kind === 'note'), context: { ...feed.context, partyName: null, canReply: false } } : feed,
      composer: { ...base.thread.composer, context: { ...base.thread.composer.context, recordType: input.recordType, recordLabel: input.record, party: null, can: { ...base.thread.composer.context.can, email: false } }, to: [], cc: [], contacts: [], subject: '', recordFiles: [] },
    },
    docked: base.docked && { ...base.docked, head: demoHead({ record: input.record, party: null, counts: {}, ...head }, undefined, false), files: [], party: null },
  }
}
// ---- end B-TH-257…264

const DOCKED = dockedThread()
const reply =(thread: RecordThreadModel): RecordThreadModel => ({ ...thread, composer: { ...thread.composer, draft: { mode: 'reply', body: 'Hello Alma,\nthe quote follows tomorrow morning.\nAlex', forFloor: false } } })

export const designScreen = defineDesignScreen<ThreadCaseModel>({
  screen: 'SCR-006-thread',
  title: 'Record thread · RecordThread v1 (reading pane and full page)',
  view: ThreadCase,
  cases: [
    { id: 'full-page', label: 'The request’s full page', model: { thread: ALPHA }, note: 'One column: the feed (oldest at the top, opened at the newest), the box at the bottom on Office note. R / N switch the box; J / K walk the messages while the feed has the focus.' },
    { id: 'reading-pane', label: 'Incoming’s reading pane', model: { thread: ALPHA, pane: true }, note: 'SplitPane 35 : 65 (one at a time below 1024 px, with a way back; Esc closes). The list is a stand-in: B-TH-217 draws Incoming.' },
    { id: 'reply', label: 'A reply with To and Cc', model: { thread: reply(ALPHA) } },
    {
      id: 'send-check',
      label: 'The send check',
      model: { thread: { ...reply(ALPHA), check: { state: { status: 'ready', check: { party: { id: 'a', name: BRAND_ALPHA.tradeName }, recipients: [], warnings: [{ code: 'MENTIONS_COST', items: ['quote'] }], attachments: [], outsideCustomer: [] } }, outside: false } } },
    },
    { id: 'anchor', label: 'A link to one message', model: { thread: { ...ALPHA, feed: { ...ALPHA.feed, context: { ...ALPHA.feed.context, anchorId: ALPHA.feed.messages[13].id } } } }, note: '?message=<id> opens that message unfolded and in focus.' },
    { id: 'loading', label: 'Loading', model: { thread: { ...ALPHA, feed: { ...ALPHA.feed, state: 'loading' } } } },
    { id: 'forbidden', label: 'No permission', model: { thread: { ...ALPHA, feed: { ...ALPHA.feed, state: 'forbidden' } } }, note: 'Without threads.read nothing of the thread is drawn, not even the box.' },
    { id: 'closed', label: 'Closed thread', model: { thread: { ...ALPHA, composer: { ...ALPHA.composer, context: { ...ALPHA.composer.context, closed: { by: 'Bea Esempio', at: '2026-11-12T15:00:00.000Z' } } } } } },
    { id: 'notice', label: 'After a note', model: { thread: { ...ALPHA, notice: { ns: 'record-thread', key: 'notice.noteAdded', tone: 'success' } } } },
    { id: 'brand-beta', label: 'Brand Beta’s copy (brand wall)', model: { thread: threadOf(BRAND_BETA) }, note: 'The same thread on Brand Beta’s request: nothing of Brand Alpha (B-TH-203 scan).' },
    // ---- B-TH-300: the docked thread ----
    {
      id: 'docked',
      label: 'Docked on a record page: Head, files line, feed, box',
      model: DOCKED,
      note: 'Three bands above the first message with the record band in the shell’s row: the Head (who answers next, the counts, View ▾, the width menu, the "⋯" that always holds Activity’s doors — R-ACT), the files line, then the feed. Saved replies ▾ beside @ in the box. Below 720 px the phone head: the record and the pill, the rest in "⋯".',
    },
    { id: 'docked-strip', label: 'Docked: the files strip open', model: { ...DOCKED, docked: { ...DOCKED.docked!, stripOpen: true } }, note: '← / → walk the tiles, Enter opens the one file viewer; "All files" opens the Files view.' },
    { id: 'docked-notes', label: 'Docked: View › Office notes', model: { ...DOCKED, docked: { ...DOCKED.docked!, head: { ...DOCKED.docked!.head, view: 'notes' } } }, note: 'The chip names the view; its × shows everything again.' },
    {
      id: 'docked-closed',
      label: 'Docked: a closed thread',
      model: { ...DOCKED, thread: { ...DOCKED.thread, composer: { ...DOCKED.thread.composer, context: { ...DOCKED.thread.composer.context, closed: { by: 'Bea Esempio', at: '2026-11-12T15:00:00.000Z' } } } }, docked: { ...DOCKED.docked!, head: { ...DOCKED.docked!.head, closed: { by: 'Bea Esempio', at: '2026-11-12T15:00:00.000Z' } } } },
    },
    { id: 'docked-no-files', label: 'Docked: no files (no line)', model: { ...DOCKED, docked: { ...DOCKED.docked!, files: [] } }, note: 'Nothing empty takes a band (T2-F09): the feed starts under the Head.' },
    { id: 'docked-brand-beta', label: 'Docked: Brand Beta’s order (brand wall)', model: dockedThread(BRAND_BETA), note: 'Brand Beta’s order shows nothing of Brand Alpha: its own files only (none here), its own name on Reply.' },
  ],
})
