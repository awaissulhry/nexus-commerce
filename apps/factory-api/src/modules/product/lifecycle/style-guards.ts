import type { ProductType } from '@nexus/factory-domain/product/styles/rules'
import type { CommandTx } from '../../../core/command'

/**
 * The database's own rules on a style's row (B-W2b-206's Style_w2b4_depth), said in words before it refuses (B-W2b-221; the
 * lead's note: W1's PATCH answered those refusals with a 500). W1's update (styles/styles.ts) asks it with the fields it
 * changes, after the style's lock:
 *
 *   - the brand of a style sold under OUR name for it (Style.soldUnderOurName) is not cleared (never true without a brand);
 *   - the product type (kind of garment) of a style with a product type of another kind does not change (the type's kind
 *     is the style's).
 *
 * A lifecycle move into IN_PRODUCTION without a released revision is refused in words by ./lifecycle.ts.
 */
export async function styleRowRefusal(tx: CommandTx, styleId: string, next: { readonly brandPartyId: string | null; readonly productType: ProductType }, changed: readonly string[]): Promise<string | null> {
  const row = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: { code: true, soldUnderOurName: true, productTypeProfileId: true } })
  if (changed.includes('brandPartyId') && next.brandPartyId === null && row.soldUnderOurName) {
    return `Style ${row.code} is made for its brand and sold under our name: its brand stays while it is (a style of our own collection is a new style).`
  }
  if (changed.includes('productType') && row.productTypeProfileId !== null) {
    const type = await tx.productTypeProfile.findUnique({ where: { id: row.productTypeProfileId }, select: { code: true, productType: true } })
    if (type && type.productType !== next.productType) {
      return `Style ${row.code} has product type ${type.code}, a type of ${type.productType.toLowerCase()}: take the type off (or give it a type of ${next.productType.toLowerCase()}) before it becomes ${next.productType.toLowerCase()}.`
    }
  }
  return null
}
