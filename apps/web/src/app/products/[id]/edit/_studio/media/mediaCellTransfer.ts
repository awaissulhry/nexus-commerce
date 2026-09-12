import { z } from 'zod'
import { productMediaQuerySchema, type ProductMediaWorkspace, type ProductMediaQuery } from '@nexus/shared/product-media'
import { getBackendUrl } from '@/lib/backend-url'

const PREFIX = 'NEXUS_PRODUCT_MEDIA_V1:'
const snapshotSchema = z.object({
  productId: z.string().min(1).max(256), context: productMediaQuerySchema,
  items: z.array(z.object({ id: z.string().min(1).max(256), type: z.string().max(100), alt: z.string().max(2000) }).strict()).max(250),
}).strict()
export type MediaCellSnapshot = z.infer<typeof snapshotSchema>
export function mediaClipboardValue(value: MediaCellSnapshot) { return PREFIX + JSON.stringify(value) }
export function readMediaClipboard(value: unknown): MediaCellSnapshot | null {
  if (typeof value !== 'string' || !value.startsWith(PREFIX) || value.length > 600000) return null
  try { return snapshotSchema.parse(JSON.parse(value.slice(PREFIX.length))) } catch { return null }
}
export function mediaSummary(workspace: ProductMediaWorkspace) {
  return workspace.collection.items.map(item => {
    const asset = workspace.assets.find(asset => asset.id === item.assetId)
    return { id: item.assetId, type: asset?.type ?? 'FILE', preview: asset?.preview ?? null, alt: item.alt ?? asset?.alt ?? '' }
  })
}
export function assertMediaSnapshot(expected: MediaCellSnapshot, actual: ProductMediaWorkspace) {
  const visible = mediaSummary(actual).map(({ id, type, alt }) => ({ id, type, alt }))
  if (JSON.stringify(expected.items) !== JSON.stringify(visible)) throw new Error('The gallery changed since this sheet loaded. Refresh the sheet and try again.')
}
function endpoint(input: { productId: string; context: ProductMediaQuery }) {
  return `${getBackendUrl()}/api/products/${encodeURIComponent(input.productId)}/product-media?${new URLSearchParams(Object.entries(input.context).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))}`
}
async function request(input: MediaCellSnapshot, body?: unknown): Promise<ProductMediaWorkspace> {
  const res = await fetch(endpoint(input), { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(30000),
    ...(body === undefined ? {} : { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
  const value = await res.json().catch(() => null)
  if (!res.ok || !value) throw new Error(value?.error ?? 'The media result could not be confirmed. Reload the gallery before retrying.')
  return value
}
export async function transferMediaCell(source: MediaCellSnapshot, target: MediaCellSnapshot) {
  const [from, to] = await Promise.all([request(source), request(target)])
  assertMediaSnapshot(source, from); assertMediaSnapshot(target, to)
  return request(target, { expectedRevision: to.revision, source: { productId: source.productId, context: source.context, expectedRevision: from.revision } })
}
export async function reorderMediaCell(target: MediaCellSnapshot, ids: string[]) {
  const current = await request(target)
  assertMediaSnapshot(target, current)
  const items = current.collection.items
  if (ids.length !== items.length || new Set(ids).size !== ids.length || ids.some(id => !items.some(item => item.assetId === id))) throw new Error('The gallery membership changed. Reload before reordering.')
  return request(target, { expectedRevision: current.revision, collection: { ...current.collection, items: ids.map(id => items.find(item => item.assetId === id)!) } })
}
