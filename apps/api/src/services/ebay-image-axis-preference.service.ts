/**
 * PER-MARKET image axis preference.
 *
 * eBay varies pictures by exactly ONE axis, and the operator picks which. That
 * pick used to live in a single global `Product.imageAxisPreference`, so
 * choosing an axis while viewing IT also changed DE/FR/ES — an operator who
 * wants IT to vary by the pipe-encoded Colore and DE to use a shared gallery
 * had no way to say so; last pick won everywhere.
 *
 * The preference now lives per market on the parent ChannelListing's
 * platformAttributes (`_imageAxis`) — the same place the per-market
 * `_variationAxes` / `_axisNameLabels` already live — with the global Product
 * column kept as the FALLBACK so every existing product keeps its current
 * behaviour until a market-specific pick is made.
 *
 * ONE definition, shared by every reader and the writer: the recurring defect in
 * this area has been two code paths deciding the same thing differently.
 */
import prisma from '../db.js'

/** Key inside ChannelListing.platformAttributes holding the per-market pick. */
export const IMAGE_AXIS_KEY = '_imageAxis'

const isObj = (o: unknown): o is Record<string, unknown> =>
  !!o && typeof o === 'object' && !Array.isArray(o)

/** 'EBAY_IT' | 'it' | 'IT' → 'IT'. Empty/absent → undefined. */
export function normalizeMarket(marketplace?: string | null): string | undefined {
  const m = String(marketplace ?? '').toUpperCase().replace(/^EBAY[_-]/, '').trim()
  return m || undefined
}

/**
 * The axis pictures should vary by for this product on this market.
 * Precedence: per-market `_imageAxis` → global Product.imageAxisPreference.
 * Returns undefined when neither is set (callers then apply their own default).
 */
export async function readImageAxisPreference(
  productId: string,
  marketplace?: string | null,
): Promise<string | undefined> {
  const mkt = normalizeMarket(marketplace)
  if (mkt) {
    const cl = await prisma.channelListing.findFirst({
      where: { productId, channel: 'EBAY', marketplace: mkt },
      select: { platformAttributes: true },
    })
    const pa = isObj(cl?.platformAttributes) ? cl!.platformAttributes : {}
    const perMarket = pa[IMAGE_AXIS_KEY]
    if (typeof perMarket === 'string' && perMarket.trim()) return perMarket.trim()
  }
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { imageAxisPreference: true },
  })
  const global = product?.imageAxisPreference
  return typeof global === 'string' && global.trim() ? global.trim() : undefined
}

export interface WriteImageAxisResult {
  axis: string
  /** 'market' = stored on that market's listing; 'global' = no listing for the
   *  market (or none supplied), so the legacy product-wide field was used. */
  scope: 'market' | 'global'
  marketplace?: string
}

/**
 * Persist the operator's pick. With a marketplace that has an eBay listing the
 * pick is stored ON THAT MARKET only; otherwise it falls back to the global
 * column so the choice is never silently dropped.
 */
export async function writeImageAxisPreference(
  productId: string,
  axis: string,
  marketplace?: string | null,
): Promise<WriteImageAxisResult> {
  const value = axis.trim()
  const mkt = normalizeMarket(marketplace)
  if (mkt) {
    const cl = await prisma.channelListing.findFirst({
      where: { productId, channel: 'EBAY', marketplace: mkt },
      select: { id: true, platformAttributes: true },
    })
    if (cl) {
      const pa = isObj(cl.platformAttributes) ? { ...cl.platformAttributes } : {}
      pa[IMAGE_AXIS_KEY] = value
      await prisma.channelListing.update({
        where: { id: cl.id },
        data: { platformAttributes: pa as never },
      })
      return { axis: value, scope: 'market', marketplace: mkt }
    }
  }
  await prisma.product.update({
    where: { id: productId },
    data: { imageAxisPreference: value },
  })
  return { axis: value, scope: 'global', ...(mkt ? { marketplace: mkt } : {}) }
}
