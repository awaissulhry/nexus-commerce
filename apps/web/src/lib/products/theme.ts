/**
 * U.1 — Backward-compat shim. The /products tokens were absorbed into
 * the app-wide design system at `@/lib/theme`. Existing imports of
 * `@/lib/products/theme` keep working via this re-export. New code
 * should import from `@/lib/theme` directly.
 *
 * This file is intentionally one line + a heading comment so deleting
 * it later (after the import sweep) is trivial.
 */

export * from '../theme'
