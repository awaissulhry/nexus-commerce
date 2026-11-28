import { z } from 'zod'

/**
 * Warn, don't stop (owb- order workflow, plan.md § 5 A "warn only where you already said yes": R39 ship with payment due;
 * base settle 11, S2 ask 22:27). A command that finds one of these does NOT do its work until the caller passes it on
 * (`overrides`, the body's list of the warnings it saw and goes on with): then the work is done and the command's OWN audit
 * row keeps `after.passedWarnings` (+ the reason, when one was given) — apps/factory-api platform/audit/passed-warnings.ts
 * (`checkWarnings`, `passedWarningsAfter`), the pattern of the cutting table's "Cut anyway" (modules/production/cutting).
 * Every other stop of round 0's table STAYS a stop (plan.md § 5 A). S2 owns this list after the base and adds kinds in its
 * own PRs; S3's ship (ss1 step 4) is the first caller.
 *
 *   PAYMENT_DUE_AT_SHIP   a payment step due before shipping is still open on an order of the shipment (R39: ship anyway)
 */
export const ORDER_WARNING_KINDS = ['PAYMENT_DUE_AT_SHIP'] as const
export type OrderWarningKind = (typeof ORDER_WARNING_KINDS)[number]

/** The words key of each kind in the web's catalogue (factory-web messages/<locale>/<owner's file>.json `warning.<key>`). */
export const ORDER_WARNING_WORD_KEYS: Readonly<Record<OrderWarningKind, string>> = Object.freeze({
  PAYMENT_DUE_AT_SHIP: 'warning.paymentDueAtShip',
})

/** The words of each kind, as the API's 409 says it (the screens use their own words by the key above). */
export const ORDER_WARNING_WORDS: Readonly<Record<OrderWarningKind, { readonly en: string; readonly it: string }>> = Object.freeze({
  PAYMENT_DUE_AT_SHIP: {
    en: 'A payment due before shipping is still open.',
    it: 'Un pagamento dovuto prima della spedizione è ancora aperto.',
  },
})

/** The body's `overrides`: the warnings the caller saw and goes on with (none: stop at the first warning). */
export const overridesSchema = z.array(z.enum(ORDER_WARNING_KINDS)).optional()
export type WarningOverrides = z.infer<typeof overridesSchema>
