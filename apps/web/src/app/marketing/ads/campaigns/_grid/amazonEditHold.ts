/**
 * CM-26 (second half) — a Sponsored Brands or Sponsored Display row must not offer a change Nexus always refuses.
 *
 * Every Amazon-bound change from the Ad Manager row (status, daily budget, bidding strategy, bid multiplier) goes to a
 * Sponsored Products endpoint, and the server refuses it for any other ad product (6a, `@nexus/shared/ads-ad-product`).
 * Wave 1 made the refusal say why AFTER the click; this says it BEFORE: those cells show their value read-only with
 * the reason beside it, reachable by keyboard. Local settings (Target ACoS, Min/Max Bid and Budget, Bid Automation,
 * the bid algorithm) are saved in Nexus and are not refused, so they stay editable.
 *
 * A row whose ad product neither column states keeps its controls, as the server allows it (`unknown: 'allow'`).
 */
import { SPONSORED_PRODUCTS, adProductLabel, adProductOf, type AdProductSource } from '@nexus/shared/ads-ad-product'

/** The reason a row's Amazon-bound controls are held; null when the row may be changed from Nexus. */
export function amazonEditHold(campaign: AdProductSource): string | null {
  const product = adProductOf(campaign)
  if (product == null || product === SPONSORED_PRODUCTS) return null
  return `This is a ${adProductLabel(product)} campaign. Nexus changes Sponsored Products campaigns only for now, so this setting cannot be changed here. Change it in Amazon's advertising console.`
}
