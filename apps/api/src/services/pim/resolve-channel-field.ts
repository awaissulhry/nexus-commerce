/**
 * FM.2 — Unified channel-field resolver.
 *
 * The single per-coordinate read-path for "what value should channel
 * field F carry for this (product, channel, marketplace, variant?)",
 * composing the FM.1 catalog mapping rule (source/fallback + transforms)
 * with the FL per-product link groups and per-coordinate overrides, and
 * returning the value + provenance + flags. preview / validate (today)
 * and cascade / sync (FM.5–FM.8) all call this so "what you preview" ==
 * "what ships".
 *
 * This module is the leaf "core": it owns the shared primitives
 * (resolveSourcePath, applyTransforms, isPresent) that publish-validator
 * (D.5) and payload-preview (D.6) previously defined locally. They now
 * import from here, which keeps a single source of truth for path
 * resolution + transforms and avoids an import cycle.
 *
 * Precedence (highest → lowest):
 *   1. missing      source + fallback + default all empty (surfaced so
 *                   validation can block on required fields)
 *   2. locked       identity field pinned to master (GTIN/SKU/brand)
 *   3. override      per-coordinate pin — the rule's source resolved to a
 *                   ChannelListing *Override / overrideData value
 *                   (detected via attribute-resolver provenance)
 *   4. linked        coordinate is a FieldLinkGroup member (value tracks
 *                   master; cross-language TRANSLATE flags needsTranslation)
 *   5. fallback      rule.source empty → rule.fallback supplied the value
 *   6. default       a `default` transform fired on an empty source
 *   7. catalogRule   value mapped from master via rule.source + transforms
 *
 * VALUE INVARIANT (FM.2): the resolved value equals the legacy
 * (resolveSourcePath → applyTransforms) result in every case. The link
 * layer only enriches provenance + needsTranslation; a FieldLinkGroup
 * stores no canonical value (linked members track master, translated at
 * propagation time — FM.5). This is what lets payload-preview's existing
 * `source`/`payload`/`missingRequired` output stay byte-identical while
 * the richer `provenance`/`needsTranslation` ride alongside.
 */

import type { ResolvedAttributes, ValueSource } from './attribute-resolver.js'
import type { FieldMappingRule, TransformOp } from './schema-mapping.service.js'
import { languageForMarketplace } from '../products/translation-resolver.service.js'

// ────────────────────────────────────────────────────────────────────
// Shared primitives (moved here from publish-validator / payload-preview)
// ────────────────────────────────────────────────────────────────────

/** Empty = null/undefined, '' (after trim), or []. 0 and false are NOT
 *  empty (a real price/flag value). */
export function isPresent(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === 'string' && v.trim() === '') return false
  if (Array.isArray(v) && v.length === 0) return false
  return true
}

/**
 * Resolve a dotted source path like 'localizedContent.{locale}.title'
 * against the flat resolver output. The resolver already merges every
 * layer into one shape so this is just a key-path walk + {locale}
 * substitution.
 *
 * Supported syntax:
 *   - `title`                              top-level resolver key
 *   - `localizedContent.{locale}.title`    {locale} substituted; the
 *                                          path then walks into the
 *                                          original Product object
 *   - `categoryAttributes.material`        walks into raw Product field
 *   - `variantAttributes.Color`            ditto
 */
export function resolveSourcePath(
  path: string,
  resolved: Record<string, unknown>,
  product: { localizedContent: unknown; categoryAttributes: unknown; variantAttributes: unknown },
  locale: string,
): unknown {
  if (!path || typeof path !== 'string') return null
  const substituted = path.replace(/\{locale\}/g, locale)

  // Single-segment paths read straight from the resolved map.
  if (!substituted.includes('.')) {
    return resolved[substituted] ?? null
  }

  // Multi-segment paths walk into the raw Product structure. This lets
  // mapping rules use deep paths even when the resolver didn't lift the
  // key into its top-level shape.
  const segments = substituted.split('.')
  const root = segments[0]
  const rest = segments.slice(1)

  let cursor: unknown
  switch (root) {
    case 'localizedContent':
      cursor = product.localizedContent
      break
    case 'categoryAttributes':
      cursor = product.categoryAttributes
      break
    case 'variantAttributes':
      cursor = product.variantAttributes
      break
    default:
      // Unknown root → try resolved map first (handles `title.foo`
      // style paths where `title` resolved to an object).
      cursor = resolved[root] ?? null
  }

  for (const seg of rest) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return null
    cursor = (cursor as Record<string, unknown>)[seg]
  }
  return cursor ?? null
}

/**
 * Lookup/format context for the FM.3 data-backed transform ops. All
 * fields optional: when absent, valueMap/sizeScale no-op with a warning
 * (the FM.4 store + FM.9 manifest wire them up) and template/channelLimit
 * fall back to their inline inputs.
 */
export interface TransformContext {
  /** Flat resolved attribute values, for {{attr}} template interpolation. */
  values?: Record<string, unknown>
  /** FM.4 — canonical value → channel/market value (e.g. Rosso → Red);
   *  null on a miss. */
  lookupValueMap?: (attribute: string, fromValue: string) => string | null
  /** FM.4 — size across systems (e.g. EU 52 → UK "L"); null on a miss. */
  lookupSizeScale?: (scale: string, from: string, to: string, value: string) => string | null
  /** FM.9 — channel field max length from the manifest, for channelLimit. */
  maxLength?: number
}

// ── FM.3 transform helpers (pure) ───────────────────────────────────

// Unit conversion via a base unit per dimension. Returns null when the
// two units aren't in the same known dimension.
const WEIGHT_TO_GRAMS: Record<string, number> = { mg: 0.001, g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237 }
const LENGTH_TO_MM: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 }

function convertUnit(value: number, from: string, to: string): number | null {
  const f = from.toLowerCase()
  const t = to.toLowerCase()
  for (const table of [WEIGHT_TO_GRAMS, LENGTH_TO_MM]) {
    if (f in table && t in table) return (value * table[f]) / table[t]
  }
  return null
}

function formatNumber(
  n: number,
  decimals: number | undefined,
  decimalSep: string,
  thousandsSep: string,
): string {
  const fixed = decimals != null ? n.toFixed(decimals) : String(n)
  const [intPart, fracPart] = fixed.split('.')
  const grouped = thousandsSep ? intPart.replace(/\B(?=(\d{3})+(?!\d))/g, thousandsSep) : intPart
  return fracPart != null ? `${grouped}${decimalSep}${fracPart}` : grouped
}

function interpolateTemplate(expr: string, values: Record<string, unknown>): string {
  return expr.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key) => {
    const v = values[key]
    return v == null ? '' : String(v)
  })
}

/** Apply transforms in order. Each transform mutates the value;
 *  warnings collect anything that's worth surfacing without blocking
 *  (e.g. truncated content). Unknown transform types are skipped with
 *  a warning rather than throwing so a partial rule doesn't sink the
 *  whole preview. */
export function applyTransforms(
  value: unknown,
  transforms: TransformOp[] | undefined,
  warnings: string[],
  ctx?: TransformContext,
): { out: unknown; applied: TransformOp['type'][] } {
  if (!transforms || transforms.length === 0) return { out: value, applied: [] }
  let current: unknown = value
  const applied: TransformOp['type'][] = []
  for (const t of transforms) {
    try {
      switch (t.type) {
        case 'truncate': {
          if (typeof current !== 'string') {
            warnings.push(`truncate skipped — value is not a string`)
            break
          }
          const max = t.max ?? Infinity
          if (current.length > max) {
            warnings.push(`truncated from ${current.length} → ${max}`)
            current = current.slice(0, max)
          }
          applied.push('truncate')
          break
        }
        case 'titleCase':
          if (typeof current !== 'string') {
            warnings.push('titleCase skipped — value is not a string')
            break
          }
          current = current.replace(/\b\w/g, (c) => c.toUpperCase())
          applied.push('titleCase')
          break
        case 'lowerCase':
          if (typeof current !== 'string') {
            warnings.push('lowerCase skipped — value is not a string')
            break
          }
          current = current.toLowerCase()
          applied.push('lowerCase')
          break
        case 'upperCase':
          if (typeof current !== 'string') {
            warnings.push('upperCase skipped — value is not a string')
            break
          }
          current = current.toUpperCase()
          applied.push('upperCase')
          break
        case 'prepend':
          if (typeof current !== 'string') {
            warnings.push('prepend skipped — value is not a string')
            break
          }
          current = String(t.value ?? '') + current
          applied.push('prepend')
          break
        case 'append':
          if (typeof current !== 'string') {
            warnings.push('append skipped — value is not a string')
            break
          }
          current = current + String(t.value ?? '')
          applied.push('append')
          break
        case 'replace':
          if (typeof current !== 'string') {
            warnings.push('replace skipped — value is not a string')
            break
          }
          try {
            const re = new RegExp(t.pattern ?? '', 'g')
            current = current.replace(re, t.replacement ?? '')
            applied.push('replace')
          } catch (e: any) {
            warnings.push(`replace failed — invalid regex: ${e?.message ?? 'unknown'}`)
          }
          break
        case 'default':
          // `default` only fires when the current value is empty.
          if (!isPresent(current)) {
            current = t.value ?? null
            applied.push('default')
          }
          break
        // ── FM.3 ────────────────────────────────────────────────────
        case 'unit': {
          const num = typeof current === 'number' ? current : Number(current)
          if (!Number.isFinite(num)) {
            warnings.push('unit skipped — value is not numeric')
            break
          }
          const converted = convertUnit(num, t.from, t.to)
          if (converted == null) {
            warnings.push(`unit skipped — cannot convert ${t.from}→${t.to}`)
            break
          }
          current = converted
          applied.push('unit')
          break
        }
        case 'numberFormat': {
          const num = typeof current === 'number' ? current : Number(current)
          if (!Number.isFinite(num)) {
            warnings.push('numberFormat skipped — value is not numeric')
            break
          }
          current = formatNumber(num, t.decimals, t.decimalSep ?? '.', t.thousandsSep ?? '')
          applied.push('numberFormat')
          break
        }
        case 'template':
          current = interpolateTemplate(t.expr ?? '', ctx?.values ?? {})
          applied.push('template')
          break
        case 'channelLimit': {
          if (typeof current !== 'string') {
            warnings.push('channelLimit skipped — value is not a string')
            break
          }
          const max = t.max ?? ctx?.maxLength
          if (max != null && current.length > max) {
            if (t.mode === 'flag') {
              warnings.push(`exceeds channel limit ${current.length} > ${max}`)
            } else {
              warnings.push(`channel-limited from ${current.length} → ${max}`)
              current = current.slice(0, max)
            }
          }
          applied.push('channelLimit')
          break
        }
        case 'valueMap': {
          if (!ctx?.lookupValueMap) {
            warnings.push('valueMap skipped — no value-map context (FM.4)')
            break
          }
          if (current == null) break
          const mapped = ctx.lookupValueMap(t.attribute, String(current))
          if (mapped != null) {
            current = mapped
          } else if (t.onMiss === 'null') {
            current = null
          } else if (t.onMiss === 'flag') {
            warnings.push(`valueMap miss — no mapping for ${t.attribute}="${String(current)}"`)
          }
          applied.push('valueMap')
          break
        }
        case 'sizeScale': {
          if (!ctx?.lookupSizeScale) {
            warnings.push('sizeScale skipped — no size-scale context (FM.4)')
            break
          }
          if (current == null) break
          const mapped = ctx.lookupSizeScale(t.scale, t.from, t.to, String(current))
          if (mapped != null) {
            current = mapped
          } else if (t.onMiss === 'null') {
            current = null
          } else if (t.onMiss === 'flag') {
            warnings.push(`sizeScale miss — ${t.scale} ${t.from}→${t.to} "${String(current)}"`)
          }
          applied.push('sizeScale')
          break
        }
        case 'translate':
          // Deferred marker — never mutates the value inline; the resolver
          // forces needsTranslation when this op is present (FM.5 fills it).
          applied.push('translate')
          break
        default:
          warnings.push(`unknown transform type "${(t as { type: string }).type}" skipped`)
      }
    } catch (e: any) {
      warnings.push(`transform "${t.type}" threw — ${e?.message ?? 'unknown'}`)
    }
  }
  return { out: current, applied }
}

// ────────────────────────────────────────────────────────────────────
// Link-group membership
// ────────────────────────────────────────────────────────────────────

export type ChannelFieldSource =
  | 'locked'
  | 'override'
  | 'linked'
  | 'fallback'
  | 'default'
  | 'catalogRule'
  | 'missing'

/** Per-coordinate link membership for one field, derived from the
 *  product's FieldLinkGroups by linkForCoordinate(). Null when the
 *  coordinate isn't a member. */
export interface FieldLinkMembership {
  translatePolicy: 'TRANSLATE' | 'VERBATIM' | 'NONE'
  sourceLanguage: string | null
  /** The coordinate's market language, for the cross-language flag. */
  targetLanguage: string | null
}

/** Minimal FieldLinkGroup shape the resolver needs. Loaded by the caller
 *  (one findMany per product) and passed in, keeping this module pure. */
export interface FieldLinkGroupLike {
  fieldKey: string
  variantId: string | null
  translatePolicy: 'TRANSLATE' | 'VERBATIM' | 'NONE'
  sourceLanguage: string | null
  /** [{ channel, marketplace, variantId? }] — the coordinate model. */
  members: unknown
}

interface MemberCoord {
  channel: string
  marketplace: string
  variantId?: string | null
}

function membersOf(group: FieldLinkGroupLike): MemberCoord[] {
  const raw = group.members
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (m): m is MemberCoord =>
      !!m && typeof m === 'object' && typeof (m as any).channel === 'string' && typeof (m as any).marketplace === 'string',
  )
}

/**
 * Resolve whether (channel, marketplace, variantId?) is a member of a
 * link group for `fieldKey`, returning the translate policy + languages
 * needed to flag cross-language translation. Returns null when not a
 * member. A coordinate belongs to ≤1 group per field (enforced by the FL
 * service layer); the first match wins defensively.
 */
export function linkForCoordinate(
  groups: FieldLinkGroupLike[],
  fieldKey: string,
  channel: string,
  marketplace: string,
  variantId?: string | null,
): FieldLinkMembership | null {
  const vid = variantId ?? null
  for (const g of groups) {
    if (g.fieldKey !== fieldKey) continue
    if ((g.variantId ?? null) !== vid) continue
    const isMember = membersOf(g).some(
      (m) => m.channel === channel && m.marketplace === marketplace && (m.variantId ?? null) === vid,
    )
    if (!isMember) continue
    return {
      translatePolicy: g.translatePolicy,
      sourceLanguage: g.sourceLanguage,
      targetLanguage: languageForMarketplace(marketplace),
    }
  }
  return null
}

// ────────────────────────────────────────────────────────────────────
// resolveChannelField
// ────────────────────────────────────────────────────────────────────

export interface ResolveChannelFieldInput {
  fieldKey: string
  rule: FieldMappingRule
  /** Provenance-carrying resolved attributes (attribute-resolver output).
   *  resolveChannelField flattens this for path resolution and reads the
   *  provenance to detect per-coordinate overrides. */
  resolvedAttrs: ResolvedAttributes
  product: { localizedContent: unknown; categoryAttributes: unknown; variantAttributes: unknown }
  locale: string
  /** Link-group membership for this coordinate+field, or null. */
  link?: FieldLinkMembership | null
  /** Identity field pinned to master (GTIN/SKU/brand). */
  locked?: boolean
}

export interface ResolvedChannelField {
  fieldKey: string
  value: unknown
  source: ChannelFieldSource
  /** rule.source result before transforms (for diff/debug). */
  raw: unknown
  appliedTransforms: TransformOp['type'][]
  warnings: string[]
  required: boolean
  /** Exact legacy D.6 value-origin ('source'|'fallback'|'default'|
   *  'missing'), independent of the enriched provenance — lets
   *  payload-preview keep its byte-identical `source` contract. */
  legacySource: 'source' | 'fallback' | 'default' | 'missing'
  /** Cross-language TRANSLATE member whose translation isn't pinned yet —
   *  the FM.5 propagation step fills it. */
  needsTranslation: boolean
}

function flattenResolved(r: ResolvedAttributes): Record<string, unknown> {
  const flat: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(r)) flat[k] = v.value
  return flat
}

/** A.1 provenance values that mean "a per-coordinate channel override
 *  supplied this value" (vs inherited master/variant). */
const OVERRIDE_SOURCES: ReadonlySet<ValueSource> = new Set<ValueSource>([
  'channelOverride',
  'channelExplicit',
])

export function resolveChannelField(input: ResolveChannelFieldInput): ResolvedChannelField {
  const { fieldKey, rule, resolvedAttrs, product, locale, link, locked } = input
  const warnings: string[] = []
  const flat = flattenResolved(resolvedAttrs)

  // 1. rule.source → fallback → transforms (the legacy value formula).
  const sourceRaw = resolveSourcePath(rule.source, flat, product, locale)
  let value: unknown = sourceRaw
  let usedFallback = false
  if (!isPresent(value) && rule.fallback) {
    const fb = resolveSourcePath(rule.fallback, flat, product, locale)
    if (isPresent(fb)) {
      value = fb
      usedFallback = true
    }
  }
  const { out, applied } = applyTransforms(value, rule.transforms, warnings, { values: flat })
  value = out
  const defaultFired = applied.includes('default') && !isPresent(sourceRaw)

  // 2. Per-coordinate override detection: when rule.source is a single
  //    segment, its provenance is the resolved attribute's source. A
  //    multi-segment path walks raw product (no override layer), so it
  //    stays unmarked — value is unaffected either way (the override is
  //    already merged into the resolved attribute the path reads).
  const subbed = rule.source.replace(/\{locale\}/g, locale)
  const overrideSource =
    !subbed.includes('.') ? resolvedAttrs[subbed]?.source : undefined
  const isOverride = !!overrideSource && OVERRIDE_SOURCES.has(overrideSource)

  // 3. Cross-language translate flag (linked TRANSLATE, different langs).
  let needsTranslation = false
  if (link && isPresent(value)) {
    needsTranslation =
      link.translatePolicy === 'TRANSLATE' &&
      !!link.targetLanguage &&
      !!link.sourceLanguage &&
      link.targetLanguage.toLowerCase() !== link.sourceLanguage.toLowerCase()
  }
  // An explicit `translate` transform op flags the field for translation
  // regardless of link membership; the FM.5 executor resolves the target
  // language per coordinate and skips same-language no-ops.
  if (!needsTranslation && isPresent(value) && (rule.transforms ?? []).some((t) => t.type === 'translate')) {
    needsTranslation = true
  }

  // 4. Provenance precedence (does not change the value).
  let source: ChannelFieldSource
  if (!isPresent(value)) source = 'missing'
  else if (locked) source = 'locked'
  else if (isOverride) source = 'override'
  else if (link) source = 'linked'
  else if (usedFallback) source = 'fallback'
  else if (defaultFired) source = 'default'
  else source = 'catalogRule'

  // Legacy D.6 value-origin — exact reproduction of the pre-FM.2 preview
  // `source` field, independent of the enriched provenance above (a field
  // can be both a link member AND fallback/default-filled).
  let legacySource: 'source' | 'fallback' | 'default' | 'missing'
  if (!isPresent(value)) legacySource = 'missing'
  else if (usedFallback) legacySource = 'fallback'
  else if (defaultFired) legacySource = 'default'
  else legacySource = 'source'

  return {
    fieldKey,
    value: isPresent(value) ? value : null,
    source,
    raw: sourceRaw,
    appliedTransforms: applied,
    warnings,
    required: rule.required === true,
    legacySource,
    needsTranslation,
  }
}
