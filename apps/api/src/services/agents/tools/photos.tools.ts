/**
 * MCP full control L10/L11 — photos (plan section 02, steps 10 and 11), on the Media page's own plan
 * (`services/images/media-plan.service.ts`). Nexus only: photos reach a channel when a publish sends them
 * (publish-listing with fields "photos").
 *
 *   arrange-photos       edit one layer of a family's photo plan (Shared, a channel, or one listing): insert, remove,
 *                        move, reorder, replace, own or follow a set, the picture axis, a swatch — the Media page's ops.
 *                        Refused while the family is not on the media plan (its older photo path would be overwritten).
 *
 * Its dry run is the plan edit itself, written nowhere; its run is that edit at the layer revision the person approved
 * (a layer that moved since is refused); its undo is the inverse ops the edit returns.
 *
 *   add-photo-from-url   (decision d6) fetch a photo from an https link through the one public-address fetch and store it
 *                        (Cloudinary), where an upload goes: the family's library on the media plan, else the product's
 *                        own gallery. Its dry run fetches and checks the link, storing nothing; its run stores exactly the
 *                        bytes the person approved (by content hash).
 *   remove-unused-photo  its way back: remove a photo nothing uses (no plan places it, not the main photo, no copy or
 *                        listing photo points at it). The stored file stays, so its own undo adds it back from there.
 */

import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import { MEDIA_LAYERS, mediaOpSchema, type MediaOp } from '@nexus/shared/media-plan'
import prisma from '../../../db.js'
import type { AgentTool, ToolResult, ToolUndo } from '../tool-types.js'
import { liveProduct, PRODUCT_NOT_FOUND } from './live-product.js'

const media = () => import('../../images/media-plan.service.js')
const linkPhotos = () => import('../../images/photo-from-url.service.js')
const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)

/** A refusal the media plan gives a person (an HTTP 4xx), as opposed to a fault. */
function personError(error: unknown): string | null {
  const status = (error as { statusCode?: unknown })?.statusCode
  return typeof status === 'number' && status >= 400 && status < 500 ? (error instanceof Error ? error.message : String(error)) : null
}

const addressInput = z.object({
  layer: z.enum(MEDIA_LAYERS).describe('SHARED (every destination), CHANNEL (one channel) or LISTING (one listing)'),
  channel: z.preprocess(upper, z.enum(['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY'])).optional().describe('CHANNEL and LISTING: the channel'),
  marketplace: z.string().trim().toUpperCase().min(2).max(16).optional().describe('LISTING: the market (eBay); Amazon, Shopify and Etsy photos are the account\'s'),
  accountId: z.string().trim().min(1).max(64).optional().describe('LISTING: the Nexus account id (media-plan lists the destinations)'),
  aliasKey: z.string().trim().min(1).max(64).optional().describe('LISTING: a second listing (alias) of the family on this account and market'),
  marketOnly: z.boolean().optional().describe('Amazon LISTING only: this market\'s own photos instead of the account\'s'),
}).describe('which layer of the photo plan: a destination key of media-plan names one')

const arrangeInput = z.object({
  productId: z.string().trim().min(1).max(64).describe('Nexus product id: the family (parent) or one of its variations'),
  address: addressInput,
  ops: z.array(mediaOpSchema).min(1).max(50)
    .describe('the edits, in order: insert, remove, move, reorder, replace (assetIds = photo ids from media-plan\'s library), own, follow, axis, swatch; a set is common, safety, value:<valueKey> or sku:<productId>'),
})

/** The family, and whether its photos are on the media plan (else this tool refuses: the older path would be overwritten). */
async function onPlan(productId: string): Promise<{ sku: string } | { error: string }> {
  const product = await prisma.product.findFirst({ where: liveProduct(productId), select: { sku: true } })
  if (!product) return { error: PRODUCT_NOT_FOUND }
  const { isMediaSwitched } = await media()
  if (!(await isMediaSwitched(productId))) {
    return { error: `${product.sku}: this family's photos are not on the media plan yet. Switch it on the Media page in Nexus first (its older photo path would otherwise be overwritten). Nothing was queued.` }
  }
  return product
}

/** C2 — the layer, as stored now: its revision (0 = no row), read by an empty edit that writes nothing. */
const ARRANGE_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { productId?: string; address?: Record<string, unknown> }
    if (!after.productId || !after.address) return null
    const { applyMediaPlanOps } = await media()
    const now = await applyMediaPlanOps(after.productId, { address: after.address as never, ops: [], dryRun: true }, null)
    return { productId: after.productId, address: after.address, revision: now.revision }
  },
  request(change) {
    const before = (change.before ?? {}) as { productId?: string; address?: Record<string, unknown>; undo?: MediaOp[] }
    if (!before.productId || !before.address) return { refusal: 'This change does not name its photo layer.' }
    if (!before.undo?.length) return { refusal: 'This edit has no way back recorded.' }
    return { tool: 'arrange-photos', args: { productId: before.productId, address: before.address, ops: before.undo } }
  },
}

const arrangePhotos: AgentTool = {
  name: 'arrange-photos',
  title: 'Arrange photos',
  input: arrangeInput,
  requires: [F.productsImagesEdit],
  category: 'products',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: false,
  // C1 — the edit returns its own inverse ops; undo applies them at the same layer while it has not moved.
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  undo: ARRANGE_UNDO,
  description:
    'Arrange a product family\'s photos in Nexus, on the Media page\'s photo plan: one layer (Shared, a channel, or one '
    + 'listing), with the Media page\'s edits (insert, remove, move, reorder, replace photos from the library; own or '
    + 'follow a set; the picture axis; a swatch). Only for a family on the media plan. Nothing reaches a channel until a '
    + 'publish sends the photos (publish-listing, fields "photos"). Amazon photos are one set per account and ASIN: they '
    + 'show in every Amazon market. Waits for a person to approve it in Nexus.',
  async handler(args): Promise<ToolResult> {
    const family = await onPlan(String(args.productId))
    if ('error' in family) return { ok: false, error: family.error }
    const { applyMediaPlanOps } = await media()
    try {
      const dry = await applyMediaPlanOps(String(args.productId), { address: args.address as never, ops: args.ops as MediaOp[], dryRun: true }, null)
      return {
        ok: true,
        preview: { action: 'arrange-photos', family: { productId: dry.rootId, sku: family.sku }, layer: dry.key, revision: dry.revision, ops: args.ops,
          after: dry.plan, note: 'Changes the photo plan in Nexus only; a publish sends the photos.' },
      }
    } catch (error) {
      const sentence = personError(error)
      if (sentence === null) throw error
      return { ok: false, error: `${family.sku}: ${sentence} Nothing was queued.` }
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const family = await onPlan(String(args.productId))
    if ('error' in family) return { ok: false, error: family.error }
    const approved = ctx.approvedPreview as { revision?: unknown } | undefined
    if (typeof approved?.revision !== 'number') return { ok: false, error: 'A photo edit runs only after a person approved its preview. Nothing changed.' }
    const { applyMediaPlanOps } = await media()
    try {
      const done = await applyMediaPlanOps(String(args.productId), { address: args.address as never, ops: args.ops as MediaOp[], expectRevision: approved.revision }, ctx.userId ?? null)
      return {
        ok: true,
        data: { layer: done.key, revision: done.revision },
        change: {
          before: { productId: done.rootId, address: args.address, revision: approved.revision, undo: done.undo },
          after: { productId: done.rootId, address: args.address, revision: done.revision },
        },
      }
    } catch (error) {
      const sentence = personError(error)
      if (sentence === null) throw error
      return { ok: false, error: `${family.sku}: ${sentence}` }
    }
  },
}

const linkInput = z.object({
  productId: z.string().trim().min(1).max(64).describe('Nexus product id: the family (parent) or one of its variations'),
  url: z.string().trim().url().max(2000).describe('https:// link to one JPEG, PNG, WebP or GIF photo, at most 15 MB, on a public web address'),
  label: z.string().trim().min(1).max(200).optional().describe('the photo\'s name in Nexus (its alt text)'),
})

/** The photo's home, or the sentence that refuses it. */
async function homeOf(productId: string) {
  const { photoHome } = await linkPhotos()
  const home = await photoHome(productId)
  return home ?? { error: PRODUCT_NOT_FOUND }
}

/** C2 — whether the photo is still there, in the change's shape (`url` and `label` are the change's own). */
const presence = (change: { after?: unknown }) => {
  const after = (change.after ?? {}) as { productId?: string; photoId?: string; url?: string; label?: string | null }
  return after
}
async function photoPresent(change: { after?: unknown }) {
  const after = presence(change)
  if (!after.productId || !after.photoId) return null
  const there = await prisma.productImage.count({ where: { id: after.photoId } })
  return { ...after, present: there > 0 }
}

const addPhotoFromUrl: AgentTool = {
  name: 'add-photo-from-url',
  title: 'Add a photo from a link',
  input: linkInput,
  requires: [F.productsImagesEdit],
  category: 'products',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  // It reads a web address the caller names (through the public-address fetch) and stores the file with Cloudinary.
  openWorld: true,
  // C1 — remove-unused-photo takes it out again while nothing uses it.
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  undo: {
    current: photoPresent,
    request(change) {
      const after = presence(change)
      if (!after.productId || !after.photoId) return { refusal: 'This change does not name its photo.' }
      return { tool: 'remove-unused-photo', args: { productId: after.productId, photoId: after.photoId } }
    },
  },
  description:
    'Add one photo to a product in Nexus from a web link: https only, a public address, a JPEG, PNG, WebP or GIF photo of '
    + 'at most 15 MB. Nexus fetches and stores it (Cloudinary) where an upload goes: a family on the media plan gets it '
    + 'in its library (place it with arrange-photos), any other product in its own gallery. A photo already there is '
    + 'not added again. Nothing reaches a channel until a publish sends the photos. Waits for a person to approve it in '
    + 'Nexus; the photo stored is exactly the one previewed.',
  async handler(args): Promise<ToolResult> {
    const home = await homeOf(String(args.productId))
    if ('error' in home) return { ok: false, error: home.error }
    const { fetchPhoto, duplicateOf, PhotoUrlError } = await linkPhotos()
    const { isCloudinaryConfigured } = await import('../../cloudinary.service.js')
    if (!isCloudinaryConfigured()) return { ok: false, error: `${home.sku}: photo storage (Cloudinary) is not configured on this Nexus. Nothing was queued.` }
    try {
      const photo = await fetchPhoto(String(args.url))
      const same = await duplicateOf(home, photo)
      if (same) return { ok: false, error: `${home.sku}: this photo is already there (photo ${same.id}${same.kind === 'near' ? ', a near duplicate' : ''}). Nothing was queued.` }
      return {
        ok: true,
        preview: {
          action: 'add-photo-from-url', family: { productId: home.ownerId, sku: home.sku }, place: home.onPlan ? 'library' : 'gallery',
          url: photo.url, host: photo.host, mimeType: photo.mimeType, bytes: photo.bytes, contentHash: photo.contentHash, label: args.label ?? null,
          note: home.onPlan ? 'Adds it to the family\'s photo library in Nexus; arrange-photos places it, a publish sends it.'
            : 'Adds it to the end of the product\'s gallery in Nexus; a publish sends it.',
        },
      }
    } catch (error) {
      if (error instanceof PhotoUrlError) return { ok: false, error: `${home.sku}: ${error.message} Nothing was queued.` }
      throw error
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const home = await homeOf(String(args.productId))
    if ('error' in home) return { ok: false, error: home.error }
    const approved = ctx.approvedPreview as { contentHash?: unknown; family?: { productId?: unknown } } | undefined
    if (typeof approved?.contentHash !== 'string') return { ok: false, error: 'A photo is added only after a person approved its preview. Nothing changed.' }
    if (approved.family?.productId !== home.ownerId) return { ok: false, error: `${home.sku}: where this photo goes changed since it was approved. Nothing changed; ask Claude again.` }
    const { fetchPhoto, duplicateOf, addPhoto, PhotoUrlError } = await linkPhotos()
    try {
      const photo = await fetchPhoto(String(args.url))
      if (photo.contentHash !== approved.contentHash) return { ok: false, error: `${home.sku}: the photo at this link changed since it was approved. Nothing changed; ask Claude again.` }
      const same = await duplicateOf(home, photo)
      if (same) return { ok: false, error: `${home.sku}: this photo is already there (photo ${same.id}). Nothing changed.` }
      const label = typeof args.label === 'string' ? args.label : null
      const image = await addPhoto(home, photo, label)
      return {
        ok: true,
        data: { photoId: image.id, url: image.url, width: image.width, height: image.height, place: home.onPlan ? 'library' : 'gallery' },
        change: {
          before: { productId: home.ownerId, photoId: image.id, url: image.url, label, present: false },
          after: { productId: home.ownerId, photoId: image.id, url: image.url, label, present: true },
        },
      }
    } catch (error) {
      if (error instanceof PhotoUrlError) return { ok: false, error: `${home.sku}: ${error.message} Nothing changed.` }
      throw error
    }
  },
}

const removeUnusedPhoto: AgentTool = {
  name: 'remove-unused-photo',
  title: 'Remove an unused photo',
  input: z.object({
    productId: z.string().trim().min(1).max(64).describe('Nexus product id: the family (parent) or one of its variations'),
    photoId: z.string().trim().min(1).max(64).describe('the photo id (media-plan\'s library, or add-photo-from-url\'s answer)'),
  }),
  requires: [F.productsImagesEdit],
  category: 'products',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: false,
  // C1 — partly: add-photo-from-url adds the same file back from where it is stored, as a new photo at the end.
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  undo: {
    current: photoPresent,
    request(change) {
      const after = presence(change)
      if (!after.productId || !after.url) return { refusal: 'This change does not name the photo\'s stored file.' }
      const label = after.label?.trim()
      return { tool: 'add-photo-from-url', args: { productId: after.productId, url: after.url, ...(label && label.length <= 200 ? { label } : {}) } }
    },
  },
  description:
    'Remove one photo from a product in Nexus while nothing uses it: no photo plan places it, it is not the main photo '
    + 'or a language version, and no copy or listing photo points at it. The stored file is kept (add-photo-from-url can '
    + 'add it back). Nothing changes on a channel. Waits for a person to approve it in Nexus.',
  async handler(args): Promise<ToolResult> {
    const home = await homeOf(String(args.productId))
    if ('error' in home) return { ok: false, error: home.error }
    const { photoInUse } = await linkPhotos()
    const why = await photoInUse(home, String(args.photoId))
    if (why) return { ok: false, error: `${home.sku}: this photo cannot be removed: ${why}. Nothing was queued.` }
    const photo = await prisma.productImage.findFirstOrThrow({ where: { id: String(args.photoId) }, select: { id: true, url: true, alt: true } })
    return {
      ok: true,
      preview: { action: 'remove-unused-photo', family: { productId: home.ownerId, sku: home.sku },
        photo: { photoId: photo.id, label: photo.alt, url: photo.url }, note: 'Removes the photo from Nexus; its stored file is kept.' },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const home = await homeOf(String(args.productId))
    if ('error' in home) return { ok: false, error: home.error }
    const approved = ctx.approvedPreview as { photo?: { photoId?: unknown } } | undefined
    if (approved?.photo?.photoId !== args.photoId) return { ok: false, error: 'A photo is removed only after a person approved its preview. Nothing changed.' }
    const { photoInUse, removePhoto } = await linkPhotos()
    const why = await photoInUse(home, String(args.photoId))
    if (why) return { ok: false, error: `${home.sku}: this photo cannot be removed: ${why}. Nothing changed.` }
    const photo = await prisma.productImage.findFirstOrThrow({ where: { id: String(args.photoId) }, select: { id: true, url: true, alt: true } })
    if (!(await removePhoto(home, photo.id))) return { ok: false, error: `${home.sku}: the photo was already gone. Nothing changed.` }
    return {
      ok: true,
      data: { removed: photo.id },
      change: {
        before: { productId: home.ownerId, photoId: photo.id, url: photo.url, label: photo.alt, present: true },
        after: { productId: home.ownerId, photoId: photo.id, url: photo.url, label: photo.alt, present: false },
      },
    }
  },
}

export const PHOTO_TOOLS: AgentTool[] = [arrangePhotos, addPhotoFromUrl, removeUnusedPhoto]
