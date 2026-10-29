import type { ScanIdKind } from '@nexus/factory-domain/numbering/kinds'
import { countsFor, isLow, remainingOf, type Counts } from '../queue/model'
import type { QueueSnapshot } from '../queue/queue'

/**
 * What the floor shell shows of the offline queue on every screen (B-W0-30; PLT-239; design "The floor frame":
 * OfflineBanner — online or offline, the waiting count as a big number, the refused count in red, "Open queue"), and
 * Home's lines about the tablet's label numbers. Pure: the frame view draws it.
 */

export interface ShellQueue {
  /** The person's actions saved here and not yet recorded. */
  readonly pending: number
  /** The person's refused actions. */
  readonly refused: number
  /** The server's last answer (an instant), for "Last sent 10:42". */
  readonly lastSentAt: string | null
  /** A label kind with fewer numbers left than its low-water mark, and how many (Home says it while offline). */
  readonly lowNumbers: readonly { readonly kind: ScanIdKind; readonly left: number }[]
  readonly counts: Counts
}

export function shellQueueOf(snapshot: QueueSnapshot, viewer: { readonly workerId: string | null; readonly numberKinds: readonly ScanIdKind[] }, today: { readonly now: Date; readonly timeZone: string }): ShellQueue {
  const shareAll = snapshot.server?.subject === 'STATION'
  const counts = countsFor(snapshot.items, { workerId: viewer.workerId, shareAll }, today)
  // Refused actions the server keeps that this tablet no longer holds (after a data loss) count too.
  const local = new Set(snapshot.items.map((item) => item.refusal?.id).filter((id): id is string => Boolean(id)))
  const serverOnly = snapshot.server?.refused.filter((row) => !local.has(row.id)).length ?? 0
  return {
    pending: counts.waiting,
    refused: counts.refused + serverOnly,
    lastSentAt: snapshot.lastSentAt,
    lowNumbers: snapshot.numbers.scanTag ? viewer.numberKinds.filter((kind) => isLow(snapshot.numbers, kind)).map((kind) => ({ kind, left: remainingOf(snapshot.numbers, kind) })) : [],
    counts,
  }
}
