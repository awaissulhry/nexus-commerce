/**
 * AG.1 — Colour palette for Amazon-tab column grouping on /products/[id]/edit.
 *
 * Scoped to the Amazon tab only. Values are copy-equal to the inline
 * `GROUP_COLORS` map in the Amazon Flat File editor so the operator
 * sees the same blue/purple/etc. theme in both surfaces.
 *
 * ⚠️  DUPLICATE-BY-DESIGN
 * Three near-identical copies of this theme currently exist:
 *   1. `apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx:247–265`
 *   2. `apps/web/src/components/flat-file/FlatFileGrid.tsx:43–56`
 *   3. THIS FILE
 *
 * The duplication is intentional — the AG-series engagement that
 * created this file is forbidden from touching (1) and (2). Any
 * palette tweak must therefore land in **all three** copies in
 * lockstep until a separate dedup engagement is approved.
 *
 * Each `GroupColorTheme` carries five Tailwind class strings:
 *   - `band`   — light background for the section the group occupies
 *   - `header` — saturated background + text colour for the group's
 *                top label row
 *   - `text`   — standalone text-colour variant (no background)
 *   - `cell`   — very-light cell-level wash (grid use; not used in
 *                the Amazon tab today but kept for parity)
 *   - `badge`  — pill-style colour set for group toggle chips
 */

export type GroupColorKey =
  | 'blue'
  | 'purple'
  | 'emerald'
  | 'orange'
  | 'teal'
  | 'amber'
  | 'yellow'
  | 'sky'
  | 'red'
  | 'violet'
  | 'slate'

export interface GroupColorTheme {
  band: string
  header: string
  text: string
  cell: string
  badge: string
}

export const GROUP_COLORS: Record<GroupColorKey, GroupColorTheme> = {
  blue:    { band: 'bg-blue-50 dark:bg-blue-950/30', header: 'bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-200', text: 'text-blue-700 dark:text-blue-300', cell: 'bg-blue-50/50 dark:bg-blue-950/10', badge: 'bg-blue-100 text-blue-700 border border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-800' },
  purple:  { band: 'bg-purple-50 dark:bg-purple-950/30', header: 'bg-purple-100 dark:bg-purple-900/50 text-purple-800 dark:text-purple-200', text: 'text-purple-700 dark:text-purple-300', cell: 'bg-purple-50/50 dark:bg-purple-950/10', badge: 'bg-purple-100 text-purple-700 border border-purple-200 dark:bg-purple-900/40 dark:text-purple-300 dark:border-purple-800' },
  emerald: { band: 'bg-emerald-50 dark:bg-emerald-950/30', header: 'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-800 dark:text-emerald-200', text: 'text-emerald-700 dark:text-emerald-300', cell: 'bg-emerald-50/50 dark:bg-emerald-950/10', badge: 'bg-emerald-100 text-emerald-700 border border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-800' },
  orange:  { band: 'bg-orange-50 dark:bg-orange-950/30', header: 'bg-orange-100 dark:bg-orange-900/50 text-orange-800 dark:text-orange-200', text: 'text-orange-700 dark:text-orange-300', cell: 'bg-orange-50/50 dark:bg-orange-950/10', badge: 'bg-orange-100 text-orange-700 border border-orange-200 dark:bg-orange-900/40 dark:text-orange-300 dark:border-orange-800' },
  teal:    { band: 'bg-teal-50 dark:bg-teal-950/30', header: 'bg-teal-100 dark:bg-teal-900/50 text-teal-800 dark:text-teal-200', text: 'text-teal-700 dark:text-teal-300', cell: 'bg-teal-50/50 dark:bg-teal-950/10', badge: 'bg-teal-100 text-teal-700 border border-teal-200 dark:bg-teal-900/40 dark:text-teal-300 dark:border-teal-800' },
  amber:   { band: 'bg-amber-50 dark:bg-amber-950/30', header: 'bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-200', text: 'text-amber-700 dark:text-amber-300', cell: 'bg-amber-50/50 dark:bg-amber-950/10', badge: 'bg-amber-100 text-amber-700 border border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800' },
  yellow:  { band: 'bg-yellow-50 dark:bg-yellow-950/30', header: 'bg-yellow-100 dark:bg-yellow-900/50 text-yellow-800 dark:text-yellow-200', text: 'text-yellow-700 dark:text-yellow-300', cell: 'bg-yellow-50/50 dark:bg-yellow-950/10', badge: 'bg-yellow-100 text-yellow-700 border border-yellow-200 dark:bg-yellow-900/40 dark:text-yellow-300 dark:border-yellow-800' },
  sky:     { band: 'bg-sky-50 dark:bg-sky-950/30', header: 'bg-sky-100 dark:bg-sky-900/50 text-sky-800 dark:text-sky-200', text: 'text-sky-700 dark:text-sky-300', cell: 'bg-sky-50/50 dark:bg-sky-950/10', badge: 'bg-sky-100 text-sky-700 border border-sky-200 dark:bg-sky-900/40 dark:text-sky-300 dark:border-sky-800' },
  red:     { band: 'bg-red-50 dark:bg-red-950/30', header: 'bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-200', text: 'text-red-700 dark:text-red-300', cell: 'bg-red-50/50 dark:bg-red-950/10', badge: 'bg-red-100 text-red-700 border border-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-800' },
  violet:  { band: 'bg-violet-50 dark:bg-violet-950/30', header: 'bg-violet-100 dark:bg-violet-900/50 text-violet-800 dark:text-violet-200', text: 'text-violet-700 dark:text-violet-300', cell: 'bg-violet-50/50 dark:bg-violet-950/10', badge: 'bg-violet-100 text-violet-700 border border-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-800' },
  slate:   { band: 'bg-slate-50 dark:bg-slate-900/30', header: 'bg-slate-100 dark:bg-slate-800/60 text-slate-700 dark:text-slate-300', text: 'text-slate-600 dark:text-slate-400', cell: '', badge: 'bg-slate-100 text-slate-600 border border-slate-200 dark:bg-slate-800/40 dark:text-slate-400 dark:border-slate-700' },
}

/**
 * Resolve a colour key (from the flat-file manifest, possibly null /
 * undefined / unknown) to a guaranteed theme. Falls back to `slate`
 * which matches what the flat-file editor uses for unrecognised keys.
 */
export function gColor(color: string | null | undefined): GroupColorTheme {
  if (color && color in GROUP_COLORS) {
    return GROUP_COLORS[color as GroupColorKey]
  }
  return GROUP_COLORS.slate
}
