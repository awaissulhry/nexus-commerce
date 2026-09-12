/**
 * PES.1 — the Product Edit Studio frame's TYPES.
 *
 * Pure: no React, no runtime imports. A server component and a `'use client'` module can both read it,
 * and so can a vitest file. The runtime half of the contract (providers + hooks) is
 * `contracts.tsx`; everything here is re-exported from there, so a consuming lane has one import.
 *
 * Owned by PES.1. PES.2/3/4/5/7 CONSUME these shapes — see `docs/pes-claims.md`, "Contracts PES.1
 * publishes". If a lane needs a field that is not here, ask for it rather than widening a local
 * copy: a second definition of the same fact is the fork this file exists to prevent.
 */

// Type-only: the DS component that DRAWS readiness defines its four states and its nullable
// percentage. The app extends that render contract below rather than re-declaring either half.
import type { ScopeBarReadiness, ScopeReadinessState } from '@/design-system/patterns'

/* ── the coordinate ──────────────────────────────────────────────────────────────────────── */

/**
 * Which layer of the data spine is being edited.
 *
 * `'master'` is the stored truth; anything else is a CHANNEL key exactly as the API spells it
 * (`'AMAZON'`, `'EBAY'`, `'SHOPIFY'`, …). It is deliberately NOT `channel:market` — the market is
 * its own control. One control per fact: the chips name the channel, the switcher names the
 * market. Merging them is what sank the reverted ads scope bar
 * (reference_one_filter_bar_merged_scope, "two controls for one fact").
 */
export type StudioScopeId = 'master' | (string & {})

export const MASTER_SCOPE = 'master' as const

/**
 * The non-tabular surfaces. The sheet IS the page; these are the things it is not.
 *
 * `visibleTabs()` in `scopes.ts` is the one place that decides which tasks a scope offers.
 * Presentation is eBay-specific; shared Needs attention explains its available checks.
 *
 * 🔴 `'variants'` is ONE page re-projected by the scope bar, not one page per channel: family STRUCTURE on
 * master, each channel's PROJECTION on its own scope (variants spec §1.1).
 *
 * 🔴 There is no `'relationships'` member. The task was removed on the Owner's call (2026-09-12) — the page
 * was never needed — so it is absent from the union, from `STUDIO_TABS` and from the frame's tab map. A
 * bookmarked `?tab=relationships` falls back to `sheet` in `contracts.tsx`, which reads the URL against
 * `STUDIO_TABS`.
 */
export type StudioTabId = 'sheet' | 'variants' | 'images' | 'analytics' | 'activity' | 'errors' | 'presentation' | 'variation-order' | 'shopify-family' | 'shopify-metafields'

/**
 * How much of a publish actually reaches a channel — the SERVER's vocabulary, verbatim.
 *
 * `getAmazonPublishMode()` returns `'gated' | 'dry-run' | 'sandbox' | 'live'` and nothing else
 * decides whether a feed is submitted, so this is the one place the four words are written down.
 *
 * 🔴 Added because there were TWO of these for one concept, each masked by the other's behaviour
 * (PES.7 / PES.3, 2026-09-02): the images lane's was OPEN but three-membered and missing
 * `'sandbox'` — safe, because everything that is not `'live'` is treated as a rehearsal, but unable
 * to *say* "sandbox"; channel-ops' had all four and was CLOSED, so a mode the server adds tomorrow
 * would not typecheck. This is the union of the two: **all four members, and still open**, because
 * degrading an unrecognised mode to "not live" is the safe direction and dropping it is not.
 *
 * Only `'live'` may submit. Treat every other value, known or not, as a rehearsal.
 */
export type PublishMode = 'gated' | 'dry-run' | 'sandbox' | 'live' | (string & {})

/** Declaration order IS the order of the secondary navigation drawer. Canvas artboard "Product navigation". */
export const STUDIO_TABS: readonly StudioTabId[] = ['sheet', 'variants', 'images', 'presentation', 'variation-order', 'shopify-family', 'shopify-metafields', 'errors', 'analytics', 'activity']

/** A channel × marketplace pair. `null` on master scope — master has no coordinate. */
export interface StudioCoordinate {
  channel: string
  marketplace: string
  accountId?: string
}

/* ── what the frame derives from live marketplaces ───────────────────────────────────────── */

/** The subset of `Marketplace` the frame reads. Mirrors the API's `/marketplaces/grouped` rows. */
export interface MarketplaceLite {
  /** Ordered Marketplace.languages authority, projected by the API. */
  languages?: string[]
  accounts?: Array<{ id: string; label: string; primary: boolean }>
  id: string
  channel: string
  code: string
  name: string
  language: string
  /** False when the marketplace is configured without an active account. */
  connected?: boolean
}

export interface ChannelOption {
  /** The API's channel key — also the scope id. */
  id: string
  label: string
  /** Market codes this channel actually serves. A chip is disabled outside them. */
  markets: string[]
}

export interface MarketOption {
  code: string
  label: string
  /** Channels present in this market. */
  channels: string[]
}

export interface LocaleOption {
  code: string
  label: string
}

export interface StudioScopeOptions {
  channels: ChannelOption[]
  markets: MarketOption[]
  locales: LocaleOption[]
}

/* ── readiness (PES.5 supplies it; the frame only renders it) ────────────────────────────── */

/**
 * The SCOPE-level readiness vocabulary — four states, deliberately its own.
 *
 * The grid's per-row `ReadinessState` (`ready|missing|errors|live|unlisted`) answers "can THIS ROW
 * ship?". A scope chip answers "how far is this whole scope from shippable?", which is a different
 * question with a different set of answers. They must still LOOK like one system, which is why
 * PES.2 has been asked to export the grid's tone map rather than PES.1 re-declaring it.
 */
export type { ScopeReadinessState }

export interface ScopeReadiness extends ScopeBarReadiness {
  /** The counts the percentage came from, so the chip's tooltip can show its own arithmetic. */
  required?: { filled: number; total: number }
  /**
   * How many mapping rules this coordinate has for THIS product type (PES.5 §11).
   *
   * `0` is the machine-readable discriminator for "nothing is configured here yet" — three
   * different causes now produce `state: 'absent'`, and `note` is what tells them apart in words.
   * `null` when the server did not say.
   *
   * 🔴 Rules are per PRODUCT TYPE, so the same Amazon · IT chip is legitimately `blocked 71%` for
   * one product and `absent` for another. Readiness must never be cached per coordinate.
   */
  mappingRules?: number | null
}

/**
 * The whole query, not just its happy answer.
 *
 * `unavailable` is a first-class state, not an error: until PES.5 ships the endpoint, every chip
 * is legitimately un-scored, and a frame that silently rendered blanks would look identical to a
 * frame whose fetch had failed.
 */
export type ScopeReadinessQuery =
  /**
   * Still measuring. `slow` means it has been in flight long enough to say so in the footer — it is
   * a DISPLAY hint, never a failure: the request is alive and still wanted (§3.6).
   */
  | { status: 'loading'; slow?: boolean }
  /**
   * `coordinate` is the `productId:market` these values answer for. A re-read keeps them on screen
   * only while it matches — a different coordinate is a different question, and the old answer is
   * not a stale version of it (§3.6; measured IT→DE showing IT's 71% under a DE bar).
   */
  | { status: 'ready'; byScope: Readonly<Record<string, ScopeReadiness>>; at: number; coordinate: string }
  | { status: 'unavailable'; reason: string }
  | { status: 'error'; message: string }

/** The wire shape PES.1 asked PES.5 for (docs/pes-claims.md). */
export interface ScopeReadinessResponse {
  market: string
  scopes: Array<{ id: string } & ScopeReadiness>
}

/* ── autosave (PES.2/3 write it; the header renders it) ──────────────────────────────────── */

/**
 * The aggregate autosave state.
 *
 * 🔴 The header does not compute this and cannot. It has no view of the sheet's writes, so a
 * header that guessed "Saved" from its own timers would say so while a cell was refusing. The
 * sheet reports; the header renders what it was told (feedback_100_percent_honest_ui).
 */
export type StudioSaveState =
  | { kind: 'idle' }
  | { kind: 'saving'; pending: number }
  | { kind: 'saved'; at: number; count: number }
  | { kind: 'error'; failed: number; pending: number; message: string }

/**
 * What PES.2/PES.3 call. Keyed by a write id so overlapping writes count correctly — a sheet
 * fills a column down and forty writes are in flight at once; a boolean would report the last one.
 */
export interface SaveReporter {
  /**
   * A write has left the browser.
   *
   * `subject` is what the write is ABOUT — a row id for a sheet, an asset id for the gallery.
   * Failures are counted per SUBJECT, so a second attempt at the same row REPLACES its failure
   * instead of adding one. Callers with no subject may omit it and are counted per write, which
   * is the old behaviour and means their failures only clear via `cleared()`.
   */
  pending(writeId: string, subject?: string): void
  /** The server answered. `message` is ITS words on failure, shown verbatim. */
  resolved(writeId: string, ok: boolean, message?: string, subject?: string): void
  /**
   * Withdraw the failures for these subjects: the work is GONE, not fixed.
   *
   * 🔴 Reload-discard needs this and nothing else could express it (#693). `resolved(id, true)`
   * would clear the count by claiming a success that never happened — a lie on the one line the
   * operator trusts about their unsaved work.
   */
  cleared(subjects: readonly string[]): void
}

/* ── the record drawer (PES.4) ───────────────────────────────────────────────────────────── */

/** URL-backed so a drawer survives reload and back/forward, as PES.4 asked. */
export interface StudioRecordValue {
  rowId: string | null
  colKey: string | null
  open(rowId: string, colKey?: string): void
  close(): void
}

/* ── the product the frame renders (identity only) ───────────────────────────────────────── */

/**
 * Identity, and nothing else.
 *
 * The frame draws a name, a SKU and a status. It deliberately does NOT load attributes, listings,
 * children or images — those belong to the tab that shows them, and loading them here would put
 * the old edit page's five-fetch cold start back in front of a sheet that does not need it.
 */
export interface StudioProduct {
  id: string
  sku: string
  name: string | null
  status: string | null
  isParent: boolean
  parentId: string | null
  productType: string | null
  /**
   * The Amazon ASIN, when the product has one. Already carried by `GET /api/products/:id` as
   * `amazonAsin` — no new backend field was needed for parity row 1.6.
   */
  asin: string | null
}

/**
 * The family a CHILD product belongs to (parity 1.29 / 8.11).
 *
 * Identity only, and fetched only when `parentId` is set. The old page's banner also listed sibling
 * chips; in the studio the SHEET is the family — it renders the parent and every variation as rows —
 * so duplicating the siblings in a banner would be a second, staler list of the same thing. What the
 * sheet cannot say is "the row you are on belongs to THIS parent, here is the way up", which is
 * identity, and identity is the header's job.
 */
export interface StudioFamily {
  parentId: string
  parentSku: string
  parentName: string | null
  parentAsin: string | null
}

/* ── view chips (the View bar's filtered views) ──────────────────────────────────────────── */

/**
 * The cells a chip is about, as `rowId → affected column ids`.
 *
 * Cell-level and not two flat lists, because "rows AND columns" is a projection of this and the
 * reverse is not: from `{rows, cols}` you cannot tell WHICH cell in the rectangle was the reason,
 * so a renderer could not highlight the seven actually-missing cells inside a 7 × 12 grid. Rows are
 * the keys; columns are the union of the values (`viewChipRows` / `viewChipColumns` derive both).
 */
export interface ViewChipCells {
  byRow: Readonly<Record<string, readonly string[]>>
}

export interface ViewChip {
  compactLabel?: string
  /** Counted unit. Information defaults to columns; row filters declare variants. */
  noun?: 'columns' | 'variants' | 'combinations' | 'axes'
  /** Stable, and the URL value when this chip is selected — `missing-required`, `ai-drafts`. */
  id: string
  label: string
  tone?: 'warning' | 'danger' | 'info' | 'neutral'
  /**
   * 🔴 `null` is NOT zero. `null` means nobody has counted yet (the fetch is in flight, or the
   * endpoint that would answer is not there); `0` means counted, and there are none. A renderer
   * shows `null` as a pending chip with no number and must never print `(0)` for it — that would
   * state "we checked, there are none" on the strength of not having checked.
   */
  count: number | null
  /** Hide the chip entirely at a REAL zero. Default true: "Missing required (0)" is noise. */
  hideWhenZero?: boolean
  /** Why the count is `null`, or what the chip means. The producer's own words. */
  note?: string
  /** Empty while `count` is null. */
  cells: ViewChipCells
}
