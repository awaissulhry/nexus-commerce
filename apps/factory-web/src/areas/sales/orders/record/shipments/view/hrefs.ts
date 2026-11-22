import { recordAddress } from '../../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../../shell/nav/office-nav'
import type { SectionId } from '../../production/layout'

/**
 * F-OS-101: the Production kit's Section (used in place, Kit.tsx untouched) names the addresses of the tabs it was made for in its type;
 * this tab's three addresses pass through it as they are (the kit uses the id only as the section's address and its head's id).
 */
export const kitId = (id: 'left' | 'shipments' | 'after-sales'): SectionId => id as string as SectionId

/** F-OS-101: a shipment's home — its record in Warehouse › Shipments (a real link: ⌘-click opens a new tab). */
export const shipmentHref = (prefix: string, companyId: string, row: { readonly id: string; readonly number: string }): string => `${prefix}${recordAddress({ type: 'Shipment', id: row.id, label: row.number, companyId }, OFFICE_PAGES)}`

/** F-OS-101: Warehouse's record at one of its tabs (Next › opens the step there: the step stays in Warehouse). */
export const shipmentTabHref = (prefix: string, companyId: string, row: { readonly id: string; readonly number: string }, tab: string): string => {
  const base = shipmentHref(prefix, companyId, row)
  return `${base}${base.includes('?') ? '&' : '?'}tab=${encodeURIComponent(tab)}`
}

/** F-OS-101: "Copy link to this part": the page's address at a section's or a row's anchor, to the clipboard. */
export function copyLinkTo(anchor: string): void {
  if (typeof window === 'undefined') return
  const { origin, pathname, search } = window.location
  void navigator.clipboard?.writeText(`${origin}${pathname}${search}#${anchor}`).catch(() => undefined)
}
