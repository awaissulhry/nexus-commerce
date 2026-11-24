import { defineDesignScreen } from '../../design/design-screen'
import { BRAND_ALPHA, BRAND_BETA } from '../../testing/two-brands'
import type { CardContext, CardMessage } from '../card/model'
import { DEMO_NOW, demoThread, OFFICE_PEOPLE } from '../demo-data'
import type { FeedEvent, FeedPin } from './model'
import { FeedCase } from './view/FeedCase'
import type { FeedModel } from './view/Feed'

/**
 * SCR-006-feed — the record thread's feed (B-TH-204, T4; picture 1, approved 2026-11-17; tw- W1.3 THE THREAD REBUILD, the bubble
 * picture 20-preview-thread.html). Made-up data (the brand-wall helpers' brands, the design kit's people). Each case is a state of the
 * picture: the thread (oldest at the top, every message whole — no fold —, a record step and grouped changes as pills, day pills),
 * runs of one sender (the tile and the name once, mine on the right, two hidden floor writers never a run, a pin pill), a jump's
 * flash, one message, a link to one message, the down button with what arrived, "3 unread messages" (200+), the older page being
 * read, empty, loading, could not load, earlier page failed, offline, no permission, and Brand Beta's copy (the brand wall).
 */

const context = (partyName: string, more: Partial<CardContext> = {}): CardContext => ({ partyName, canReadFiles: true, canReply: true, canTask: true, ...more })

const EVENTS: FeedEvent[] = [
  { id: 'e-made', at: '2026-11-02T10:20:00.000Z', who: 'Alex Demo', actorAudience: 'OFFICE', verb: 'create', status: null, values: [], fields: [] },
  ...[
    ['customerRef', '—', BRAND_ALPHA.customerRef],
    ['requestedDate', '2026-11-28', '2026-12-01'],
    ['line 2 · pieces', '110', '120'],
    ['line 2 · size 56', '20', '30'],
    ['deliveryAddress', 'Warehouse 1', 'Warehouse 2'],
  ].map(([field, before, after], index): FeedEvent => ({
    id: `e-change-${index}`,
    at: `2026-11-12T15:${String(40 + index).padStart(2, '0')}:00.000Z`,
    who: 'Bea Esempio',
    actorAudience: 'OFFICE',
    verb: 'update',
    status: null,
    values: [{ field, before, after }],
    fields: [field],
  })),
  { id: 'e-status', at: '2026-11-16T08:00:00.000Z', who: 'Carlo Prova', actorAudience: 'OFFICE', verb: 'setStatus', status: { from: 'CONFIRMED', to: 'IN_PRODUCTION' }, values: [], fields: ['status'] },
]

const thread = demoThread(BRAND_ALPHA)
const base: FeedModel = { state: 'ready', messages: thread, events: EVENTS, context: context(BRAND_ALPHA.tradeName), more: true, older: 'idle', now: DEMO_NOW }

// ---- B-TH-255 (B-TH-079): the quiet lines at the end of the feed — made-up counts and reasons; never a sender (the API sends none).
const REVIEW = '/w/demo/home/mail-to-sort'
const waitingReview: FeedModel = { ...base, waitingMail: { count: 1, reasons: ['UNKNOWN_SENDER'], mayReview: true, reviewHref: REVIEW } }
const waitingTwo: FeedModel = { ...base, waitingMail: { count: 2, reasons: ['UNKNOWN_SENDER', 'THREAD_CLOSED', 'UNKNOWN_SENDER'], mayReview: true, reviewHref: REVIEW } }
const waitingColleague: FeedModel = { ...base, waitingMail: { count: 1, reasons: ['UNKNOWN_SENDER'], mayReview: false, reviewHref: null } }
// The With-the-customer view (the notes taken out, as the Head's View does) while an office note arrived: "1 new message hidden…".
const sharedOnly: FeedModel = { ...base, messages: thread.filter((message) => message.kind === 'theirs' || message.kind === 'ours'), events: [], hiddenNew: 1 }
// An erased message and a message of files only, drawn whole in the feed (no fold since tw- W1.3): the erased one says why.
const erasedAndFiles: FeedModel = {
  ...base,
  messages: thread.map((message, index) => (index === 3 ? { ...message, author: null, body: '', files: [], erased: true } : index === thread.length - 6 ? { ...message, body: '', files: [{ id: 'fd-1', name: 'collar.jpg', sizeBytes: 640_000, contentType: 'image/jpeg', status: 'AVAILABLE' as const }, { id: 'fd-2', name: 'sizes.pdf', sizeBytes: 90_000, contentType: 'application/pdf', status: 'AVAILABLE' as const }] } : message)),
}
// ---- end B-TH-255

// ---- tw- W1.3 (10-design §3, §5, §7): runs of one sender, the quote, mine on the right, hidden floor writers, a pin pill — made-up.
const romeAt = (day: number, hhmm: string) => {
  const [hours, minutes] = hhmm.split(':').map(Number)
  return new Date(Date.UTC(2026, 10, day, hours - 1, minutes)).toISOString()
}
const [ALEX, BEA, CARLO] = OFFICE_PEOPLE
const contact = BRAND_ALPHA.contact.name
const lia = BRAND_ALPHA.portalPerson.name
const note = (id: string, who: { id: string; name: string }, at: string, body: string, more: Partial<CardMessage> = {}): CardMessage => ({ id, kind: 'note', channel: 'APP', author: who.name, authorKind: 'USER', senderKey: `USER:${who.id}`, at, body, mentions: [], files: [], ...more })
const RUNS: CardMessage[] = [
  { id: 'run-1', kind: 'theirs', channel: 'EMAIL', author: contact, authorKind: 'PARTY', senderKey: `PARTY~${contact}`, at: romeAt(12, '09:20'), body: `Good morning! Attached is the final size split for ${BRAND_ALPHA.numbers.order}. Can you confirm the delivery week?`, mentions: [], files: [{ id: 'run-f1', name: 'Size split v3.pdf', sizeBytes: 86_000, contentType: 'application/pdf', status: 'AVAILABLE' }] },
  note('run-2', BEA, romeAt(12, '09:31'), '@Carlo Prova can the floor make week 50 with this split?', { mentions: ['Carlo Prova'] }),
  note('run-3', CARLO, romeAt(12, '09:40'), 'Cutting can start on Monday.'),
  note('run-4', CARLO, romeAt(12, '09:41'), 'Week 50 works if the fabric lands by Friday.'),
  note('run-5', CARLO, romeAt(12, '09:41'), 'I will check with the supplier today.'),
  {
    id: 'run-6',
    kind: 'ours',
    channel: 'EMAIL',
    author: ALEX.name,
    authorKind: 'USER',
    senderKey: `USER:${ALEX.id}`,
    mine: true,
    at: romeAt(12, '09:55'),
    body: 'Confirmed: delivery in week 50. We start cutting on Monday.',
    mentions: [],
    files: [],
    email: { to: [BRAND_ALPHA.contact.email], subject: `Re: Size split ${BRAND_ALPHA.numbers.order}`, status: 'DELIVERED' },
    replyTo: { id: 'run-1', author: contact, excerpt: `Good morning! Attached is the final size split for ${BRAND_ALPHA.numbers.order}.`, at: romeAt(12, '09:20'), authorKind: 'PARTY', senderKey: `PARTY~${contact}`, audience: 'PARTNER', fileCount: 1, firstFile: { id: 'run-f1', kind: 'DOCUMENT', contentType: 'application/pdf' } },
  },
  { id: 'run-7', kind: 'theirs', channel: 'PORTAL', author: lia, authorKind: 'PARTY', senderKey: `PARTY~${lia}`, at: romeAt(16, '14:02'), body: 'Perfect, thank you.', mentions: [], files: [] },
  { id: 'run-8', kind: 'theirs', channel: 'PORTAL', author: lia, authorKind: 'PARTY', senderKey: `PARTY~${lia}`, at: romeAt(16, '14:03'), body: 'One more thing: can the logo on the sleeve be 2 mm smaller?', mentions: [], files: [] },
  { id: 'run-9', kind: 'floor', channel: 'APP', author: null, authorKind: 'WORKER', authorHidden: true, at: romeAt(17, '08:30'), body: 'Collar lining cut in grey mesh.', forFloor: true, mentions: [], files: [] },
  { id: 'run-10', kind: 'floor', channel: 'APP', author: null, authorKind: 'WORKER', authorHidden: true, at: romeAt(17, '08:32'), body: 'Sleeve pattern checked on the M.', forFloor: true, mentions: [], files: [] },
  note('run-11', ALEX, romeAt(17, '09:10'), 'Good. Carlo, please check the sleeve again before cutting.', { mine: true, pinned: true, replyTo: { id: 'run-10', author: null, excerpt: 'Sleeve pattern checked on the M.', at: romeAt(17, '08:32'), authorKind: 'WORKER', audience: 'OFFICE' } }),
]
const RUN_PINS: FeedPin[] = [{ messageId: 'run-11', at: romeAt(17, '09:11'), by: ALEX.name }]
const runs: FeedModel = { ...base, messages: RUNS, events: [], more: false, pins: RUN_PINS }
// ---- end tw- W1.3

export const designScreen = defineDesignScreen<FeedModel>({
  screen: 'SCR-006-feed',
  title: 'Record thread · the feed (T4)',
  view: FeedCase,
  cases: [
    { id: 'conversation', label: 'The conversation', model: base, note: 'Oldest at the top, opened at the newest, every message whole (no fold): scroll up and the next older page is read. The order made, 5 changes by Bea Esempio (Show), the status step — centred pills; Today / Yesterday / weekday pills in the company’s time zone. Click a message, then J / K, R.' },
    // ---- tw- W1.3
    { id: 'runs', label: 'Runs, quotes, mine, hidden floor writers, a pin', model: runs, note: 'Carlo’s three notes are ONE run (one tile, one name, the tail on the first, 2 px apart); Bea’s note and her colleague’s email are other runs; Alex (mine) on the right with no tile and no name, his email quoting Lia’s PDF; Lia’s two portal messages one run; two notes of a person on the floor kept back are two runs with the “?” tile; “Alex Demo pinned a message”.' },
    { id: 'flash', label: 'A jump lights the row', model: { ...runs, flash: { id: 'run-1', seq: 1 } }, note: 'Click a quote: the thread goes to the message it quotes and its whole row lights up for about 1.5 s, then fades (a still tint with reduced motion).' },
    // ---- end tw- W1.3
    { id: 'one-message', label: 'One message', model: { ...base, messages: thread.slice(-1), events: [], more: false }, note: 'One message, its own run.' },
    { id: 'anchor', label: 'A link to one message', model: { ...base, context: { ...base.context, anchorId: thread[4].id } }, note: '?message=<id>: that message opens in focus, in the middle of the thread, and its row lights up.' },
    { id: 'new-messages', label: '2 new messages', model: { ...base, newCount: 2 }, note: 'You scrolled up while two messages arrived live: nothing jumped; the round down button counts them and takes you down.' },
    // ---- B-TH-229: the reader's own reading (B-TH-027)
    { id: 'unread', label: '2 unread messages', model: { ...base, firstNewId: thread[thread.length - 2].id, newSince: 2 }, note: 'Two messages are new to you: “2 unread messages” sits above the first new one and the thread opens there. A second on screen marks them read (your own mark only; nobody sees who read what).' },
    { id: 'unread-many', label: 'Over 200 unread', model: { ...base, firstNewId: 'older-than-this-page', newSince: 240 }, note: 'More new messages than the page holds: the band sits above the first one shown and says “200+”.' },
    { id: 'unread-bar', label: '8 unread + the down button', model: { ...base, firstNewId: thread[thread.length - 8].id, newSince: 8, newCount: 8 }, note: 'Eight new: the thread opens at the band, the down button counts what waits below.' },
    // ---- end B-TH-229
    { id: 'older-loading', label: 'Reading earlier messages', model: { ...base, older: 'loading' }, note: 'Scrolled to the top: one pill while the next page is read; no “scroll up” words otherwise.' },
    { id: 'empty', label: 'Empty', model: { ...base, messages: [], events: [], more: false } },
    { id: 'loading', label: 'Loading', model: { ...base, state: 'loading' } },
    { id: 'error', label: 'Could not load', model: { ...base, state: 'error' } },
    { id: 'older-failed', label: 'Earlier page failed', model: { ...base, older: 'failed' } },
    { id: 'offline', label: 'Offline', model: { ...base, offline: { since: '2026-11-17T09:44:00.000Z' } } },
    { id: 'forbidden', label: 'No permission', model: { ...base, state: 'forbidden' } },
    // ---- B-TH-255
    { id: 'waiting-review', label: 'Mail waiting in Mail to sort (email.triage)', model: waitingReview, note: '“1 mail for this conversation waits in Mail to sort — sender not a contact · Review”: for a reader who may sort mail (email.triage); Review opens Home › Mail to sort. Never the sender’s address.' },
    { id: 'waiting-two', label: 'Two mails waiting, two reasons', model: waitingTwo, note: 'Each reason once, in words; the count in the plural.' },
    { id: 'waiting-colleague', label: 'Mail waiting — a reader without email.triage', model: waitingColleague, note: '“A reply waits for a colleague to check it”: no sender, no reason, no link (W07, W08, W22).' },
    { id: 'hidden-new', label: 'View on: 1 new message hidden', model: sharedOnly, note: 'The Head’s View is on “With the customer” and an office note arrived: the pill “1 new message hidden by this view · Show all” at the end, so a forgotten view never hides news.' },
    { id: 'erased-files', label: 'An erased message and one of files only', model: erasedAndFiles, note: '“Message removed after a privacy request” in place of the words; the message of files only shows its tiles and its file row — never an empty bubble that looks erased.' },
    // ---- end B-TH-255
    { id: 'brand-beta', label: 'Brand Beta’s copy (brand wall)', model: { ...base, messages: demoThread(BRAND_BETA), events: [], context: context(BRAND_BETA.tradeName) }, note: 'The same feed on Brand Beta’s order: nothing of Brand Alpha (B-TH-203 scan).' },
  ],
})
