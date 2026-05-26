// UC.1.1 — Shared cockpit design tokens.
//
// One source of truth for the chrome both the Amazon and eBay cockpits
// render: status tones (the coloured dot + pill), the sticky-header
// offset, the pill base, and the muted Level-0 provenance badge base.
//
// Status is intentionally open-ended (raw channel strings) because the
// canonical statuses differ per channel — Amazon ACTIVE/INACTIVE/
// SUPPRESSED, eBay ACTIVE/ENDED/DRAFT, Shopify ACTIVE/ARCHIVED/DRAFT,
// plus feed/publish lifecycle (QUEUED/PROCESSING/...). `statusTone`
// folds any of them into one of five visual tones.

export type StatusTone = 'emerald' | 'amber' | 'slate' | 'rose' | 'sky'

const TONE_BY_STATUS: Record<string, StatusTone> = {
  // live / buyable
  ACTIVE: 'emerald',
  PUBLISHED: 'emerald',
  BUYABLE: 'emerald',
  ONLINE: 'emerald',
  DONE: 'emerald',
  // needs attention but not broken
  DRAFT: 'amber',
  UNPUBLISHED: 'amber',
  INCOMPLETE: 'amber',
  PENDING: 'amber',
  // dormant / neutral
  INACTIVE: 'slate',
  ENDED: 'slate',
  ARCHIVED: 'slate',
  OUT_OF_STOCK: 'slate',
  // broken / blocked
  SUPPRESSED: 'rose',
  SEARCH_SUPPRESSED: 'rose',
  BLOCKED: 'rose',
  ERROR: 'rose',
  FATAL: 'rose',
  CANCELLED: 'rose',
  // in-flight (feed/publish)
  QUEUED: 'sky',
  PROCESSING: 'sky',
  SUBMITTED: 'sky',
}

export function statusTone(status?: string | null): StatusTone {
  if (!status) return 'slate'
  return TONE_BY_STATUS[status.toUpperCase()] ?? 'slate'
}

/** Pill chrome (border + bg + text) keyed by tone. */
export const STATUS_PILL: Record<StatusTone, string> = {
  emerald:
    'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900',
  amber:
    'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900',
  slate:
    'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
  rose:
    'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900',
  sky:
    'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900',
}

/** Text-only colour keyed by tone (used by static provenance icons). */
export const STATUS_TEXT: Record<StatusTone, string> = {
  emerald: 'text-emerald-600 dark:text-emerald-400',
  amber: 'text-amber-600 dark:text-amber-400',
  slate: 'text-slate-500 dark:text-slate-400',
  rose: 'text-rose-600 dark:text-rose-400',
  sky: 'text-sky-600 dark:text-sky-400',
}

/** Solid dot colour keyed by tone (used in the header + chip strip). */
export const STATUS_DOT: Record<StatusTone, string> = {
  emerald: 'bg-emerald-500',
  amber: 'bg-amber-500',
  slate: 'bg-slate-400',
  rose: 'bg-rose-500',
  sky: 'bg-sky-500',
}

// ── Shared chrome class strings ──────────────────────────────────────

/** Header sticks below the product-edit tab bar (top-14) and sits just
 *  under it in the stacking context. Matches the existing AmazonCockpit
 *  header so the migration in UC.3 is a no-op visually. */
export const COCKPIT_HEADER_STICKY = 'sticky top-14 z-[5]'

/** Base for the small rounded pills in the header (status, fulfilment,
 *  identifier, extra). Tone classes from STATUS_PILL append to this. */
export const PILL_BASE =
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap'

/** Muted, informational Level-0 provenance badge (·linked / ·master /
 *  ·pinned). Deliberately quiet so the default automated state does not
 *  shout. FL.2 renders the actual badge component on top of this base. */
export const PROVENANCE_BADGE_BASE =
  'inline-flex items-center gap-0.5 text-[10px] leading-none text-slate-400 dark:text-slate-500'

/** The full-bleed wrapper every cockpit root uses: never let a wide
 *  card force the page into horizontal scroll (regression fixed during
 *  AC — keep it baked into the primitive). */
export const COCKPIT_ROOT = 'space-y-4 min-w-0 max-w-full'
