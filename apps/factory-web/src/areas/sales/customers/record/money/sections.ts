import type { SectionId } from '../../../orders/record/production/layout'

/**
 * F-CM-101 (customer page › MONEY tab, 10-design §1; 18-lead-settles Z18) — the tab's EIGHT sections, top to bottom, each its address
 * (`…/sales/customers/<id>?tab=money#<id>`). They STACK at every room (a pair lives only inside a section). "Payments & refunds" holds
 * the money on account (`#on-account`), To give back (`#give-back`) and Payments received (`#received`). `#collect` and `#credit` are
 * the Overview's doors, `#invoices` the order's ("All money of <customer> ›"). The empty ones share ONE card at the foot.
 */
export const CUSTOMER_MONEY_SECTIONS = ['balance', 'collect', 'invoices', 'received', 'credit', 'statement', 'price-check', 'margin'] as const
export type CustomerMoneySectionId = (typeof CUSTOMER_MONEY_SECTIONS)[number]

/** The addresses that land inside a section (a box or a block at its top). */
export const CUSTOMER_MONEY_ALIASES = ['on-account', 'give-back'] as const
export type CustomerMoneyAlias = (typeof CUSTOMER_MONEY_ALIASES)[number]

/** The foot card of the sections with nothing (each quiet line keeps its section's id, so a door still lands). */
export const NOTHING_YET = 'nothing-yet'

/** Every address the tab answers (the landing scrolls to it as the reads above it arrive). */
export const CUSTOMER_MONEY_ANCHORS: readonly string[] = [...CUSTOMER_MONEY_SECTIONS, ...CUSTOMER_MONEY_ALIASES]

/**
 * The Production kit's Section (used in place, Kit.tsx untouched) names the addresses of the tabs it was made for in its type; this
 * tab's addresses pass through it as they are (the kit uses the id only as the section's address and its head's id) — the
 * Shipments tab's own way (`rec/shipments/view/hrefs.ts` kitId).
 */
export const kitId = (id: CustomerMoneySectionId | typeof NOTHING_YET): SectionId => id as string as SectionId

/** The anchor of a To-collect row: its own id (an open item's), never another customer's (the row is this customer's). */
export const collectAnchor = (target: 'DEPOSIT_REQUEST' | 'INVOICE', id: string): string => `cm-${target === 'INVOICE' ? 'Invoice' : 'DepositRequest'}-${id}`
