import type { CardMessage } from '../../../../lib/record-thread/card/model'
import type { FeedModel } from '../../../../lib/record-thread/feed/view/Feed'
import { fileSeries, recordFiles, type FileSeries, type FilesParty, type ThreadFile } from '../../../../lib/record-thread/files/model'

/**
 * B-TH-280 — the record's thread for paper (the record frame's print view, `?print=1`; threads plan T1-F09): the docked thread's
 * own feed drawn read-only — every message open (no fold by age, no "New since your last visit", no "N new" bar, no link anchor),
 * nothing to answer, correct, task or carry — then the record's documents in force with who sees each. It replaces the old record
 * panels' print form (thread, tasks, files and history panels): the feed already holds the record's steps and field changes, and
 * a measurement sheet the reader may not open prints as "Measurement sheet — you cannot open it", never by its name. Pure: the
 * container (ThreadPrint.tsx) reads, the view (view/ThreadPrintView.tsx) draws.
 */
export interface ThreadPrintModel {
  /** The record's name as its page shows it ("SO-2026-0142 · Brand Alpha"). */
  readonly title: string
  /** The thread's feed, already shaped for paper (`paperFeed`). */
  readonly feed: FeedModel
  /** The record's documents in force, newest first; null: the reader may not read files (files.read) — no Files part. */
  readonly files: readonly FileSeries[] | null
  /** The record's party, for the "Customer" / "Supplier" audience word. */
  readonly party: FilesParty | null
  /** Now, for retention dates (ms). */
  readonly now: number
}

/** The feed for paper: everything open and nothing to act on (the reading actions — older messages, Try again — stay). */
export function paperFeed(feed: FeedModel): FeedModel {
  return {
    ...feed,
    runOpen: true,
    openIds: feed.messages.map((message) => message.id),
    firstNewId: null,
    newSince: 0,
    newCount: 0,
    hiddenNew: 0,
    context: { ...feed.context, canReply: false, canTask: false, canUseOn: false, anchorId: null, canCorrect: { note: false, email: false, portal: false } },
  }
}

/** T1-F09: a paper that carries office notes says so at its head and its foot (a note printed for a customer by mistake). */
export const carriesOfficeNotes = (messages: readonly Pick<CardMessage, 'kind'>[]): boolean => messages.some((message) => message.kind === 'note')

/** The record's own documents in force (a file of another record never prints here; deleted and unfinished uploads are left out). */
export function paperFiles(files: readonly ThreadFile[], record: { readonly type: string; readonly id: string }): FileSeries[] {
  return fileSeries(recordFiles(files, record))
}
