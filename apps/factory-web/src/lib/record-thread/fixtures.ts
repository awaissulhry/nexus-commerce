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
import type { FeedEvent } from './feed/model' // tw- T.1
import type { CardMessage } from './card/model' // tw- T.1

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
  // The made-up party's own words everywhere — its name and code, its contacts, its file, its numbers: nothing of Brand Alpha's
  // (brandMarkers) reaches another party's thread; a record without a party is named by its own number.
  const name = input.party?.name ?? input.record
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'demo'
  const brand: BrandFixture = {
    ...BRAND_ALPHA,
    legalName: name,
    tradeName: name,
    code: slug.toUpperCase(),
    contact: { name: 'Giulia Esempio', email: `ordini@${slug}.example.com` },
    portalPerson: { name: 'Marta Esempio', email: `marta@${slug}.example.com` },
    address: { ...BRAND_ALPHA.address, line1: 'Via Esempio 1' },
    fileName: `${name} tech pack.pdf`,
    customerRef: `PO-${slug.toUpperCase()}`,
    message: 'Please confirm the delivery date.',
    numbers: { order: input.record, quote: input.record, request: input.record, invoice: input.record, style: input.record },
  }
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

// ---- tw- T.1 (THE THREAD REBUILD; 20-preview-thread.html; B13): the picture's cases, made-up data only (Brand Alpha, Bea Esempio,
// example.com) — docked at a third (433 / 593) beside the 40 % ones, every role and every state; nothing opened on the server render.
const THIRD = (model: ThreadCaseModel): ThreadCaseModel => ({ ...model, docked: { ...model.docked!, head: { ...model.docked!.head, width: 'third' } } })
const withMessages = (model: ThreadCaseModel, messages: (all: readonly CardMessage[]) => readonly CardMessage[], events: readonly FeedEvent[] = []): ThreadCaseModel => ({
  ...model,
  thread: { ...model.thread, feed: { ...model.thread.feed, messages: messages(model.thread.feed.messages), events } },
})
const withFeed = (model: ThreadCaseModel, feed: Partial<RecordThreadModel['feed']>): ThreadCaseModel => ({ ...model, thread: { ...model.thread, feed: { ...model.thread.feed, ...feed } } })
const withContext = (model: ThreadCaseModel, context: Partial<CardContext>, can?: Partial<RecordThreadModel['composer']['context']['can']>): ThreadCaseModel => ({
  ...model,
  thread: {
    ...model.thread,
    feed: { ...model.thread.feed, context: { ...model.thread.feed.context, ...context } },
    composer: can ? { ...model.thread.composer, context: { ...model.thread.composer.context, can: { ...model.thread.composer.context.can, ...can } } } : model.thread.composer,
  },
})
const ALL_WAYS = { note: true, email: true, portal: true }
const step = (id: string, minutes: number, status: { from: string | null; to: string | null } | null, verb = 'setStatus'): FeedEvent => ({
  id,
  at: new Date(Date.parse(DEMO_NOW) - minutes * 60_000).toISOString(),
  who: 'Bea Esempio',
  actorAudience: 'OFFICE',
  verb,
  action: `sales.orders.${verb}`,
  status,
  values: [],
  fields: [],
})
const TW_PINS = (all: readonly CardMessage[]) =>
  all.slice(0, 3).map((message, index) => ({ messageId: message.id, pinnedAt: new Date(Date.parse(DEMO_NOW) - index * 3_600_000).toISOString(), author: message.authorHidden ? null : message.author, hidden: message.authorHidden === true, excerpt: message.body.slice(0, 80), office: message.kind === 'note' || message.kind === 'floor', files: message.files.length, removed: false }))
const BUSY = THIRD(withContext(DOCKED, { replyWays: ALL_WAYS, canPin: true, canRemind: true, canTask: true }))
const TW_CASES = [
  { id: 'tw-busy-third', label: 'tw- Busy order thread at a third (433 / 593): four senders, runs, mine on the right', model: BUSY, note: 'The thread’s bubbles in runs (one tile and one name per run, in the sender’s colour); the head ONE row; the composer ONE row.' },
  { id: 'tw-busy-forty', label: 'tw- The same at 40 %', model: withContext(DOCKED, { replyWays: ALL_WAYS, canPin: true, canRemind: true }) },
  { id: 'tw-note-beside-shared', label: 'tw- An office note beside a shared message', model: THIRD(withMessages(DOCKED, (all) => all.filter((message) => message.kind === 'note' || message.kind === 'theirs').slice(-4))), note: 'The office note is the one yellow, with the lock and “Office only” in its foot (R17); the customer’s message plain.' },
  {
    id: 'tw-mail-bounce',
    label: 'tw- A mail in and out, with a bounce',
    model: THIRD(
      withMessages(DOCKED, (all) =>
        all.map((message) =>
          message.kind === 'theirs' && message.channel === 'EMAIL'
            ? { ...message, mail: { from: { address: 'buyer@brand-alpha.example', name: message.author }, to: ['orders@example.com'], cc: [], subject: 'Sizes', verdicts: { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' } } }
            : message.kind === 'ours' && message.email
              ? { ...message, email: { ...message.email, status: 'BOUNCED' as const } }
              : message,
        ),
      ),
    ),
    note: 'Our email bounced: the red line and Open task; the ticks are grey, never “read”. Email details is a row of each email’s menu.',
  },
  {
    id: 'tw-quote-far',
    label: 'tw- A reply quoting a message far up',
    model: THIRD(withMessages(DOCKED, (all) => [...all, { ...all[all.length - 1]!, id: 'tw-quote', body: 'Yes — as in your first message.', replyTo: { id: all[0]!.id, author: all[0]!.author, excerpt: all[0]!.body.slice(0, 90), at: all[0]!.at, ...(all[0]!.senderKey ? { senderKey: all[0]!.senderKey } : {}) } }])),
    note: 'The quote at the bubble’s top; Enter or a click jumps up to it and lights its row for 1.5 s.',
  },
  { id: 'tw-pins', label: 'tw- Three pinned messages: the pinned bar', model: THIRD({ ...DOCKED, thread: { ...DOCKED.thread, pinned: TW_PINS(DOCKED.thread.feed.messages) } }), note: 'Under the head: marks · pin · “Sender: text”; a click goes to it and shows the next.' },
  {
    id: 'tw-hidden-floor',
    label: 'tw- Hidden floor writers',
    model: THIRD(
      withMessages(DOCKED, (all) => [
        ...all,
        ...[1, 2].map((n): CardMessage => ({ id: `tw-floor-${n}`, kind: 'floor', channel: 'APP', author: null, authorKind: 'WORKER', authorHidden: true, at: new Date(Date.parse(DEMO_NOW) + n * 60_000).toISOString(), body: n === 1 ? 'Collar cut, 24 pieces.' : 'Sleeves next.', mentions: [], files: [] })),
      ]),
    ),
    note: '“A person on the floor”, the neutral tile “?”, never a person colour and never a run (R5): two hidden notes are two runs.',
  },
  {
    id: 'tw-pills',
    label: 'tw- Steps, changes and an approval as pills',
    model: THIRD(withMessages(DOCKED, (all) => all, [step('tw-s1', 300, { from: 'CONFIRMED', to: 'IN_PRODUCTION' }), step('tw-s2', 200, { from: 'IN_PRODUCTION', to: 'SOME_CODE_WITHOUT_WORDS' }), step('tw-s3', 100, null, 'update')])),
    note: 'Centred pills, one line each; a status in the record type’s words, never a code (a code without words: the step’s label alone).',
  },
  { id: 'tw-empty', label: 'tw- An empty thread', model: THIRD(withMessages(DOCKED, () => [])) },
  // ---- roles
  { id: 'tw-role-owner', label: 'tw- Role: Owner (every way, Close thread…)', model: THIRD(withContext(DOCKED, { replyWays: ALL_WAYS, canPin: true, canRemind: true, canTask: true, canUseOn: true }, { manage: true })) },
  { id: 'tw-role-sales', label: 'tw- Role: Sales', model: THIRD(withContext(DOCKED, { replyWays: ALL_WAYS, canPin: true, canRemind: true })) },
  { id: 'tw-role-production', label: 'tw- Role: Production manager (the portal way only)', model: THIRD(withContext(DOCKED, { replyWays: { note: true, email: false, portal: true }, canPin: true, canRemind: true }, { email: false })) },
  { id: 'tw-role-read-only', label: 'tw- Role: Read-only', model: THIRD(withContext(DOCKED, { replyWays: { note: false, email: false, portal: false }, canReply: false, canRemind: true }, { post: false, email: false })), note: 'The composer is one line: “You can read this thread; writing in it needs another role.”' },
  // ---- states
  { id: 'tw-state-loading', label: 'tw- State: reading (skeleton bubbles)', model: THIRD(withFeed(DOCKED, { state: 'loading' })) },
  { id: 'tw-state-error', label: 'tw- State: could not be read', model: THIRD(withFeed(DOCKED, { state: 'error' })) },
  { id: 'tw-state-forbidden', label: 'tw- State: no right to read', model: THIRD(withFeed(DOCKED, { state: 'forbidden' })) },
  { id: 'tw-state-step-up', label: 'tw- State: confirm it’s you (the second step)', model: THIRD(withFeed(DOCKED, { state: 'forbidden', forbiddenWhy: 'stepUp' })) },
  { id: 'tw-state-offline', label: 'tw- State: offline', model: THIRD(withFeed(DOCKED, { offline: { since: DEMO_NOW } })) },
  { id: 'tw-state-closed', label: 'tw- State: closed', model: THIRD({ ...DOCKED, thread: { ...DOCKED.thread, composer: { ...DOCKED.thread.composer, context: { ...DOCKED.thread.composer.context, closed: { by: 'Bea Esempio', at: DEMO_NOW } } } } }) },
]
// ---- end tw- T.1
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
      label: 'Docked on a record page: Head, feed, box',
      model: DOCKED,
      note: 'tw- W2.1: ONE head row of two lines — the title and who answers next · the owner — with Files (its count) · Search · ⓘ (the keys) · ⋮ (every other tool, Activity’s doors always there — R-ACT; Show, Width and the counts inside), then the feed. Saved replies ▾ beside @ in the box.',
    },
    { id: 'docked-notes', label: 'Docked: View › Office notes', model: { ...DOCKED, docked: { ...DOCKED.docked!, head: { ...DOCKED.docked!.head, view: 'notes' } } }, note: 'The chip names the view; its × shows everything again.' },
    {
      id: 'docked-closed',
      label: 'Docked: a closed thread',
      model: { ...DOCKED, thread: { ...DOCKED.thread, composer: { ...DOCKED.thread.composer, context: { ...DOCKED.thread.composer.context, closed: { by: 'Bea Esempio', at: '2026-11-12T15:00:00.000Z' } } } }, docked: { ...DOCKED.docked!, head: { ...DOCKED.docked!.head, closed: { by: 'Bea Esempio', at: '2026-11-12T15:00:00.000Z' } } } },
    },
    { id: 'docked-no-files', label: 'Docked: no files', model: { ...DOCKED, docked: { ...DOCKED.docked!, files: [] } }, note: 'The Files icon without a number; the feed starts under the Head.' },
    { id: 'docked-brand-beta', label: 'Docked: Brand Beta’s order (brand wall)', model: dockedThread(BRAND_BETA), note: 'Brand Beta’s order shows nothing of Brand Alpha: its own files only (none here), its own name on Reply.' },
    ...TW_CASES,
  ],
})
