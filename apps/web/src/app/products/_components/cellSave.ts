/**
 * The product grid's inline-cell save line (/catalog/organize and /products, GridView's EditableCell).
 *
 * Each cell PATCHes /api/products/:id with If-Match. It used to send the row's version from the grid's last read: after
 * its own save the row kept that version until the refetch landed, so a second field of the same row (brand, then
 * product type) refused itself with "Another change landed first".
 *
 * Now (the Matrix's #592 pattern, `@/lib/sync/save-line`): a row's cell writes go one at a time, each at the newer of
 * the row's read version and the version this tab's own last write of the row left (the PATCH answers the version it
 * wrote). A move by anyone else is still a conflict. A no-op answer (`noop: true`) wrote nothing, so its version is
 * never taken as this tab's own.
 *
 * One line PER ROW: a row's writes must chain (each needs the version the one before it wrote), but rows are
 * independent, so a slow or hung save of one row never holds up the cells of another. A row's line is dropped once it
 * is idle.
 */
import { ownVersions, saveLine, type OwnVersions, type SaveLine } from '@/lib/sync/save-line'

export interface CellSave {
  /** The rows with a write waiting or in flight, each with its own line. */
  lines: Map<string, SaveLine>
  versions: OwnVersions
}

export const cellSave = (): CellSave => ({ lines: new Map(), versions: ownVersions() })

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
 * One cell's PATCH, in its row's line. `readVersion` is the row's version as the person saw it when they committed;
 * `send` gets the If-Match to send (none when the row has no version).
 */
export async function saveProductCell(
  save: CellSave,
  productId: string,
  readVersion: number | null | undefined,
  send: (ifMatch: number | undefined) => Promise<CellPatchReply>,
): Promise<CellSaveResult> {
  let line = save.lines.get(productId)
  if (!line) { line = saveLine(); save.lines.set(productId, line) }
  try {
    return await line.write(() => sendCell(save, productId, readVersion, send))
  } finally {
    if (line.pending === 0 && save.lines.get(productId) === line) save.lines.delete(productId)
  }
}

async function sendCell(
  save: CellSave,
  productId: string,
  readVersion: number | null | undefined,
  send: (ifMatch: number | undefined) => Promise<CellPatchReply>,
): Promise<CellSaveResult> {
  try {
    const reply = await send(save.versions.at(productId, readVersion))
    if (reply.ok) {
      // Only a write's own version: a no-op wrote nothing, and its version is a read.
      if (reply.json?.noop !== true && typeof reply.json?.version === 'number') save.versions.record(productId, reply.json.version)
      return { kind: 'saved' }
    }
    if (reply.status === 409 && reply.json?.code === 'VERSION_CONFLICT') {
      return { kind: 'conflict', currentVersion: typeof reply.json.currentVersion === 'number' ? reply.json.currentVersion : null }
    }
    return { kind: 'failed', message: reply.json?.error ?? `Update failed (${reply.status})` }
  } catch (e) {
    return { kind: 'failed', message: e instanceof Error ? e.message : String(e) }
  }
}
