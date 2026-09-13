/**
 * VT.3 — the Variations group's copy and derivations, as PURE functions.
 *
 * Why a separate module: every sentence this group prints is verbatim copy from
 * `docs/2026-09-13-variation-theme-column-design.md` Appendix A and
 * `docs/2026-09-12-variation-projection-design.md` Appendix C. Copy that lives inside JSX can only
 * be checked by looking at a screenshot; copy that lives here is checked by a test that names the
 * sentence. `apps/web`'s vitest is node-only, so nothing in this file may touch the DOM or React.
 *
 * The other rule this file exists to hold: **no count is computed here.** Every number the group
 * shows arrives on `VariationRuleView` from the wire. These functions only choose WHICH number and
 * WHICH words — a page that adds up its own totals is a page that can disagree with the server it
 * is reporting on.
 */

import type {
  CollisionResolverKind, ListingSplitMode, VariationRuleAxis, VariationRuleView,
  VariationRuleWrite, VariationThemeOption, VariationValueMapCount,
} from './contracts'

/** The group's own title and row labels — VX Appendix C, verbatim. */
export const VARIATIONS_COPY = {
  title: 'Variations',
  rowRule: 'Rule',
  rowTheme: 'Theme',
  rowAxes: 'Axes on channel',
  rowCollisions: 'Collisions',
  rowSplit: 'Listing split',
  rowValueMaps: 'Value maps',
  rowAxisNames: 'Axis names',
  rowPreviewSku: 'Preview SKU',
  list: 'List',
  derived: 'derived',
  openValueMaps: 'Open value maps',
  previewPayload: 'Preview payload',
  previewHint: 'the same preview dock as the studio, dry-run through the publish adapter',
  noneDropped: 'none dropped',
  noValueMap: 'none',
  saveRule: 'Save rule',
  activate: 'Activate standing rule',
  simulating: 'Simulating…',
  saving: 'Saving…',
  blastRadiusTitle: 'Before this rule saves',
} as const

/** Appendix C's resolver labels. `fold` is split around its axis Listbox, so it carries two halves. */
export const RESOLVER_COPY: Record<CollisionResolverKind, { label: string; suffix?: (separator: string) => string }> = {
  split: { label: 'Split per dropped axis' },
  fold: { label: 'Fold into', suffix: (separator) => `with “${separator}”` },
  exclude: { label: 'Exclude the duplicates' },
}

/** VX §6's own order: split · fold · exclude. The wire says which are available, never this table. */
export const RESOLVER_ORDER: CollisionResolverKind[] = ['split', 'fold', 'exclude']

export const SPLIT_COPY: Record<ListingSplitMode, string> = {
  one: 'One listing',
  'per-axis': 'One per',
}

export const SPLIT_ORDER: ListingSplitMode[] = ['one', 'per-axis']

/**
 * The Rule line. Appendix A fixes the no-rule sentence verbatim:
 * `No rule — <n> families follow the derived theme`. With a rule, the server's own `ruleLabel` is
 * printed through the `Follows rule <label>` frame Appendix A also fixes — the page never composes
 * a rule name of its own.
 */
export function ruleLineText(view: VariationRuleView): string {
  if (view.source === 'rule') {
    return view.ruleLabel ? `Follows rule ${view.ruleLabel}` : 'Follows rule'
  }
  return `No rule — ${view.counts.follow} families follow the derived theme`
}

/** `Write a rule for <category>` (Appendix A frame + the server's category label). */
export function writeRuleLabel(view: VariationRuleView): string {
  return `Write a rule for ${view.categoryLabel}`
}

/**
 * The header's count line — `38 follow · 3 override · 0 collide` (canvas artboard 6; VX Appendix C
 * fixes the first two words). Returned as parts so the numbers can be bold without the component
 * re-splitting a sentence.
 */
export function headerCounts(view: VariationRuleView): Array<{ n: number; word: string }> {
  return [
    { n: view.counts.follow, word: 'follow' },
    { n: view.counts.override, word: 'override' },
    { n: view.counts.collide, word: 'collide' },
  ]
}

/**
 * design §3.7's one addition to VX: with no rule, the derivation for this category's most common
 * axis set — `colour × size → COLOR/SIZE on 9 of 9 families`. `null` when the server did not derive
 * one, which is a different state from "derived nothing" and must not print an empty frame.
 */
export function derivationSentence(view: VariationRuleView): string | null {
  const d = view.derivation
  if (!d || view.source === 'rule') return null
  const target = d.themeCode ?? d.themeLabel
  /**
   * The `on <n> of <m> families` clause earns its place only when the two numbers DIFFER — that is
   * the informative case ("on 9 of 12 families" says the category is not uniform). When they agree
   * it restates the count the Rule sentence beside it already gives, and measured at a 1440 content
   * width (group 1022) that restatement is what pushed the row to a second line: 69.84px with it,
   * 41px without. Shorter here is not a shortcut; the number is still on screen, once.
   */
  const scope = d.families === d.familiesTotal ? '' : ` on ${d.families} of ${d.familiesTotal} families`
  if (!target) return `${d.axisSummary}${scope || ` on ${d.families} families`}`
  return `${d.axisSummary} → ${target}${scope}`
}

/**
 * The Theme row's hint — `Amazon only · the product type's enum, 50 values on DE` (canvas). The
 * count is `options.length` from the wire; it is not a constant, because the enum is per product
 * type and per market (measured on this catalogue: 50 on AMAZON·DE·OUTERWEAR).
 */
export function themeHintText(view: VariationRuleView): string | null {
  if (!view.theme) return null
  return `Amazon only · the product type’s enum, ${view.theme.options.length} values on ${view.market}`
}

/** The Theme listbox's own option text: the enum code and the localized label the wire derived. */
export function themeOptionLabel(option: VariationThemeOption): string {
  const label = option.label && option.label !== option.code ? ` · ${option.label}` : ''
  const flags = [
    option.coversAll ? null : option.drops.length ? `drops ${option.drops.join(', ')}` : null,
    option.deprecated ? 'deprecated' : null,
  ].filter(Boolean)
  return `${option.code}${label}${flags.length ? ` — ${flags.join(' · ')}` : ''}`
}

/**
 * The Axes row's trailing hint. `none dropped` when nothing is, and otherwise the dropped axes BY
 * NAME (VX §6: "a dropped axis is shown as dropped, by name" — an axis silently missing is the
 * two-column-builders trap in another vocabulary). The names come from `axes`, so a dropped key the
 * axis list does not carry still prints its key rather than vanishing.
 */
export function droppedText(view: VariationRuleView): string {
  if (view.dropped.length === 0) return VARIATIONS_COPY.noneDropped
  const names = view.dropped.map((key) => view.axes.find((a) => a.axisKey === key)?.label ?? key)
  return `${names.join(' · ')} dropped`
}

/** One value-map line — `colour: 12 mapped · 2 unreviewed`, or `size: none`. */
export function valueMapText(map: VariationValueMapCount): { label: string; mapped: number | null; unreviewed: number } {
  if (map.mapped === 0 && map.unreviewed === 0) return { label: map.label, mapped: null, unreviewed: 0 }
  return { label: map.label, mapped: map.mapped, unreviewed: map.unreviewed }
}

/**
 * The blast radius the save simulation prints before it commits — the prompt's sentence verbatim:
 * `<n> products follow this rule · <m> would gain a collision`. Both numbers are the SERVER's
 * answer to the dry-run PUT, never the view's stale counts.
 */
export function blastRadiusSentence(simulation: { follow: number; wouldCollide: number }): string {
  return `${simulation.follow} products follow this rule · ${simulation.wouldCollide} would gain a collision`
}

/**
 * `[List]` → the catalogue, filtered to the families this line is about (design §3.7).
 * The filter value is `source.kind`'s vocabulary minus `none`; `none` has nothing to list that is
 * not already the derived set, so it lists `derived`.
 */
export function variationMappingListHref(view: VariationRuleView): string {
  const query = new URLSearchParams({
    filter: `variation-mapping:${VARIATION_MAPPING_LIST_VALUES.join('|')}`,
    channel: view.channel,
    market: view.market,
  })
  /**
   * `/products`, not the doc's `/products/next`: measured 2026-09-13 07:3x, `next.config.js:87`
   * permanently redirects `/products/next → /products` (query preserved) and
   * `products/next/page.tsx` calls itself a "legacy entry point". The link followed the redirect
   * correctly on screen; pointing at the live path just removes the 308.
   */
  return `/products?${query}`
}

/**
 * The three tiers the button lists, in design §3.7's own order and spelling
 * (`variation-mapping:derived|rule|overridden`). Not narrowed to this line's `source`: the header
 * beside the button counts all three (`38 follow · 3 override · 0 collide`), so listing only one of
 * them would answer a question the button does not ask.
 *
 * 🔴 Measured 2026-09-13 06:22Z, correcting an earlier reading of mine: `/products/next` DOES read
 * this parameter now — `ProductsNextClient.tsx:251` calls `parseVariationMappingFilter(searchParams
 * .get('filter'))`, whose vocabulary is `derived | rule | overridden | unset | collides`
 * (`variationMappingFilter.ts:40`) and whose own test pins this exact string. An earlier VT.3
 * measurement at ~05:2xZ found no `filter` reader; it landed in between. The values below are
 * checked against that module's list by this file's test, so a rename there fails here.
 */
export const VARIATION_MAPPING_LIST_VALUES = ['derived', 'rule', 'overridden'] as const

/** Only the axes this coordinate actually delivers, in delivery order — what the chips show. */
export function includedAxes(view: VariationRuleView): VariationRuleAxis[] {
  return view.axes.filter((a) => a.included)
}

/**
 * Amazon's theme FIXES the axis order (the enum's segment order is the delivery order), so the
 * mapping page offers no reorder control there — changing the theme is how the order changes.
 * Every other channel orders its own axes, which is where the DS's `OrderedList` grip belongs.
 * Derived from the wire (`theme !== null`), never from a channel name.
 */
export function axisOrderIsThemeDriven(view: VariationRuleView): boolean {
  return view.theme !== null
}

/** The fold resolver needs an axis that is actually delivered; `split` needs aliases (held). */
export function resolverAvailability(
  view: VariationRuleView, kind: CollisionResolverKind,
): { available: boolean; reason: string | null } {
  const stated = view.collisions.resolvers.find((r) => r.kind === kind)
  if (stated) return { available: stated.available, reason: stated.reason }
  return { available: false, reason: 'This resolver was not offered for this coordinate.' }
}

/**
 * The draft the group PUTs. `included` rides along so a dropped axis stays named in the rule rather
 * than disappearing from it — the wire needs the whole list, exactly as the projection PATCH does
 * (`docs/vt1-contracts.md` §3.2: "an axis left out is unmapped; a partial patch cannot express a
 * removal").
 */
export function buildVariationWrite(view: VariationRuleView, dryRun: boolean): VariationRuleWrite {
  return {
    expectedToken: view.expectedToken,
    dryRun,
    rule: {
      theme: view.theme?.code ?? null,
      axes: view.axes.map((a, order) => ({ axisKey: a.axisKey, target: a.target, order, included: a.included })),
      collisions: {
        resolver: view.collisions.resolver,
        foldInto: view.collisions.foldInto,
        foldSeparator: view.collisions.foldSeparator,
      },
      split: { mode: view.split.mode, axisKey: view.split.axisKey },
    },
  }
}

/**
 * True when the draft differs from what the server served — the save controls appear only then.
 * Compared on the WRITE body, so a field the write does not carry cannot make the group look dirty.
 */
export function isDirty(saved: VariationRuleView, draft: VariationRuleView): boolean {
  return JSON.stringify(buildVariationWrite(saved, false)) !== JSON.stringify(buildVariationWrite(draft, false))
}

/**
 * Choosing a theme re-derives which axes survive it: the enum value's own `drops` list decides
 * inclusion, and its segment order decides delivery order. Pure, so the test can pin it — this is
 * the one place on the page where a control changes more than the field it sits on.
 */
export function applyTheme(view: VariationRuleView, code: string): VariationRuleView {
  if (!view.theme) return view
  const option = view.theme.options.find((o) => o.code === code)
  if (!option) return view
  const dropped = new Set(option.drops)
  return {
    ...view,
    theme: { ...view.theme, code: option.code, label: option.label },
    axes: view.axes.map((a) => ({ ...a, included: !dropped.has(a.axisKey) })),
    dropped: option.drops,
  }
}

/** Reordering is a list permutation by axisKey — `OrderedList` hands back the ids in their new order. */
export function applyAxisOrder(view: VariationRuleView, axisKeys: readonly string[]): VariationRuleView {
  const byKey = new Map(view.axes.map((a) => [a.axisKey, a]))
  const next = axisKeys.map((key) => byKey.get(key)).filter((a): a is VariationRuleAxis => a != null)
  return next.length === view.axes.length ? { ...view, axes: next } : view
}
