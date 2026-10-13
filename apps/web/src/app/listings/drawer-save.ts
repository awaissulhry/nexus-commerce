/**
 * The listing drawer's save line (Listings page). Its toggles, rule, percent and buffer each PATCH the listing with
 * `expectedVersion`. They used to send the version of the drawer's last read: a second quick toggle went out before the
 * reload of the first had landed, at the version the first had already moved, and refused itself.
 *
 * Now (the Matrix's #592 pattern, `@/lib/sync/save-line`): the drawer's writes go one at a time, each at the version
 * this drawer's own last write of the listing left (taken from the PATCH answer, which is the version that write
 * wrote), or the read's when that is newer; a move by anyone else is still refused. A write is never sent without a
 * version. The drawer's reloads are ticketed (`line.read`), so an older reload never paints over a newer one, and a
 * reload of a listing the drawer has moved away from (a companion on the Per-channel tab, another grid row) is dropped.
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

/** The drawer has no version for this listing (it still shows another one, or has not read it yet). */
export const RELOAD_FIRST = 'Reload the listing, then try again.'

/**
 * A drawer reload: ticketed, and kept only while it is still the listing the drawer is on. A reload that started before
 * the drawer moved to another listing is dropped without counting as painted, so the new listing's own read lands.
 */
export function readDrawerListing<T extends { id?: unknown } | null>(save: DrawerSave, currentId: () => string, fetchIt: () => Promise<T>) {
  return save.line.read(fetchIt, { keep: (value) => value?.id === currentId() })
}

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
    // Never unchecked: without a version the PATCH would write over whatever the listing holds now.
    if (expectedVersion === undefined) return { ok: false, error: RELOAD_FIRST }
    try {
      const reply = await send({ ...body, expectedVersion })
      if (!reply.ok) return { ok: false, error: reply.json?.error ?? `HTTP ${reply.status}` }
      const written = reply.json?.listing?.version
      if (typeof written === 'number') save.versions.record(listingId, written)
      return { ok: true, answer: reply.json }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}
