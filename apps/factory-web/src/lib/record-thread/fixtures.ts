import { defineDesignScreen } from '../design/design-screen'
import { BRAND_ALPHA, BRAND_BETA, type BrandFixture } from '../testing/two-brands'
import type { RecordFile } from './attachments/model'
import type { CardContext } from './card/model'
import { DEMO_NOW, demoThread, OFFICE_PEOPLE } from './demo-data'
import type { RecordThreadModel } from './RecordThread'
import { ThreadCase, type ThreadCaseModel } from './ThreadCase'

/**
 * SCR-006-thread — RecordThread v1 (B-TH-212; pictures 1–5 in one column): the feed, the cards and the box for Incoming's reading
 * pane and the request's full page. Made-up data (the brand-wall helpers' brands, the design kit's people). Cases: the full page,
 * the reading pane (SplitPane, 35 : 65), a reply with To / Cc, the send check, a link to one message, loading, no permission, a
 * closed thread, and Brand Beta's copy (the brand wall). Light / dark and 375 / 1440 / 1920 from the frame.
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
const reply = (thread: RecordThreadModel): RecordThreadModel => ({ ...thread, composer: { ...thread.composer, draft: { mode: 'reply', body: 'Hello Alma,\nthe quote follows tomorrow morning.\nAlex', forFloor: false } } })

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
  ],
})
