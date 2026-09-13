/**
 * VT.1 — the ONE variation-theme parser, and the ONE attribute binding.
 *
 * Design `docs/2026-09-13-variation-theme-column-design.md` §3.2; contract `docs/vt1-contracts.md` §2.1.
 *
 * Why this file exists. The codebase had THREE ways to read a theme string and they disagreed:
 * `parseThemeAxes` (`ebay-theme-axes.ts`, splits `, / | ;`, caps 5 — eBay's SET store),
 * `ffcParseThemeAxes` (`amazon/flat-file.service.ts`) and an inline `.split('/')` in the publish adapter. Worse,
 * the adapter guessed the ATTRIBUTE a segment writes with `` `${axis}_name` `` — and VT.0 measured (T15) that
 * `color_name` / `size_name` / `style_name` / `material_type` do not exist on OUTERWEAR at all, on IT or DE. So
 * that fallback named attributes Amazon does not have: a live defect on any push that reached it.
 *
 * Everything here is DERIVED from the cached product-type schema. Nothing is a synonym table, a suffix list or a
 * remembered spelling: a candidate binding is accepted only when the schema's `properties` actually declares it.
 *
 * PURE — no prisma, no fetch, no clock. It is probed with `tsx` and unit-tested with no database.
 */

import { canonicalVariantAxis } from './variant-attribute-keys.js'

/** The theme string's segments. Amazon joins with `/`; a stray space or empty segment is dropped. */
export function themeSegments(theme: string | null | undefined): string[] {
  if (typeof theme !== 'string') return []
  return theme.split('/').map((s) => s.trim()).filter(Boolean)
}

/**
 * A theme SEGMENT is not an axis label.
 *
 * `canonicalVariantAxis('COLOR_NAME')` is `colorname`, NOT `color` — it strips separators, so the `_NAME`
 * vocabulary survives as part of the key and the two spellings of the same relationship canonicalise apart.
 * Strip a trailing `NAME` token FIRST, then canonicalise. (`STYLE_NAME` reaches `style` either way, because
 * `canonicalVariantAxis` happens to map `stylename`; the other segments do not.)
 */
export function canonicalThemeSegment(segment: string): string {
  return canonicalVariantAxis(String(segment ?? '').replace(/_?NAME$/i, ''))
}

/** The canonical axis keys a theme delivers, in the theme's own order. */
export function canonicalThemeKeys(theme: string | null | undefined): string[] {
  return themeSegments(theme).map(canonicalThemeSegment)
}

/**
 * `'' ` IS NOT A THEME (T16). `GALE-JACKET-BLACK-MEN-XS` carries `variationTheme = ""` on an ACTIVE Amazon·IT
 * row — on prod and on local. An empty string read as an override would pin the coordinate to "no theme" and
 * hide the derivation for ever, so every reader normalises through here.
 */
export function normaliseStoredTheme(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

// ────────────────────────────────────────────────────────────────────
// The schema side
// ────────────────────────────────────────────────────────────────────

/** The subset of a cached Amazon product-type schema this module reads. Nothing else is needed. */
export interface ThemeSchemaFacts {
  /** `properties` at the schema root — the ONLY evidence that an attribute exists. */
  properties: Record<string, { title?: unknown } | undefined>
  /** `variation_theme.items.properties.name.enum`. */
  themes: string[]
  /** `…name.$lifecycle.enumDeprecated` — values Amazon still OFFERS but marks dead. */
  deprecated: string[]
}

/**
 * Read the theme enum, its deprecated values and the property titles out of a cached schema definition.
 *
 * The enum's home is `variation_theme.items.properties.name` (`schema-sync.service.ts:495-513` writes
 * `CategorySchema.variationThemes` from exactly that), and the deprecation marker sits on the SAME node that
 * carries the enum — the placement `services/amazon/flat-file.service.ts:findEnumDeprecated` verified against 49
 * cached definitions. That module is UNTOUCHABLE (design Appendix B) and pulls prisma, stock movements and the
 * schema-sync service into its module graph, so this pure module has its own four-line reader, PINNED by
 * `variation-theme-segments.vitest.test.ts` which asserts both readers return the identical list on a real node.
 */
export function themeSchemaFacts(schemaDefinition: unknown): ThemeSchemaFacts {
  const root = (schemaDefinition ?? {}) as Record<string, any>
  const properties = (root.properties ?? {}) as Record<string, any>
  const name = properties?.variation_theme?.items?.properties?.name ?? {}
  const themes = Array.isArray(name.enum) ? name.enum.map(String).filter(Boolean) : []
  const deprecatedRaw = name?.$lifecycle?.enumDeprecated
  const deprecated = Array.isArray(deprecatedRaw) ? deprecatedRaw.map(String).filter(Boolean) : []
  return { properties, themes, deprecated }
}

/**
 * Which ATTRIBUTE a theme segment writes — resolved against the schema's own `properties`, never by convention.
 *
 * The rule, in order, and every candidate must EXIST as a property:
 *   1. `lower(segment)`                                  `TEAM_NAME` → `team_name` where the PT declares it
 *   2. the same with a trailing `_name` removed          `COLOR_NAME` → `color`, `SIZE_NAME` → `size`
 *   3. progressively shorter underscore-token prefixes   `MATERIAL_TYPE` → `material`
 *   4. the property whose own name CANONICALISES to the segment's canonical key (`Colore`-style spellings)
 * …and when none of them exists, **unbound** — reported, never guessed. A missing binding is a readiness item
 * (`attribute-unbound`) and a warning-toned segment in the cell; it is NEVER silently turned into `color_name`.
 *
 * 🔴 Step 3 is wider than design §3.2's two steps, and it is what makes the doc's own example true: the doc says
 * `MATERIAL_TYPE → material` on OUTERWEAR, which steps 1–2 cannot produce (`material_type` is ABSENT — T15).
 * Step 3 is still derived, because a prefix is only accepted if the schema declares it; measured across every
 * cached Amazon schema in `variation-theme-segments.vitest.test.ts`.
 */
export function bindSegmentToAttribute(
  segment: string,
  properties: Record<string, unknown>,
): { attribute: string; via: 'exact' | 'name-suffix' | 'prefix' | 'canonical' } | null {
  const has = (k: string) => k.length > 0 && Object.prototype.hasOwnProperty.call(properties ?? {}, k)
  const lower = String(segment ?? '').trim().toLowerCase()
  if (!lower) return null
  if (has(lower)) return { attribute: lower, via: 'exact' }

  const withoutName = lower.replace(/_?name$/, '')
  if (withoutName !== lower && has(withoutName)) return { attribute: withoutName, via: 'name-suffix' }

  // Longest surviving prefix first, so `MATERIAL_TYPE` prefers `material_type` over `material` when both exist.
  const tokens = lower.split('_').filter(Boolean)
  for (let take = tokens.length - 1; take >= 1; take--) {
    const candidate = tokens.slice(0, take).join('_')
    if (has(candidate)) return { attribute: candidate, via: 'prefix' }
  }

  const wanted = canonicalThemeSegment(segment)
  for (const key of Object.keys(properties ?? {})) {
    if (key.startsWith('__')) continue
    if (canonicalVariantAxis(key) === wanted) return { attribute: key, via: 'canonical' }
  }
  return null
}

/**
 * The human label for a bound attribute: the schema's own `title`, in the marketplace's language
 * (`Colore`/`Taglia` on IT, `Farbe`/`Größe` on DE).
 *
 * NOT `enumNames`: Amazon's localized theme labels are machine-cased — measured 2026-09-13, IT says
 * `COLORE/DIMENSIONI` and DE `FARBE/GRÖSSE` for `COLOR/SIZE`. Those are not words an operator should read.
 */
export function attributeTitle(attribute: string | null, properties: Record<string, unknown>): string | null {
  if (!attribute) return null
  const node = (properties ?? {})[attribute] as { title?: unknown } | undefined
  return typeof node?.title === 'string' && node.title.trim() ? node.title.trim() : null
}

export interface ThemeMatch {
  /** The enum value. */
  code: string
  /** Canonical keys it delivers, in the theme's order. */
  keys: string[]
  deprecated: boolean
  /** True when it has no `_NAME` segment. */
  bare: boolean
}

/** Every enum value, classified — the raw material for both the derivation and the editor's candidate list. */
export function classifyThemes(facts: ThemeSchemaFacts): ThemeMatch[] {
  const dead = new Set(facts.deprecated)
  return facts.themes.map((code) => ({
    code,
    keys: canonicalThemeKeys(code),
    deprecated: dead.has(code),
    bare: !themeSegments(code).some((s) => /_?NAME$/i.test(s)),
  }))
}

export type ThemeTieBreak = 'only-match' | 'only-live' | 'bare-form' | 'set-order'

/**
 * Derive the Amazon theme for a family's ordered canonical axes (D-VT8).
 *
 * Measured on this catalogue: the in-order arm matches TWO spellings for 35 of 35 family × marketplace pairs, so
 * the tie-break is load-bearing for 100% of the catalogue, not an edge case. It resolves in this order:
 *   • exactly one in-order match                        → `only-match`
 *   • several, exactly one NOT deprecated               → `only-live`   ← what fires on OUTERWEAR
 *   • several live ones, prefer the BARE spelling       → `bare-form`
 *   • none in order but some as a SET                   → `set-order` (the theme's order wins; the editor says so)
 *   • nothing                                           → null → `theme-unset`
 */
export function deriveAmazonTheme(
  wantedKeys: string[],
  facts: ThemeSchemaFacts,
): { match: ThemeMatch; tieBreak: ThemeTieBreak } | null {
  if (wantedKeys.length === 0) return null
  const all = classifyThemes(facts)
  const sameLength = all.filter((t) => t.keys.length === wantedKeys.length)
  const inOrder = sameLength.filter((t) => t.keys.every((k, i) => k === wantedKeys[i]))

  const pick = (pool: ThemeMatch[], fallback: ThemeTieBreak): { match: ThemeMatch; tieBreak: ThemeTieBreak } => {
    if (pool.length === 1) return { match: pool[0], tieBreak: fallback === 'set-order' ? 'set-order' : 'only-match' }
    const live = pool.filter((t) => !t.deprecated)
    if (live.length === 1) return { match: live[0], tieBreak: fallback === 'set-order' ? 'set-order' : 'only-live' }
    const consider = live.length > 0 ? live : pool
    const bare = consider.filter((t) => t.bare)
    const chosen = (bare.length > 0 ? bare : consider)[0]
    return { match: chosen, tieBreak: fallback === 'set-order' ? 'set-order' : 'bare-form' }
  }

  if (inOrder.length > 0) return pick(inOrder, 'only-match')

  const want = [...wantedKeys].sort().join('|')
  const asSet = sameLength.filter((t) => [...t.keys].sort().join('|') === want)
  if (asSet.length > 0) return pick(asSet, 'set-order')
  return null
}

/** What a candidate theme would DROP, given the family's axes: the axes it does not deliver, in family order. */
export function dropsForTheme(themeKeys: string[], wantedKeys: string[]): string[] {
  const delivered = new Set(themeKeys)
  return wantedKeys.filter((k) => !delivered.has(k))
}

/**
 * What a candidate theme would ADD: segments it delivers that the family does not vary by.
 *
 * Measured, and the reason this function exists: on OUTERWEAR-IT **thirteen** of the 50 themes deliver colour and
 * size and therefore "drop nothing" (`MATERIAL/SIZE/COLOR`, `TEAM_NAME/SIZE/COLOR`,
 * `SPECIAL_SIZE_TYPE/SIZE_NAME/COLOR_NAME`, ...), while only **four** cover the family exactly. Choosing one of
 * the other nine is not free: Amazon would require a value for the extra segment on every child. Grouping them
 * under `Covers every axis` with no further word would offer nine choices that silently demand new data, so the
 * editor is told which ones ADD an axis. The derivation itself never picks them - it only considers themes with
 * the same segment COUNT as the family's axis list.
 */
export function addsForTheme(themeKeys: string[], wantedKeys: string[]): string[] {
  const wanted = new Set(wantedKeys)
  const out: string[] = []
  for (const k of themeKeys) if (!wanted.has(k) && out.indexOf(k) < 0) out.push(k)
  return out
}

/**
 * eBay's marketplace id — the key `__lastPublishedAxes` is written under.
 *
 * MOVED here from `family-projection.service.ts` (where it was a file-local const) so the projection read and the
 * variation resolver address that store with ONE rule. Two callers deriving "EBAY_IT" separately is the
 * two-builders trap at the size of a string template.
 */
export const marketplaceIdFor = (channel: string, market: string): string =>
  String(channel ?? '').toUpperCase() === 'EBAY' ? `EBAY_${String(market ?? '').toUpperCase()}` : String(market ?? '').toUpperCase()
