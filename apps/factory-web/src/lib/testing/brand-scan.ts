import type { BrandFixture } from './two-brands'

/**
 * B-TH-203 — the brand wall's name scan for screens (T00 at the screen level; the API's twin is the golden flows' findMarkers):
 * everything of a brand that must never reach another — its legal and trade names, code, contacts and portal people (names and
 * addresses), address line, file name, purchase-order reference, message, record numbers and ids — and `scanText`, which says
 * which of them a rendered text holds. A marker counts only as a whole token, in any case ("SO-2026-0101" is not found inside
 * "SO-2026-01012"), so a view may show its own brand's numbers freely.
 */

/** One thing of a brand that must never reach the other: what it is (for the failure) and its text. */
export interface BrandMarker {
  readonly label: string
  readonly text: string
}

/** Every marker of a brand, without repeats. */
export function brandMarkers(brand: BrandFixture): BrandMarker[] {
  const markers: BrandMarker[] = [
    { label: 'legal name', text: brand.legalName },
    { label: 'trade name', text: brand.tradeName },
    { label: 'code', text: brand.code },
    { label: 'contact name', text: brand.contact.name },
    { label: 'contact address', text: brand.contact.email },
    { label: 'portal person name', text: brand.portalPerson.name },
    { label: 'portal person address', text: brand.portalPerson.email },
    { label: 'address line', text: brand.address.line1 },
    { label: 'file name', text: brand.fileName },
    { label: 'purchase-order reference', text: brand.customerRef },
    { label: 'message', text: brand.message },
    ...Object.entries(brand.numbers).map(([kind, text]) => ({ label: `${kind} number`, text })),
    ...Object.entries(brand.ids).map(([kind, text]) => ({ label: `${kind} id`, text })),
  ]
  const seen = new Set<string>()
  return markers.filter((marker) => {
    const key = marker.text.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The markers of `brand` a rendered text holds (a view's `textContent`, an answer's JSON, a mail), each as `label: text`; empty
 * when the text shows nothing of that brand. Spaces of any kind and length match a space (a rendered name may wrap).
 */
export function scanText(rendered: string, brand: BrandFixture): string[] {
  const text = rendered.replace(/\s+/g, ' ')
  return brandMarkers(brand)
    .filter((marker) => new RegExp(`(?<![A-Za-z0-9])${escape(marker.text).replace(/ /g, '\\s+')}(?![A-Za-z0-9])`, 'i').test(text))
    .map((marker) => `${marker.label}: ${marker.text}`)
}
