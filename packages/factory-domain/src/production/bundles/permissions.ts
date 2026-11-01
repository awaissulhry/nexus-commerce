import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The bundles' permissions (apps/factory-api modules/production/bundles; features MES-065, MES-066, MES-068, MES-073,
 * MES-184; W2b B-W2b-41: MES-067, MES-074, MES-075, MES-078, MES-168; A2 SCR-095 floor bundles, SCR-072 the work order's
 * bundles, SCR-259 Production › Bundles), in the production area. Checked with can() against the work order's company
 * and site; a floor device works at its own site only (can() pins it, row-level security too). The office reads a work
 * order's bundles with workorders.view (they are part of the work order record). Nothing here carries money.
 *
 * W2b (B-W2b-41): `bundles.view` reads where every bundle of the caller's sites is, the stuck ones, a bundle's record and
 * the scan-pattern checks as counts per line and operation (office only). `bundles.findings` reviews or dismisses one
 * finding (a person decides; never a score). `bundles.who` opens the scans behind ONE finding by name (Statuto dei
 * Lavoratori, L. 300/1970, art. 4: only where the site names workers with its legal basis on record and its PERFORMANCE
 * purpose switched on, with a reason; every opening is written down, so it is `write` and read_only never holds it). No
 * template holds `bundles.who`: the owner holds it through the registry and may give it to a custom role.
 */
export const PRODUCTION_BUNDLES_DEFINITIONS = definePermissions('production', {
  bundles: {
    risk: 'write',
    description:
      "Make bundles from a work order's cut garments at the cutting table and print their tickets, reprint a lost or damaged ticket (a new code; the old one is refused when scanned), void a bundle made by mistake before any scan names it, and print, reprint or void a bundle's coupons (a floor device: at its own site).",
  },
  // W2b B-W2b-41 (MES-074, MES-075, MES-168).
  'bundles.view': {
    risk: 'read',
    description: 'See where every bundle of your sites is (its place now, last scan and genealogy), the bundles with no scan for longer than the site allows, and the scan-pattern checks as counts per line and operation (never people).',
  },
  'bundles.findings': {
    risk: 'write',
    description: 'Review or dismiss a scan-pattern finding about a bundle (with a note): a pattern to talk about, never a score.',
  },
  'bundles.who': {
    risk: 'write',
    description:
      "Open the scans behind one scan-pattern finding with the workers' names, with a stated reason, only where the site names workers with its legal basis on record (Statuto dei Lavoratori art. 4); every opening is written in the audit log.",
  },
})

export const PRODUCTION_BUNDLES = 'production.bundles' satisfies Permission
// W2b B-W2b-41.
export const PRODUCTION_BUNDLES_VIEW = 'production.bundles.view' satisfies Permission
export const PRODUCTION_BUNDLES_FINDINGS = 'production.bundles.findings' satisfies Permission
export const PRODUCTION_BUNDLES_WHO = 'production.bundles.who' satisfies Permission

export const PRODUCTION_BUNDLES_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_BUNDLES, PRODUCTION_BUNDLES_VIEW, PRODUCTION_BUNDLES_FINDINGS, PRODUCTION_BUNDLES_WHO])

/** What a floor role may hold of them (FLOOR_SHARED_PERMISSIONS): bundles, their tickets and coupons at its own site. */
export const PRODUCTION_BUNDLES_FLOOR_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_BUNDLES])
