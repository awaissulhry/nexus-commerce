/**
 * E1 (2026-10-04) — eBay's package types, ONE list for the sheet's column (`channel-specs/ebay.ts`), the value reader
 * (`ebay-listing-values.ts`) and the publisher (`ebayPackageXml`). The sheet stores eBay's Inventory names
 * (PACKAGE_THICK_ENVELOPE); eBay Trading names them differently (ShippingPackageCodeType: PackageThickEnvelope).
 * #36 (2026-10-01) — publish refuses a type outside this list by name; the column offers only this list.
 */
export const EBAY_TRADING_PACKAGES: Readonly<Record<string, string>> = {
  LETTER: 'Letter', BULKY_GOODS: 'BulkyGoods', CARAVAN: 'Caravan', CARS: 'Cars', EUROPALLET: 'Europallet', EXPANDABLE_TOUGH_BAGS: 'ExpandableToughBags',
  EXTRA_LARGE_PACK: 'ExtraLargePack', FURNITURE: 'Furniture', INDUSTRY_VEHICLES: 'IndustryVehicles', LARGE_CANADA_POSTBOX: 'LargeCanadaPostBox',
  LARGE_CANADA_POST_BUBBLE_MAILER: 'LargeCanadaPostBubbleMailer', LARGE_ENVELOPE: 'LargeEnvelope', MAILING_BOX: 'MailingBoxes', MEDIUM_CANADA_POST_BOX: 'MediumCanadaPostBox',
  MEDIUM_CANADA_POST_BUBBLE_MAILER: 'MediumCanadaPostBubbleMailer', MOTORBIKES: 'Motorbikes', ONE_WAY_PALLET: 'OneWayPallet', PACKAGE_THICK_ENVELOPE: 'PackageThickEnvelope',
  PADDED_BAGS: 'PaddedBags', PARCEL_OR_PADDED_ENVELOPE: 'ParcelOrPaddedEnvelope', ROLL: 'Roll', SMALL_CANADA_POST_BOX: 'SmallCanadaPostBox',
  SMALL_CANADA_POST_BUBBLE_MAILER: 'SmallCanadaPostBubbleMailer', TOUGH_BAGS: 'ToughBags', UPS_LETTER: 'UPSLetter', USPS_FLAT_RATE_ENVELOPE: 'USPSFlatRateEnvelope',
  USPS_LARGE_PACK: 'USPSLargePack', VERY_LARGE_PACK: 'VeryLargePack', WINE_PAK: 'Winepak',
}

/** The package type codes the sheet offers (the column's strict list). */
export const EBAY_PACKAGE_TYPES: readonly string[] = Object.keys(EBAY_TRADING_PACKAGES)

const codeByTradingName = new Map(Object.entries(EBAY_TRADING_PACKAGES).map(([code, name]) => [name.toLowerCase(), code]))

/** The sheet's code for a package type: a code in any case, or eBay Trading's name for it. Anything else unchanged. */
export function ebayPackageCode(value: string): string {
  const text = value.trim()
  if (!text) return value
  const upper = text.toUpperCase()
  if (EBAY_TRADING_PACKAGES[upper]) return upper
  return codeByTradingName.get(text.toLowerCase()) ?? value
}

/** eBay Trading's name for a package type code (or for a Trading name already); null when eBay does not know it. */
export function ebayTradingPackage(value: string): string | null {
  const code = ebayPackageCode(value)
  return EBAY_TRADING_PACKAGES[code] ?? null
}
