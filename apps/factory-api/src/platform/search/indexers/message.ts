import { excerptOf } from '@nexus/factory-domain/threads/rules'
import { holdsAmount, withoutAmounts } from '@nexus/factory-domain/search/text'
import type { CommandTx } from '../../../core/command'
import { recordLabelOf } from '../../threads/labels'
import { THREAD_GATES } from '../../threads/records'
import { defineIndexer, idWhere, type SearchDocument } from '../indexer'

/**
 * Messages of record threads (B-TH-097; threads plan TH-9, G11 "search inside messages", office only; design thread T1 "Search
 * in the thread", PROJ.thread "Search in the project"): every note, mail and portal message by its words and the names of its
 * files, so the office finds the conversation where something was said. The entry is the thread's: its company, site and party
 * (as GET /threads reads it), seen with threads.read — and ../search.ts reads each hit again against its thread (the record type's
 * gate, the thread's scope now) before showing it, with the record it opens. Never in the portal: no partner view names a
 * message (a portal or link session's search never reaches one, of its own party or another's, nor an office note).
 *
 * Left out (in the read's `where`, never after reading: the rebuild pages on what it reads): the notes about a PERSON or body data
 * (a record type with a thread gate — a colleague, a role, a device, a worker, a team, an outside account, a rider's measurements:
 * whoever reads threads must not find them) and a message without words (an erased one: the privacy erasure removes its entry
 * too). Never an amount (factory-domain withoutAmounts) and never the author's name (a floor worker's least of all: Statuto dei
 * Lavoratori art. 4).
 */

const GATED = Object.keys(THREAD_GATES)
/** One line under the record: the message's opening words. */
const EXCERPT = 140

async function documentsOf(tx: CommandTx, rows: readonly MessageRow[]): Promise<SearchDocument[]> {
  const files = new Map(
    (await tx.storedFile.findMany({ where: { id: { in: [...new Set(rows.flatMap((row) => row.attachmentFileIds))] } }, select: { id: true, originalName: true } })).map((file) => [file.id, file.originalName]),
  )
  const labels = new Map<string, string | null>()
  const documents: SearchDocument[] = []
  for (const row of rows) {
    const key = `${row.thread.recordType}:${row.thread.recordId}`
    if (!labels.has(key)) labels.set(key, await recordLabelOf(tx, row.thread.recordType, row.thread.recordId))
    // One document per message read (the rebuild pages on them): a record gone names its type; a message of amounts only, no words.
    const label = labels.get(key) ?? null
    const words = withoutAmounts(row.bodyText)
    documents.push({
      recordId: row.id,
      companyId: row.thread.companyId,
      siteId: row.thread.siteId,
      partyId: row.thread.partyId,
      number: null,
      title: label === null || holdsAmount(label) ? row.thread.recordType : label,
      subtitle: words === '' ? null : excerptOf(words, EXCERPT),
      status: row.direction,
      words: [words, ...row.attachmentFileIds.map((id) => files.get(id)).filter((name): name is string => typeof name === 'string' && !holdsAmount(name))],
    })
  }
  return documents
}

const MESSAGE_SELECT = {
  id: true,
  direction: true,
  bodyText: true,
  attachmentFileIds: true,
  thread: { select: { recordType: true, recordId: true, companyId: true, siteId: true, partyId: true } },
} as const
interface MessageRow {
  readonly id: string
  readonly direction: string
  readonly bodyText: string
  readonly attachmentFileIds: string[]
  readonly thread: { readonly recordType: string; readonly recordId: string; readonly companyId: string | null; readonly siteId: string | null; readonly partyId: string | null }
}

export default defineIndexer({
  recordType: 'Message',
  area: 'home',
  viewPermission: 'threads.read',
  on: {
    // A message is written once (append-only); its thread's event names it.
    'thread.message_posted': (event) => {
      const messageId = (event.payload as { messageId?: unknown } | null)?.messageId
      return typeof messageId === 'string' ? [messageId] : []
    },
  },
  async read(tx, filter, take) {
    const rows = (await tx.message.findMany({
      where: { ...idWhere(filter), bodyText: { not: '' }, thread: { recordType: { notIn: GATED } } },
      orderBy: { id: 'asc' },
      take,
      select: MESSAGE_SELECT,
    })) as MessageRow[]
    return documentsOf(tx, rows)
  },
})
