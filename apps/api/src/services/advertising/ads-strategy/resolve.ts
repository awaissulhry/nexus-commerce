/**
 * ADS AUTONOMY W1-2 — which strategy number is in force for a market, a category, a product, an ad group or a
 * campaign, and which row supplied it. Pure: the rows and the catalog facts come in (load.ts); nothing is read here.
 *
 * Inside one market, most specific first (Owner decisions 2026-10-06):
 *   1. the PRODUCT row of the product itself (a variation);
 *   2. the PRODUCT row of its parent ("a parent's strategy covers its variations");
 *   3. the CATEGORY rows of the ROOT product's primary category and its ancestors, deepest first (classification
 *      lives on the parent). No primary flagged but exactly one category: that one. Several categories and no primary,
 *      or several primaries: the SAFER value across them, with a warning — nothing is guessed;
 *   4. the MARKET row.
 * A field is taken from the first row that sets it; a group (target, harvest, negate, stop) only from a row that sets
 * it whole. Claude's autonomy resolves per action type. The monthly cap is not inherited: every cap of a scope the
 * subject belongs to binds on that scope's own spend.
 *
 * Several products (an ad group, a campaign): each product resolves on its own, then each field takes the SAFER value
 * (fields.ts `safer`) and names the product it came from. A TACoS target is shown, never steered by: the ACoS target
 * the engines use (`targetAcosPct`) skips it and takes the next ACoS target down the chain.
 *
 * A stored value the resolver cannot read in its unit and range (a target of 0.3 where a whole percent is kept, an
 * unknown word, a half-set group, a field on a level that cannot hold it) is ignored and named in `warnings`.
 */
import type { ClaudeTrust } from '../../agents/tool-types.js'
import {
  CLAUDE_ACTION_TYPES,
  CLAUDE_LEVELS,
  COLUMN_CHECKS,
  DEFAULT_STOP_BID_CENTS,
  MARKET_SCOPE,
  STRATEGY_FIELDS,
  STRATEGY_LEVELS,
  STRATEGY_MONEY,
  pctToFraction,
  requiredColumns,
  type ClaudeActionType,
  type StrategyColumn,
  type StrategyField,
  type StrategyFieldKey,
  type StrategyLevel,
} from './fields.js'

// ── Inputs ────────────────────────────────────────────────────────────────────────────────────────

/** One AdsStrategy row as the loader selects it. Setting columns are read defensively (`unknown`). */
export type StrategyRow = {
  id: string
  channel: string
  market: string
  level: string
  scopeId: string
  label: string
  version: number
  updatedAt: Date
  updatedBy: string
} & { [C in StrategyColumn]: unknown }

export interface CatalogProduct {
  id: string
  sku: string
  parentId: string | null
}

/** What the resolver needs to know about the products it resolves, read once per run (load.ts). */
export interface Catalog {
  products: ReadonlyMap<string, CatalogProduct>
  /** Per ROOT product (the parent, or a product without one): the categories flagged primary, and all of them. */
  memberships: ReadonlyMap<string, { primary: readonly string[]; all: readonly string[] }>
  /** Per category: itself and its ancestors, deepest first (CategoryClosure ordered by depth). */
  ancestry: ReadonlyMap<string, readonly string[]>
  /** Category names, for the warnings. */
  categoryNames?: ReadonlyMap<string, string>
}

// ── Outputs ───────────────────────────────────────────────────────────────────────────────────────

export type SourceLevel = 'product' | 'category' | 'market'
const LEVEL_OF: Record<StrategyLevel, SourceLevel> = { PRODUCT: 'product', CATEGORY: 'category', MARKET: 'market' }

/** Which strategy row supplied a number (design §3.2). */
export interface StrategySource {
  level: SourceLevel
  strategyId: string
  scopeId: string
  label: string
  version: number
  /** A PRODUCT row of the product's parent. */
  via?: 'parent'
  /** Several products (or categories) gave one: whose number this is (a SKU, or a category's name). */
  product?: string
}

/** A field's value: the stored value (a group as its columns), or the action type → level map of Claude's autonomy. */
export type FieldValue = string | number | boolean | Readonly<Record<string, unknown>>

export interface ResolvedField {
  /** Null: no level sets it (and, for a descriptive field, the products agree it is not set). */
  value: FieldValue | null
  source: StrategySource | null
  /** A descriptive field (goal, why, the target as written) on which the products or categories differ. */
  mixed?: Array<{ who: string; value: FieldValue | null; source: StrategySource | null }>
}

export interface CapInForce {
  source: StrategySource
  monthlySpendCapCents: number
}

/** One row consulted for one field, most specific first: what it says about the field (null: nothing). */
export interface ChainEntry {
  source: StrategySource
  value: FieldValue | null
}

export interface ResolvedStrategy {
  /** Every inherit field but Claude's autonomy, which resolves per action type. */
  fields: Map<StrategyFieldKey, ResolvedField>
  autonomy: Map<ClaudeActionType, ResolvedField>
  /** Every monthly cap in force, each on its own scope's spend. */
  caps: CapInForce[]
  /** For one subject (a market, a category, one product): every row consulted, per field. */
  chains?: Map<StrategyFieldKey, ChainEntry[]>
  warnings: string[]
}

// ── Reading a row ─────────────────────────────────────────────────────────────────────────────────

/** A row's own settings, read and checked once: field → value (a group whole), and Claude's levels per action type. */
interface RowSettings {
  fields: Map<StrategyFieldKey, FieldValue>
  autonomy: Map<ClaudeActionType, ClaudeTrust>
}

export interface StrategyIndex {
  market: string
  channel: string
  marketRow: StrategyRow | null
  categories: ReadonlyMap<string, StrategyRow>
  products: ReadonlyMap<string, StrategyRow>
  settings: ReadonlyMap<string, RowSettings>
  /** Every row the index holds (orphans and unreadable rows left out). */
  rows: readonly StrategyRow[]
  /** Stored values (or whole rows) the resolver does not read, each with why. */
  warnings: string[]
}

export interface Orphan {
  strategyId: string
  level: string
  scopeId: string
  label: string
  why: string
}

function checkValue(column: StrategyColumn, value: unknown): string | null {
  const check = COLUMN_CHECKS[column]
  switch (check.kind) {
    case 'int':
      if (typeof value !== 'number' || !Number.isInteger(value)) return 'not a whole number'
      if (value < check.min || (check.max != null && value > check.max)) return `outside ${check.min}–${check.max ?? '…'}`
      if (check.allowed && !check.allowed.includes(value)) return `not one of ${check.allowed.join(', ')}`
      return null
    case 'enum':
      return typeof value === 'string' && check.values.includes(value) ? null : `not one of ${check.values.join(', ')}`
    case 'text':
      return typeof value === 'string' && value.length <= check.maxLength ? null : `not a text of at most ${check.maxLength} characters`
    case 'boolean':
      return typeof value === 'boolean' ? null : 'not true or false'
    case 'autonomy':
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? null : 'not a map of action type → level'
  }
}

const shown = (value: unknown) => JSON.stringify(value)
const rowName = (row: StrategyRow) => `${row.label} (${LEVEL_OF[row.level as StrategyLevel] ?? row.level}, v${row.version})`

/** A row's settings: each field the row may hold and sets in full, its values checked; the rest named in `warnings`. */
function readRow(row: StrategyRow, warnings: string[]): RowSettings {
  const level = row.level as StrategyLevel
  const clean = new Map<StrategyColumn, unknown>()
  for (const field of STRATEGY_FIELDS) {
    if (field.derivedFrom) continue
    for (const column of field.columns) {
      const value = row[column]
      if (value == null) continue
      if (!field.levels.includes(level)) {
        warnings.push(`${rowName(row)}: ${column} cannot be set on a ${LEVEL_OF[level]} row; ignored`)
        continue
      }
      const problem = checkValue(column, value)
      // A money value is not quoted: a warning is read by people who may not see ad-spend money.
      if (problem) warnings.push(`${rowName(row)}: ${column} ${column in STRATEGY_MONEY ? 'holds a value that' : shown(value)} is ${problem}; ignored`)
      else clean.set(column, value)
    }
  }
  const fields = new Map<StrategyFieldKey, FieldValue>()
  for (const field of STRATEGY_FIELDS) {
    if (field.derivedFrom || field.key === 'claudeAutonomy') continue
    const required = requiredColumns(field)
    const present = field.columns.filter((c) => clean.has(c))
    if (!present.length) continue
    if (!required.every((c) => clean.has(c))) {
      warnings.push(`${rowName(row)}: ${field.key} is only partly set (${present.join(', ')}); a group counts only whole, so it is ignored`)
      continue
    }
    fields.set(field.key, field.columns.length === 1 ? (clean.get(field.columns[0]) as FieldValue) : Object.fromEntries(field.columns.map((c) => [c, clean.has(c) ? clean.get(c) : null])))
  }
  const autonomy = new Map<ClaudeActionType, ClaudeTrust>()
  const map = clean.get('claudeAutonomy') as Record<string, unknown> | undefined
  for (const [action, level] of Object.entries(map ?? {})) {
    if (!(CLAUDE_ACTION_TYPES as string[]).includes(action)) warnings.push(`${rowName(row)}: claudeAutonomy has an unknown action type ${shown(action)}; ignored`)
    else if (!(CLAUDE_LEVELS as readonly unknown[]).includes(level)) warnings.push(`${rowName(row)}: claudeAutonomy.${action} ${shown(level)} is not off, ask, confirm or auto; ignored`)
    else autonomy.set(action as ClaudeActionType, level as ClaudeTrust)
  }
  return { fields, autonomy }
}

/**
 * The rows of ONE market, indexed by scope and read once. `live` (from the loader) names the categories and the
 * products that still exist in this business; a row whose scope is gone is an orphan: never resolved, listed apart.
 * Without `live` every scope counts as existing.
 */
export function indexStrategy(
  market: string,
  rows: readonly StrategyRow[],
  live?: { categories: ReadonlySet<string>; products: ReadonlySet<string> },
  channel = 'AMAZON',
): { index: StrategyIndex; orphans: Orphan[] } {
  const warnings: string[] = []
  const orphans: Orphan[] = []
  let marketRow: StrategyRow | null = null
  const categories = new Map<string, StrategyRow>()
  const products = new Map<string, StrategyRow>()
  const settings = new Map<string, RowSettings>()
  const kept: StrategyRow[] = []
  for (const row of rows) {
    if (row.market !== market || row.channel !== channel) continue
    if (!(STRATEGY_LEVELS as readonly string[]).includes(row.level)) {
      warnings.push(`${row.label}: level ${shown(row.level)} is not MARKET, CATEGORY or PRODUCT; the row is ignored`)
      continue
    }
    if ((row.level === 'MARKET') !== (row.scopeId === MARKET_SCOPE)) {
      warnings.push(`${rowName(row)}: a ${row.level === 'MARKET' ? 'market row must have the scope "*"' : `${LEVEL_OF[row.level as StrategyLevel]} row must name its ${LEVEL_OF[row.level as StrategyLevel]}`}; the row is ignored`)
      continue
    }
    if (row.level === 'CATEGORY' && live && !live.categories.has(row.scopeId)) {
      orphans.push({ strategyId: row.id, level: row.level, scopeId: row.scopeId, label: row.label, why: 'the category no longer exists' })
      continue
    }
    if (row.level === 'PRODUCT' && live && !live.products.has(row.scopeId)) {
      orphans.push({ strategyId: row.id, level: row.level, scopeId: row.scopeId, label: row.label, why: 'the product no longer exists or was deleted' })
      continue
    }
    if (row.level === 'MARKET') marketRow = row
    else (row.level === 'CATEGORY' ? categories : products).set(row.scopeId, row)
    settings.set(row.id, readRow(row, warnings))
    kept.push(row)
  }
  return { index: { market, channel, marketRow, categories, products, settings, rows: kept, warnings }, orphans }
}

// ── Resolving ─────────────────────────────────────────────────────────────────────────────────────

const sourceOf = (row: StrategyRow, via?: 'parent'): StrategySource => ({
  level: LEVEL_OF[row.level as StrategyLevel],
  strategyId: row.id,
  scopeId: row.scopeId,
  label: row.label,
  version: row.version,
  ...(via ? { via } : {}),
})

/** One level of the order: one or more chains of rows (several categories of one product), most specific row first. */
interface Layer {
  chains: Array<{ who: string; rows: Array<{ row: StrategyRow; via?: 'parent' }> }>
}

interface Candidate { value: FieldValue; source: StrategySource; who: string }

/** The value a field takes from ONE row, or undefined when the row says nothing about it. */
function valueIn(index: StrategyIndex, row: StrategyRow, key: StrategyFieldKey): FieldValue | undefined {
  const own = index.settings.get(row.id)
  if (!own) return undefined
  if (key === 'targetAcosPct') {
    const target = own.fields.get('target') as { targetKind: string; targetPct: number } | undefined
    return target?.targetKind === 'ACOS' ? target.targetPct : undefined
  }
  return own.fields.get(key)
}

const rank = (level: unknown) => CLAUDE_LEVELS.indexOf(level as ClaudeTrust)
const num = (value: unknown, fallback = Number.POSITIVE_INFINITY) => (typeof value === 'number' ? value : fallback)
const field = (value: FieldValue | null, column: string) => (value as Record<string, unknown> | null)?.[column]

/** The safer of several candidates for one field (fields.ts `safer`); for a descriptive field, null when they differ. */
function safer(rule: StrategyField['safer'], candidates: Candidate[]): Candidate | null {
  if (candidates.length <= 1) return candidates[0] ?? null
  const best = (better: (a: Candidate, b: Candidate) => boolean) => candidates.reduce((kept, next) => (better(next, kept) ? next : kept))
  switch (rule) {
    case 'lower':
      return best((a, b) => num(a.value) < num(b.value))
    case 'anyProtected':
      return best((a, b) => a.value === true && b.value !== true)
    case 'lowerLevel':
      return best((a, b) => rank(a.value) < rank(b.value))
    case 'stricterHarvest':
      return best((a, b) => {
        const [ao, bo] = [num(field(a.value, 'harvestMinOrders'), 0), num(field(b.value, 'harvestMinOrders'), 0)]
        return ao > bo || (ao === bo && num(field(a.value, 'harvestMinClicks'), 0) > num(field(b.value, 'harvestMinClicks'), 0))
      })
    case 'stricterNegate':
      return best((a, b) => {
        const [ac, bc] = [num(field(a.value, 'negateMinClicks'), 0), num(field(b.value, 'negateMinClicks'), 0)]
        return ac > bc || (ac === bc && num(field(a.value, 'negateMinSpendCents'), 0) > num(field(b.value, 'negateMinSpendCents'), 0))
      })
    case 'saferStop':
      return best((a, b) => {
        const lowBids = (c: Candidate) => field(c.value, 'stopMethod') === 'LOW_BIDS'
        if (lowBids(a) !== lowBids(b)) return lowBids(a)
        return num(field(a.value, 'stopBidCents'), DEFAULT_STOP_BID_CENTS) < num(field(b.value, 'stopBidCents'), DEFAULT_STOP_BID_CENTS)
      })
    case 'mixed':
      return candidates.every((c) => shown(c.value) === shown(candidates[0].value)) ? candidates[0] : null
    case 'ownSpend':
      return candidates[0]
  }
}

const categoryLabel = (index: StrategyIndex, categoryId: string, names?: ReadonlyMap<string, string>) =>
  names?.get(categoryId) ?? index.categories.get(categoryId)?.label ?? categoryId

/** Resolve the fields of ONE subject from its layers, most specific first. */
function resolveLayers(index: StrategyIndex, layers: Layer[], warnings: string[], withChains: boolean): ResolvedStrategy {
  const fields = new Map<StrategyFieldKey, ResolvedField>()
  const autonomy = new Map<ClaudeActionType, ResolvedField>()
  const chains = withChains ? new Map<StrategyFieldKey, ChainEntry[]>() : undefined

  const resolveOne = (rule: StrategyField['safer'], read: (row: StrategyRow) => FieldValue | undefined): ResolvedField => {
    for (const layer of layers) {
      const candidates: Candidate[] = []
      for (const chain of layer.chains) {
        const hit = chain.rows.find(({ row }) => read(row) !== undefined)
        if (hit) candidates.push({ value: read(hit.row)!, source: { ...sourceOf(hit.row, hit.via), ...(layer.chains.length > 1 ? { product: chain.who } : {}) }, who: chain.who })
      }
      if (!candidates.length) continue
      const picked = safer(rule, candidates)
      if (picked) return { value: picked.value, source: picked.source }
      return { value: null, source: null, mixed: candidates.map((c) => ({ who: c.who, value: c.value, source: c.source })) }
    }
    return { value: null, source: null }
  }

  for (const spec of STRATEGY_FIELDS) {
    if (spec.key === 'claudeAutonomy' || spec.resolve === 'everyScope') continue
    fields.set(spec.key, resolveOne(spec.safer, (row) => valueIn(index, row, spec.key)))
    if (chains) {
      chains.set(spec.key, layers.flatMap((layer) => layer.chains.flatMap((chain) => chain.rows.map(({ row, via }) => ({
        source: { ...sourceOf(row, via), ...(layer.chains.length > 1 ? { product: chain.who } : {}) },
        value: valueIn(index, row, spec.key) ?? null,
      })))))
    }
  }
  for (const action of CLAUDE_ACTION_TYPES) {
    autonomy.set(action, resolveOne('lowerLevel', (row) => index.settings.get(row.id)?.autonomy.get(action)))
  }

  // Every cap of every scope the subject belongs to (ancestor categories too), once each.
  const caps: CapInForce[] = []
  const seen = new Set<string>()
  for (const layer of layers) {
    for (const chain of layer.chains) {
      for (const { row, via } of chain.rows) {
        const cap = valueIn(index, row, 'monthlySpendCapCents')
        if (typeof cap !== 'number' || seen.has(row.id)) continue
        seen.add(row.id)
        caps.push({ source: sourceOf(row, via), monthlySpendCapCents: cap })
      }
    }
  }
  return { fields, autonomy, caps, ...(chains ? { chains } : {}), warnings }
}

const marketLayer = (index: StrategyIndex): Layer[] => (index.marketRow ? [{ chains: [{ who: index.market, rows: [{ row: index.marketRow }] }] }] : [])

/** One category's chain: its own row, then its ancestors' rows, deepest first. */
function categoryChain(index: StrategyIndex, categoryId: string, catalog: Pick<Catalog, 'ancestry'>): Array<{ row: StrategyRow }> {
  const path = catalog.ancestry.get(categoryId) ?? [categoryId]
  return path.map((id) => index.categories.get(id)).filter((row): row is StrategyRow => !!row).map((row) => ({ row }))
}

/** The market itself: its own row only. */
export function resolveMarket(index: StrategyIndex): ResolvedStrategy {
  return resolveLayers(index, marketLayer(index), [...index.warnings], true)
}

/** A category: its row and its ancestors' rows, deepest first, then the market. */
export function resolveCategory(index: StrategyIndex, categoryId: string, catalog: Pick<Catalog, 'ancestry'>): ResolvedStrategy {
  return resolveLayers(index, [{ chains: [{ who: categoryId, rows: categoryChain(index, categoryId, catalog) }] }, ...marketLayer(index)], [...index.warnings], true)
}

/** The categories a product resolves through: its root's primary one, or why there is no single one. */
export function categoriesFor(product: CatalogProduct, catalog: Catalog): { ids: string[]; warning?: string } {
  const root = product.parentId ?? product.id
  const member = catalog.memberships.get(root)
  if (!member || member.all.length === 0) return { ids: [] }
  if (member.primary.length === 1) return { ids: [member.primary[0]] }
  if (member.primary.length > 1) {
    return { ids: [...member.primary], warning: `${product.sku}: its family has ${member.primary.length} primary categories; the safer value across them applies` }
  }
  if (member.all.length === 1) return { ids: [member.all[0]] }
  return { ids: [...member.all], warning: `${product.sku}: its family has ${member.all.length} categories and none is primary; the safer value across them applies` }
}

function productLayers(index: StrategyIndex, product: CatalogProduct, catalog: Catalog, warnings: string[]): Layer[] {
  const layers: Layer[] = []
  const own = index.products.get(product.id)
  if (own) layers.push({ chains: [{ who: product.sku, rows: [{ row: own }] }] })
  const parent = product.parentId ? index.products.get(product.parentId) : undefined
  if (parent) layers.push({ chains: [{ who: product.sku, rows: [{ row: parent, via: 'parent' }] }] })
  const { ids, warning } = categoriesFor(product, catalog)
  if (warning) warnings.push(warning)
  const chains = ids.map((id) => ({ who: categoryLabel(index, id, catalog.categoryNames), rows: categoryChain(index, id, catalog) })).filter((c) => c.rows.length)
  if (chains.length) layers.push({ chains })
  return [...layers, ...marketLayer(index)]
}

/** One product (a variation or a parent): its row, its parent's, its root's primary category chain, the market. */
export function resolveProduct(index: StrategyIndex, product: CatalogProduct, catalog: Catalog): ResolvedStrategy {
  const warnings = [...index.warnings]
  return resolveLayers(index, productLayers(index, product, catalog, warnings), warnings, true)
}

/**
 * Several products sharing ONE ad group (or a campaign's ad groups): each resolves on its own, then each field takes
 * the safer value and names the product it came from; a descriptive field the products disagree on is `mixed`. Every
 * product's caps stay in force (each on its own spend). `unknownAds`: ads whose product Nexus does not know — ignored
 * when a known product exists; with none known, the market row applies.
 */
export function resolveProducts(
  index: StrategyIndex,
  products: readonly CatalogProduct[],
  catalog: Catalog,
  unknownAds = 0,
): ResolvedStrategy {
  const warnings = [...index.warnings]
  if (!products.length) {
    if (unknownAds) warnings.push(`${unknownAds} ad${unknownAds === 1 ? '' : 's'} advertise${unknownAds === 1 ? 's' : ''} a product Nexus does not know: the market's strategy applies`)
    return resolveLayers(index, marketLayer(index), warnings, false)
  }
  if (unknownAds) warnings.push(`${unknownAds} ad${unknownAds === 1 ? '' : 's'} advertise${unknownAds === 1 ? 's' : ''} a product Nexus does not know; ${unknownAds === 1 ? 'it is' : 'they are'} left out`)
  if (products.length === 1) return resolveLayers(index, productLayers(index, products[0], catalog, warnings), warnings, true)
  const each = products.map((product) => ({ product, resolved: resolveLayers(index, productLayers(index, product, catalog, warnings), [], false) }))
  // Whose number it is, when a product's own (or its category's) row gave it; a market value is every product's.
  const owned = (source: StrategySource, sku: string): StrategySource => (source.level === 'market' ? source : { ...source, product: source.product ?? sku })
  const merge = (spec: StrategyField['safer'], get: (r: ResolvedStrategy) => ResolvedField | undefined): ResolvedField => {
    if (spec === 'mixed') {
      const all = each.map(({ product, resolved }) => ({ who: product.sku, value: get(resolved)?.value ?? null, source: get(resolved)?.source ?? null }))
      return all.every((c) => shown(c.value) === shown(all[0].value)) ? { value: all[0].value, source: all[0].source } : { value: null, source: null, mixed: all }
    }
    const candidates: Candidate[] = each.flatMap(({ product, resolved }) => {
      const r = get(resolved)
      return r?.value != null && r.source ? [{ value: r.value, source: owned(r.source, product.sku), who: product.sku }] : []
    })
    const picked = safer(spec, candidates)
    return picked ? { value: picked.value, source: picked.source } : { value: null, source: null }
  }
  const fields = new Map<StrategyFieldKey, ResolvedField>()
  for (const spec of STRATEGY_FIELDS) {
    if (spec.key === 'claudeAutonomy' || spec.resolve === 'everyScope') continue
    fields.set(spec.key, merge(spec.safer, (r) => r.fields.get(spec.key)))
  }
  const autonomy = new Map<ClaudeActionType, ResolvedField>()
  for (const action of CLAUDE_ACTION_TYPES) autonomy.set(action, merge('lowerLevel', (r) => r.autonomy.get(action)))
  const caps: CapInForce[] = []
  const seen = new Set<string>()
  for (const { product, resolved } of each) {
    for (const cap of resolved.caps) {
      if (seen.has(cap.source.strategyId)) continue
      seen.add(cap.source.strategyId)
      caps.push({ ...cap, source: owned(cap.source, product.sku) })
    }
  }
  return { fields, autonomy, caps, warnings: [...new Set(warnings)] }
}

/**
 * W1-6b — every monthly cap the market's rows hold, each with its row: a CATEGORY or PRODUCT cap binds on its own
 * scope's spend (the products under it), the market's on the whole market.
 */
export function capRows(index: StrategyIndex): CapInForce[] {
  return index.rows.flatMap((row) => {
    const cap = valueIn(index, row, 'monthlySpendCapCents')
    return typeof cap === 'number' ? [{ source: sourceOf(row), monthlySpendCapCents: cap }] : []
  })
}

// ── What the engines take ─────────────────────────────────────────────────────────────────────────

/** The typed numbers an engine reads (W1-5..W1-8). Null: the strategy says nothing; keep today's behaviour. */
export interface StrategyValues {
  /** The ACoS target as a FRACTION (25 % → 0.25): the W0 target resolver's unit. TACoS never lands here. */
  targetAcos: number | null
  targetAcosPct: number | null
  minBidCents: number | null
  maxBidCents: number | null
  maxChangePct: number | null
  maxActionsPerRun: number | null
  reviewEveryDays: number | null
  protect: boolean | null
  harvest: { minOrders: number; minClicks: number; maxAcosPct: number | null; windowDays: number } | null
  negate: { minClicks: number; minSpendCents: number; maxOrders: number; windowDays: number } | null
  /** A stop's method and low bid (the 2¢ floor when the strategy names none). */
  stop: { method: 'LOW_BIDS' | 'PAUSE'; bidCents: number } | null
  monthlyCaps: CapInForce[]
  /** Claude's level per action type where the strategy narrows it. */
  claude: Partial<Record<ClaudeActionType, ClaudeTrust>>
}

const numberOf = (r: ResolvedField | undefined) => (typeof r?.value === 'number' ? r.value : null)

export function valuesOf(resolved: ResolvedStrategy): StrategyValues {
  const group = (key: StrategyFieldKey) => resolved.fields.get(key)?.value as Record<string, unknown> | null | undefined
  const targetAcosPct = numberOf(resolved.fields.get('targetAcosPct'))
  const harvest = group('harvest')
  const negate = group('negate')
  const stop = group('stop')
  const claude: Partial<Record<ClaudeActionType, ClaudeTrust>> = {}
  for (const [action, r] of resolved.autonomy) if (typeof r.value === 'string') claude[action] = r.value as ClaudeTrust
  return {
    targetAcos: pctToFraction(targetAcosPct),
    targetAcosPct,
    minBidCents: numberOf(resolved.fields.get('minBidCents')),
    maxBidCents: numberOf(resolved.fields.get('maxBidCents')),
    maxChangePct: numberOf(resolved.fields.get('maxChangePct')),
    maxActionsPerRun: numberOf(resolved.fields.get('maxActionsPerRun')),
    reviewEveryDays: numberOf(resolved.fields.get('reviewEveryDays')),
    protect: typeof resolved.fields.get('protect')?.value === 'boolean' ? (resolved.fields.get('protect')!.value as boolean) : null,
    harvest: harvest ? { minOrders: harvest.harvestMinOrders as number, minClicks: harvest.harvestMinClicks as number, maxAcosPct: (harvest.harvestMaxAcosPct as number | null) ?? null, windowDays: harvest.harvestWindowDays as number } : null,
    negate: negate ? { minClicks: negate.negateMinClicks as number, minSpendCents: negate.negateMinSpendCents as number, maxOrders: negate.negateMaxOrders as number, windowDays: negate.negateWindowDays as number } : null,
    stop: stop ? { method: stop.stopMethod as 'LOW_BIDS' | 'PAUSE', bidCents: (stop.stopBidCents as number | null) ?? DEFAULT_STOP_BID_CENTS } : null,
    monthlyCaps: resolved.caps,
    claude,
  }
}
