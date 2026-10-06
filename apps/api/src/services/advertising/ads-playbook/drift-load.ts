/**
 * ADS PLAYBOOK PB-10 — what drift reads (no writes): one product's playbook in one market (build-preview.ts
 * loadProductPlaybook), the campaigns its slots hold, the product's own scope (rule 3: the isolation loader's, the ad
 * groups that advertise nothing but this product), what the playbook compiles to (compile.ts with no slot built, the
 * isolation and source negatives planned on today's data, each artifact's compiled version), and who changed what
 * himself (the ads audit, the playbook's own applies left out). Then the pure findDrift (drift.ts).
 *
 *   loadDrift    one product in one market: the report, and the facts it was judged on (sync plans from them)
 *   marketDrift  every enrolled product of a market, each with its drift counted (the list view)
 *
 * Reads only, through the business-scoped client; nothing is sent to Amazon.
 */
import { adProductRefusal } from '@nexus/shared/ads-ad-product'
import prisma from '../../../db.js'
import { openStrategy } from '../ads-strategy/effective.js'
import { strategyMarketOf } from '../ads-strategy/terms.js'
import type { ProtectedTerm } from '../ads-negation-policy.js'
import { normaliseNegTerm } from '../ads-protect-converting.js'
import { familyOfProducts, negativeKey, positivesIn, type NegativeMatch, type Positive } from '../ads-winner-lock.js'
import type { AdsActor } from '../ads-mutation.service.js'
import { expectArtifacts, type ArtifactContext } from './artifacts.js'
import { loadProductPlaybook, productAdsOf } from './build-preview.js'
import { compilePlaybook } from './compile.js'
import type { ProductTerms } from './doc.js'
import { findDrift, type DriftCampaign, type DriftFacts, type DriftReport, type ExpectedSlot, type PersonChange } from './drift.js'
import { compileIsolationRule, isolationItemKey, ISOLATION_HANDOVER, planIsolation, type PlannedNegative, type ScopeGroup } from './isolation.js'
import { loadIsolation } from './isolation-load.js'
import { loadPlaybookIndex, playbookLinks } from './load.js'
import { isEnrolled } from './resolve.js'

export const DRIFT_NOTE =
  'Drift: where what is live differs from what this product\'s playbook compiles to. Bids and budgets the engines, '
  + 'Claude or a person moved are not drift. apply-ads-playbook op sync fixes what it can, adding only (it never deletes, '
  + 'archives or pauses): what adds spend waits for a person; negatives may run by the business\'s rule. A change a '
  + 'person made himself is offered as keep (written into the product\'s playbook row) or revert — never put back by itself.'

const MAX_OUTSIDE = 50
const MAX_LIST = 50
const EMPTY_TERMS: ProductTerms = { brand: [], category: [], competitor: [], competitorAsins: [], negatives: [] }
const PLACEMENT_FIELD: Record<string, keyof DriftCampaign['placements']> = { PLACEMENT_TOP: 'top', PLACEMENT_PRODUCT_PAGE: 'productPage', PLACEMENT_REST_OF_SEARCH: 'restOfSearch' }

export interface LoadedDrift {
  channel: string
  market: string
  product: { productId: string; sku: string }
  /** The PRODUCT row that holds the playbook. */
  playbook: { id: string; version: number; state: string | null; scopeId: string; label: string; compiledVersion: number | null } | null
  template: { id: string; version: number } | null
  enrolled: boolean
  compiles: boolean
  problems: string[]
  warnings: string[]
  /** Slots whose campaign is outside the product's own scope (rule 3): nothing is written there. */
  excluded: Array<{ slot: string; why: string }>
  report: DriftReport | null
  /** What drift was judged on: sync plans from it (never shown). */
  facts: DriftFacts | null
}

const placementsOf = (dynamicBidding: unknown): DriftCampaign['placements'] => {
  const out = { top: 0, productPage: 0, restOfSearch: 0 }
  const list = (dynamicBidding as { placementBidding?: Array<{ placement?: string; percentage?: number }> } | null)?.placementBidding
  for (const p of Array.isArray(list) ? list : []) {
    const field = p?.placement ? PLACEMENT_FIELD[p.placement] : undefined
    if (field && typeof p.percentage === 'number') out[field] = p.percentage
  }
  return out
}

const negativeMatchOf = (kind: string, expressionType: string): NegativeMatch | null =>
  kind === 'PRODUCT' ? 'PRODUCT' : /PHRASE/.test(expressionType) ? 'PHRASE' : /EXACT/.test(expressionType) ? 'EXACT' : null

/** One product's drift in one market: the report, and the facts it was judged on. */
export async function loadDrift(args: { market: string; productId?: string; sku?: string; channel?: string }): Promise<{ data: LoadedDrift } | { status: 400 | 404; error: string }> {
  const loaded = await loadProductPlaybook(args)
  if ('error' in loaded) return loaded
  const { channel, market, product, resolved, row, ownRows, links, linkedNames } = loaded
  const base: LoadedDrift = {
    channel, market, product: { productId: product.id, sku: product.sku },
    playbook: row ? { id: row.id, version: row.version, state: row.state, scopeId: row.scopeId, label: row.label, compiledVersion: row.compiledVersion } : null,
    template: resolved.template.value ? { id: resolved.template.value.id, version: resolved.template.value.version } : null,
    enrolled: isEnrolled(resolved), compiles: !!resolved.doc, problems: [...resolved.problems], warnings: [...resolved.warnings], excluded: [], report: null, facts: null,
  }
  if (!row) return { status: 400, error: `${product.sku} has no product playbook row in ${market}: drift compares a product's playbook with what is live (set-ads-playbook sets one).` }
  if (!base.enrolled || !resolved.doc) return { data: base }
  const doc = resolved.doc
  const value = <T>(field: keyof NonNullable<typeof resolved.product>) => (resolved.product?.[field].value ?? null) as T | null
  const nameToken = value<string>('nameToken')
  if (!nameToken) return { data: { ...base, compiles: false, problems: [...base.problems, 'The product row names no name token: the slots\' names and the brand words need it'] } }
  const terms = value<ProductTerms>('terms') ?? EMPTY_TERMS
  const notChecked: string[] = []

  // The slots: each with its live link, or the link whose campaign is archived or gone.
  const allLinks = await playbookLinks(ownRows.map((r) => r.id))
  const liveBy = new Map(links.map((l) => [l.key, l]))
  const slots = doc.structure.slots.map((slot) => {
    const link = liveBy.get(slot.key)
    const lost = link ? undefined : allLinks.find((l) => l.kind === 'slot' && l.key === slot.key)
    return {
      slot,
      link: link ? { campaignId: link.refId, adGroupId: link.adGroupId, origin: (link.origin === 'built' ? 'built' : 'adopted') as 'built' | 'adopted' } : null,
      lost: lost ? { campaignId: lost.refId, status: linkedNames.get(lost.refId)?.status ?? 'GONE' } : null,
    }
  })
  const linkedIds = [...new Set(links.map((l) => l.refId))]
  const campaignRows = linkedIds.length
    ? await prisma.campaign.findMany({
      where: { id: { in: linkedIds } },
      select: { id: true, name: true, status: true, targetingType: true, portfolioId: true, liveBidWritesEnabled: true, dynamicBidding: true, adGroups: { where: { status: { not: 'ARCHIVED' } }, select: { id: true } } },
    })
    : []
  const campaigns = new Map<string, DriftCampaign>(campaignRows.map((c) => [c.id, {
    id: c.id, name: c.name, status: String(c.status), targetingType: c.targetingType ?? null, portfolioId: c.portfolioId ?? null,
    liveWrites: c.liveBidWritesEnabled, placements: placementsOf(c.dynamicBidding),
  }]))
  // A slot link without its ad group: the campaign's one ad group (a playbook slot is one campaign with one ad group).
  for (const s of slots) {
    if (!s.link || s.link.adGroupId) continue
    const groups = campaignRows.find((c) => c.id === s.link!.campaignId)?.adGroups ?? []
    if (groups.length === 1) s.link.adGroupId = groups[0].id
  }
  const groupIds = [...new Set(slots.map((s) => s.link?.adGroupId).filter((g): g is string => !!g))]

  // Rule 3 — the product's own scope, and the facts every negative is judged on (the isolation run's own loader).
  const action = compileIsolationRule({ playbookId: row.id, market: strategyMarketOf(market) ?? market, nameToken, doc, terms, handover: ISOLATION_HANDOVER }).action
  const iso = await loadIsolation(action)
  const scope: ScopeGroup[] = 'inputs' in iso ? iso.inputs.scope : []
  const excluded = 'inputs' in iso ? iso.inputs.excluded.map((e) => ({ slot: e.slot, why: e.why })) : []
  if ('refused' in iso) notChecked.push(`Keywords, product ads and negatives: ${iso.refused}`)
  const inputs = 'inputs' in iso ? iso.inputs : null
  const positives = inputs?.positives ?? new Map<string, Positive[]>()
  const winners = inputs?.winners ?? new Map<string, Set<string>>()
  const standing = inputs?.standing ?? new Set<string>()
  const protections = inputs?.protections ?? new Map<string, ProtectedTerm[]>()

  // What isolation would add today (only while a switch is on), and the harvest's source negatives (its exact edges
  // that negate their source), each planned the same way: the lock, protected terms, winners stay until proven.
  const switches = doc.isolation.exactIntoResearch || doc.isolation.brandPhraseIntoCategoryAndCompetitor || doc.isolation.phraseIntoBroadAndAuto
  const isolationPlan = inputs && switches ? planIsolation({ action, ...inputs }) : null
  const planned = new Set((isolationPlan?.adds ?? []).map(isolationItemKey))
  const source: PlannedNegative[] = []
  if (inputs) {
    for (const edge of doc.harvest.edges) {
      if (edge.what !== 'KEYWORD_EXACT' || !edge.negateSource) continue
      const homes = new Set(typeof edge.to === 'string' ? [edge.to] : [edge.to.brand, edge.to.competitor, edge.to.category])
      const from = new Set(edge.from)
      const part = scope.filter((g) => homes.has(g.slot) || from.has(g.slot)).map((g) => ({ ...g, role: homes.has(g.slot) ? 'exact' as const : 'research' as const }))
      if (!part.some((g) => g.role === 'exact') || !part.some((g) => g.role === 'research')) continue
      const plan = planIsolation({ action: { exactIntoResearch: true, phraseIntoBroadAndAuto: false, brandPhrase: null, handover: ISOLATION_HANDOVER }, ...inputs, scope: part })
      for (const a of plan.adds) if (!planned.has(isolationItemKey(a))) { planned.add(isolationItemKey(a)); source.push(a) }
    }
  }

  // What the playbook compiles to, every slot as if none were built: positives with their start bids.
  const strategy = (await openStrategy(market, channel).then((v) => v.forProducts([product.id]))).values
  const { ads } = await productAdsOf(product.id, market, doc.structure.productAds.fulfilment)
  const compiled = compilePlaybook({
    market, doc,
    product: { nameToken, dailyBudgetCents: value<number>('dailyBudgetCents'), baseBidCents: value<number>('baseBidCents'), terms },
    asins: ads.map((a) => a.asin),
    band: { minBidCents: strategy.minBidCents, maxBidCents: strategy.maxBidCents },
  })
  let expected: Map<string, ExpectedSlot> | null = null
  if (compiled.problems.length) notChecked.push(`Keywords and product targets the terms feed: ${compiled.problems.join('; ')}`)
  else {
    expected = new Map(compiled.campaigns.map((c) => {
      const targets = c.adGroups[0]?.targets ?? []
      return [c.role, {
        startBidCents: compiled.slots.find((s) => s.key === c.role)?.startBidCents ?? 0,
        keywords: targets.filter((t) => !t.isNegative && t.kind === 'KEYWORD').map((t) => ({ text: t.expression, match: t.expressionType as 'BROAD' | 'PHRASE' | 'EXACT', bidCents: t.bidCents ?? 0, gated: !!t.gated })),
        productTargets: targets.filter((t) => !t.isNegative && t.kind === 'PRODUCT').map((t) => ({ asin: t.expression, bidCents: t.bidCents ?? 0 })),
      }]
    }))
  }

  // What the slots' ad groups hold: product ads (live and archived), archived positives and negatives.
  const [adRows, archivedTargets] = groupIds.length
    ? await Promise.all([
      prisma.adProductAd.findMany({ where: { adGroupId: { in: groupIds } }, select: { adGroupId: true, asin: true, status: true } }),
      prisma.adTarget.findMany({ where: { adGroupId: { in: groupIds }, status: 'ARCHIVED', kind: { in: ['KEYWORD', 'PRODUCT'] } }, select: { id: true, adGroupId: true, kind: true, isNegative: true, expressionType: true, expressionValue: true } }),
    ])
    : [[], []]
  const productAds = new Map<string, Set<string>>()
  const archivedAds = new Map<string, Set<string>>()
  for (const a of adRows) {
    if (!a.asin) continue
    const into = String(a.status) === 'ARCHIVED' ? archivedAds : productAds
    into.set(a.adGroupId, (into.get(a.adGroupId) ?? new Set()).add(a.asin.trim().toUpperCase()))
  }
  // A product ad that stands wins over an archived one of the same ASIN (it was made again).
  for (const [g, set] of archivedAds) for (const asin of productAds.get(g) ?? []) set.delete(asin)
  const archivedPositives = new Map<string, Array<{ id: string; text: string; match: string }>>()
  const archivedNegatives = new Map<string, string>()
  for (const t of archivedTargets) {
    if (t.isNegative) {
      const match = negativeMatchOf(t.kind, t.expressionType)
      if (match) archivedNegatives.set(negativeKey(t.adGroupId, match, t.expressionValue), t.id)
      continue
    }
    const match = t.kind === 'PRODUCT' ? 'PRODUCT' : t.expressionType.toUpperCase()
    archivedPositives.set(t.adGroupId, [...(archivedPositives.get(t.adGroupId) ?? []), { id: t.id, text: t.expressionValue, match }])
  }

  // Outside the playbook: this product's campaigns in the market that play no slot of it.
  const family = await familyOfProducts([row.scopeId])
  const outsideRows = family.asins.length
    ? await prisma.campaign.findMany({
      where: {
        marketplace: market, status: { not: 'ARCHIVED' }, ...(linkedIds.length ? { id: { notIn: linkedIds } } : {}),
        adGroups: { some: { productAds: { some: { asin: { in: family.asins }, status: { not: 'ARCHIVED' } } } } },
      },
      select: { id: true, name: true, status: true, type: true, adProduct: true, adGroups: { where: { status: { not: 'ARCHIVED' } }, select: { id: true } } },
      orderBy: { name: 'asc' },
      take: MAX_OUTSIDE + 1,
    })
    : []
  const sp = outsideRows.filter((c) => !adProductRefusal({ type: c.type == null ? null : String(c.type), adProduct: c.adProduct }))
  if (sp.length > MAX_OUTSIDE) notChecked.push(`More than ${MAX_OUTSIDE} campaigns outside the playbook advertise this product: the first ${MAX_OUTSIDE} are listed`)
  const inOtherPlaybooks = new Set(sp.length ? (await prisma.adsPlaybookLink.findMany({ where: { kind: 'slot', refId: { in: sp.map((c) => c.id) } }, select: { refId: true } })).map((l) => l.refId) : [])
  const outside = sp.slice(0, MAX_OUTSIDE).map((c) => ({ campaignId: c.id, name: c.name, status: String(c.status), inPlaybook: inOtherPlaybooks.has(c.id) }))
  const heldOutside = new Set<string>()
  const ownOutside = sp.filter((c) => !inOtherPlaybooks.has(c.id)).flatMap((c) => c.adGroups.map((g) => g.id))
  for (const list of (await positivesIn(ownOutside)).values()) for (const p of list) if (p.match !== 'PRODUCT') heldOutside.add(normaliseNegTerm(p.text))

  // The artifacts' compiled versions (artifacts.ts expected): a read, in the hook's conservative mode.
  const rankRole = (key: string) => doc.structure.slots.find((s) => s.key === key)?.rankRole ?? 'none'
  const ctx: ArtifactContext = {
    playbookId: row.id, market, productId: product.id, nameToken, doc,
    slots: links.map((l) => ({ key: l.key, campaignId: l.refId, adGroupId: l.adGroupId, origin: l.origin === 'built' ? 'built' : 'adopted', rankRole: rankRole(l.key) })),
    mode: 'adopt', actor: 'automation:ads-playbook-drift' as AdsActor, changeSetId: null, compiledVersion: row.version,
  }
  const artifactLinks = allLinks.filter((l) => l.kind !== 'slot' && l.kind !== 'portfolio').map((l) => ({ kind: l.kind, key: l.key, refId: l.refId }))
  const artifacts = await expectArtifacts(ctx, artifactLinks)
  for (const e of artifacts.errors) notChecked.push(e)

  // Who changed what himself: the ads audit's `user:` rows on these entities, the playbook's own applies left out.
  const own = new Set((await prisma.adsPlaybookVersion.findMany({ where: { kind: 'playbook', refId: { in: ownRows.map((r) => r.id) }, approvalId: { not: null } }, select: { approvalId: true } })).map((v) => v.approvalId!))
  const entityIds = [
    ...new Set([
      ...linkedIds, ...slots.map((s) => s.lost?.campaignId).filter((x): x is string => !!x),
      ...[...archivedPositives.values()].flat().map((a) => a.id), ...archivedNegatives.values(),
      ...artifacts.expectations.map((e) => e.refId).filter((x): x is string => !!x),
    ]),
  ]
  const personal = new Map<string, PersonChange[]>()
  if (entityIds.length) {
    const logs = await prisma.advertisingActionLog.findMany({
      where: { entityId: { in: entityIds }, userId: { startsWith: 'user:' } },
      orderBy: { createdAt: 'desc' }, take: 1000,
      select: { entityId: true, userId: true, actionType: true, executionId: true, createdAt: true, payloadAfter: true },
    })
    for (const l of logs) {
      if (l.executionId && own.has(l.executionId)) continue
      const after = l.payloadAfter && typeof l.payloadAfter === 'object' && !Array.isArray(l.payloadAfter) ? Object.keys(l.payloadAfter as object) : []
      personal.set(l.entityId, [...(personal.get(l.entityId) ?? []), { userId: l.userId!, at: l.createdAt.toISOString(), action: l.actionType, ...(after.length ? { fields: after } : {}) }])
    }
  }

  const portfolioId = allLinks.find((l) => l.kind === 'portfolio' && l.playbookId === row.id)?.refId ?? null
  const facts: DriftFacts = {
    market, product: { productId: product.id, sku: product.sku },
    playbook: { id: row.id, version: row.version, state: row.state, scopeId: row.scopeId },
    doc, nameToken, terms, skipSlots: resolved.skipSlots?.value ?? [], adoptedPlacements: resolved.adoptedPlacements?.value ?? {}, slots, campaigns,
    scope: new Set(scope.map((g) => g.adGroupId)),
    empty: new Set(slots.filter((x) => x.link?.adGroupId && campaigns.has(x.link.campaignId) && String(campaigns.get(x.link.campaignId)!.status) !== 'ARCHIVED' && !productAds.has(x.link.adGroupId)).map((x) => x.link!.adGroupId!)),
    positives, winners, standing, protections,
    archived: { positives: archivedPositives, negatives: archivedNegatives, productAds: archivedAds },
    productAds, expectedAds: ads, expected,
    isolation: isolationPlan ? { adds: isolationPlan.adds } : null, source,
    heldOutside, outside, portfolioId, personal,
    artifacts: { expectations: artifacts.expectations, notChecked: artifacts.notChecked, held: artifacts.held },
    notChecked,
  }
  const report = findDrift(facts)
  for (const l of (isolationPlan?.leftAlone ?? []).slice(0, 20)) report.heldBack.push({ slot: l.slot, what: l.text, why: l.why })
  if (base.template && row.compiledTemplateVersion != null && base.template.version > row.compiledTemplateVersion) {
    base.warnings.push(`The template is at v${base.template.version}; this product was last applied with v${row.compiledTemplateVersion}. Drift compares with the template as it is now.`)
  }
  return { data: { ...base, excluded, report, facts } }
}

/** A product's drift, as the market list shows it: counted, the first items named. */
function summaryOf(d: LoadedDrift) {
  const byKind: Record<string, number> = {}
  for (const i of d.report?.items ?? []) byKind[i.kind] = (byKind[i.kind] ?? 0) + 1
  return {
    productId: d.product.productId, sku: d.product.sku, playbookId: d.playbook?.id ?? null, state: d.playbook?.state ?? null,
    enrolled: d.enrolled, compiles: d.compiles,
    ...(d.report ? { counts: d.report.counts, byKind, top: d.report.items.slice(0, 5).map((i) => ({ key: i.key, kind: i.kind, slot: i.slot, says: i.says })), notChecked: d.report.notChecked.length } : {}),
    ...(d.problems.length ? { problems: d.problems.slice(0, 5) } : {}),
  }
}

/** Every enrolled product of one market (its own row says enrolled), each with its drift counted. */
export async function marketDrift(market: string, channel = 'AMAZON'): Promise<{ market: string; products: Array<Record<string, unknown>>; more: number }> {
  const { rows } = await loadPlaybookIndex(market, channel)
  const enrolled = rows.filter((r) => r.level === 'PRODUCT' && r.enrolled === true).sort((a, b) => a.label.localeCompare(b.label))
  const products: Array<Record<string, unknown>> = []
  for (const r of enrolled.slice(0, MAX_LIST)) {
    const d = await loadDrift({ market, productId: r.scopeId, channel })
    products.push('error' in d ? { productId: r.scopeId, label: r.label, error: d.error } : summaryOf(d.data))
  }
  return { market, products, more: Math.max(0, enrolled.length - MAX_LIST) }
}
