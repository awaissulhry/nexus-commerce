/**
 * owb-b5 (w5.1) — the section kit's one rule without a screen, MOVED here unchanged from areas/sales/orders/record/production/layout.ts
 * (F-PT-101, 18-lead-settles L2): a section's head shows at most three buttons; the rest go into its ⋯. The office's layout re-exports
 * it, so its readers and its test keep their import. Pure.
 */

/** A section's head: at most three visible buttons; the rest go into its ⋯. */
export const HEAD_BUTTONS_MAX = 3

/** The buttons a head shows and the ones it moves into its ⋯ (in their order). */
export function headButtonsOf<T>(buttons: readonly T[]): { readonly shown: readonly T[]; readonly more: readonly T[] } {
  return { shown: buttons.slice(0, HEAD_BUTTONS_MAX), more: buttons.slice(HEAD_BUTTONS_MAX) }
}
