import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { CardContext } from '../../../../lib/record-thread/card/model'
import { DEMO_NOW, demoThread } from '../../../../lib/record-thread/demo-data'
import type { FeedModel } from '../../../../lib/record-thread/feed/view/Feed'
import { DEMO_FILES, DEMO_FILES_PARTY } from '../../../../lib/record-thread/files/fixtures'
import type { ThreadFile } from '../../../../lib/record-thread/files/model'
import { BRAND_ALPHA } from '../../../../lib/testing/two-brands'
import { DEMO_COMPANIES, DEMO_SITES, DEMO_USER } from '../../../../shell/design-data'
import { PrintFrameView, type PrintFrameModel } from '../../../../shell/print/view/PrintFrameView'
import { paperFeed, paperFiles, type ThreadPrintModel } from './model'
import { ThreadPrintView } from './view/ThreadPrintView'

/**
 * SCR-006-print — "Print view of the record" (B-W2b-05, PLT-171; B-TH-280): any record's print view, a new tab opened from the
 * thread Head's "Print or save as PDF". The paper's head (company, site, place, who printed it and when), the record page's band
 * and body (drawn by each page), then the thread for paper: the docked thread's own feed with every message open and nothing to
 * act on, "Contains office notes" at the head and the foot when a note prints (T1-F09), and the record's documents in force with
 * who sees each — a measurement sheet the reader may not open prints by its lock words, never by its name. Made-up data only
 * (Brand Alpha, SO-2026-0142).
 */

interface ThreadPrintCase {
  frame: PrintFrameModel
  paper: ThreadPrintModel
}

const frame: PrintFrameModel = {
  kind: 'record',
  company: { name: DEMO_COMPANIES[0].name, code: DEMO_COMPANIES[0].code },
  site: { kind: 'site', name: DEMO_SITES[0].name },
  place: 'Sales › Orders',
  printedBy: DEMO_USER.displayName,
  printedAt: new Date(Date.UTC(2026, 10, 17, 9, 42)).toISOString(),
  backHref: '/w/DEMO/sales/orders/0190f0e2-7f00-7000-8000-000000000001',
}

const context: CardContext = { partyName: BRAND_ALPHA.tradeName, canReadFiles: true, canReply: true, canTask: true, canUseOn: true, canCorrect: { note: true, email: true, portal: true } }
const thread = demoThread(BRAND_ALPHA)
const feed: FeedModel = { state: 'ready', messages: thread, events: [], context, more: false, older: 'idle', now: DEMO_NOW }
const record = { type: DEMO_FILES[0]!.recordType, id: DEMO_FILES[0]!.recordId }
const now = Date.parse(DEMO_NOW)
const title = `${BRAND_ALPHA.numbers.order} · ${BRAND_ALPHA.tradeName}`

/** A measurement sheet this reader may not open (B-TH-083): no name reaches the paper. */
const LOCKED_SHEET: ThreadFile = { ...DEMO_FILES[1]!, id: '0190f0e2-7f00-7000-8000-000000000099', name: 'Rider measurements.pdf', locked: 'MEASUREMENTS', visibility: ['OFFICE'], partyId: null, createdAt: '2026-11-15T09:00:00.000Z' }

const paper = (over: Partial<ThreadPrintModel> = {}, feedOver: Partial<FeedModel> = {}): ThreadPrintModel => ({
  title,
  feed: paperFeed({ ...feed, ...feedOver }),
  files: paperFiles(DEMO_FILES, record),
  party: DEMO_FILES_PARTY,
  now,
  ...over,
})

function ThreadPrintDesign({ model }: { model: ThreadPrintCase }) {
  return createElement(PrintFrameView, { model: model.frame }, createElement(ThreadPrintView, { model: model.paper }))
}

export const designScreen = defineDesignScreen<ThreadPrintCase>({
  screen: 'SCR-006-print',
  title: 'Print view of the record: the thread for paper',
  view: ThreadPrintDesign,
  cases: [
    {
      id: 'normal',
      label: 'A conversation with office notes, and the record’s files',
      model: { frame, paper: paper() },
      note: 'The docked thread’s cards, every message open; "Contains office notes" at the head and the foot; no button prints.',
    },
    {
      id: 'shared-only',
      label: 'Only messages with the customer: no office-notes line',
      model: { frame, paper: paper({}, { messages: thread.filter((message) => message.kind === 'theirs' || message.kind === 'ours') }) },
    },
    {
      id: 'locked-sheet',
      label: 'A measurement sheet the reader may not open',
      model: { frame, paper: paper({ files: paperFiles([...DEMO_FILES, LOCKED_SHEET], record) }) },
      note: 'Named "Measurement sheet — you cannot open it" with why; its own name never prints.',
    },
    {
      id: 'no-files-right',
      label: 'A reader without the files right: no Files part',
      model: { frame, paper: paper({ files: null }) },
    },
    {
      id: 'empty',
      label: 'A new record: nothing yet',
      model: { frame: { ...frame, site: null }, paper: paper({ files: [] }, { messages: [], events: [] }) },
    },
    {
      id: 'loading',
      label: 'Still reading',
      model: { frame, paper: paper({ files: [] }, { state: 'loading', messages: [] }) },
      note: 'Print once the conversation is read: the feed says it is still reading.',
    },
    {
      id: 'error',
      label: 'The thread could not be read',
      model: { frame, paper: paper({}, { state: 'error', messages: [] }) },
    },
  ],
})
