import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Currencies and exchange rates (B-W2b-389; PLT-132, PLT-133; apps/factory-api platform/currency; design finance.settings
 * "Currencies & rates"), office only, in their own area. A company's document currencies are checked with can() against
 * that company; the rates are the tenant's (one table for every company: a manual rate serves every company), so writing
 * one, and switching the daily ECB rates on or off, needs the grant over every company.
 *
 *   view     the company's base currency and document currencies, the rates table (the ECB's and the manual ones per day),
 *            whether the daily ECB rates are on and when they were last read
 *   manage   add a document currency, switch one off or on again; keep, correct or remove a manual rate of a day; switch the
 *            daily ECB rates on or off and read today's now
 *
 * No money is shown (rates only). The day's rate a document takes is read by the modules themselves, with no permission of
 * its own (a purchase order's send, a credit check, a work order's cost).
 */
export const CURRENCY_DEFINITIONS = definePermissions('currencies', {
  view: { risk: 'read', description: "See the company's own currency and the currencies its documents may be in, and the exchange rates of each day (the ECB's and the ones typed by hand)." },
  manage: {
    risk: 'write',
    description: "Add a currency the company's documents may be in, or switch one off; keep, correct or remove the rate of a day typed by hand (for every company); switch the daily ECB rates on or off.",
  },
})

export const CURRENCIES_VIEW = 'currencies.view' satisfies Permission
export const CURRENCIES_MANAGE = 'currencies.manage' satisfies Permission

export const CURRENCY_PERMISSIONS: readonly Permission[] = Object.freeze([CURRENCIES_VIEW, CURRENCIES_MANAGE])

/** The role templates that get them (owner: every()): finance and the administrator keep them; buyers and sales read them. */
export const CURRENCY_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: [CURRENCIES_VIEW, CURRENCIES_MANAGE],
  finance: [CURRENCIES_VIEW, CURRENCIES_MANAGE],
  buyer: [CURRENCIES_VIEW],
  sales: [CURRENCIES_VIEW],
})
