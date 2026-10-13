/**
 * Cycle count session — the page's save line.
 *
 * Each blur used to send its own PATCH and then its own re-read, with no ticket; tabbing across items ran them in
 * parallel. An older re-read could land last and show an item as uncounted after its draft had been cleared, and one
 * shared "acting" id re-enabled an item whose write was still in flight.
 *
 * Now (the Matrix's #592 pattern, `@/lib/sync/save-line`):
 * - the page's writes (a count, a reconcile, an ignore, start, complete, cancel) go one at a time;
 * - each item is busy while a write of it is waiting or in flight (its own state, not one shared id);
 * - reads are ticketed and kept off the screen while a write is waiting or in flight; the page reads again once its
 *   last write has settled;
 * - a recorded count stays on screen (its draft) until a read that started after the count landed is painted.
 * The reconcile maths stays on the server (a delta against the snapshot); nothing here computes stock.
 */
import { saveLine } from '@/lib/sync/save-line'

export interface CountSaveIO<S> {
  /** Read the session. Throws when the read fails. */
  read: () => Promise<S>
  /** Paint a read. `settled`: counts this read includes — their drafts can go when they still hold the value sent. */
  paint: (session: S, settled: ReadonlyArray<{ itemId: string; draft: string }>) => void
  readFailed: (error: unknown) => void
  /** The items with a write waiting or in flight changed. */
  busy: (itemIds: ReadonlySet<string>) => void
}

export interface CountSave {
  /** Read again (ticketed; quiet while a write is waiting or in flight). */
  refresh: () => Promise<void>
  /**
   * A write of this page, in line. `itemId` keeps that item busy until the write settles; `draft` (a recorded count)
   * stays on screen until a read that includes it. The page reads again once its last write has settled; the last
   * write resolves after that read, so a button stays busy until the screen shows what it did.
   */
  write: <T>(task: () => Promise<T>, opts?: { itemId?: string; draft?: string }) => Promise<T>
  /** The count of this item that is waiting, in flight, or landed but not read yet: sending it again changes nothing. */
  held: (itemId: string) => string | undefined
}

export function countSave<S>(io: CountSaveIO<S>): CountSave {
  const line = saveLine()
  const busy = new Map<string, number>()
  const sending = new Map<string, string>()
  const landed = new Map<string, { draft: string; after: number }>()
  const announce = () => io.busy(new Set(busy.keys()))

  const refresh = async () => {
    const got = await line.read(io.read, { quietWhileWriting: true })
    if (got.kind === 'failed') { io.readFailed(got.error); return }
    if (got.kind !== 'fresh') return
    const settled: Array<{ itemId: string; draft: string }> = []
    for (const [itemId, count] of landed) {
      // A read that started after the count landed shows it; an older one never clears its draft.
      if (got.ticket > count.after) { settled.push({ itemId, draft: count.draft }); landed.delete(itemId) }
    }
    io.paint(got.value, settled)
  }

  const write = async <T>(task: () => Promise<T>, opts: { itemId?: string; draft?: string } = {}): Promise<T> => {
    const { itemId, draft } = opts
    if (itemId) { busy.set(itemId, (busy.get(itemId) ?? 0) + 1); announce() }
    if (itemId && draft !== undefined) sending.set(itemId, draft)
    try {
      return await line.write(async () => {
        const result = await task()
        if (itemId && draft !== undefined) landed.set(itemId, { draft, after: line.issued })
        return result
      })
    } finally {
      if (itemId && draft !== undefined && sending.get(itemId) === draft) sending.delete(itemId)
      if (itemId) {
        const left = (busy.get(itemId) ?? 1) - 1
        if (left > 0) busy.set(itemId, left)
        else busy.delete(itemId)
        announce()
      }
      if (line.pending === 0) await refresh()
    }
  }

  const held = (itemId: string) => sending.get(itemId) ?? landed.get(itemId)?.draft

  return { refresh, write, held }
}
