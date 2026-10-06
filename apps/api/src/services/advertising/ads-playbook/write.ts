/**
 * ADS PLAYBOOK PB-3 — the ads playbook, written: ONE change of ONE template or ONE playbook row, planned and applied,
 * each change kept as a version. Shared by Claude's `set-ads-playbook` and the Control Room's Playbook section
 * (POST/PUT /api/advertising/automation/playbook…).
 *
 *   template  set (a new one needs its whole doc; an existing one takes its whole doc or some sections, a name, a
 *             status), capture (a new template, or an existing one's doc, captured from live campaigns — capture.ts),
 *             remove (only while no playbook row names it; retire it otherwise)
 *   row       set (template, whole-section overrides, skipSlots, and on a product row its name token, portfolio, daily
 *             budget, base bid, terms, phase recipes), enroll / leave (a product row: the Owner's "include this
 *             product", Owner decision D-PB4), remove (a row that owns nothing at Amazon)
 *   enroll    makes the template's phase recipes absolute for the product (recipes.ts): its break-even ACoS from profit
 *             data (its family's, revenue-weighted, the last 90 days), the market's target ACoS (the strategy's market
 *             row, else the account default, else 30 %) and its base bid. A product enrolls only into a playbook that
 *             compiles. Recipes the row already holds stay unless `recompute`.
 *   judge     each change is RAISE / LOWER / SAME by what it would make an ENROLLED product spend once applied
 *             (judge.ts): enrolling, a higher daily budget or base bid, more terms, slots, start-bid factors,
 *             placements, an isolation switch off. A raise needs settings.security.manage and a fresh authenticator
 *             code — on the screen with the code (the route), from Claude approved in Nexus with it or confirmed in
 *             Claude with it (set-ads-playbook) — and never runs by rule. Everything else a person approves, or the
 *             business's rule runs inside the tool's limits.
 *   apply     ONE transaction: the row (version + 1; a stale `expectVersion` or a row moved since → a conflict) and one
 *             AdsPlaybookVersion row (changes, direction, via, approvalId, actor, stepUpAt).
 *
 * Live effect: NONE at Amazon and none in any engine — nothing reads a playbook. It is compiled only by an approved
 * apply (build and adopt: apply-ads-playbook, PB-5a; sync, PB-10; start and phase come later).
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { Prisma } from '@nexus/database'
import prisma from '../../../db.js'
import { STEP_UP_NEEDS } from '../../agents/step-up-approval.js'
import type { RaiseWords } from '../../agents/claude-trust.service.js'
import { PRODUCT_NOT_FOUND } from '../../agents/tools/live-product.js'
import { MARKET_SCOPE, fractionToPct, type StrategyLevel } from '../ads-strategy/fields.js'
import { openStrategy } from '../ads-strategy/effective.js'
import { findCategory, findLiveProduct, loadCatalog, productFamily } from '../ads-strategy/load.js'
import { accountDefaultFraction, readOwnerTargets } from '../ads-target-acos-resolver.js'
import { computeProductTargetAcos } from '../ads-target-acos.service.js'
import { captureTemplate } from './capture.js'
import {
  checkTemplateDoc,
  OVERRIDES,
  PHASE_RECIPES,
  PRODUCT_TERMS,
  readSection,
  SECTIONS,
  TEMPLATE_STATUSES,
  type Overrides,
  type PhaseRecipes,
  type ProductTerms,
  type SectionKey,
  type TemplateDoc,
} from './doc.js'
import { judgeDoc, judgeEnrolled, judgeMoney, judgeTerms, overall, same, type Direction } from './judge.js'
import { loadCaptureSource, loadPlaybookRows, loadTemplates, PLAYBOOK_ROW_SELECT, TEMPLATE_ROW_SELECT } from './load.js'
import { absoluteRecipes } from './recipes.js'
import { indexPlaybook, isEnrolled, resolveProduct, type PlaybookRow, type ResolvedPlaybook, type TemplateRow } from './resolve.js'

// ── The change, as asked ──────────────────────────────────────────────────────────────────────────

const ID = z.string().trim().min(1).max(64)
const CENTS = z.number().int().min(1).max(10_000_000)
/** A JSON object whose shape doc.ts checks (a whole template doc, or sections): its problems come back by path. */
const JSON_OBJECT = z.record(z.string(), z.unknown())

/** One value per field: a value sets it, null clears it (the row then inherits it), absent leaves it as it is. */
export const PLAYBOOK_VALUES_INPUT = z.object({
  templateId: ID.nullable().optional().describe('the template this row follows (templateId from ads-playbook view templates); null = inherit it from a broader row'),
  overrides: JSON_OBJECT.optional()
    .describe("sections this row replaces WHOLE — structure, budget, bids, placements, harvest, isolation, rank, phases, each in the template doc's own shape (read one with ads-playbook view templates and a templateId); null for a section clears it (it inherits again); a product row may also give skipSlots: the optional slots it leaves out"),
  enrolled: z.boolean().optional().describe("product rows: the Owner's \"include this product\" (op enroll and op leave set it too)"),
  nameToken: z.string().trim().min(1).max(40).nullable().optional().describe("product rows: the product's token in campaign names"),
  portfolioName: z.string().trim().min(1).max(120).nullable().optional().describe("product rows: the Amazon portfolio its campaigns go into (no '·': Amazon refuses it)"),
  dailyBudgetCents: CENTS.nullable().optional().describe("product rows: its daily ad budget, in cents of the market's currency, split across the slots by the template's weights"),
  baseBidCents: CENTS.nullable().optional().describe("product rows: the base bid the template's start-bid ladder multiplies, in cents"),
  terms: PRODUCT_TERMS.nullable().optional().describe('product rows: its brand, category (exact at start marks), competitor and competitor-ASIN terms, and its negatives'),
  phaseRecipes: PHASE_RECIPES.nullable().optional().describe("product rows: each phase's numbers for this product, in the ads strategy's field names (whole percents, cents); written into the strategy only by an approved phase switch"),
}).strict()

/**
 * The one change, as Claude's tool and the screen ask for it. Unknown top-level names are refused at Claude's door with
 * the name meant (tool-arguments.ts); inside `values`, an unknown key is refused here (strict).
 */
export const PLAYBOOK_CHANGE_INPUT = z.object({
  channel: z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.enum(['AMAZON']))
    .describe('AMAZON: the playbook covers Amazon Sponsored Products in this release'),
  kind: z.enum(['template', 'playbook']).describe('template (a reusable playbook) or playbook (one row: a market, a category or a product in one market)'),
  op: z.enum(['set', 'capture', 'enroll', 'leave', 'remove']).default('set')
    .describe('template: set, capture (from live campaigns) or remove (only while no row names it); playbook: set, enroll or leave (a product row), remove'),
  templateId: ID.optional().describe('template: the one to change (absent with op set or capture: a new template)'),
  name: z.string().trim().min(1).max(80).optional().describe('template: its name (a new one needs it; unique in the business)'),
  status: z.enum(TEMPLATE_STATUSES).optional().describe('template: DRAFT, ACTIVE or RETIRED (a retired template still applies where a row names it; no row may newly name it)'),
  doc: JSON_OBJECT.optional().describe("template, op set: the WHOLE doc (structure, budget, bids, placements, harvest, isolation, rank, phases); a new template needs it"),
  sections: JSON_OBJECT.optional().describe('template, op set: some sections only, each replaced whole'),
  market: z.string().trim().toUpperCase().min(2).max(20).optional()
    .describe('playbook: ONE Amazon market code (IT, DE, FR, ES, UK; business-overview lists them) — every row belongs to one market; capture: the market of the campaigns'),
  level: z.preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v), z.enum(['market', 'category', 'product'])).optional()
    .describe('playbook: market, category (with categoryId) or product (with productId or sku; a parent covers its variations)'),
  categoryId: ID.optional().describe('level category: the category, its Nexus id (catalog-structure)'),
  productId: ID.optional().describe('level product: the product (a parent or a variation), its Nexus id'),
  sku: z.string().trim().min(1).max(100).optional().describe("level product, instead of productId: the product's SKU in this business"),
  values: PLAYBOOK_VALUES_INPUT.optional().describe('playbook: the fields to set: a value sets it, null clears it (inherit), absent leaves it'),
  recompute: z.boolean().default(false).describe("op enroll: make the phase recipes again from the template, even when the row holds some"),
  campaignIds: z.array(ID).min(1).max(50).optional().describe('capture: the live campaigns, their Nexus ids (campaignId in ad-campaigns); or portfolioId, or namePrefix'),
  portfolioId: z.string().trim().min(1).max(64).optional().describe('capture: every campaign of this Amazon portfolio'),
  namePrefix: z.string().trim().min(1).max(120).optional().describe('capture: every campaign whose name starts with this'),
  productToken: z.string().trim().min(1).max(60).optional().describe("capture: the product's token in the campaign names"),
  competitorTokens: z.array(z.string().trim().min(1).max(60)).max(30).optional().describe('capture: rival brand words'),
  expectVersion: z.number().int().min(0).optional().describe('the version you read (0 when it does not exist yet): refused when it moved since'),
  reason: z.string().trim().max(500).optional().describe('why, in a sentence: kept with the version'),
})

export type PlaybookChangeInput = z.input<typeof PLAYBOOK_CHANGE_INPUT>
type ChangeArgs = z.output<typeof PLAYBOOK_CHANGE_INPUT>

// ── Plans ─────────────────────────────────────────────────────────────────────────────────────────

/** A row's own values, as the writer keeps them. */
export interface RowValues {
  templateId: string | null
  overrides: Overrides | null
  enrolled: boolean | null
  state: string | null
  nameToken: string | null
  portfolioName: string | null
  dailyBudgetCents: number | null
  baseBidCents: number | null
  terms: ProductTerms | null
  phaseRecipes: PhaseRecipes | null
}
export interface TemplateValues {
  name: string
  status: string
  doc: TemplateDoc
  capturedFrom: unknown
}

/** What a change wrote and replaced: the change record (and its undo) compares these. */
export type PlaybookState =
  | { kind: 'template'; channel: string; templateId: string | null; version: number; values: TemplateValues | null }
  | { kind: 'playbook'; channel: string; market: string; level: StrategyLevel; scopeId: string; version: number; values: RowValues | null }

/** One recorded change: a field of the row (or the template), or one section. */
export interface PlaybookChange {
  field: string
  label: string
  from: unknown
  to: unknown
  direction: Direction
}

type Scope =
  | { level: 'MARKET'; scopeId: typeof MARKET_SCOPE; label: string }
  | { level: 'CATEGORY'; scopeId: string; label: string }
  | { level: 'PRODUCT'; scopeId: string; label: string; product: { id: string; sku: string; parentId: string | null } }

export interface PlaybookPreview {
  action: 'set-ads-playbook'
  summary: string
  kind: 'template' | 'playbook'
  op: ChangeArgs['op']
  target: { templateId: string | null; name: string } | { channel: string; market: string; level: StrategyLevel; scopeId: string; label: string }
  version: { from: number; to: number | null }
  changes: PlaybookChange[]
  direction: Direction
  raises: string[]
  stepUp: { what: string; raises: string[]; needs: string; how: string } | null
  reachesAmazon: false
  reachNote: string
  liveEffect: string
  affects: { enrolledProducts: number; products: Array<{ productId: string; sku: string; market: string }> }
  recipes?: { phaseRecipes: PhaseRecipes; from: Record<string, unknown>; notes: string[] }
  capture?: { slots: unknown; product: unknown; warnings: string[] }
  problems?: string[]
  warnings?: string[]
  basis: string
}

export interface PlaybookPlan {
  kind: 'template' | 'playbook'
  op: ChangeArgs['op']
  channel: string
  /** template: the row as it is (null: a new one) and its values after (null: removed). */
  template?: { row: { id: string; version: number } | null; after: TemplateValues | null }
  /** playbook: the scope, the row as it is (null: a new one) and its values after (null: removed). */
  playbook?: { market: string; scope: Scope; row: { id: string; version: number } | null; after: RowValues | null }
  changes: PlaybookChange[]
  direction: Direction
  raises: string[]
  reason: string | null
  before: PlaybookState
  preview: PlaybookPreview
}

export type PlanOutcome = { ok: true; plan: PlaybookPlan } | { ok: false; status: 400 | 404 | 409; error: string; code?: 'version_moved' }

const refuse = (status: 400 | 404 | 409, error: string, code?: 'version_moved'): PlanOutcome => ({ ok: false, status, error, ...(code ? { code } : {}) })
const MAX_LISTED = 50
const MOVED_PLAN = 'It moved since you read it (expectVersion): read it again and change it from there.'
const SECTION_LABEL: Record<SectionKey, string> = {
  structure: 'Campaign set (slots)', budget: 'Budget split', bids: 'Start-bid ladder', placements: 'Placements',
  harvest: 'Harvest flows', isolation: 'Isolation', rank: 'Hourly plans by rank role', phases: 'Phase table',
}
const FIELD_LABEL: Record<string, string> = {
  templateId: 'Template', 'overrides.skipSlots': 'Slots left out', 'overrides.adoptedPlacements': 'Placements as adopted (drift baseline)', enrolled: 'Enrolled', nameToken: 'Name token',
  portfolioName: 'Portfolio', dailyBudgetCents: 'Daily budget', baseBidCents: 'Base bid', terms: 'Terms', phaseRecipes: 'Phase recipes',
  name: 'Name', status: 'Status',
}
const labelOf = (field: string) => FIELD_LABEL[field] ?? (field.startsWith('overrides.') || field.startsWith('section.') ? SECTION_LABEL[field.split('.')[1] as SectionKey] ?? field : field)
const issues = (error: z.ZodError) => error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')
const canonicalHash = (value: unknown) => createHash('sha256').update(JSON.stringify(sortKeys(value ?? null))).digest('base64url').slice(0, 32)
const sortKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortKeys) : v !== null && typeof v === 'object' && !(v instanceof Date)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v

const rowValuesOf = (row: PlaybookRow | null): RowValues | null => {
  if (!row) return null
  const overrides = OVERRIDES.safeParse(row.overrides ?? {})
  const terms = PRODUCT_TERMS.safeParse(row.terms)
  const recipes = PHASE_RECIPES.safeParse(row.phaseRecipes)
  return {
    templateId: row.templateId, overrides: row.overrides == null ? null : overrides.success ? overrides.data : (row.overrides as Overrides),
    enrolled: row.enrolled, state: row.state, nameToken: row.nameToken, portfolioName: row.portfolioName,
    dailyBudgetCents: row.dailyBudgetCents, baseBidCents: row.baseBidCents,
    terms: row.terms == null ? null : terms.success ? terms.data : (row.terms as ProductTerms),
    phaseRecipes: row.phaseRecipes == null ? null : recipes.success ? recipes.data : (row.phaseRecipes as PhaseRecipes),
  }
}
const asRow = (base: PlaybookRow | null, scope: Scope, market: string, channel: string, values: RowValues): PlaybookRow => ({
  id: base?.id ?? 'planned', channel, market, level: scope.level, scopeId: scope.scopeId, label: scope.label, version: (base?.version ?? 0) + 1,
  templateId: values.templateId, overrides: values.overrides, enrolled: values.enrolled, state: values.state, nameToken: values.nameToken,
  portfolioName: values.portfolioName, dailyBudgetCents: values.dailyBudgetCents, baseBidCents: values.baseBidCents, terms: values.terms,
  phaseRecipes: values.phaseRecipes, compiledVersion: base?.compiledVersion ?? null, compiledTemplateVersion: base?.compiledTemplateVersion ?? null,
  updatedAt: new Date(0), updatedBy: 'planned',
})

// ── What a change would make an enrolled product spend ────────────────────────────────────────────

interface Effect {
  sections: Map<SectionKey, Direction>
  enrolled: Direction
  dailyBudgetCents: Direction
  baseBidCents: Direction
  terms: Direction
  products: Array<{ productId: string; sku: string; market: string }>
}

const noEffect = (): Effect => ({ sections: new Map(), enrolled: 'same', dailyBudgetCents: 'same', baseBidCents: 'same', terms: 'same', products: [] })
const num = (v: unknown) => (typeof v === 'number' ? v : null)

/**
 * The effect in ONE market: every product row's playbook resolved before and after (rows and templates as given); a
 * product enrolled before or after counts. Each section's direction (judge.ts) and the product's own money and terms.
 */
async function effectIn(
  market: string,
  channel: string,
  rows: { before: readonly PlaybookRow[]; after: readonly PlaybookRow[] },
  templates: { before: readonly TemplateRow[]; after: readonly TemplateRow[] },
  into: Effect,
): Promise<void> {
  const products = [...new Set([...rows.before, ...rows.after].filter((r) => r.level === 'PRODUCT').map((r) => r.scopeId))]
  if (!products.length) return
  const { catalog } = await loadCatalog(products)
  const before = indexPlaybook(market, rows.before, templates.before, undefined, channel).index
  const after = indexPlaybook(market, rows.after, templates.after, undefined, channel).index
  const add = (map: Map<SectionKey, Direction>, key: SectionKey, d: Direction) => map.set(key, overall([map.get(key) ?? 'same', d]))
  for (const id of products) {
    const product = catalog.products.get(id)
    if (!product) continue
    const b = resolveProduct(before, product, catalog)
    const a = resolveProduct(after, product, catalog)
    const was = isEnrolled(b)
    const is = isEnrolled(a)
    if (!was && !is) continue
    into.products.push({ productId: id, sku: product.sku, market })
    into.enrolled = overall([into.enrolled, judgeEnrolled(was, is)])
    if (!is) continue
    for (const [key, d] of judgeDoc(was ? b.doc : null, a.doc)) add(into.sections, key, d)
    into.dailyBudgetCents = overall([into.dailyBudgetCents, judgeMoney(was ? num(b.product?.dailyBudgetCents.value) : null, num(a.product?.dailyBudgetCents.value))])
    into.baseBidCents = overall([into.baseBidCents, judgeMoney(was ? num(b.product?.baseBidCents.value) : null, num(a.product?.baseBidCents.value))])
    into.terms = overall([into.terms, judgeTerms(was ? (b.product?.terms.value as ProductTerms | null) : null, a.product?.terms.value as ProductTerms | null)])
  }
}

function directionOf(field: string, effect: Effect): Direction {
  if (field === 'templateId') return overall([...effect.sections.values()])
  if (field === 'overrides.skipSlots') return effect.sections.get('structure') ?? 'same'
  if (field.startsWith('overrides.') || field.startsWith('section.')) return effect.sections.get(field.split('.')[1] as SectionKey) ?? 'same'
  if (field === 'enrolled') return effect.enrolled
  if (field === 'dailyBudgetCents' || field === 'baseBidCents' || field === 'terms') return effect[field]
  return 'same'
}

// ── Recipes at enrollment ─────────────────────────────────────────────────────────────────────────

/** The facts a product's phase recipes are made absolute from, and where each came from. */
async function recipeFacts(market: string, channel: string, productId: string, baseBidCents: number | null) {
  const family = await productFamily(productId)
  const results = await Promise.all(family.map((id) => computeProductTargetAcos({ productId: id, marketplace: market, windowDays: 90 })))
  const known = results.filter((r) => r.basis === 'profit-data' && r.breakevenAcos != null && r.grossRevenueCents > 0)
  const revenue = known.reduce((n, r) => n + r.grossRevenueCents, 0)
  const breakEvenPct = revenue > 0 ? Math.round((known.reduce((n, r) => n + r.breakevenAcos! * r.grossRevenueCents, 0) / revenue) * 100) : null
  const strategy = await openStrategy(market, channel)
  const marketPct = strategy.forMarket().values.targetAcosPct
  const account = accountDefaultFraction((await readOwnerTargets([])).accountDefaultPct)
  const marketTargetPct = marketPct ?? (typeof account === 'number' ? fractionToPct(account) : 30)
  return {
    facts: { breakEvenPct, marketTargetPct, baseBidCents },
    from: {
      breakEvenAcosPct: breakEvenPct,
      breakEvenFrom: breakEvenPct == null ? 'no cost data for this product or its variations (the last 90 days)' : `profit data of ${known.length} of ${family.length} products, the last 90 days, weighted by revenue`,
      marketTargetPct,
      marketTargetFrom: marketPct != null ? `the ads strategy of ${market}` : typeof account === 'number' ? "the account's default target ACoS" : 'no target set: 30 %',
      baseBidCents,
    },
  }
}

// ── Templates ─────────────────────────────────────────────────────────────────────────────────────

async function planTemplate(args: ChangeArgs): Promise<PlanOutcome> {
  const channel = args.channel
  if (args.op !== 'set' && args.op !== 'capture' && args.op !== 'remove') return refuse(400, `op ${args.op} is for a playbook row (kind playbook), not a template.`)
  if (args.values || args.level || args.categoryId || args.productId || args.sku) return refuse(400, 'A template names no scope and takes no values: use kind playbook for a market, category or product row.')
  const templates = await loadTemplates(channel)
  const existing = args.templateId ? templates.find((t) => t.id === args.templateId) ?? null : null
  if (args.templateId && !existing) return refuse(404, 'Template not found (templateId from ads-playbook view templates).')
  if (args.expectVersion !== undefined && args.expectVersion !== (existing?.version ?? 0)) return refuse(409, MOVED_PLAN, 'version_moved')
  const beforeDoc = existing ? checkTemplateDoc(existing.doc) : null
  const before: PlaybookState = {
    kind: 'template', channel, templateId: existing?.id ?? null, version: existing?.version ?? 0,
    values: existing ? { name: existing.name, status: existing.status, doc: existing.doc as TemplateDoc, capturedFrom: existing.capturedFrom ?? null } : null,
  }
  const allRows = (await Promise.all((await playbookMarketsOf(channel)).map(async (market) => ({ market, rows: await loadPlaybookRows(market, channel) }))))
  const naming = allRows.flatMap((m) => m.rows.filter((r) => existing && r.templateId === existing.id).map((r) => ({ ...r, market: m.market })))

  let after: TemplateValues | null = null
  let capture: PlaybookPreview['capture']
  if (args.op === 'remove') {
    if (!existing) return refuse(400, 'Name the template to remove (templateId).')
    if (naming.length) return refuse(409, `${naming.length} playbook row(s) name this template (${naming.slice(0, 5).map((r) => `${r.label}`).join(', ')}): retire it instead (status RETIRED), or point those rows at another template first.`)
  } else {
    const name = args.name?.trim() || existing?.name
    if (!name) return refuse(400, 'A new template needs a name.')
    if (templates.some((t) => t.name === name && t.id !== existing?.id)) return refuse(409, `A template named "${name}" exists: change it by its templateId, or pick another name.`)
    let doc: unknown
    let capturedFrom: unknown = existing?.capturedFrom ?? null
    if (args.op === 'capture') {
      if (args.doc || args.sections) return refuse(400, 'A capture reads the doc from live campaigns: give no doc or sections.')
      if (!args.market || !args.productToken) return refuse(400, 'A capture needs the market of the campaigns (market) and the product\'s token in their names (productToken).')
      const selectors = [args.campaignIds?.length, args.portfolioId, args.namePrefix].filter(Boolean)
      if (selectors.length !== 1) return refuse(400, 'Name the live campaigns one way: campaignIds, portfolioId or namePrefix.')
      const source = await loadCaptureSource({ campaignIds: args.campaignIds, portfolioId: args.portfolioId, namePrefix: args.namePrefix, marketplace: args.market })
      if (!source.campaigns.length) return refuse(404, `No campaign in ${args.market} matches (campaignIds from ad-campaigns).`)
      const captured = captureTemplate({
        market: args.market, productToken: args.productToken, competitorTokens: args.competitorTokens,
        campaigns: source.campaigns.map((c) => ({ id: c.id, source: c.source })), schedules: source.schedules, floorTargets: source.floorTargets,
        portfolioName: source.portfolio?.name ?? null,
      })
      if (!captured.doc) return refuse(400, `The captured template does not pass its checks: ${captured.problems.slice(0, 5).join('; ')}`)
      doc = captured.doc
      capturedFrom = { campaignIds: source.campaigns.map((c) => c.id), productToken: args.productToken, market: args.market, at: new Date().toISOString() }
      capture = { slots: captured.slots, product: captured.product, warnings: captured.warnings }
    } else if (args.doc) {
      if (args.sections) return refuse(400, 'Give the whole doc or some sections, not both.')
      doc = args.doc
    } else if (args.sections) {
      if (!existing) return refuse(400, 'A new template needs its whole doc (doc), or capture one from live campaigns (op capture).')
      const unknown = Object.keys(args.sections).filter((k) => !(SECTIONS as readonly string[]).includes(k))
      if (unknown.length) return refuse(400, `sections: unknown section(s) ${unknown.join(', ')}; the sections are ${SECTIONS.join(', ')}.`)
      doc = { ...(existing.doc as Record<string, unknown>), ...args.sections }
    } else {
      if (!existing) return refuse(400, 'A new template needs its whole doc (doc), or capture one from live campaigns (op capture).')
      doc = existing.doc
    }
    const checked = checkTemplateDoc(doc)
    if ('problems' in checked) return refuse(400, `The template doc does not pass its checks: ${checked.problems.slice(0, 8).join('; ')}`)
    const status = args.status ?? existing?.status ?? 'ACTIVE'
    after = { name, status, doc: checked.doc, capturedFrom }
  }

  // The changes, and what they would make the enrolled products that follow this template spend.
  const changes: PlaybookChange[] = []
  if (after && (!existing || existing.name !== after.name)) changes.push({ field: 'name', label: 'Name', from: existing?.name ?? null, to: after.name, direction: 'same' })
  if (after && (!existing || existing.status !== after.status)) changes.push({ field: 'status', label: 'Status', from: existing?.status ?? null, to: after.status, direction: 'same' })
  for (const key of SECTIONS) {
    const from = existing ? (existing.doc as Record<string, unknown> | null)?.[key] ?? null : null
    const to = after ? after.doc[key] : null
    if (!same(from, to)) changes.push({ field: `section.${key}`, label: SECTION_LABEL[key], from, to, direction: 'same' })
  }
  const effect = noEffect()
  if (existing && naming.length) {
    const swapped = (doc: TemplateDoc | null): TemplateRow[] => templates.map((t) => (t.id === existing.id ? { ...t, doc: doc ?? {} } : t))
    for (const market of [...new Set(naming.map((r) => r.market))]) {
      const rows = allRows.find((m) => m.market === market)!.rows
      await effectIn(market, channel, { before: rows, after: rows }, { before: templates, after: swapped(after?.doc ?? null) }, effect)
    }
  }
  for (const c of changes) c.direction = directionOf(c.field, effect)
  const target = { templateId: existing?.id ?? null, name: after?.name ?? existing!.name }
  const usedNote = existing && naming.length ? '' : ' No playbook row names it yet, so it binds nothing until one does (that change is judged then).'
  return finish({
    kind: 'template', op: args.op, channel, target, version: { from: existing?.version ?? 0, to: after ? (existing?.version ?? 0) + 1 : null },
    changes, effect, reason: args.reason ?? null, before, template: { row: existing ? { id: existing.id, version: existing.version } : null, after },
    capture, extraNote: usedNote, beforeDocProblems: beforeDoc && 'problems' in beforeDoc ? beforeDoc.problems : null,
  })
}

async function playbookMarketsOf(channel: string): Promise<string[]> {
  const rows = await prisma.adsPlaybook.findMany({ where: { channel }, distinct: ['market'], select: { market: true } })
  return rows.map((r) => r.market).sort()
}

// ── Playbook rows ─────────────────────────────────────────────────────────────────────────────────

const PRODUCT_ONLY = ['enrolled', 'nameToken', 'portfolioName', 'dailyBudgetCents', 'baseBidCents', 'terms', 'phaseRecipes'] as const

async function scopeOf(args: ChangeArgs, market: string): Promise<Scope | PlanOutcome> {
  if (args.level === 'product') {
    if (args.categoryId) return refuse(400, 'A product row names a product (productId or sku), not a category.')
    if (!args.productId && !args.sku) return refuse(400, 'Name the product (productId or sku).')
    if (args.productId && args.sku) return refuse(400, 'Name the product once: productId or sku, not both.')
    const product = await findLiveProduct({ productId: args.productId, sku: args.sku })
    if (!product) return refuse(404, PRODUCT_NOT_FOUND)
    return { level: 'PRODUCT', scopeId: product.id, label: `${product.sku} (${market})`, product }
  }
  if (args.productId || args.sku) return refuse(400, 'A product (productId or sku) belongs to level product.')
  if (args.level === 'category') {
    if (!args.categoryId) return refuse(400, 'Name the category (categoryId).')
    const category = await findCategory(args.categoryId)
    if (!category) return refuse(404, 'Category not found (categoryId from catalog-structure).')
    return { level: 'CATEGORY', scopeId: category.id, label: `${category.name} (${market})` }
  }
  if (args.categoryId) return refuse(400, 'A category (categoryId) belongs to level category.')
  return { level: 'MARKET', scopeId: MARKET_SCOPE, label: `Amazon ${market}` }
}

/** The row's overrides with the asked sections set (null: cleared), each read with its own schema. */
function mergeOverrides(current: Overrides | null, asked: Record<string, unknown>, level: StrategyLevel): { overrides: Overrides | null } | PlanOutcome {
  const out: Record<string, unknown> = { ...(current ?? {}) }
  const problems: string[] = []
  for (const [key, value] of Object.entries(asked)) {
    if (key === 'skipSlots') {
      if (level !== 'PRODUCT') { problems.push('overrides.skipSlots: only a product row leaves slots out'); continue }
      if (value === null) { delete out.skipSlots; continue }
      const parsed = OVERRIDES.shape.skipSlots.safeParse(value)
      if (parsed.success) out.skipSlots = parsed.data
      else problems.push(`overrides.skipSlots: ${issues(parsed.error)}`)
      continue
    }
    if (key === 'adoptedPlacements') {
      if (level !== 'PRODUCT') { problems.push('overrides.adoptedPlacements: only a product row adopts campaigns'); continue }
      if (value === null) { delete out.adoptedPlacements; continue }
      const parsed = OVERRIDES.shape.adoptedPlacements.safeParse(value)
      if (parsed.success) out.adoptedPlacements = parsed.data
      else problems.push(`overrides.adoptedPlacements: ${issues(parsed.error)}`)
      continue
    }
    if (!(SECTIONS as readonly string[]).includes(key)) { problems.push(`overrides.${key}: not a section (${SECTIONS.join(', ')}, skipSlots or adoptedPlacements)`); continue }
    if (value === null) { delete out[key]; continue }
    const read = readSection(key as SectionKey, value)
    if ('value' in read) out[key] = read.value
    else problems.push(...read.problems.map((p) => `overrides.${p}`))
  }
  if (problems.length) return refuse(400, problems.slice(0, 8).join('; '))
  return { overrides: Object.keys(out).length ? (out as Overrides) : null }
}

async function planRow(args: ChangeArgs): Promise<PlanOutcome> {
  const channel = args.channel
  if (args.op === 'capture') return refuse(400, 'A capture makes a template (kind template).')
  if (args.templateId || args.name || args.status || args.doc || args.sections) {
    return refuse(400, 'templateId, name, status, doc and sections belong to kind template; a row names its template in values.templateId.')
  }
  if (!args.market) return refuse(400, 'Name the market (market): every playbook row belongs to one market.')
  if (!args.level) return refuse(400, 'Name the level: market, category or product.')
  const market = args.market
  const scope = await scopeOf(args, market)
  if ('ok' in scope) return scope
  if ((args.op === 'enroll' || args.op === 'leave') && scope.level !== 'PRODUCT') return refuse(400, `op ${args.op} is for a product row: a category or market playbook is a default, it never enrolls anything.`)

  const [rows, templates] = await Promise.all([loadPlaybookRows(market, channel), loadTemplates(channel)])
  const current = rows.find((r) => r.level === scope.level && r.scopeId === scope.scopeId) ?? null
  if (args.expectVersion !== undefined && args.expectVersion !== (current?.version ?? 0)) return refuse(409, MOVED_PLAN, 'version_moved')
  const values = args.values ?? {}
  if (scope.level !== 'PRODUCT') {
    const wrong = PRODUCT_ONLY.filter((k) => values[k] !== undefined)
    if (wrong.length) return refuse(400, `${wrong.join(', ')}: only a product row holds ${wrong.length === 1 ? 'it' : 'them'}.`)
  }
  const before: PlaybookState = { kind: 'playbook', channel, market, level: scope.level, scopeId: scope.scopeId, version: current?.version ?? 0, values: rowValuesOf(current) }

  let after: RowValues | null
  let recipes: PlaybookPreview['recipes']
  const problems: string[] = []
  if (args.op === 'remove') {
    if (!current) return refuse(404, 'There is no playbook row here to remove.')
    if (args.values) return refuse(400, 'A remove takes no values.')
    const links = await prisma.adsPlaybookLink.count({ where: { playbookId: current.id } })
    if (links) return refuse(409, `This playbook owns ${links} campaign(s), rule(s) or hourly plan(s): leave the product instead (op leave), or remove those first.`)
    after = null
  } else {
    const base: RowValues = before.values ?? {
      templateId: null, overrides: null, enrolled: null, state: null, nameToken: null, portfolioName: null, dailyBudgetCents: null,
      baseBidCents: null, terms: null, phaseRecipes: null,
    }
    const next: RowValues = { ...base }
    if (values.templateId !== undefined) {
      if (values.templateId !== null) {
        const named = templates.find((t) => t.id === values.templateId)
        if (!named) return refuse(404, 'Template not found (templateId from ads-playbook view templates).')
        if (named.status === 'RETIRED' && named.id !== base.templateId) return refuse(400, `The template "${named.name}" is retired: name another one.`)
      }
      next.templateId = values.templateId
    }
    if (values.overrides !== undefined) {
      const merged = mergeOverrides(base.overrides, values.overrides, scope.level)
      if ('ok' in merged) return merged
      next.overrides = merged.overrides
    }
    for (const key of ['nameToken', 'portfolioName', 'dailyBudgetCents', 'baseBidCents', 'terms', 'phaseRecipes'] as const) {
      if (values[key] !== undefined) (next as unknown as Record<string, unknown>)[key] = values[key]
    }
    if (next.portfolioName?.includes('·')) return refuse(400, "portfolioName: Amazon refuses '·' in a portfolio name.")
    if (values.enrolled !== undefined) next.enrolled = values.enrolled
    if (args.op === 'enroll') next.enrolled = true
    if (args.op === 'leave') next.enrolled = false
    if (next.enrolled && !next.state) next.state = 'DRAFT'
    after = next

    // Enrolling: only into a playbook that compiles; its phase recipes made absolute for this product.
    if (scope.level === 'PRODUCT' && next.enrolled) {
      const rowsAfter = [...rows.filter((r) => r.id !== current?.id), asRow(current, scope, market, channel, next)]
      const { catalog } = await loadCatalog([scope.scopeId])
      const resolved: ResolvedPlaybook = resolveProduct(indexPlaybook(market, rowsAfter, templates, undefined, channel).index, catalog.products.get(scope.scopeId) ?? scope.product, catalog)
      if (!resolved.doc) {
        const why = `this product's playbook does not compile: ${resolved.problems.slice(0, 5).join('; ')}`
        if (args.op === 'enroll' || !base.enrolled) return refuse(400, `Enrolling needs a playbook it can be built from, and ${why}`)
        problems.push(`After this change ${why}`)
      } else if (args.op === 'enroll' && values.phaseRecipes === undefined && (!base.phaseRecipes || args.recompute)) {
        const baseBid = num(resolved.product?.baseBidCents.value)
        const { facts, from } = await recipeFacts(market, channel, scope.scopeId, baseBid)
        const made = absoluteRecipes(resolved.doc.phases, facts)
        next.phaseRecipes = made.recipes
        recipes = { phaseRecipes: made.recipes, from, notes: made.notes }
      }
    }
  }

  // The changes, row field by row field, each judged by what it would make an enrolled product spend.
  const changes: PlaybookChange[] = []
  const was = before.values
  const field = (name: string, from: unknown, to: unknown) => { if (!same(from, to)) changes.push({ field: name, label: labelOf(name), from: from ?? null, to: to ?? null, direction: 'same' }) }
  field('templateId', was?.templateId, after?.templateId)
  for (const key of [...SECTIONS, 'skipSlots', 'adoptedPlacements'] as const) field(`overrides.${key}`, (was?.overrides as Record<string, unknown> | null)?.[key], (after?.overrides as Record<string, unknown> | null)?.[key])
  for (const key of ['enrolled', 'nameToken', 'portfolioName', 'dailyBudgetCents', 'baseBidCents', 'terms', 'phaseRecipes'] as const) field(key, was?.[key], after?.[key])
  const effect = noEffect()
  const rowsAfter = after ? [...rows.filter((r) => r.id !== current?.id), asRow(current, scope, market, channel, after)] : rows.filter((r) => r.id !== current?.id)
  await effectIn(market, channel, { before: rows, after: rowsAfter }, { before: templates, after: templates }, effect)
  for (const c of changes) c.direction = directionOf(c.field, effect)

  return finish({
    kind: 'playbook', op: args.op, channel,
    target: { channel, market, level: scope.level, scopeId: scope.scopeId, label: scope.label },
    version: { from: current?.version ?? 0, to: after ? (current?.version ?? 0) + 1 : null },
    changes, effect, reason: args.reason ?? null, before, playbook: { market, scope, row: current ? { id: current.id, version: current.version } : null, after },
    recipes, problems,
  })
}

// ── The preview ───────────────────────────────────────────────────────────────────────────────────

function finish(p: {
  kind: 'template' | 'playbook'; op: ChangeArgs['op']; channel: string; target: PlaybookPreview['target']; version: PlaybookPreview['version']
  changes: PlaybookChange[]; effect: Effect; reason: string | null; before: PlaybookState
  template?: PlaybookPlan['template']; playbook?: PlaybookPlan['playbook']; capture?: PlaybookPreview['capture']; recipes?: PlaybookPreview['recipes']
  problems?: string[]; extraNote?: string; beforeDocProblems?: string[] | null
}): PlanOutcome {
  const direction = overall(p.changes.map((c) => c.direction))
  const raises = [...new Set(p.changes.filter((c) => c.direction === 'raise').map((c) => c.label))]
  const where = 'name' in p.target ? `the template "${p.target.name}"` : p.target.level === 'MARKET' ? `the playbook of Amazon ${p.target.market}` : `the ${p.target.level.toLowerCase()} playbook of ${p.target.label}`
  const verb = p.op === 'remove' ? 'Removes' : p.op === 'enroll' ? 'Enrolls' : p.op === 'leave' ? 'Takes out' : p.op === 'capture' ? 'Captures' : direction === 'raise' ? 'Raises' : direction === 'lower' ? 'Lowers' : 'Changes'
  const summary = p.changes.length || p.op === 'remove'
    ? `${verb} ${where}: ${p.changes.length} change${p.changes.length === 1 ? '' : 's'}${raises.length ? `; it raises ${raises.join(', ')}` : ''}.`
    : `Nothing changes in ${where}: it already says this.`
  const liveEffect = `Saved in Nexus only. No engine, rule or Claude change follows a playbook, and nothing at Amazon moves, until an approved apply (apply-ads-playbook) compiles it.${p.extraNote ?? ''}`
  const warnings = [...(p.capture?.warnings ?? []), ...(p.recipes?.notes ?? []), ...(p.beforeDocProblems ? ['The template as stored did not pass its checks; this change replaces it.'] : [])]
  const preview: PlaybookPreview = {
    action: 'set-ads-playbook',
    summary,
    kind: p.kind,
    op: p.op,
    target: p.target,
    version: p.version,
    changes: p.changes,
    direction,
    raises,
    stepUp: direction === 'raise'
      ? {
          what: 'raises what an ads playbook may spend',
          raises,
          needs: STEP_UP_NEEDS,
          how: 'A person with settings.security.manage approves it in Nexus with their authenticator code, or the person who asked confirms it in Claude with theirs when the business set set-ads-playbook to confirm in Claude. It never runs by rule.',
        }
      : null,
    reachesAmazon: false,
    reachNote: 'Nexus only: nothing is sent to Amazon by this change.',
    liveEffect,
    affects: { enrolledProducts: p.effect.products.length, products: p.effect.products.slice(0, MAX_LISTED) },
    ...(p.recipes ? { recipes: p.recipes } : {}),
    ...(p.capture ? { capture: p.capture } : {}),
    ...(p.problems?.length ? { problems: p.problems } : {}),
    ...(warnings.length ? { warnings } : {}),
    // What it starts from and every change: anything that moves between the approval and the run makes it another decision.
    basis: canonicalHash({ before: p.before, changes: p.changes, recipes: p.recipes?.phaseRecipes ?? null }),
  }
  return {
    ok: true,
    plan: {
      kind: p.kind, op: p.op, channel: p.channel, template: p.template, playbook: p.playbook, changes: p.changes, direction, raises,
      reason: p.reason, before: p.before, preview,
    },
  }
}

/** Plan ONE change, nothing saved: the preview the person approves (and the screen shows before Save). */
export async function planPlaybookChange(raw: unknown): Promise<PlanOutcome> {
  const parsed = PLAYBOOK_CHANGE_INPUT.safeParse(raw)
  if (!parsed.success) return refuse(400, issues(parsed.error))
  // A product that is not here (or was deleted) is the first answer, whatever else the change says (MCP.12).
  const { productId, sku } = parsed.data
  if ((productId || sku) && !(productId && sku) && !(await findLiveProduct({ productId, sku }))) return refuse(404, PRODUCT_NOT_FOUND)
  return parsed.data.kind === 'template' ? planTemplate(parsed.data) : planRow(parsed.data)
}

// ── Apply ─────────────────────────────────────────────────────────────────────────────────────────

/** Who writes a change, for the row, its version and the audit (the strategy writer's shape). */
export interface PlaybookWriter {
  /** screen | claude | assistant | fleet | system — the door the change came through. */
  via: string
  actor: string
  actorUserId: string | null
  approvalId?: string | null
  /** When a raise was confirmed with a fresh authenticator code; null for a change that does not raise. */
  stepUpAt?: Date | null
  /** 'user:<id>' or 'claude:<approvalId>'. */
  updatedBy: string
}

export type ApplyOutcome =
  | { ok: true; id: string; version: number; direction: Direction; changes: PlaybookChange[]; before: PlaybookState; after: PlaybookState }
  | { ok: false; status: 409; error: string; code: 'version_moved' }

class Moved extends Error {}
const MOVED = 'The playbook moved since this change was planned: nothing was saved. Read it again and change it from there.'
const json = (value: unknown) => (value == null ? Prisma.DbNull : (value as Prisma.InputJsonValue))

/** Write a planned change in ONE transaction, with its version row; a row that moved since → a conflict. */
export async function applyPlaybookPlan(plan: PlaybookPlan, writer: PlaybookWriter): Promise<ApplyOutcome> {
  if (plan.direction === 'raise' && !writer.stepUpAt) throw new Error('a raise of an ads playbook is written only with the time its authenticator code was confirmed')
  let id = ''
  let version = 0
  try {
    await prisma.$transaction(async (tx) => {
      if (plan.kind === 'template') {
        const { row, after } = plan.template!
        version = (row?.version ?? 0) + 1
        if (!after) {
          if (await tx.adsPlaybook.count({ where: { templateId: row!.id } })) throw new Moved()
          if ((await tx.adsPlaybookTemplate.deleteMany({ where: { id: row!.id, version: row!.version } })).count !== 1) throw new Moved()
          id = row!.id
        } else if (row) {
          const moved = await tx.adsPlaybookTemplate.updateMany({
            where: { id: row.id, version: row.version },
            data: { name: after.name, status: after.status, doc: after.doc as unknown as Prisma.InputJsonValue, capturedFrom: json(after.capturedFrom), version, updatedBy: writer.updatedBy },
          })
          if (moved.count !== 1) throw new Moved()
          id = row.id
        } else {
          const created = await tx.adsPlaybookTemplate.create({
            data: { channel: plan.channel, name: after.name, status: after.status, doc: after.doc as unknown as Prisma.InputJsonValue, capturedFrom: json(after.capturedFrom), version: 1, updatedBy: writer.updatedBy },
            select: { id: true },
          })
          id = created.id
        }
        await tx.adsPlaybookVersion.create({
          data: {
            kind: 'template', refId: id, version, op: plan.op, values: after ? ({ name: after.name, status: after.status, doc: after.doc, capturedFrom: after.capturedFrom } as unknown as Prisma.InputJsonValue) : undefined,
            changes: plan.changes as unknown as Prisma.InputJsonValue, direction: plan.direction, via: writer.via, approvalId: writer.approvalId ?? null,
            actor: writer.actor, actorUserId: writer.actorUserId, stepUpAt: plan.direction === 'raise' ? writer.stepUpAt! : null, reason: plan.reason,
          },
        })
        return
      }
      const { market, scope, row, after } = plan.playbook!
      version = (row?.version ?? 0) + 1
      const data = after
        ? {
            templateId: after.templateId, overrides: json(after.overrides), enrolled: after.enrolled, state: after.state, nameToken: after.nameToken,
            portfolioName: after.portfolioName, dailyBudgetCents: after.dailyBudgetCents, baseBidCents: after.baseBidCents, terms: json(after.terms),
            phaseRecipes: json(after.phaseRecipes), label: scope.label, updatedBy: writer.updatedBy,
          }
        : null
      if (!after) {
        if (await tx.adsPlaybookLink.count({ where: { playbookId: row!.id } })) throw new Moved()
        if ((await tx.adsPlaybook.deleteMany({ where: { id: row!.id, version: row!.version } })).count !== 1) throw new Moved()
        id = row!.id
      } else if (row) {
        if ((await tx.adsPlaybook.updateMany({ where: { id: row.id, version: row.version }, data: { ...data!, version } })).count !== 1) throw new Moved()
        id = row.id
      } else {
        if (await tx.adsPlaybook.findFirst({ where: { channel: plan.channel, market, level: scope.level, scopeId: scope.scopeId }, select: { id: true } })) throw new Moved()
        id = (await tx.adsPlaybook.create({ data: { ...data!, channel: plan.channel, market, level: scope.level, scopeId: scope.scopeId, version: 1 }, select: { id: true } })).id
      }
      await tx.adsPlaybookVersion.create({
        data: {
          kind: 'playbook', refId: id, version, market, level: scope.level, scopeId: scope.scopeId, op: plan.op,
          values: after ? (after as unknown as Prisma.InputJsonValue) : undefined, changes: plan.changes as unknown as Prisma.InputJsonValue,
          direction: plan.direction, via: writer.via, approvalId: writer.approvalId ?? null, actor: writer.actor, actorUserId: writer.actorUserId,
          stepUpAt: plan.direction === 'raise' ? writer.stepUpAt! : null, reason: plan.reason,
        },
      })
    })
  } catch (error) {
    if (error instanceof Moved || (error as { code?: string } | null)?.code === 'P2002') return { ok: false, status: 409, error: MOVED, code: 'version_moved' }
    throw error
  }
  const before = plan.before
  const after = await playbookStateNow(before.kind === 'template' ? { ...before, templateId: id } : before)
  return { ok: true, id, version, direction: plan.direction, changes: plan.changes, before, after }
}

// ── PB-5a — an apply recorded on the product row ──────────────────────────────────────────────────

/** Who applied it, for the row's version and the audit. */
export interface PlaybookApplyWriter {
  via: string
  actor: string
  actorUserId?: string | null
  approvalId?: string | null
  updatedBy: string
  /** PB-5b — a START approved with the approver's authenticator code: when the code was typed (the version row keeps it). */
  stepUpAt?: Date | null
}

/** What an apply op made of the row: its state, and the row and template versions it compiled. */
export interface PlaybookApplyRecord {
  /** PB-10 — a sync records itself too (what it added, in the reason). */
  op: 'build' | 'adopt' | 'start' | 'stop' | 'sync'
  state: string
  /** The row version the op was planned (and approved) from. */
  compiledVersion: number
  compiledTemplateVersion: number | null
  reason?: string | null
  /**
   * PB-10 — an adopt: each adopted slot's placements as its campaign holds them (null: an unbound slot's taken out),
   * merged into the row's overrides.adoptedPlacements in the same write — drift's baseline for that campaign.
   */
  adoptedPlacements?: Record<string, { top: number; productPage: number; restOfSearch: number } | null>
  /** PB-10 — a sync: the bids START gives the keywords and targets it added at the floor (kept in the version row). */
  plannedBids?: Array<{ adTargetId: string; startBidCents: number }>
}

type Tx = Prisma.TransactionClient

/**
 * PB-5a — record an apply (build, adopt; PB-5b: start, stop) on the PRODUCT row: its state and what it compiled, with
 * one AdsPlaybookVersion row (op = the apply's op; no money moves in the row, so it is `same`). Optimistic on the row's
 * version: unmoved since the plan → `compiledVersion` = the new version; moved since → the new state only, and
 * `compiledVersion` stays what was compiled (so the row honestly reads as newer than what was built). `tx`: inside the
 * caller's transaction (an adopt writes its links and this together).
 */
export async function recordPlaybookApply(rowId: string, record: PlaybookApplyRecord, writer: PlaybookApplyWriter, tx?: Tx): Promise<{ version: number; compiledVersion: number; moved: boolean } | null> {
  const write = async (db: Tx) => {
    const row = await db.adsPlaybook.findUnique({ where: { id: rowId }, select: PLAYBOOK_ROW_SELECT })
    if (!row) return null
    const moved = row.version !== record.compiledVersion
    const version = row.version + 1
    const compiledVersion = moved ? record.compiledVersion : version
    // PB-10 — an adopt's placement baselines, merged into the row's own overrides (nothing compiles from them).
    const overridesWas = (row.overrides && typeof row.overrides === 'object' && !Array.isArray(row.overrides) ? row.overrides : {}) as Record<string, unknown>
    const adoptedWas = (overridesWas.adoptedPlacements ?? {}) as Record<string, unknown>
    let overrides: Record<string, unknown> | undefined
    if (record.adoptedPlacements && Object.keys(record.adoptedPlacements).length) {
      const adopted: Record<string, unknown> = { ...adoptedWas }
      for (const [slot, p] of Object.entries(record.adoptedPlacements)) { if (p) adopted[slot] = p; else delete adopted[slot] }
      const { adoptedPlacements: _was, ...rest } = overridesWas
      overrides = Object.keys(adopted).length ? { ...rest, adoptedPlacements: adopted } : rest
    }
    const updated = await db.adsPlaybook.updateMany({
      where: { id: row.id, version: row.version },
      data: {
        state: record.state, compiledVersion, compiledTemplateVersion: record.compiledTemplateVersion, version, updatedBy: writer.updatedBy,
        ...(overrides ? { overrides: json(Object.keys(overrides).length ? overrides : null) } : {}),
      },
    })
    if (updated.count !== 1) throw new Moved()
    const changes: PlaybookChange[] = [
      ...(row.state !== record.state ? [{ field: 'state', label: 'State', from: row.state, to: record.state, direction: 'same' as Direction }] : []),
      { field: 'compiledVersion', label: 'Compiled', from: row.compiledVersion, to: compiledVersion, direction: 'same' as Direction },
      ...(overrides && !same(adoptedWas, overrides.adoptedPlacements ?? {}) ? [{ field: 'overrides.adoptedPlacements', label: labelOf('overrides.adoptedPlacements'), from: overridesWas.adoptedPlacements ?? null, to: overrides.adoptedPlacements ?? null, direction: 'same' as Direction }] : []),
      // Each entry's bid under `startBidCents`, a money key: the history hides it from who may not see ad spend.
      ...(record.plannedBids?.length ? [{ field: 'sync.plannedBids', label: 'Bids START gives the keywords added at the floor', from: null, to: record.plannedBids, direction: 'same' as Direction }] : []),
    ]
    await db.adsPlaybookVersion.create({
      data: {
        kind: 'playbook', refId: row.id, version, market: row.market, level: row.level, scopeId: row.scopeId, op: record.op,
        values: rowValuesOf({ ...row, state: record.state, ...(overrides ? { overrides: Object.keys(overrides).length ? overrides : null } : {}) } as typeof row) as unknown as Prisma.InputJsonValue, changes: changes as unknown as Prisma.InputJsonValue,
        direction: 'same', via: writer.via, approvalId: writer.approvalId ?? null, actor: writer.actor, actorUserId: writer.actorUserId ?? null,
        stepUpAt: writer.stepUpAt ?? null, reason: record.reason ?? null,
      },
    })
    return { version, compiledVersion, moved }
  }
  // One retry: a row another writer moved in between is read again (the op's state still lands, honestly versioned).
  for (let attempt = 0; ; attempt++) {
    try {
      return tx ? await write(tx) : await prisma.$transaction((t) => write(t))
    } catch (error) {
      if (attempt === 0 && !tx && (error instanceof Moved || (error as { code?: string } | null)?.code === 'P2002')) continue
      throw error
    }
  }
}

// ── State and undo ────────────────────────────────────────────────────────────────────────────────

/** What is stored now for the template or the row a change recorded (`state`): what its undo compares. */
export async function playbookStateNow(state: PlaybookState): Promise<PlaybookState> {
  if (state.kind === 'template') {
    const row = state.templateId ? await prisma.adsPlaybookTemplate.findUnique({ where: { id: state.templateId }, select: TEMPLATE_ROW_SELECT }) : null
    return {
      kind: 'template', channel: state.channel, templateId: state.templateId, version: row?.version ?? 0,
      values: row ? { name: row.name, status: row.status, doc: row.doc as TemplateDoc, capturedFrom: row.capturedFrom ?? null } : null,
    }
  }
  const row = await prisma.adsPlaybook.findFirst({ where: { channel: state.channel, market: state.market, level: state.level, scopeId: state.scopeId }, select: PLAYBOOK_ROW_SELECT })
  return { ...state, version: row?.version ?? 0, values: rowValuesOf(row) }
}

/** The arguments of set-ads-playbook that put `before` back over `after` (an undo). */
export function undoArgsOf(before: PlaybookState, after: PlaybookState): Record<string, unknown> {
  const reason = 'undo of an earlier ads playbook change'
  if (before.kind === 'template' && after.kind === 'template') {
    if (!before.values) return { channel: before.channel, kind: 'template', op: 'remove', templateId: after.templateId, expectVersion: after.version, reason }
    // A removed template comes back as a new one (its id is gone); a changed one is set back by its id.
    const id = after.values ? { templateId: after.templateId ?? before.templateId } : {}
    return {
      channel: before.channel, kind: 'template', op: 'set', ...id, name: before.values.name, status: before.values.status,
      doc: before.values.doc, expectVersion: after.values ? after.version : 0, reason,
    }
  }
  const b = before as Extract<PlaybookState, { kind: 'playbook' }>
  const a = after as Extract<PlaybookState, { kind: 'playbook' }>
  const scope = b.level === 'CATEGORY' ? { categoryId: b.scopeId } : b.level === 'PRODUCT' ? { productId: b.scopeId } : {}
  const base = { channel: b.channel, kind: 'playbook', market: b.market, level: b.level.toLowerCase(), ...scope, expectVersion: a.version, reason }
  if (!b.values) return { ...base, op: 'remove' }
  // Every override the change added is cleared again; every one it changed or cleared is set back.
  const was = (b.values.overrides ?? {}) as Record<string, unknown>
  const now = (a.values?.overrides ?? {}) as Record<string, unknown>
  const overrides = { ...Object.fromEntries(Object.keys(now).filter((k) => !(k in was)).map((k) => [k, null])), ...was }
  return {
    ...base,
    op: 'set',
    values: {
      templateId: b.values.templateId,
      ...(Object.keys(overrides).length ? { overrides } : {}),
      ...(b.level === 'PRODUCT' ? {
        enrolled: b.values.enrolled ?? false, nameToken: b.values.nameToken, portfolioName: b.values.portfolioName,
        dailyBudgetCents: b.values.dailyBudgetCents, baseBidCents: b.values.baseBidCents, terms: b.values.terms, phaseRecipes: b.values.phaseRecipes,
      } : {}),
    },
  }
}

/** The words of a raise's refusals on the Playbook section (claude-trust.service.ts mayRaise). */
export const PLAYBOOK_RAISE: RaiseWords = {
  act: 'Raising what an ads playbook may spend',
  before: 'you raise what an ads playbook may spend',
  free: 'A change that adds no spend does not.',
}
