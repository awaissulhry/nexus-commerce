import { createHash } from 'node:crypto'
import prisma from '../../db.js'
import { AMAZON_ARCHIVE_MAX_BYTES, AMAZON_ARCHIVE_MAX_SIZE, planAmazonArchive, type AmazonArchiveKind } from '@nexus/shared/media-plan-archive'
import type { AmazonMediaLayout } from '@nexus/shared/media-plan-channels'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'
import { marketLanguages } from '../pim/market-languages.js'
import { mediaLayoutFor } from './media-plan.service.js'
import { buildJpegArchive } from './jpeg-archive.js'

/**
 * Images rebuild P4d — the Amazon ZIPs for Seller Central, from the photo plan (PLAN.md §7.1). A preview lists every
 * file (`ASIN.SLOT.jpg`) and what is left out; the download rebuilds the same list, refuses when it changed since the
 * preview (a fingerprint of names and addresses), and writes real JPEGs through the shared archive engine. Nothing is
 * written anywhere and nothing is sent to Amazon.
 */

/**
 * Nexus's own limits (Amazon takes up to 5 GB per upload). The build stops at 90 s so the answer starts before Vercel's
 * proxy gives up waiting (120 s for the first byte); the file itself then streams for as long as it needs.
 */
const ZIP_WORDS = {
  tooLong: 'Making the ZIP took more than 90 seconds, so Nexus stopped. No ZIP was saved. Try again in a minute.',
  tooBig: () => `This ZIP would be larger than ${AMAZON_ARCHIVE_MAX_SIZE}, the most Nexus makes in one ZIP. No ZIP was saved.`,
  nothingSaved: 'No ZIP was saved.',
}

export interface AmazonArchiveRequest { accountId: string; market: string; kind: AmazonArchiveKind }

async function archivePlan(productId: string, input: AmazonArchiveRequest) {
  const market = input.market.trim().toUpperCase()
  const media = await mediaLayoutFor({ productId, channel: 'AMAZON', marketplace: market, accountId: input.accountId })
  if (!media) throw new WorkspaceScopeError('This product does not use the photo plan yet. Start it on the Media page.', 409)
  if (!media.destination.markets.includes(market)) throw new WorkspaceScopeError(`This Amazon account has no listing of this product on ${market}.`, 404)
  if (media.layout.channel !== 'AMAZON') throw new WorkspaceScopeError('This destination is not an Amazon listing.', 409)
  const layout = media.layout as unknown as AmazonMediaLayout
  const productIds = [...(layout.parent ? [layout.parent.productId] : []), ...layout.items.map(i => i.productId)]
  const listings = await prisma.channelListing.findMany({ where: { productId: { in: productIds }, channel: 'AMAZON', marketplace: market, channelConnectionId: media.destination.accountId },
    select: { productId: true, externalListingId: true, platformProductId: true } })
  // The ASIN as the Amazon workspace reads it; a listing without one is told apart from no listing at all.
  const listed = new Map(listings.map(l => [l.productId, { asin: l.externalListingId || l.platformProductId || null }]))
  // A market with no content language is an operator setting, not a server fault: say so instead of failing.
  const languages = await marketLanguages('AMAZON', market).catch((error: { code?: string }) => { if (error?.code === 'market_languages_unconfigured') return [] as string[]; throw error })
  const language = languages[0]
  if (input.kind === 'country' && !language) throw new WorkspaceScopeError(`Amazon ${market} has no language set, so its country photos cannot be chosen. Set it in the marketplace settings.`, 422)
  const plan = planAmazonArchive({ kind: input.kind, market, layout, assets: media.assets, listingOf: id => listed.get(id) ?? null, language: input.kind === 'country' ? language : undefined })
  const files = plan.files.map(f => {
    const photo = media.assets.get(f.assetId)?.label ?? 'Photo'
    return { ...f, url: media.url(f.assetId), label: `${photo} (${f.asin} ${f.slot})`, photo }
  })
  const digest = createHash('sha256').update(JSON.stringify(files.map(f => [f.name, f.url]))).digest('hex')
  const kindName = input.kind === 'slots' ? 'photos' : input.kind
  // The API sends one version of each photo to every market of the account: its first market's language (PLAN.md §4.5).
  const apiLanguage = media.destination.languages.find(l => l !== 'mul') ?? media.mainLanguage
  return { market, language: language ?? null, apiLanguage, apiMarket: media.destination.markets[0] ?? market, plan, files, digest, filename: `amazon-${market.replace(/[^A-Z0-9]/g, '')}-${kindName}-${digest.slice(0, 10)}.zip` }
}

export async function amazonArchivePreview(productId: string, input: AmazonArchiveRequest) {
  const { market, language, apiLanguage, apiMarket, plan, files, digest, filename } = await archivePlan(productId, input)
  return { market, kind: input.kind, language, apiLanguage, apiMarket, digest, filename, issues: plan.issues, warnings: plan.warnings, skipped: plan.skipped,
    files: files.map(f => ({ name: f.name, asin: f.asin, slot: f.slot, skus: f.skus, assetId: f.assetId, photo: f.photo })) }
}

export async function amazonArchiveDownload(productId: string, input: AmazonArchiveRequest & { digest: string }) {
  const before = await archivePlan(productId, input)
  if (before.digest !== input.digest) throw new WorkspaceScopeError('The photos changed since the preview. Check the list again, then download.', 409)
  if (before.plan.issues.length) throw new WorkspaceScopeError(before.plan.issues.join('\n'), 422)
  if (!before.files.length) throw new WorkspaceScopeError('This ZIP has no photos, so none was made.', 422)
  const buffer = await buildJpegArchive(before.files, ZIP_WORDS, { maxBytes: AMAZON_ARCHIVE_MAX_BYTES })
  // The photos must not have changed while they were downloaded: the archive matches the preview exactly.
  const after = await archivePlan(productId, input)
  if (after.digest !== before.digest) throw new WorkspaceScopeError('The photos changed while the ZIP was made. Check the list again, then download.', 409)
  return { buffer, filename: before.filename, fileCount: before.files.length }
}
