/**
 * ADS PLAYBOOK PB-2 — which playbook a product, a category or a market follows, section by section, and where each part
 * came from (design report 9 §1.2, §4.4). Pure: the rows, the templates and the catalog facts come in (load.ts, and the
 * ads strategy's own catalog loader); nothing is read here.
 *
 * Inside one market, most specific first — the ads strategy's order (ads-strategy/resolve.ts), reused, never copied:
 *   1. the PRODUCT row of the product itself (a variation);
 *   2. the PRODUCT row of its parent (a parent's playbook covers its variations);
 *   3. the CATEGORY rows of the ROOT product's primary category and its ancestors, deepest first (categoriesFor). A
 *      product filed under several categories with no single primary takes no category row: a structure has no "safer"
 *      value to pick, so nothing is guessed and a warning says so;
 *   4. the MARKET row;
 *   5. the template the first row naming one names.
 * Each section (doc.ts SECTIONS) resolves WHOLE: from the first row whose overrides set it, else from the template. The
 * product's own fields (enrolled, state, name token, portfolio, daily budget, base bid, terms, phase recipes, the
 * versions last applied) come from the product's row, else its parent's. A PRODUCT row's `skipSlots` leaves optional
 * slots out of the doc the product would be built from.
 *
 * Enrollment (Owner decision D-PB4): a product is in only when its own (or its parent's) row says `enrolled`; a
 * category or market row never enrolls anything. Stored values the resolver cannot read are ignored and named in
 * `warnings`; an incomplete or inconsistent result says why in `problems` (`doc` is then null).
 */
import { categoriesFor, type Catalog, type CatalogProduct } from '../ads-strategy/resolve.js'
import { MARKET_SCOPE, STRATEGY_LEVELS, type StrategyLevel } from '../ads-strategy/fields.js'
import {
  crossCheck,
  OVERRIDES,
  PHASE_RECIPES,
  PRODUCT_TERMS,
  readSection,
  SECTIONS,
  type Overrides,
  type SectionKey,
  type TemplateDoc,
} from './doc.js'

// ── Inputs ────────────────────────────────────────────────────────────────────────────────────────

/** One AdsPlaybook row as the loader selects it. JSON columns are read defensively (`unknown`). */
export interface PlaybookRow {
  id: string
  channel: string
  market: string
  level: string
  scopeId: string
  label: string
  version: number
  templateId: string | null
  overrides: unknown
  enrolled: boolean | null
  state: string | null
  nameToken: string | null
  portfolioName: string | null
  dailyBudgetCents: number | null
  baseBidCents: number | null
  terms: unknown
  phaseRecipes: unknown
  compiledVersion: number | null
  compiledTemplateVersion: number | null
  updatedAt: Date
  updatedBy: string
}

/** One AdsPlaybookTemplate row as the loader selects it. */
export interface TemplateRow {
  id: string
  channel: string
  adProduct: string
  name: string
  version: number
  status: string
  doc: unknown
  capturedFrom: unknown
  updatedAt: Date
  updatedBy: string
}

// ── Outputs ───────────────────────────────────────────────────────────────────────────────────────

export type PlaybookSourceLevel = 'product' | 'category' | 'market' | 'template'
const LEVEL_OF: Record<StrategyLevel, PlaybookSourceLevel> = { PRODUCT: 'product', CATEGORY: 'category', MARKET: 'market' }

/** Which row (or template) supplied a part of the playbook. */
export interface PlaybookSource {
  level: PlaybookSourceLevel
  /** AdsPlaybook.id, or AdsPlaybookTemplate.id for the template. */
  id: string
  label: string
  version: number
  /** The PRODUCT row of the product's parent. */
  via?: 'parent'
}

export interface Resolved<T> {
  value: T | null
  source: PlaybookSource | null
}

export const PRODUCT_FIELDS = [
  'enrolled', 'state', 'nameToken', 'portfolioName', 'dailyBudgetCents', 'baseBidCents', 'terms', 'phaseRecipes',
  'compiledVersion', 'compiledTemplateVersion',
] as const
export type ProductField = (typeof PRODUCT_FIELDS)[number]

export interface ResolvedPlaybook {
  template: (Resolved<{ id: string; name: string; version: number; status: string }>)
  sections: Record<SectionKey, Resolved<unknown>>
  /** PRODUCT subjects: the optional slots this product leaves out. */
  skipSlots: Resolved<string[]> | null
  /** PB-10 — PRODUCT subjects: each adopted slot's placements as adopted (drift's baseline for it; never compiled). */
  adoptedPlacements: Resolved<NonNullable<Overrides['adoptedPlacements']>> | null
  /** PRODUCT subjects: the product's own fields. */
  product: Record<ProductField, Resolved<unknown>> | null
  /** The doc the subject would be built from (sections whole, skipped slots left out), when it is complete and consistent. */
  doc: TemplateDoc | null
  problems: string[]
  warnings: string[]
}

export interface PlaybookIndex {
  market: string
  channel: string
  marketRow: PlaybookRow | null
  categories: ReadonlyMap<string, PlaybookRow>
  products: ReadonlyMap<string, PlaybookRow>
  /** Each row's overrides, read once: the sections that read (a section that does not is ignored, with a warning). */
  overrides: ReadonlyMap<string, Overrides>
  templates: ReadonlyMap<string, TemplateRow>
  rows: readonly PlaybookRow[]
  warnings: string[]
}

export interface PlaybookOrphan {
  playbookId: string
  level: string
  scopeId: string
  label: string
  why: string
}

const rowName = (row: PlaybookRow) => `${row.label} (${LEVEL_OF[row.level as StrategyLevel] ?? row.level}, v${row.version})`
const shown = (value: unknown) => JSON.stringify(value)

/** A row's overrides, section by section: each that reads under its own schema; the rest named in `warnings`. */
function readOverrides(row: PlaybookRow, warnings: string[]): Overrides {
  const value = row.overrides
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    warnings.push(`${rowName(row)}: overrides is not a map of sections; ignored`)
    return {}
  }
  const out: Overrides = {}
  for (const [key, section] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'skipSlots') {
      if (row.level !== 'PRODUCT') { warnings.push(`${rowName(row)}: skipSlots belongs on a product row; ignored`); continue }
      const parsed = OVERRIDES.shape.skipSlots.safeParse(section)
      if (parsed.success) out.skipSlots = parsed.data
      else warnings.push(`${rowName(row)}: skipSlots is not a list of slot keys; ignored`)
      continue
    }
    if (key === 'adoptedPlacements') {
      if (row.level !== 'PRODUCT') { warnings.push(`${rowName(row)}: adoptedPlacements belongs on a product row; ignored`); continue }
      const parsed = OVERRIDES.shape.adoptedPlacements.safeParse(section)
      if (parsed.success) out.adoptedPlacements = parsed.data
      else warnings.push(`${rowName(row)}: adoptedPlacements is not a map of slot placements; ignored`)
      continue
    }
    if (!(SECTIONS as readonly string[]).includes(key)) { warnings.push(`${rowName(row)}: overrides names an unknown section ${shown(key)}; ignored`); continue }
    const read = readSection(key as SectionKey, section)
    if ('value' in read) (out as Record<string, unknown>)[key] = read.value
    else warnings.push(`${rowName(row)}: its ${key} section does not read (${read.problems.slice(0, 3).join('; ')}); ignored`)
  }
  return out
}

/**
 * The rows of ONE market, indexed by scope and read once, with every template of the business. `live` (from the
 * loader) names the categories and products that still exist; a row whose scope is gone is an orphan: never resolved.
 */
export function indexPlaybook(
  market: string,
  rows: readonly PlaybookRow[],
  templates: readonly TemplateRow[],
  live?: { categories: ReadonlySet<string>; products: ReadonlySet<string> },
  channel = 'AMAZON',
): { index: PlaybookIndex; orphans: PlaybookOrphan[] } {
  const warnings: string[] = []
  const orphans: PlaybookOrphan[] = []
  let marketRow: PlaybookRow | null = null
  const categories = new Map<string, PlaybookRow>()
  const products = new Map<string, PlaybookRow>()
  const overrides = new Map<string, Overrides>()
  const kept: PlaybookRow[] = []
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
      orphans.push({ playbookId: row.id, level: row.level, scopeId: row.scopeId, label: row.label, why: 'the category no longer exists' })
      continue
    }
    if (row.level === 'PRODUCT' && live && !live.products.has(row.scopeId)) {
      orphans.push({ playbookId: row.id, level: row.level, scopeId: row.scopeId, label: row.label, why: 'the product no longer exists or was deleted' })
      continue
    }
    if (row.level === 'MARKET') marketRow = row
    else (row.level === 'CATEGORY' ? categories : products).set(row.scopeId, row)
    if (row.templateId && !templates.some((t) => t.id === row.templateId)) warnings.push(`${rowName(row)}: its template no longer exists; the next row's template applies`)
    overrides.set(row.id, readOverrides(row, warnings))
    kept.push(row)
  }
  return {
    index: { market, channel, marketRow, categories, products, overrides, templates: new Map(templates.map((t) => [t.id, t])), rows: kept, warnings },
    orphans,
  }
}

// ── Resolving ─────────────────────────────────────────────────────────────────────────────────────

const sourceOf = (row: PlaybookRow, via?: 'parent'): PlaybookSource => ({
  level: LEVEL_OF[row.level as StrategyLevel], id: row.id, label: row.label, version: row.version, ...(via ? { via } : {}),
})
const templateSource = (t: TemplateRow): PlaybookSource => ({ level: 'template', id: t.id, label: t.name, version: t.version })

type Chain = Array<{ row: PlaybookRow; via?: 'parent' }>

function categoryChain(index: PlaybookIndex, categoryId: string, catalog: Pick<Catalog, 'ancestry'>): Chain {
  const path = catalog.ancestry.get(categoryId) ?? [categoryId]
  return path.map((id) => index.categories.get(id)).filter((row): row is PlaybookRow => !!row).map((row) => ({ row }))
}

const marketChain = (index: PlaybookIndex): Chain => (index.marketRow ? [{ row: index.marketRow }] : [])

/** The doc with the skipped slots left out, and every reference to them (weights, ladder, placements, edges, phases). */
function withoutSlots(doc: TemplateDoc, skip: ReadonlySet<string>, warnings: string[]): TemplateDoc {
  if (!skip.size) return doc
  const drop = <V>(record: Record<string, V>) => Object.fromEntries(Object.entries(record).filter(([key]) => !skip.has(key)))
  const edges = doc.harvest.edges.flatMap((edge) => {
    const from = edge.from.filter((key) => !skip.has(key))
    if (!from.length) return []
    if (typeof edge.to === 'string') return skip.has(edge.to) ? [] : [{ ...edge, from }]
    const { brand, competitor, category } = edge.to
    if (skip.has(category)) return []
    // A skipped brand or competitor slot hands its terms to the category slot (the router's conservative default).
    return [{ ...edge, from, to: { ...edge.to, brand: skip.has(brand) ? category : brand, competitor: skip.has(competitor) ? category : competitor } }]
  })
  if (edges.length < doc.harvest.edges.length) warnings.push(`${doc.harvest.edges.length - edges.length} harvest edge(s) lead only to or from slots this product leaves out; they are left out too`)
  const roles = Object.fromEntries(Object.entries(doc.rank.roles).map(([role, plan]) => [role, plan && plan.slotOverrides ? { ...plan, slotOverrides: drop(plan.slotOverrides) } : plan]))
  return {
    ...doc,
    structure: { ...doc.structure, slots: doc.structure.slots.filter((s) => !skip.has(s.key)) },
    budget: { ...doc.budget, weights: drop(doc.budget.weights) },
    bids: { ...doc.bids, ladder: drop(doc.bids.ladder) },
    placements: drop(doc.placements),
    harvest: { edges },
    rank: { roles: roles as TemplateDoc['rank']['roles'] },
    phases: Object.fromEntries(Object.entries(doc.phases).map(([phase, entry]) => [phase, entry && {
      ...entry, slots: drop(entry.slots), ...(entry.weights ? { weights: drop(entry.weights) } : {}),
    }])) as TemplateDoc['phases'],
  }
}

/** A product field as stored: the JSON ones read under their schemas (an unreadable one is ignored, with a warning). */
function fieldValue(row: PlaybookRow, field: ProductField, warnings: string[]): unknown {
  const value = row[field]
  if (value == null) return null
  if (field === 'terms' || field === 'phaseRecipes') {
    const parsed = (field === 'terms' ? PRODUCT_TERMS : PHASE_RECIPES).safeParse(value)
    if (parsed.success) return parsed.data
    warnings.push(`${rowName(row)}: its ${field} do not read (${parsed.error.issues.slice(0, 2).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}); ignored`)
    return null
  }
  return value
}

/** Resolve ONE subject from its chain, most specific row first. */
function resolveChain(index: PlaybookIndex, chain: Chain, productChain: Chain | null, warnings: string[]): ResolvedPlaybook {
  const problems: string[] = []
  // The template: from the first row that names one that still exists.
  const named = chain.find(({ row }) => row.templateId && index.templates.has(row.templateId))
  const template = named ? index.templates.get(named.row.templateId!)! : null
  if (template && template.status === 'RETIRED') warnings.push(`The template "${template.name}" is retired; it still applies here until a row names another`)
  const templateDoc: Partial<Record<SectionKey, unknown>> = {}
  if (template) {
    const doc = template.doc && typeof template.doc === 'object' && !Array.isArray(template.doc) ? (template.doc as Record<string, unknown>) : {}
    for (const key of SECTIONS) {
      if (doc[key] === undefined) continue
      const read = readSection(key, doc[key])
      if ('value' in read) templateDoc[key] = read.value
      else warnings.push(`The template "${template.name}" (v${template.version}): its ${key} section does not read (${read.problems.slice(0, 3).join('; ')}); ignored`)
    }
  }

  const sections = {} as Record<SectionKey, Resolved<unknown>>
  for (const key of SECTIONS) {
    const hit = chain.find(({ row }) => index.overrides.get(row.id)?.[key] !== undefined)
    if (hit) sections[key] = { value: index.overrides.get(hit.row.id)![key], source: sourceOf(hit.row, hit.via) }
    else if (template && templateDoc[key] !== undefined) sections[key] = { value: templateDoc[key], source: templateSource(template) }
    else sections[key] = { value: null, source: null }
  }

  let skipSlots: ResolvedPlaybook['skipSlots'] = null
  let adoptedPlacements: ResolvedPlaybook['adoptedPlacements'] = null
  let product: ResolvedPlaybook['product'] = null
  if (productChain) {
    const hit = productChain.find(({ row }) => index.overrides.get(row.id)?.skipSlots !== undefined)
    skipSlots = hit ? { value: index.overrides.get(hit.row.id)!.skipSlots!, source: sourceOf(hit.row, hit.via) } : { value: [], source: null }
    const adopted = productChain.find(({ row }) => index.overrides.get(row.id)?.adoptedPlacements !== undefined)
    adoptedPlacements = adopted ? { value: index.overrides.get(adopted.row.id)!.adoptedPlacements!, source: sourceOf(adopted.row, adopted.via) } : { value: {}, source: null }
    product = {} as Record<ProductField, Resolved<unknown>>
    for (const field of PRODUCT_FIELDS) {
      let picked: Resolved<unknown> = { value: null, source: null }
      for (const { row, via } of productChain) {
        const value = fieldValue(row, field, warnings)
        if (value !== null) { picked = { value, source: sourceOf(row, via) }; break }
      }
      product[field] = picked
    }
  }

  const missing = SECTIONS.filter((key) => sections[key].value === null)
  if (!template && !chain.some(({ row }) => index.overrides.get(row.id) && Object.keys(index.overrides.get(row.id)!).length)) problems.push('No playbook applies here: no row names a template')
  else if (missing.length) problems.push(`Incomplete: no ${missing.join(', ')} section (no row sets it and ${template ? `the template "${template.name}" has none` : 'no row names a template'})`)
  let doc: TemplateDoc | null = null
  if (!missing.length) {
    let whole = Object.fromEntries(SECTIONS.map((key) => [key, sections[key].value])) as TemplateDoc
    const skip = new Set(skipSlots?.value ?? [])
    for (const key of [...skip]) {
      const slot = whole.structure.slots.find((s) => s.key === key)
      if (!slot) { warnings.push(`skipSlots names "${key}", which no slot is; ignored`); skip.delete(key) }
      else if (!slot.optional) { warnings.push(`skipSlots names "${key}", which is not an optional slot; it stays`); skip.delete(key) }
    }
    whole = withoutSlots(whole, skip, warnings)
    const crossed = crossCheck(whole)
    if (crossed.length) problems.push(...crossed.map((p) => `Inconsistent: ${p}`))
    else doc = whole
  }
  return {
    template: template ? { value: { id: template.id, name: template.name, version: template.version, status: template.status }, source: sourceOf(named!.row, named!.via) } : { value: null, source: null },
    sections,
    skipSlots,
    adoptedPlacements,
    product,
    doc,
    problems,
    warnings: [...new Set(warnings)],
  }
}

/** The market itself: its own row, then its template. */
export function resolveMarket(index: PlaybookIndex): ResolvedPlaybook {
  return resolveChain(index, marketChain(index), null, [...index.warnings])
}

/** A category: its row and its ancestors' rows, deepest first, then the market. */
export function resolveCategory(index: PlaybookIndex, categoryId: string, catalog: Pick<Catalog, 'ancestry'>): ResolvedPlaybook {
  return resolveChain(index, [...categoryChain(index, categoryId, catalog), ...marketChain(index)], null, [...index.warnings])
}

/** One product (a variation or a parent): its row, its parent's, its root's primary category chain, the market. */
export function resolveProduct(index: PlaybookIndex, product: CatalogProduct, catalog: Catalog): ResolvedPlaybook {
  const warnings = [...index.warnings]
  const own: Chain = []
  const mine = index.products.get(product.id)
  if (mine) own.push({ row: mine })
  const parent = product.parentId ? index.products.get(product.parentId) : undefined
  if (parent) own.push({ row: parent, via: 'parent' })
  const { ids, warning } = categoriesFor(product, catalog)
  let categories: Chain = []
  if (ids.length === 1) categories = categoryChain(index, ids[0], catalog)
  else if (ids.length > 1) {
    const withRows = ids.filter((id) => categoryChain(index, id, catalog).length)
    if (withRows.length) warnings.push(`${warning ?? `${product.sku}: its family has ${ids.length} categories`}; a playbook has no safer value to pick, so no category playbook applies (the market's does)`)
  }
  return resolveChain(index, [...own, ...categories, ...marketChain(index)], own, warnings)
}

/** Is this product in (Owner decision D-PB4)? Only its own row or its parent's says so; nothing broader enrolls. */
export const isEnrolled = (resolved: ResolvedPlaybook) => resolved.product?.enrolled.value === true
