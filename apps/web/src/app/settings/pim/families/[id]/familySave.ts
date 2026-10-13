/**
 * Settings › PIM › Families › a family — the page's save line.
 *
 * A drag used to send one PATCH per attribute link at once, with no transaction, and re-read when they answered: two
 * quick drags mixed their orders, and the first drag's re-read could put the old order back on screen under the second.
 *
 * Now (the Matrix's #592 pattern, `@/lib/sync/save-line`): a drag is ONE request (PUT /api/families/:id/attribute-order,
 * one transaction on the server), the page's writes go one at a time, and its reads are ticketed and kept off the
 * screen while a write is waiting or in flight — the page reads again once its last write has settled.
 */
import { getBackendUrl } from '@/lib/backend-url'
import { saveLine } from '@/lib/sync/save-line'

export interface FamilySaveIO<S> {
  /** Read the family as the page shows it. Throws when the read fails. */
  read: () => Promise<S>
  paint: (snapshot: S) => void
  readFailed: (error: unknown) => void
}

export interface FamilySave {
  /** Read again (ticketed; quiet while a write is waiting or in flight). */
  refresh: () => Promise<void>
  /**
   * A write of this page, in line. The page reads again once its last write has settled, whatever its outcome; the
   * last write resolves after that read.
   */
  write: <T>(task: () => Promise<T>) => Promise<T>
}

export function familySave<S>(io: FamilySaveIO<S>): FamilySave {
  const line = saveLine()
  const refresh = async () => {
    const got = await line.read(io.read, { quietWhileWriting: true })
    if (got.kind === 'fresh') io.paint(got.value)
    else if (got.kind === 'failed') io.readFailed(got.error)
  }
  const write = async <T>(task: () => Promise<T>): Promise<T> => {
    try {
      return await line.write(task)
    } finally {
      if (line.pending === 0) await refresh()
    }
  }
  return { refresh, write }
}

/** One drag: every own attribute link of the family, in its new order, in one request. Throws the refusal's sentence. */
export async function sendAttributeOrder(familyId: string, familyAttributeIds: string[]): Promise<void> {
  const res = await fetch(`${getBackendUrl()}/api/families/${familyId}/attribute-order`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ familyAttributeIds }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `reorder HTTP ${res.status}`)
  }
}
