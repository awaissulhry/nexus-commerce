/**
 * The product grid's inline-cell save line (/catalog/organize and /products, GridView's EditableCell).
 *
 * Each cell PATCHes /api/products/:id with If-Match. It used to send the row's version from the grid's last read: after
 * its own save the row kept that version until the refetch landed, so a second field of the same row (brand, then
 * product type) refused itself with "Another change landed first".
 *
 * Now (the Matrix's #592 pattern, `@/lib/sync/save-line`): the cells' writes go one at a time, each at the newer of the
 * row's read version and the version this tab's own last write of the row left (the PATCH answers `version`). A move by
 * anyone else is still a conflict.
 */
import { ownVersions, saveLine, type OwnVersions, type SaveLine } from '@/lib/sync/save-line'

export interface CellSave {
  line: SaveLine
  versions: OwnVersions
}

export const cellSave = (): CellSave => ({ line: saveLine(), versions: ownVersions() })

/** What the PATCH answered: its status and its body (`{}` when the body was not JSON). */
export interface CellPatchReply {
  ok: boolean
  status: number
  json: any
}

export type CellSaveResult =
  | { kind: 'saved' }
  | { kind: 'conflict'; currentVersion: number | null }
  | { kind: 'failed'; message: string }

/**
 * One cell's PATCH, in the grid's line. `readVersion` is the row's version as the person saw it when they committed;
 * `send` gets the If-Match to send (none when the row has no version).
 */
export function saveProductCell(
  save: CellSave,
  productId: string,
  readVersion: number | null | undefined,
  send: (ifMatch: number | undefined) => Promise<CellPatchReply>,
): Promise<CellSaveResult> {
  return save.line.write(async (): Promise<CellSaveResult> => {
    try {
      const reply = await send(save.versions.at(productId, readVersion))
      if (reply.ok) {
        if (typeof reply.json?.version === 'number') save.versions.record(productId, reply.json.version)
        return { kind: 'saved' }
      }
      if (reply.status === 409 && reply.json?.code === 'VERSION_CONFLICT') {
        return { kind: 'conflict', currentVersion: typeof reply.json.currentVersion === 'number' ? reply.json.currentVersion : null }
      }
      return { kind: 'failed', message: reply.json?.error ?? `Update failed (${reply.status})` }
    } catch (e) {
      return { kind: 'failed', message: e instanceof Error ? e.message : String(e) }
    }
  })
}
