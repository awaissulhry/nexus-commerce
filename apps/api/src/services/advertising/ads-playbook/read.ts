/**
 * ADS PLAYBOOK PB-2 — the reads of the ads playbook, shared by Claude's `ads-playbook` tool and the GET routes
 * (advertising-playbook.routes.ts):
 *
 *   effective  for a product (a variation or a parent), a category or a market in one market: each section of the
 *              playbook with the row (or template) it came from, the product's own fields (enrolled, state, name token,
 *              budget, base bid, terms, phase recipes), the slots it would be built from, what it owns (links), why it
 *              cannot compile yet, and beside it the ads strategy in force there — the phase (the strategy's goal) and
 *              the numbers the engines obey — read-only
 *   rows       every playbook row of a market (rows whose category or product is gone flagged)
 *   templates  the business's templates (one with its whole doc)
 *   history    the recorded changes of a template, or of a market's rows (one scope's), newest first
 *   capture    what a template captured from live campaigns would hold (slots, naming, budget split, bid ladder,
 *              placements, hourly plans by rank role, the product's terms) — a preview: nothing is saved
 *   compile    PB-4 — a DRY RUN of building one product's playbook in one market (build-preview.ts): the campaigns, ad
 *              groups, keywords, negatives, product ads, budgets and start bids it would create, judged by the blueprint
 *              engine's gate — nothing is created, saved or sent
 *   build      PB-5a — the builds of a product's playbook (or one, by applicationId): status, progress, the campaigns
 *              each made (at Amazon or not, off the allowlist, at the floor), what failed, what START will apply
 *   drift      PB-10 — where what is live differs from what a product's playbook compiles to in one market (drift.ts,
 *              drift-load.ts): each item with what fixes it (apply-ads-playbook op sync, another tool, or nothing) and,
 *              for a change a person made himself, keep or revert; or, for a market, every enrolled product counted
 *
 * Honest by construction: no engine, rule or Claude change reads a playbook. It is compiled only by an approved apply
 * (PB-5a: apply-ads-playbook build and adopt; PB-10: sync; start and phase come later); until then it is stored and shown only,
 * and nothing at Amazon moves because of it.
 *
 * Money (the product's daily budget and base bid, the least budget per slot, the recipes' targets and bids, the
 * strategy's numbers) sits ONLY under the keys in PLAYBOOK_MONEY, alone, so the money filter removes exactly the money.
 */
import { PRODUCT_NOT_FOUND } from '../../agents/tools/live-product.js'
import { openStrategy } from '../ads-strategy/effective.js'
import { campaignMarkets, findCategory, findLiveProduct, loadAncestry, loadCatalog } from '../ads-strategy/load.js'
import { valuesOf, type ResolvedStrategy, type StrategySource } from '../ads-strategy/resolve.js'
import { captureTemplate } from './capture.js'
import { checkTemplateDoc, SECTIONS } from './doc.js'
import {
  campaignNames,
  loadCaptureSource,
  loadPlaybookIndex,
  loadTemplates,
  playbookLinks,
  playbookMarkets,
  playbookVersions,
} from './load.js'
import {
  PRODUCT_FIELDS,
  resolveCategory,
  resolveMarket,
  resolveProduct,
  type PlaybookSource,
  type ResolvedPlaybook,
  type TemplateRow,
} from './resolve.js'

export const PLAYBOOK_VIEWS = ['effective', 'rows', 'templates', 'history', 'capture', 'compile', 'build', 'drift'] as const
export type PlaybookViewName = (typeof PLAYBOOK_VIEWS)[number]

export interface PlaybookReadArgs {
  channel?: string
  market?: string
  view?: PlaybookViewName
  productId?: string
  sku?: string
  categoryId?: string
  templateId?: string
  /** capture: the live campaigns, by ids, by portfolio or by name prefix (one of them). */
  campaignIds?: string[]
  portfolioId?: string
  namePrefix?: string
  /** capture: the product's token in the campaign names, and rival brand words. */
  productToken?: string
  competitorTokens?: string[]
  /** build: one build run. */
  applicationId?: string
  limit?: number
}

export interface PlaybookReadFailure { status: 400 | 404; error: string }
export type PlaybookReadResult = { data: Record<string, unknown> } | PlaybookReadFailure

export const PLAYBOOK_NOTE =
  'No engine, rule or Claude change follows a playbook, and nothing at Amazon moves because of it, until an approved apply '
  + 'compiles it: apply-ads-playbook builds a product\'s missing campaigns (at the floor, off the live-write allowlist) or '
  + 'adopts the ones it runs, or syncs its drift (adding only); starting to spend comes later. Until then it is stored and shown only (set-ads-playbook '
  + "changes it). The numbers the engines obey are the ads strategy's (strategy, read-only here)."
const ENROLL_NOTE = 'A product is in only when its own row (or its parent\'s) says enrolled; a category or market playbook is a default for the products under it, never a build.'
const CAPTURE_NOTE =
  'A preview: nothing is saved (set-ads-playbook op capture saves it as a template). Slots, naming, budget shares, the bid ladder, placements, Auto groups and the hourly plans '
  + "by rank role come from the campaigns as they are today (bids at the 2¢ floor left out); harvest edges and the phase table "
  + "are the defaults for these slots. The product's terms, daily budget and base bid belong on its product row, never in a template."
const MAX_LISTED = 100
const fail = (status: 400 | 404, error: string): PlaybookReadFailure => ({ status, error })
const iso = (at: Date | null | undefined) => (at ? at.toISOString() : null)

const sourceOut = (s: PlaybookSource | null) => (s ? { level: s.level, id: s.id, label: s.label, version: s.version, ...(s.via ? { via: s.via } : {}) } : null)
const strategySource = (s: StrategySource | null | undefined) => (s ? { level: s.level, label: s.label, version: s.version, ...(s.via ? { via: s.via } : {}) } : null)

// ── The scope ─────────────────────────────────────────────────────────────────────────────────────

type Scope =
  | { kind: 'market' }
  | { kind: 'category'; category: { id: string; name: string } }
  | { kind: 'product'; product: { id: string; sku: string; parentId: string | null } }

async function scopeOf(a: PlaybookReadArgs): Promise<Scope | PlaybookReadFailure> {
  if ((a.productId || a.sku) && a.categoryId) return fail(400, 'Name one scope: a product (productId or sku) or a category — not both.')
  if (a.productId && a.sku) return fail(400, 'Name the product once: productId or sku, not both.')
  if (a.productId || a.sku) {
    const product = await findLiveProduct({ productId: a.productId, sku: a.sku })
    return product ? { kind: 'product', product } : fail(404, PRODUCT_NOT_FOUND)
  }
  if (a.categoryId) {
    const category = await findCategory(a.categoryId)
    return category ? { kind: 'category', category } : fail(404, 'Category not found (categoryId from catalog-structure).')
  }
  return { kind: 'market' }
}

async function marketsFor(a: PlaybookReadArgs, channel: string): Promise<string[]> {
  const asked = a.market?.trim().toUpperCase() || null
  if (asked) return [asked]
  return [...new Set([...(await playbookMarkets(channel)), ...(await campaignMarkets())])].sort()
}

const scopeOut = (scope: Scope) =>
  scope.kind === 'product' ? { kind: 'product', productId: scope.product.id, sku: scope.product.sku }
    : scope.kind === 'category' ? { kind: 'category', categoryId: scope.category.id, name: scope.category.name }
      : { kind: 'market' }

// ── effective ─────────────────────────────────────────────────────────────────────────────────────

/** The slots the subject would be built from: each slot's shape, name, budget share and start-bid factor. */
function slotsOf(resolved: ResolvedPlaybook, market: string): Array<Record<string, unknown>> {
  const doc = resolved.doc
  if (!doc) return []
  const token = typeof resolved.product?.nameToken.value === 'string' ? resolved.product.nameToken.value : null
  const total = doc.structure.slots.reduce((n, s) => n + (doc.budget.weights[s.key] ?? 0), 0)
  return doc.structure.slots.map((s) => ({
    key: s.key, targeting: s.targeting, ...(s.match ? { match: s.match } : {}), intent: s.intent, rankRole: s.rankRole, optional: s.optional,
    feeds: s.feeds,
    name: token
      ? doc.structure.naming.pattern.replace('{product}', token).replace('{market}', market).replace('{parts}', s.nameParts.join(doc.structure.naming.partSeparator))
      : null,
    budgetSharePct: total > 0 ? Math.round(((doc.budget.weights[s.key] ?? 0) / total) * 1000) / 10 : 0,
    startBidFactor: doc.bids.ladder[s.key] ?? null,
    placements: doc.placements[s.key] ?? null,
  }))
}

/** The strategy in force for the same scope: the phase (its goal) and the numbers the engines obey. */
function strategyOut(resolved: ResolvedStrategy) {
  const values = valuesOf(resolved)
  const goal = resolved.fields.get('goal')
  return {
    phase: { goal: goal?.value ?? null, source: strategySource(goal?.source) },
    targetAcosPct: values.targetAcosPct,
    minBidCents: values.minBidCents,
    maxBidCents: values.maxBidCents,
    maxChangePct: values.maxChangePct,
    monthlyCaps: values.monthlyCaps.map((c) => ({ monthlySpendCapCents: c.monthlySpendCapCents, source: strategySource(c.source) })),
    note: "The phase is the strategy's goal (one field, Owner decision D-PB3). These numbers bind the engines; the playbook never does. Read the whole strategy with ads-strategy.",
  }
}

async function effectiveIn(market: string, channel: string, scope: Scope): Promise<Record<string, unknown>> {
  const [{ index, orphans, templates }, strategy] = await Promise.all([loadPlaybookIndex(market, channel), openStrategy(market, channel)])
  let resolved: ResolvedPlaybook
  let strategyResolved: ResolvedStrategy
  if (scope.kind === 'product') {
    const { catalog } = await loadCatalog([scope.product.id])
    resolved = resolveProduct(index, catalog.products.get(scope.product.id) ?? scope.product, catalog)
    strategyResolved = (await strategy.forProducts([scope.product.id])).resolved
  } else if (scope.kind === 'category') {
    resolved = resolveCategory(index, scope.category.id, { ancestry: (await loadAncestry([scope.category.id])).ancestry })
    strategyResolved = (await strategy.forCategory(scope.category.id)).resolved
  } else {
    resolved = resolveMarket(index)
    strategyResolved = strategy.forMarket().resolved
  }
  const template = resolved.template.value ? templates.find((t) => t.id === resolved.template.value!.id) ?? null : null
  const compiledTemplateVersion = typeof resolved.product?.compiledTemplateVersion.value === 'number' ? resolved.product.compiledTemplateVersion.value : null

  // What the product's own row (and its parent's) owns.
  const ownRows = scope.kind === 'product' ? [index.products.get(scope.product.id), scope.product.parentId ? index.products.get(scope.product.parentId) : undefined].filter((r): r is NonNullable<typeof r> => !!r) : []
  const links = await playbookLinks(ownRows.map((r) => r.id))
  const names = await campaignNames(links.filter((l) => l.kind === 'slot').map((l) => l.refId))

  return {
    market,
    playbookRows: index.rows.length,
    ...(index.rows.length ? {} : { note: `No playbook is set for ${market} yet.` }),
    ...(scope.kind === 'product' ? { enrolled: resolved.product?.enrolled.value === true, enrollNote: ENROLL_NOTE } : {}),
    template: resolved.template.value
      ? {
        templateId: resolved.template.value.id, name: resolved.template.value.name, version: resolved.template.value.version,
        status: resolved.template.value.status, source: sourceOut(resolved.template.source),
        ...(compiledTemplateVersion != null && template && template.version > compiledTemplateVersion
          ? { newer: `The template is at v${template.version}; this product was last applied with v${compiledTemplateVersion}. A newer template never applies by itself.` }
          : {}),
      }
      : null,
    // Values and sources apart, each keyed by section: the money filter reads a fixed depth, and a section is deep.
    sections: Object.fromEntries(SECTIONS.map((key) => [key, resolved.sections[key].value])),
    sources: Object.fromEntries(SECTIONS.map((key) => [key, sourceOut(resolved.sections[key].source)])),
    ...(resolved.skipSlots ? { skipSlots: { slots: resolved.skipSlots.value ?? [], source: sourceOut(resolved.skipSlots.source) } } : {}),
    ...(resolved.product ? {
      product: PRODUCT_FIELDS.map((field) => ({ field, [field]: resolved.product![field].value, source: sourceOut(resolved.product![field].source) })),
    } : {}),
    compiles: !!resolved.doc,
    slots: slotsOf(resolved, market),
    ...(resolved.problems.length ? { problems: resolved.problems } : {}),
    ...(scope.kind === 'product' ? {
      links: links.slice(0, MAX_LISTED).map((l) => ({
        kind: l.kind, key: l.key, refId: l.refId, origin: l.origin, compiledVersion: l.compiledVersion,
        ...(l.adGroupId ? { adGroupId: l.adGroupId } : {}),
        ...(l.kind === 'slot' ? { campaign: names.get(l.refId) ?? null } : {}),
      })),
    } : {}),
    strategy: strategyOut(strategyResolved),
    warnings: resolved.warnings,
    orphans,
  }
}

// ── rows ──────────────────────────────────────────────────────────────────────────────────────────

/** One market's rows, each naming its market (the view lists them flat: a row's overrides are deep). */
async function rowsIn(market: string, channel: string): Promise<{ rows: Array<Record<string, unknown>>; ignored: string[] }> {
  const { rows, orphans, index, templates } = await loadPlaybookIndex(market, channel)
  const orphanWhy = new Map(orphans.map((o) => [o.playbookId, o.why]))
  const templateName = new Map(templates.map((t) => [t.id, t.name]))
  const order = (level: string) => ['MARKET', 'CATEGORY', 'PRODUCT'].indexOf(level)
  return {
    rows: [...rows].sort((a, b) => order(a.level) - order(b.level) || a.label.localeCompare(b.label)).map((r) => ({
      market, playbookId: r.id, level: r.level, scopeId: r.scopeId, label: r.label, version: r.version,
      templateId: r.templateId, template: r.templateId ? templateName.get(r.templateId) ?? null : null,
      overrides: r.overrides ?? null,
      ...(r.level === 'PRODUCT' ? {
        enrolled: r.enrolled, state: r.state, nameToken: r.nameToken, portfolioName: r.portfolioName,
        dailyBudgetCents: r.dailyBudgetCents, baseBidCents: r.baseBidCents, terms: r.terms ?? null, phaseRecipes: r.phaseRecipes ?? null,
        compiledVersion: r.compiledVersion, compiledTemplateVersion: r.compiledTemplateVersion,
      } : {}),
      updatedAt: iso(r.updatedAt), updatedBy: r.updatedBy,
      ...(orphanWhy.has(r.id) ? { orphan: orphanWhy.get(r.id) } : {}),
    })),
    ignored: index.warnings.map((w) => `${market}: ${w}`),
  }
}

// ── templates ─────────────────────────────────────────────────────────────────────────────────────

function templateOut(t: TemplateRow, withDoc: boolean): Record<string, unknown> {
  const checked = checkTemplateDoc(t.doc)
  const slots = 'doc' in checked ? checked.doc.structure.slots : []
  return {
    templateId: t.id, name: t.name, version: t.version, status: t.status, channel: t.channel, adProduct: t.adProduct,
    slots: slots.map((s) => s.key),
    capturedFrom: t.capturedFrom ?? null,
    updatedAt: iso(t.updatedAt), updatedBy: t.updatedBy,
    ...('problems' in checked ? { problems: checked.problems.slice(0, 20) } : {}),
    ...(withDoc ? { doc: t.doc } : {}),
  }
}

async function templatesIn(channel: string, templateId: string | undefined): Promise<PlaybookReadResult> {
  const templates = await loadTemplates(channel)
  if (templateId) {
    const one = templates.find((t) => t.id === templateId)
    return one ? { data: { channel, view: 'templates', templates: [templateOut(one, true)], note: PLAYBOOK_NOTE } } : fail(404, 'Template not found (templateId from view templates).')
  }
  return {
    data: {
      channel, view: 'templates',
      templates: templates.map((t) => templateOut(t, false)),
      ...(templates.length ? {} : { note: 'No playbook template yet.' }),
      playbookNote: PLAYBOOK_NOTE,
    },
  }
}

// ── history ───────────────────────────────────────────────────────────────────────────────────────

/**
 * A recorded change, its from → to under the field's own key (dailyBudgetCents, budget, …), so a money field's numbers
 * are money to the filter and a section's inner money keys are too.
 */
function changeOut(change: unknown): Record<string, unknown> {
  const c = (change ?? {}) as Record<string, unknown>
  const last = typeof c.field === 'string' ? c.field.split('.').pop() ?? '' : ''
  const name = /^[A-Za-z][A-Za-z0-9]*$/.test(last) ? last : 'value'
  return { field: c.field ?? null, label: c.label ?? null, direction: c.direction ?? null, [name]: { from: c.from ?? null, to: c.to ?? null } }
}

const versionOut = (v: Awaited<ReturnType<typeof playbookVersions>>[number]) => ({
  kind: v.kind, refId: v.refId, version: v.version, ...(v.kind === 'playbook' ? { market: v.market, level: v.level, scopeId: v.scopeId } : {}),
  op: v.op, direction: v.direction, via: v.via, approvalId: v.approvalId, actor: v.actor, stepUpAt: iso(v.stepUpAt), reason: v.reason, at: iso(v.createdAt),
  values: v.values ?? null, changes: Array.isArray(v.changes) ? v.changes.map(changeOut) : [],
})

async function historyIn(market: string, scope: Scope, limit: number) {
  const at = scope.kind === 'product' ? { level: 'PRODUCT', scopeId: scope.product.id } : scope.kind === 'category' ? { level: 'CATEGORY', scopeId: scope.category.id } : null
  return playbookVersions({ kind: 'playbook', market, scope: at }, limit)
}

// ── capture ───────────────────────────────────────────────────────────────────────────────────────

async function captureIn(a: PlaybookReadArgs, channel: string): Promise<PlaybookReadResult> {
  const market = a.market?.trim().toUpperCase()
  if (!market) return fail(400, 'A capture reads one market: name it (market).')
  const token = a.productToken?.trim()
  if (!token) return fail(400, 'A capture needs the product\'s token in the campaign names (productToken), e.g. the word every campaign name of the set carries.')
  const named = [a.campaignIds?.length ? 'campaignIds' : null, a.portfolioId ? 'portfolioId' : null, a.namePrefix ? 'namePrefix' : null].filter(Boolean)
  if (named.length !== 1) return fail(400, 'Name the live campaigns one way: campaignIds, portfolioId or namePrefix.')
  const source = await loadCaptureSource({ campaignIds: a.campaignIds, portfolioId: a.portfolioId, namePrefix: a.namePrefix, marketplace: market })
  if (!source.campaigns.length) return fail(404, `No campaign in ${market} matches (campaignIds from ad-campaigns).`)
  const result = captureTemplate({
    market,
    productToken: token,
    competitorTokens: a.competitorTokens,
    campaigns: source.campaigns.map((c) => ({ id: c.id, source: c.source })),
    schedules: source.schedules,
    floorTargets: source.floorTargets,
    portfolioName: source.portfolio?.name ?? null,
  })
  return {
    data: {
      channel, view: 'capture', market,
      source: { campaigns: source.campaigns.slice(0, MAX_LISTED).map((c) => ({ campaignId: c.id, name: c.source.name })), portfolio: source.portfolio },
      slots: result.slots,
      template: result.doc,
      ...(result.problems.length ? { problems: result.problems } : {}),
      product: result.product,
      warnings: result.warnings,
      note: CAPTURE_NOTE,
    },
  }
}

// ── PB-5a — the builds ────────────────────────────────────────────────────────────────────────────

const BUILD_NOTE =
  'A build creates the slots a product does not hold yet through the SP Super Wizard\'s own launch: each campaign at Amazon\'s '
  + '2¢ floor with its planned bids remembered (suppressed, never paused), off the live-write allowlist, without placements. '
  + 'It serves next to nothing (not nothing) until START puts it on the allowlist and its planned bids and placements back.'

async function buildIn(a: PlaybookReadArgs, channel: string): Promise<PlaybookReadResult> {
  const { buildRunsOf } = await import('./build.js')
  if (a.applicationId) {
    const [run] = await buildRunsOf({ applicationId: a.applicationId }, 1)
    if (!run) return fail(404, 'Playbook build not found in this business (applicationId: the one apply-ads-playbook answered).')
    const links = run.playbookId ? (await playbookLinks([run.playbookId])).map(linkOut) : []
    return { data: { channel, view: 'build', run, links, note: BUILD_NOTE } }
  }
  if (!a.market) return fail(400, 'The builds are read for one product in one market: name the market (or an applicationId).')
  if (!a.productId && !a.sku) return fail(400, 'The builds are read for one product: name it (productId or sku), or one build by applicationId.')
  if (a.productId && a.sku) return fail(400, 'Name the product once: productId or sku, not both.')
  const market = a.market.trim().toUpperCase()
  const product = await findLiveProduct({ productId: a.productId, sku: a.sku })
  if (!product) return fail(404, PRODUCT_NOT_FOUND)
  const { index } = await loadPlaybookIndex(market, channel)
  const rows = [index.products.get(product.id), product.parentId ? index.products.get(product.parentId) : undefined].filter((r): r is NonNullable<typeof r> => !!r)
  const limit = Math.min(Math.max(Math.trunc(a.limit ?? 10), 1), 50)
  const runs = rows.length ? await buildRunsOf({ playbookIds: rows.map((r) => r.id) }, limit) : []
  const links = (await playbookLinks(rows.map((r) => r.id))).map(linkOut)
  return {
    data: {
      channel, view: 'build', market, product: { productId: product.id, sku: product.sku }, runs, links, note: BUILD_NOTE,
      ...(runs.length ? {} : { empty: rows.length ? 'No build of this playbook yet.' : `${product.sku} has no product playbook row in ${market}.` }),
    },
  }
}

// ── PB-10 — drift ─────────────────────────────────────────────────────────────────────────────────

async function driftIn(a: PlaybookReadArgs, channel: string): Promise<PlaybookReadResult> {
  if (!a.market) return fail(400, 'Drift is read for one market: name it (market), and a product (productId or sku) for its items.')
  if (a.productId && a.sku) return fail(400, 'Name the product once: productId or sku, not both.')
  const market = a.market.trim().toUpperCase()
  const { DRIFT_NOTE, loadDrift, marketDrift } = await import('./drift-load.js')
  if (!a.productId && !a.sku) {
    const list = await marketDrift(market, channel)
    return {
      data: {
        channel, view: 'drift', market, products: list.products, ...(list.more ? { more: `${list.more} more enrolled product(s): read one by productId or sku` } : {}),
        ...(list.products.length ? {} : { empty: `No product is enrolled in a playbook in ${market}.` }),
        note: DRIFT_NOTE,
      },
    }
  }
  const out = await loadDrift({ market, productId: a.productId, sku: a.sku, channel })
  if ('error' in out) return out
  const d = out.data
  const head = { channel, view: 'drift', market, product: d.product, playbook: d.playbook, enrolled: d.enrolled, compiles: d.compiles, note: DRIFT_NOTE }
  if (!d.enrolled) return { data: { ...head, empty: `${d.product.sku} is not enrolled in its playbook in ${market}: nothing is held to it, so nothing drifts.` } }
  if (!d.report) return { data: { ...head, problems: d.problems, warnings: d.warnings } }
  return {
    data: {
      ...head,
      counts: d.report.counts,
      items: d.report.items,
      heldBack: d.report.heldBack.slice(0, MAX_LISTED),
      notChecked: d.report.notChecked,
      ...(d.excluded.length ? { excluded: d.excluded } : {}),
      warnings: d.warnings,
      ...(d.report.items.length ? {} : { empty: 'No drift: what is live matches what this product\'s playbook compiles to (as far as it is checked — see notChecked).' }),
    },
  }
}

const linkOut = (l: { playbookId: string; kind: string; key: string; refId: string; adGroupId: string | null; origin: string; compiledVersion: number }) => ({
  playbookId: l.playbookId, kind: l.kind, key: l.key, refId: l.refId, adGroupId: l.adGroupId, origin: l.origin, compiledVersion: l.compiledVersion,
})

// ── The read ──────────────────────────────────────────────────────────────────────────────────────

export async function readPlaybook(args: PlaybookReadArgs): Promise<PlaybookReadResult> {
  const channel = (args.channel ?? 'AMAZON').toUpperCase()
  if (channel !== 'AMAZON') return fail(400, 'The ads playbook covers Amazon Sponsored Products in this release.')
  const view: PlaybookViewName = args.view ?? 'effective'
  if (view === 'templates') return templatesIn(channel, args.templateId)
  if (view === 'capture') return captureIn(args, channel)
  if (view === 'compile') {
    if (!args.market) return fail(400, 'A build preview is for one market: name it (market).')
    if (!args.productId && !args.sku) return fail(400, 'A build preview is for one product: name it (productId or sku).')
    if (args.productId && args.sku) return fail(400, 'Name the product once: productId or sku, not both.')
    const { previewBuild } = await import('./build-preview.js')
    return previewBuild({ market: args.market, productId: args.productId, sku: args.sku, channel })
  }
  if (view === 'build') return buildIn(args, channel)
  if (view === 'drift') return driftIn(args, channel)
  const limit = Math.min(Math.max(Math.trunc(args.limit ?? 20), 1), 100)
  if (view === 'history' && args.templateId) {
    const versions = await playbookVersions({ kind: 'template', refId: args.templateId }, limit)
    return { data: { channel, view, templateId: args.templateId, versions: versions.map(versionOut), ...(versions.length ? {} : { note: 'No change recorded yet.' }) } }
  }
  const scope = await scopeOf(args)
  if ('error' in scope) return scope
  if (view === 'rows' && scope.kind !== 'market') return fail(400, 'The rows view lists a whole market: name no product or category (or use view effective).')
  const markets = await marketsFor(args, channel)
  const base = {
    channel, view, scope: scopeOut(scope), markets: markets as unknown,
    ...(markets.length ? {} : { note: 'This business has no ads playbook and no Amazon campaign yet.' }),
  }
  // rows and history are flat lists (each entry names its market): a row's overrides and a version's values are deep.
  if (view === 'rows') {
    const each = await Promise.all(markets.map((market) => rowsIn(market, channel)))
    const rows = each.flatMap((e) => e.rows)
    return { data: { ...base, rows, ignored: each.flatMap((e) => e.ignored), ...(rows.length || !markets.length ? {} : { note: `No playbook is set for ${markets.join(', ')} yet.` }), playbookNote: PLAYBOOK_NOTE } }
  }
  if (view === 'history') {
    const versions = (await Promise.all(markets.map((market) => historyIn(market, scope, limit)))).flat()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.version - a.version).slice(0, limit)
    return { data: { ...base, versions: versions.map(versionOut), ...(versions.length ? {} : { note: 'No change recorded yet.' }) } }
  }
  const perMarket: Array<Record<string, unknown>> = []
  for (const market of markets) perMarket.push(await effectiveIn(market, channel, scope))
  return { data: { ...base, markets: perMarket, playbookNote: PLAYBOOK_NOTE } }
}
