import { mediaRequest } from '../ebay/transport'

/**
 * Images rebuild W4a — answers about two photos that look the same: "same photo" (keep one; the other becomes its copy,
 * and every photo set that showed it shows the kept one), "not the same", and the undo of each. The server's sentence
 * comes back as the error message.
 */
export interface SamePhotoUndo {
  keep: string; drop: string; previous: string | null; repointed: string[]
  layers: Array<{ layer: string; channel: string; marketplace: string; accountId: string; aliasKey: string; ops: unknown[] }>
}

const path = (productId: string) => `/api/products/${encodeURIComponent(productId)}/media/library/lookalikes`

export async function markSame(productId: string, keep: string, drop: string): Promise<{ layersChanged: number; undo: SamePhotoUndo }> {
  const data = await mediaRequest(path(productId), 'POST', { action: 'same', keep, drop }) as { layersChanged?: unknown; undo?: SamePhotoUndo }
  if (typeof data?.layersChanged !== 'number' || !data.undo) throw new Error('The answer was saved, but it could not be read. Reload the page.')
  return { layersChanged: data.layersChanged, undo: data.undo }
}
export async function undoSame(productId: string, undo: SamePhotoUndo) { await mediaRequest(path(productId), 'POST', { action: 'undo-same', undo }) }
export async function markDistinct(productId: string, a: string, b: string, undo = false) {
  await mediaRequest(path(productId), 'POST', { action: undo ? 'undo-distinct' : 'distinct', a, b })
}
/** The lasting way back from "Same photo": the copy is its own photo again; photo sets stay as they are. */
export async function separate(productId: string, drop: string) { await mediaRequest(path(productId), 'POST', { action: 'separate', drop }) }

/** W4b — the way back from "language versions": each photo's language and group, and each layer's sets. */
export interface VersionsUndo {
  groupId: string
  members: Array<{ id: string; languageTag: string; versionGroupId: string | null }>
  layers: SamePhotoUndo['layers']
}
export async function joinVersions(productId: string, ids: string[], languages: Record<string, string>): Promise<{ keep: string; layersChanged: number; undo: VersionsUndo }> {
  const data = await mediaRequest(path(productId), 'POST', { action: 'versions', ids, languages }) as { keep?: unknown; layersChanged?: unknown; undo?: VersionsUndo }
  if (typeof data?.keep !== 'string' || typeof data.layersChanged !== 'number' || !data.undo) throw new Error('The answer was saved, but it could not be read. Reload the page.')
  return { keep: data.keep, layersChanged: data.layersChanged, undo: data.undo }
}
export async function undoVersions(productId: string, undo: VersionsUndo) { await mediaRequest(path(productId), 'POST', { action: 'undo-versions', undo }) }
/** A photo leaves its language versions (its language stays; photo sets do not change). */
export async function leaveVersions(productId: string, id: string) { await mediaRequest(path(productId), 'POST', { action: 'leave-versions', id }) }
