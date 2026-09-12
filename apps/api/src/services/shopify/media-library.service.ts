import { createHash } from 'node:crypto'
import { workspaceIdForQuery, workspaceKey } from '@nexus/database/workspace-context'
import type { ShopifyFile, ShopifyMediaSource, MediaSourcesResponse, ShopifyFilesResponse, ShopifyFileReference } from '@nexus/shared/shopify-media'
import { shopifyFileQuerySchema, SHOPIFY_UPLOAD_MAX_BYTES } from '@nexus/shared/shopify-media'
import prisma from '../../db.js'
import { listActiveConnections, resolveConnection, type ConnectionRow } from '../connection-resolver.service.js'
import { shopifyShopDomain } from '../cx/connectors/shopify/auth.js'
import { getShopifyPublishMode } from '../shopify-publish-gate.service.js'
import { shopifyAdmin, assertShopifyResult, type ShopifyGraphql } from './admin-client.js'

export class ShopifyMediaError extends Error {
  constructor(message: string, readonly statusCode = 409) { super(message) }
}

function source(connection: ConnectionRow): ShopifyMediaSource {
  const domain = shopifyShopDomain(connection.region)
  const scopes = connection.grantedScopes ?? []
  const readIssue = !domain ? 'Reconnect this store to verify its Shopify address.'
    : connection.authStatus !== 'connected' ? 'Reconnect this Shopify store before loading its files.'
    : !['read_files', 'write_files'].some(scope => scopes.includes(scope)) ? 'Reconnect this store and grant access to Shopify Files.' : null
  const uploadIssue = readIssue ?? (!scopes.includes('write_files') ? 'Grant permission to upload Shopify files in Connections.'
    : getShopifyPublishMode() !== 'live' ? 'Shopify uploads are disabled by the server’s publish settings.' : null)
  return { accountId: connection.id, label: connection.accountLabel || connection.displayName || domain || 'Shopify store', domain, isPrimary: connection.isPrimary, readIssue, uploadIssue }
}

export async function mediaSources(): Promise<MediaSourcesResponse> {
  const stores = (await listActiveConnections('SHOPIFY')).map(source)
  const primary = stores.filter(store => store.isPrimary)
  return { stores, defaultSource: stores.length === 0 ? 'nexus' : stores.length === 1 ? stores[0].accountId : primary.length === 1 ? primary[0].accountId : null }
}

export async function defaultShopifyMediaAccount(): Promise<string | null> {
  const { defaultSource } = await mediaSources()
  if (defaultSource === null) throw new ShopifyMediaError('Choose a Shopify store in the media library to upload there, or mark one store as primary in Connections.')
  return defaultSource === 'nexus' ? null : defaultSource
}

async function mediaAdmin(accountId: string, write = false) {
  const connection = await resolveConnection({ accountId })
  if (connection.channelType !== 'SHOPIFY') throw new ShopifyMediaError('Select a Shopify store.', 400)
  const store = source(connection)
  const issue = write ? store.uploadIssue : store.readIssue
  if (issue) throw new ShopifyMediaError(issue, 403)
  return shopifyAdmin(accountId)
}

// Query only durable delivery URLs. MediaImage.originalSource.url expires and must never
// become a stored asset URL. Video duration is milliseconds, unlike Nexus seconds.
export const SHOPIFY_FILE_FIELDS = `__typename id alt fileStatus createdAt updatedAt fileErrors { message }
  preview { image { url(transform: { maxWidth: 640 }) } }
  ... on MediaImage { mimeType image { url width height } imageOriginal: originalSource { fileSize } }
  ... on Video { filename duration videoSources: sources { url mimeType width height } videoOriginal: originalSource { fileSize } }
  ... on GenericFile { url mimeType originalFileSize }
  ... on Model3d { filename modelSources: sources { url mimeType } }`

interface RemoteFile {
  __typename: 'MediaImage' | 'Video' | 'GenericFile' | 'Model3d'
  id: string; alt: string | null; fileStatus: string; createdAt: string; updatedAt: string
  fileErrors?: { message: string }[]; preview?: { image?: { url: string } | null } | null
  image?: { url: string; width: number; height: number } | null
  filename?: string; duration?: number | null; url?: string | null; mimeType?: string | null
  originalFileSize?: number | null; imageOriginal?: { fileSize?: number | null } | null; videoOriginal?: { fileSize?: number | null } | null
  videoSources?: { url: string; mimeType: string; width?: number; height?: number }[]
  modelSources?: { url: string; mimeType: string }[]
}
const TYPES = { MediaImage: 'image', Video: 'video', GenericFile: 'document', Model3d: 'model3d' } as const
function https(value: string | null | undefined): string | null {
  if (!value) return null
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null } catch { return null }
}
function filename(url: string | null): string | null {
  if (!url) return null
  try { return decodeURIComponent(new URL(url).pathname.split('/').at(-1)!) || null } catch { return null }
}
export function normalizeShopifyFile(file: RemoteFile, accountId: string): ShopifyFile {
  const type = TYPES[file.__typename]
  if (!type) throw new ShopifyMediaError('Shopify returned an unsupported file type.', 502)
  const playable = file.videoSources?.filter(s => s.mimeType === 'video/mp4').sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]
  const delivery = type === 'image' ? file.image : type === 'video' ? playable : type === 'model3d' ? file.modelSources?.[0] : { url: file.url, mimeType: file.mimeType }
  const url = file.fileStatus === 'READY' ? https(delivery?.url) : null
  return { id: file.id, accountId, type, label: file.filename || filename(url) || file.alt || `${file.__typename} ${file.id.split('/').at(-1)}`,
    alt: file.alt, status: file.fileStatus, errors: file.fileErrors?.map(error => error.message) ?? [], url,
    previewUrl: https(file.preview?.image?.url) ?? (type === 'image' ? url : null),
    mimeType: file.mimeType ?? (delivery && 'mimeType' in delivery ? delivery.mimeType ?? null : null),
    width: delivery && 'width' in delivery ? delivery.width ?? null : null,
    height: delivery && 'height' in delivery ? delivery.height ?? null : null,
    sizeBytes: file.imageOriginal?.fileSize ?? file.videoOriginal?.fileSize ?? file.originalFileSize ?? null,
    durationSeconds: typeof file.duration === 'number' ? file.duration / 1000 : null,
    createdAt: file.createdAt, updatedAt: file.updatedAt }
}

const quoteSearch = (value: string) => `"${value.replace(/[\\"():]/g, '\\$&')}"`
export async function listShopifyFiles(input: unknown): Promise<ShopifyFilesResponse> {
  const parsed = shopifyFileQuerySchema.safeParse(input)
  if (!parsed.success) throw new ShopifyMediaError('Choose a store and valid file filters.', 400)
  const { accountId, type, search, after } = parsed.data
  const { graphql } = await mediaAdmin(accountId)
  const mediaType = { image: 'IMAGE', video: 'VIDEO', document: 'GENERIC_FILE', model3d: 'MODEL_3D' }
  const query = [type !== 'all' ? `media_type:${mediaType[type]}` : '', search ? `filename:${quoteSearch(search)}` : ''].filter(Boolean).join(' AND ')
  const data = await graphql<{ files: { nodes: RemoteFile[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(
    `query NexusMediaLibrary($after:String,$query:String!) { files(first:48,after:$after,query:$query,sortKey:CREATED_AT,reverse:true) { nodes { ${SHOPIFY_FILE_FIELDS} } pageInfo { hasNextPage endCursor } } }`, { after: after ?? null, query })
  const { nodes, pageInfo } = data.files
  if (pageInfo.hasNextPage && (!pageInfo.endCursor || pageInfo.endCursor === after)) throw new ShopifyMediaError('Shopify pagination did not advance. Refresh the library.', 502)
  return { accountId, items: nodes.map(file => normalizeShopifyFile(file, accountId)), nextCursor: pageInfo.hasNextPage ? pageInfo.endCursor : null, fetchedAt: new Date().toISOString() }
}

async function readFile(graphql: ShopifyGraphql, accountId: string, id: string) {
  const { node } = await graphql<{ node: RemoteFile | null }>(`query NexusMediaFile($id:ID!) { node(id:$id) { ... on File { ${SHOPIFY_FILE_FIELDS} } } }`, { id })
  if (!node?.id || node.id !== id) throw new ShopifyMediaError('This file is no longer available in the selected store. Refresh the library.', 404)
  return normalizeShopifyFile(node, accountId)
}
export async function getShopifyFile(accountId: string, id: string) {
  return readFile((await mediaAdmin(accountId)).graphql, accountId, id)
}
const stableId = (prefix: string, ...values: string[]) => `${prefix}_${createHash('sha256').update(JSON.stringify([workspaceIdForQuery(), ...values])).digest('hex').slice(0, 40)}`

export async function referenceShopifyFile(accountId: string, id: string): Promise<ShopifyFileReference> {
  const file = await getShopifyFile(accountId, id)
  if (file.status !== 'READY' || !file.url) throw new ShopifyMediaError('This file is not ready to use. Refresh after Shopify finishes processing it.')
  const assetId = stableId('shopify', accountId, id)
  const previous = await prisma.digitalAsset.findUnique({ where: { id: assetId }, select: { metadata: true } })
  const metadata = previous?.metadata && typeof previous.metadata === 'object' && !Array.isArray(previous.metadata) ? previous.metadata : {}
  const data = { label: file.label, type: file.type, mimeType: file.mimeType ?? 'application/octet-stream', sizeBytes: file.sizeBytes ?? 0,
    storageProvider: 'shopify', storageId: id, url: file.url, originalFilename: file.label,
    metadata: { ...metadata, shopifyAccountId: accountId, shopifyFileId: id, remoteUpdatedAt: file.updatedAt, alt: file.alt, width: file.width, height: file.height, previewUrl: file.previewUrl, durationSeconds: file.durationSeconds, sizeKnown: file.sizeBytes !== null } }
  await prisma.digitalAsset.upsert({ where: { id: assetId }, create: { id: assetId, ...data }, update: data })
  return { assetId, url: file.url, label: file.label }
}

/** Existing upload callers expect a usable URL. An unready upload stays in Shopify and
 * returns an explicit processing result, never a fake URL or a Cloudinary fallback. */
export async function uploadReadyShopifyAsset(accountId: string, buffer: Buffer, name: string) {
  const uploaded = await uploadShopifyFile(accountId, buffer, name)
  let file = uploaded.file
  for (let attempt = 0; !['READY', 'FAILED'].includes(file.status) && attempt < 8; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    file = await getShopifyFile(accountId, file.id)
  }
  if (file.status !== 'READY' || !file.url) throw new ShopifyMediaError(file.status === 'FAILED'
    ? `Shopify could not process this upload. ${file.errors.join('; ')}`
    : 'Uploaded to Shopify and still processing. Refresh the media library to check progress, then retry this upload to attach it. The upload is retained.')
  const reference = await referenceShopifyFile(accountId, file.id)
  const asset = await prisma.digitalAsset.findUniqueOrThrow({ where: { id: reference.assetId } })
  return { asset, reused: uploaded.reused }
}

/** Revalidate the remote file before use; deterministic IDs make concurrent imports safe. */
export async function attachShopifyImage(productId: string, asset: { id: string; storageId: string; metadata: unknown }, type: string, alt?: string | null) {
  return attachShopifyMedia(productId, asset, type, alt, 'image')
}

export async function attachShopifyMedia(productId: string, asset: { id: string; storageId: string; metadata: unknown }, type: string, alt: string | null | undefined, expectedType: 'image' | 'video') {
  const accountId = (asset.metadata as { shopifyAccountId?: string } | null)?.shopifyAccountId
  if (!accountId) throw new ShopifyMediaError('The Shopify source account is missing. Load this file from the Shopify library again.')
  const file = await getShopifyFile(accountId, asset.storageId)
  if (file.type !== expectedType || !file.url || file.status !== 'READY') throw new ShopifyMediaError('This Shopify media is unavailable or still processing.')
  const id = stableId('shopify_image', productId, asset.id)
  return prisma.$transaction(async tx => {
    const existing = await tx.productImage.findFirst({ where: { productId, OR: [{ id }, { sourceAssetId: asset.id }] } })
    const max = await tx.productImage.aggregate({ where: { productId }, _max: { sortOrder: true } })
    const delivery = { url: file.url!, width: file.width, height: file.height, mimeType: file.mimeType, fileSize: file.sizeBytes,
      posterUrl: expectedType === 'video' ? file.previewUrl : null, durationSec: file.durationSeconds }
    const image = existing ? await tx.productImage.update({ where: { id: existing.id }, data: delivery }) : await tx.productImage.upsert({ where: { id }, update: delivery, create: {
      id, productId, sourceAssetId: asset.id, url: file.url!, publicId: null, type, alt: alt === undefined ? file.alt : alt,
      mediaType: expectedType === 'video' ? 'VIDEO' : 'IMAGE', posterUrl: expectedType === 'video' ? file.previewUrl : null, durationSec: file.durationSeconds,
      width: file.width, height: file.height, mimeType: file.mimeType, fileSize: file.sizeBytes, sortOrder: (max._max.sortOrder ?? -1) + 1,
    } })
    await tx.assetUsage.upsert({ where: { assetId_scope_productId_role_sortOrder: workspaceKey({ assetId: asset.id, scope: 'product', productId, role: image.type.toLowerCase(), sortOrder: image.sortOrder }) },
      create: { assetId: asset.id, scope: 'product', productId, role: image.type.toLowerCase(), sortOrder: image.sortOrder }, update: {} })
    return { ok: true, image, reused: !!existing }
  })
}

const EXTENSIONS: Record<string, [string, 'IMAGE' | 'VIDEO' | 'MODEL_3D' | 'FILE']> = {
  jpg: ['image/jpeg', 'IMAGE'], jpeg: ['image/jpeg', 'IMAGE'], png: ['image/png', 'IMAGE'], webp: ['image/webp', 'IMAGE'], gif: ['image/gif', 'IMAGE'], avif: ['image/avif', 'IMAGE'], heic: ['image/heic', 'IMAGE'],
  mp4: ['video/mp4', 'VIDEO'], mov: ['video/quicktime', 'VIDEO'], webm: ['video/webm', 'VIDEO'], glb: ['model/gltf-binary', 'MODEL_3D'], usdz: ['model/vnd.usdz+zip', 'MODEL_3D'],
  pdf: ['application/pdf', 'FILE'], txt: ['text/plain', 'FILE'], csv: ['text/csv', 'FILE'], zip: ['application/zip', 'FILE'],
  doc: ['application/msword', 'FILE'], docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'FILE'],
  xls: ['application/vnd.ms-excel', 'FILE'], xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'FILE'],
  ppt: ['application/vnd.ms-powerpoint', 'FILE'], pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'FILE'],
}
export async function uploadShopifyFile(accountId: string, buffer: Buffer, originalFilename: string) {
  const extension = originalFilename.split('.').at(-1)?.toLowerCase() ?? ''
  const format = EXTENSIONS[extension]
  if (!format) throw new ShopifyMediaError('This file format is not supported. Choose an image, video, 3D model or document.', 400)
  const [mimeType, contentType] = format
  const limit = contentType === 'IMAGE' || contentType === 'FILE' ? 20 * 1024 * 1024 : SHOPIFY_UPLOAD_MAX_BYTES
  if (!buffer.length || buffer.length > limit) throw new ShopifyMediaError(`Choose a non-empty file no larger than ${limit / 1024 / 1024} MB.`, 400)
  const { graphql } = await mediaAdmin(accountId, true)
  const hash = createHash('sha256').update(buffer).digest('hex')
  const stem = originalFilename.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 70) || 'file'
  const name = `${stem}-nexus-${hash.slice(0, 32)}.${extension}`
  const existing = async () => {
    const data = await graphql<{ files: { nodes: RemoteFile[] } }>(`query NexusUploadedFile($query:String!) { files(first:2,query:$query) { nodes { ${SHOPIFY_FILE_FIELDS} } } }`, { query: `filename:${quoteSearch(name)}` })
    if (data.files.nodes.length > 1) throw new ShopifyMediaError('Several Shopify files match this upload. Review them in the library before retrying.')
    return data.files.nodes[0] ? normalizeShopifyFile(data.files.nodes[0], accountId) : null
  }
  const found = await existing()
  if (found) return { file: found, reused: true }
  const staged = assertShopifyResult((await graphql(`mutation NexusStageMedia($input:[StagedUploadInput!]!) { stagedUploadsCreate(input:$input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } } }`, {
    input: [{ filename: name, mimeType, resource: contentType, httpMethod: 'POST', fileSize: String(buffer.length) }],
  })).stagedUploadsCreate, 'Prepare Shopify upload') as { stagedTargets: { url: string; resourceUrl: string; parameters: { name: string; value: string }[] }[] }
  const target = staged.stagedTargets[0]
  if (!target || !https(target.url) || !https(target.resourceUrl)) throw new ShopifyMediaError('Shopify did not provide a secure upload target.', 502)
  const form = new FormData()
  for (const parameter of target.parameters) form.append(parameter.name, parameter.value)
  form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), name)
  const response = await fetch(target.url, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000), redirect: 'error' })
  if (!response.ok) throw new ShopifyMediaError('The transfer to Shopify failed. Retry this file.', 502)
  try {
    const result = assertShopifyResult((await graphql(`mutation NexusCreateMedia($files:[FileCreateInput!]!) { fileCreate(files:$files) { files { ${SHOPIFY_FILE_FIELDS} } userErrors { field message } } }`, {
      files: [{ originalSource: target.resourceUrl, filename: name, contentType, duplicateResolutionMode: 'RAISE_ERROR' }],
    })).fileCreate, 'Create Shopify file') as { files: RemoteFile[] }
    if (!result.files[0]) throw new ShopifyMediaError('Shopify did not confirm the file. Refresh the library before retrying.', 502)
    return { file: normalizeShopifyFile(result.files[0], accountId), reused: false }
  } catch (error) {
    // Read reconciliation also covers a lost response; never issue a second blind mutation.
    const recovered = await existing().catch(() => null)
    if (recovered) return { file: recovered, reused: true }
    throw error
  }
}
