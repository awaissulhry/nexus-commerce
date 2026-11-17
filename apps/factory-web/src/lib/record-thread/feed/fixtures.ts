import { defineDesignScreen } from '../../design/design-screen'
import { BRAND_ALPHA, BRAND_BETA } from '../../testing/two-brands'
import type { CardContext } from '../card/model'
import { DEMO_NOW, demoThread } from '../demo-data'
import type { FeedEvent } from './model'
import { FeedCase } from './view/FeedCase'
import type { FeedModel } from './view/Feed'

/**
 * SCR-006-feed — the record thread's feed (B-TH-204, T4; picture 1, approved 2026-11-17). Made-up data (the brand-wall helpers'
 * brands, the design kit's people). Each case is a state of the picture: the conversation (oldest at the top, the oldest run
 * folded, two folded lines, the last three open, a record step and grouped changes, day lines), the fold opened, one message,
 * a link to one message, the "2 new messages" bar, B-TH-229's "New since your last visit" (read messages folded, 200+), empty,
 * loading, could not load, earlier page failed, offline, no permission, and Brand Beta's copy (the brand wall).
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
// A folded erased message and a folded message of files only (their one lines say so; never an empty line).
const foldedDepth: FeedModel = {
  ...base,
  messages: thread.map((message, index) => (index === 3 ? { ...message, author: null, body: '', files: [], erased: true } : index === thread.length - 6 ? { ...message, body: '', files: [{ id: 'fd-1', name: 'collar.jpg', sizeBytes: 640_000, contentType: 'image/jpeg', status: 'AVAILABLE' as const }, { id: 'fd-2', name: 'sizes.pdf', sizeBytes: 90_000, contentType: 'application/pdf', status: 'AVAILABLE' as const }] } : message)),
  runOpen: true,
}
// ---- end B-TH-255

export const designScreen = defineDesignScreen<FeedModel>({
  screen: 'SCR-006-feed',
  title: 'Record thread · the feed (T4)',
  view: FeedCase,
  cases: [
    { id: 'conversation', label: 'The conversation', model: base, note: 'Oldest at the top, opened at the newest: “12 earlier messages” (2 – 10 Nov), two folded lines, the last three open; the order made, 5 changes by Bea Esempio (Show), the status step; Today / Yesterday / weekday lines in the company’s time zone. Click a message, then J / K.' },
    { id: 'fold-open', label: 'Earlier messages opened', model: { ...base, runOpen: true }, note: '“12 earlier messages” opened: each one line (sender, first words, time); Enter opens one in place.' },
    { id: 'one-message', label: 'One message', model: { ...base, messages: thread.slice(-1), events: [], more: false }, note: 'One message: nothing folds.' },
    { id: 'anchor', label: 'A link to one message', model: { ...base, context: { ...base.context, anchorId: thread[4].id } }, note: '?message=<id>: that message opens unfolded and in focus, in the middle of the thread.' },
    { id: 'new-messages', label: '2 new messages', model: { ...base, newCount: 2 }, note: 'You scrolled up while two messages arrived live: nothing jumped; the bar takes you down.' },
    // ---- B-TH-229: the reader's own reading (B-TH-027)
    { id: 'unread', label: 'New since your last visit', model: { ...base, firstNewId: thread[thread.length - 2].id, newSince: 2 }, note: 'Two messages are new to you: the read ones fold, the one they answer stays open, “New since your last visit · 2 messages” sits above the first new one and the thread opens there. A second on screen marks them read (your own mark only; nobody sees who read what).' },
    { id: 'unread-many', label: 'Over 200 new', model: { ...base, firstNewId: 'older-than-this-page', newSince: 240 }, note: 'More new messages than the page holds: the line sits above the first one shown, says “200+”, and nothing folds.' },
    { id: 'unread-bar', label: 'New since your last visit + the bar', model: { ...base, firstNewId: thread[thread.length - 8].id, newSince: 8, newCount: 8 }, note: 'Eight new: the thread opens at the line, the rest wait below behind “8 new messages”.' },
    // ---- end B-TH-229
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
    { id: 'hidden-new', label: 'View on: 1 new message hidden', model: sharedOnly, note: 'The Head’s View is on “With the customer” and an office note arrived: “1 new message hidden by this view · Show all” at the end, so a forgotten view never hides news.' },
    { id: 'folded-depth', label: 'Folded: an erased message and one of files only', model: foldedDepth, note: 'Their one lines say “Message removed (privacy request)” and “2 files” — never an empty line.' },
    // ---- end B-TH-255
    { id: 'brand-beta', label: 'Brand Beta’s copy (brand wall)', model: { ...base, messages: demoThread(BRAND_BETA), events: [], context: context(BRAND_BETA.tradeName) }, note: 'The same feed on Brand Beta’s order: nothing of Brand Alpha (B-TH-203 scan).' },
  ],
})
