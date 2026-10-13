/**
 * The listing drawer's save line (Listings page). Its toggles, rule, percent and buffer each PATCH the listing with
 * `expectedVersion`. They used to send the version of the drawer's last read: a second quick toggle went out before the
 * reload of the first had landed, at the version the first had already moved, and refused itself.
 *
 * Now (the Matrix's #592 pattern, `@/lib/sync/save-line`): the drawer's writes go one at a time, each at the version
 * this drawer's own last write of the listing left (taken from the PATCH answer), or the read's when that is newer; a
 * move by anyone else is still refused. The drawer's reloads are ticketed (`line.read`), so an older reload never
 * paints over a newer one.
 */
import { ownVersions, saveLine, type OwnVersions, type SaveLine } from '@/lib/sync/save-line'

export interface DrawerSave {
  line: SaveLine
  versions: OwnVersions
}

export const drawerSave = (): DrawerSave => ({ line: saveLine(), versions: ownVersions() })

/** What the PATCH answered: its status and its body (`{}` when the body was not JSON). */
export interface DrawerPatchReply {
  ok: boolean
  status: number
  json: any
}

export type DrawerPatchResult = { ok: true; answer: any } | { ok: false; error: string }

/**
 * One drawer write, in the drawer's line. `readVersion` is asked when the write STARTS (after every write before it),
 * so it sees the newest read; the version sent is the newer of that and this drawer's own last write of the listing.
 */
export function sendDrawerPatch(
  save: DrawerSave,
  listingId: string,
  readVersion: () => number | null | undefined,
  body: Record<string, unknown>,
  send: (body: Record<string, unknown>) => Promise<DrawerPatchReply>,
): Promise<DrawerPatchResult> {
  return save.line.write(async (): Promise<DrawerPatchResult> => {
    const expectedVersion = save.versions.at(listingId, readVersion())
    try {
      const reply = await send(expectedVersion === undefined ? body : { ...body, expectedVersion })
      if (!reply.ok) return { ok: false, error: reply.json?.error ?? `HTTP ${reply.status}` }
      const written = reply.json?.listing?.version
      if (typeof written === 'number') save.versions.record(listingId, written)
      return { ok: true, answer: reply.json }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}
