/**
 * MCP full control I2 — the identity checks, as a pure registry: what each check finds, how bad it is, what it means
 * in plain words, and which tool fixes it. Plan: docs/mcp-full-control/sections/04-identity.md §2 (the 21-row
 * inconsistency catalogue); `number` is the catalogue row. identity-audit.service.ts holds one bounded SQL per check.
 *
 * All 21 rows of the catalogue are checked here. #2 (an id another business also holds) asks the cross-business function
 * nexus_identity_foreign_ids (I5, packages/database/workspaces/identity-foreign.sql); #3, #4 and #12 read what each
 * channel account holds, as recorded by the per-account sweep (I6, ChannelHeldId) — they find nothing until a sweep ran.
 * #10's "same GTIN" case is reported once, as #18.
 *
 * The fix tools are the plan's (§3). Most are not built yet: the audit says per check whether its tool exists now.
 */

export type IdentitySeverity = 'error' | 'warning' | 'info'

export const IDENTITY_SEVERITIES: readonly IdentitySeverity[] = ['error', 'warning', 'info']

/** A column a check needs that this database may not have yet. */
export type IdentityRequirement = 'listing-alias-sku'

export interface IdentityCheck {
  /** Stable name, kebab-case: what a person or Claude filters by. */
  kind: string
  /** The row of the plan's inconsistency catalogue (§2). */
  number: number
  severity: IdentitySeverity
  title: string
  /** What is wrong and why it matters, in plain words. */
  explanation: string
  /** The plan's fix tool (null: a person does it in Nexus), and what the fix does. */
  fix: { tool: string | null; how: string }
  /** A column the check reads that may be missing; without it the check is skipped and says so. */
  requires?: IdentityRequirement
}

/** Why a check whose column is missing was not run. */
export const REQUIREMENT_MISSING: Record<IdentityRequirement, string> = {
  'listing-alias-sku':
    'not available until the listing-SKU column exists (ProductListingAlias.sku, added with the eBay import by SKU): '
    + 'an extra listing has no SKU of its own here yet, so there is nothing to compare.',
}

export const IDENTITY_CHECKS: readonly IdentityCheck[] = [
  {
    kind: 'channel-id-on-two-families',
    number: 1,
    severity: 'error',
    title: 'One channel id on two families or listings',
    explanation: 'The same eBay Item ID, Shopify product or Etsy listing sits on two product families, or on two listings '
      + '(extra listings) of one family, in the same market. A push for either one changes the same live item: price, '
      + 'stock and title of one family can land on the other.',
    fix: { tool: 'unlink-channel-id', how: 'keep the family the channel confirms and unlink the id from the other' },
  },
  {
    kind: 'channel-id-in-another-business',
    number: 2,
    severity: 'error',
    title: 'Channel id also held by another business',
    explanation: 'An eBay Item ID, Shopify product or Etsy listing this business holds is also on a listing of another '
      + 'business. A seller-owned id belongs to one seller account, so one of the two is driving an item that is not its '
      + 'own. The other business is named only to its members. (A shared ASIN or GTIN is legal and not checked here.)',
    fix: { tool: 'unlink-channel-id', how: 'unlink it in the business whose account does not hold the item (the channel says which)' },
  },
  {
    kind: 'channel-id-not-held-by-account',
    number: 3,
    severity: 'error',
    title: 'Listing id its account does not hold',
    explanation: 'The listing carries an eBay Item ID, ASIN, Shopify product or Etsy listing that its own account did not '
      + 'hold at the last complete read of that account: the item ended, or it belongs to another seller. Pushes for it '
      + 'fail or reach an item that is not this account\'s. channel-identity-check tells which.',
    fix: { tool: 'unlink-channel-id', how: 'ended: relist it or unlink the id; another seller\'s: unlink the id' },
  },
  {
    kind: 'channel-id-not-in-nexus',
    number: 4,
    severity: 'warning',
    title: 'Item the account holds that no listing carries',
    explanation: 'The account holds a live item (by its own read) that no listing in this business carries. Nexus does '
      + 'not manage its stock or price.',
    fix: { tool: 'link-channel-id', how: 'link it to the product that sells it, create the listing, or mark it ignored' },
  },
  {
    kind: 'live-listing-without-channel-id',
    number: 5,
    severity: 'warning',
    title: 'Live listing without a channel id',
    explanation: 'Nexus counts this listing as live, but it carries no ASIN, Item ID or channel product id, so no '
      + 'update can reach the item on the channel.',
    fix: { tool: 'link-channel-id', how: 'Amazon: read the ASIN from Amazon; other channels: link the id the account holds' },
  },
  {
    kind: 'ebay-item-id-differs-from-shared-listing',
    number: 6,
    severity: 'error',
    title: 'eBay Item ID differs between the listing and its shared variations',
    explanation: 'The family\'s eBay listing names one Item ID while its shared variation rows (the eBay listing that '
      + 'carries several SKUs) name another. The sheet shows one and stock goes to the other.',
    fix: { tool: 'link-channel-id', how: 're-link the Item ID eBay confirms; it writes both places in one step' },
  },
  {
    kind: 'legacy-channel-id-differs',
    number: 7,
    severity: 'info',
    title: 'Old product id column differs from the listings',
    explanation: 'An older product column (amazonAsin, parentAsin, ebayItemId or shopifyProductId) holds an id that none '
      + 'of the product\'s listings carries. The listings are what Nexus uses; the old column can mislead a report.',
    fix: { tool: null, how: 'information only for now; the old columns are cleared once nothing reads them' },
  },
  {
    kind: 'child-listing-points-elsewhere',
    number: 8,
    severity: 'error',
    title: 'Variation listing points at another item than its parent',
    explanation: 'A variation\'s listing carries another eBay or Etsy listing id, or another Amazon parent ASIN, than the '
      + 'parent product\'s listing on the same account and market. Often left behind when a variation moved to another '
      + 'parent.',
    fix: { tool: 'link-channel-id', how: 'link the variation to its parent\'s item, or move it back with fix-parent' },
  },
  {
    kind: 'parent-deleted',
    number: 9,
    severity: 'error',
    title: 'Variation under a deleted parent',
    explanation: 'The product is a variation of a parent product that was deleted, so it belongs to no live family.',
    fix: { tool: 'fix-parent', how: 'attach it to a live parent or make it a single product' },
  },
  {
    kind: 'parent-is-a-variation',
    number: 9,
    severity: 'error',
    title: 'Parent that is itself a variation',
    explanation: 'The product\'s parent is itself a variation (or the product is its own parent). Families have one level; '
      + 'a nested family is read differently by different screens.',
    fix: { tool: 'fix-parent', how: 'attach it to the top parent of the family' },
  },
  {
    kind: 'children-under-non-parent',
    number: 9,
    severity: 'warning',
    title: 'Variations under a product not marked as a parent',
    explanation: 'Products name this product as their parent, but it is not marked as a parent product.',
    fix: { tool: 'fix-parent', how: 'mark it as the parent, or move the variations' },
  },
  {
    kind: 'listing-alias-on-a-variation',
    number: 9,
    severity: 'error',
    title: 'Extra listing on a variation',
    explanation: 'An extra listing (listing alias) belongs to a variation. Extra listings always belong to the family\'s '
      + 'parent, so this one is not found where the family\'s listings are read.',
    fix: { tool: 'fix-parent', how: 'move the extra listing to the family\'s parent' },
  },
  {
    kind: 'unadopted-ebay-shell',
    number: 10,
    severity: 'warning',
    title: 'Old eBay listing shell not adopted',
    explanation: 'A placeholder product (EBAY_LISTING_SHELL) still holds an eBay listing of another product. It is a '
      + 'duplicate: the listing belongs on that product as an extra listing.',
    fix: { tool: 'merge-duplicate-products', how: 'adopt the shell\'s listing as an extra listing of the real product' },
  },
  {
    kind: 'sku-differs-only-in-case',
    number: 10,
    severity: 'warning',
    title: 'Two products whose SKUs differ only in case or spaces',
    explanation: 'Two products have SKUs that are equal once case and surrounding spaces are ignored. A channel or a file '
      + 'may treat them as one SKU.',
    fix: { tool: 'merge-duplicate-products', how: 'merge them when one is a duplicate, else rename one with set-product-sku' },
  },
  {
    kind: 'listing-sku-equals-product-sku',
    number: 11,
    severity: 'error',
    title: 'Extra listing SKU equal to a product SKU',
    explanation: 'An extra listing\'s own SKU is the SKU of a product. An import or a channel names both by that SKU, so '
      + 'one can be taken for the other.',
    fix: { tool: 'set-listing-sku', how: 'give the extra listing a SKU of its own' },
    requires: 'listing-alias-sku',
  },
  {
    kind: 'offer-sku-equals-other-listing-sku',
    number: 11,
    severity: 'error',
    title: 'Offer SKU equal to another listing\'s seller SKU',
    explanation: 'An offer\'s SKU (for example the FBA SKU) is the seller SKU of another product\'s listing on the same '
      + 'account and market. The channel knows one SKU there, so the two listings overwrite each other.',
    fix: { tool: 'set-listing-sku', how: 'give one of them another seller SKU (a live Amazon SKU cannot be renamed)' },
  },
  {
    kind: 'name-alias-equals-other-product-sku',
    number: 11,
    severity: 'warning',
    title: 'SKU alias equal to another product\'s SKU',
    explanation: 'A product\'s SKU alias (another name it is found by, for example in an order file) is the SKU of a '
      + 'different product, so a match by that name can pick the wrong product.',
    fix: { tool: 'set-product-sku', how: 'remove the alias, or rename the other product' },
  },
  {
    kind: 'channel-sku-differs',
    number: 12,
    severity: 'info',
    title: 'Channel SKU differs from the SKU Nexus sends',
    explanation: 'The channel shows another seller SKU for this listing than the one Nexus would send. A live listing\'s '
      + 'SKU is never renamed on the channel (decided): record the channel\'s SKU in Nexus, or leave it as a known difference.',
    fix: { tool: 'set-listing-sku', how: 'record the channel\'s SKU on the listing (an extra listing), or leave it' },
  },
  {
    kind: 'shopify-variant-on-two-products',
    number: 13,
    severity: 'error',
    title: 'One Shopify variant on two products',
    explanation: 'Two Nexus products carry the same Shopify variant id. Stock and price for both go to one Shopify variant.',
    fix: { tool: 'unlink-channel-id', how: 'unlink the variant from the product it does not belong to' },
  },
  {
    kind: 'shopify-variant-of-other-product',
    number: 13,
    severity: 'error',
    title: 'Shopify variation tied to another Shopify product',
    explanation: 'A Shopify listing names another Shopify product than its family\'s listing (or its colour product), or '
      + 'its own two Shopify product ids disagree.',
    fix: { tool: 'link-channel-id', how: 'link it to the Shopify product of its family' },
  },
  {
    kind: 'shared-account-listing-without-claim',
    number: 14,
    severity: 'warning',
    title: 'Live listing on a shared account without a claim',
    explanation: 'The listing is live on an account shared between businesses, but this business holds no claim on its '
      + 'seller SKU there. Another business can publish the same SKU on that account.',
    fix: { tool: null, how: 'claim the SKU (it is claimed when the listing is next sent), or release the listing' },
  },
  {
    kind: 'claim-without-listing',
    number: 14,
    severity: 'info',
    title: 'Claim on a shared account with no listing',
    explanation: 'This business holds a claim on a seller SKU of a shared account, but no live listing of it uses the '
      + 'claim. The other businesses on that account cannot use the SKU while it is held.',
    fix: { tool: null, how: 'release the claim when the SKU is no longer listed' },
  },
  {
    kind: 'listing-on-account-not-usable',
    number: 15,
    severity: 'error',
    title: 'Listing on an account this business may no longer use',
    explanation: 'The listing belongs to a channel account that this business does not own and is no longer allowed to '
      + 'publish on (the sharing was revoked or is read-only). Nexus cannot send it, and the live item is the owner\'s.',
    fix: { tool: 'unlink-channel-id', how: 'unlink it here; the account\'s owner decides about the live item' },
  },
  {
    kind: 'listing-without-account',
    number: 16,
    severity: 'warning',
    title: 'Listing with no account',
    explanation: 'The listing names no channel account, so Nexus cannot tell which seller account it is sent to.',
    fix: { tool: null, how: 'set the account of the listing' },
  },
  {
    kind: 'gtin-invalid',
    number: 17,
    severity: 'warning',
    title: 'GTIN, EAN or UPC that is not valid',
    explanation: 'The barcode is not 8, 12, 13 or 14 digits, or its check digit is wrong. Channels refuse it or match '
      + 'the product to another item.',
    fix: { tool: 'set-gtin', how: 'correct the barcode' },
  },
  {
    kind: 'gtin-ean-upc-disagree',
    number: 17,
    severity: 'warning',
    title: 'GTIN, EAN and UPC disagree',
    explanation: 'The product carries more than one barcode field and they hold different codes.',
    fix: { tool: 'set-gtin', how: 'keep the one code that is right' },
  },
  {
    kind: 'listing-gtin-differs',
    number: 17,
    severity: 'warning',
    title: 'Listing barcode differs from the product\'s',
    explanation: 'The listing carries a barcode that is none of its product\'s GTIN, EAN or UPC.',
    fix: { tool: 'set-gtin', how: 'make the listing and the product carry the same code' },
  },
  {
    kind: 'parent-carries-gtin',
    number: 17,
    severity: 'warning',
    title: 'Parent product with a barcode',
    explanation: 'A parent product (one with variations) carries a GTIN, EAN or UPC. A parent is not sold itself; its '
      + 'barcode belongs on a variation.',
    fix: { tool: 'set-gtin', how: 'move the barcode to the variation it belongs to' },
  },
  {
    kind: 'gtin-missing-for-new-amazon-listing',
    number: 17,
    severity: 'info',
    title: 'New Amazon listing without a barcode',
    explanation: 'An Amazon listing that has no ASIN yet belongs to a product with no GTIN, EAN or UPC and no GTIN '
      + 'exemption. Amazon needs one of them to create the listing.',
    fix: { tool: 'set-gtin', how: 'add the barcode, or record a GTIN exemption' },
  },
  {
    kind: 'gtin-on-two-products',
    number: 18,
    severity: 'warning',
    title: 'One barcode on two products',
    explanation: 'Two products in this business carry the same GTIN, EAN or UPC. A channel matches both to one catalogue item.',
    fix: { tool: 'set-gtin', how: 'correct the barcode of the wrong one, or merge duplicates' },
  },
  {
    kind: 'brand-spelled-several-ways',
    number: 19,
    severity: 'info',
    title: 'Brand spelled several ways',
    explanation: 'Products carry the same brand written differently (case, spaces or punctuation). Filters, reports and '
      + 'channel brand checks treat them as different brands.',
    fix: { tool: 'set-brand', how: 'use one spelling' },
  },
  {
    kind: 'listing-brand-differs',
    number: 19,
    severity: 'warning',
    title: 'Listing brand differs from the product\'s',
    explanation: 'The brand sent to Amazon or eBay for this listing is not the product\'s brand.',
    fix: { tool: 'set-brand', how: 'use the product\'s brand on the listing (eBay needs one of its allowed values)' },
  },
  {
    kind: 'listing-on-deleted-product',
    number: 20,
    severity: 'warning',
    title: 'Listing of a deleted product',
    explanation: 'A listing still belongs to a product that was deleted. If it is live, the channel keeps selling an item '
      + 'Nexus no longer manages.',
    fix: { tool: 'unlink-channel-id', how: 'end or unlink the listing' },
  },
  {
    kind: 'listing-alias-without-listings',
    number: 20,
    severity: 'info',
    title: 'Extra listing with no listing rows',
    explanation: 'An extra listing (listing alias) exists but no listing belongs to it.',
    fix: { tool: null, how: 'archive the extra listing' },
  },
  {
    kind: 'ebay-index-names-gone-product',
    number: 20,
    severity: 'info',
    title: 'eBay listing index names a deleted product',
    explanation: 'The index of this business\'s eBay listings matches an item to a product that was deleted or no longer exists.',
    fix: { tool: 'link-channel-id', how: 'link the item to the product that sells it now' },
  },
  {
    kind: 'ebay-account-without-identity',
    number: 21,
    severity: 'warning',
    title: 'eBay account without a seller identity',
    explanation: 'This eBay account was connected before Nexus recorded the eBay seller behind it, so Nexus cannot prove '
      + 'which seller an Item ID belongs to.',
    fix: { tool: null, how: 'reconnect the account in Nexus (Settings → Channels)' },
  },
]

const BY_KIND = new Map(IDENTITY_CHECKS.map((check) => [check.kind, check]))

export const IDENTITY_CHECK_KINDS = IDENTITY_CHECKS.map((check) => check.kind) as [string, ...string[]]

export function identityCheck(kind: string): IdentityCheck | undefined {
  return BY_KIND.get(kind)
}

/** The checks a filter names, in registry order (the order findings are listed in). */
export function selectChecks(filter: { checks?: readonly string[]; severity?: IdentitySeverity } = {}): IdentityCheck[] {
  const wanted = filter.checks?.length ? new Set(filter.checks) : null
  return IDENTITY_CHECKS.filter((check) => (!wanted || wanted.has(check.kind)) && (!filter.severity || check.severity === filter.severity))
}
