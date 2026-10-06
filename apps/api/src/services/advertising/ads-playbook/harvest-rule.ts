/**
 * ADS PLAYBOOK PB-6b — a product's harvest rule, compiled from its playbook (one per product × market): the pure
 * `compileHarvestRule`, and `syncHarvestRule`, which reads what the compile needs and saves it once (rules.ts).
 *
 *   sources       every slot the product holds (a slot link with its ad group): waste negatives (negative exact) in every
 *                 keyword and Auto slot, wasteful ASINs (negative product target) in the Auto and product-targeting
 *                 slots, and graduations from the harvest edges whose `from` holds the slot — exact or phrase keywords,
 *                 ASINs as product targets
 *   destinations  per source and match type: the edge's slot, or the intent router (ads-harvest-route.ts) — the product's
 *                 Brand, Competitor or Category slot by the term's words, with the product's name token and brand terms
 *                 and its competitor terms compiled in (a snapshot; the harvest never reads the playbook row)
 *   home scope    every linked slot ad group of this product: a term at home there is never created again (L2)
 *   bid           the edge's start bid, in the harvest wire's modes (the term's CPC, CPC + a percent, the destination's
 *                 default bid, a fixed bid); held inside the strategy's band at the destination by the harvest
 *   handover      the Owner's choice (B, `proven`): a source keeps running a term until its new home meets the harvest
 *                 bar there; only then is it negated in the source — never, where an edge from it says `negateSource:
 *                 false`
 *   cadence       the strategy's goal at this product is the phase; its harvestCadence: daily → 1 day, weekly → 7, off →
 *                 no source is harvested from (`harvestFrom: false`: the rule proposes nothing) until the phase changes
 *
 * No numbers of its own (no window, spend or orders): the strategy's harvest and negate groups decide per ad group
 * (W1-7), and the lock judges a home on the same bar. Never another product's campaigns: only this product's links (the
 * Owner's rule 3) — a term another product buys is never a reason to skip one. Saved born disabled, as a dry run that
 * proposes only (PROPOSE): a person, or Claude inside his limits, decides each card. The playbook's start switches it
 * on (never over a person's switch-off); a re-sync never touches its switch or its autonomy level (rules.ts). At run
 * time the rule looks a term's home up only in these slots (`homeScope`, the harvest's `listedOnly`).
 */
import prisma from '../../../db.js'
import { openStrategy } from '../ads-strategy/effective.js'
import { findLiveProduct, loadCatalog } from '../ads-strategy/load.js'
import { strategyMarketOf } from '../ads-strategy/terms.js'
import type { HarvestDestination, IntentRouter } from '../ads-harvest-route.js'
import { PHASES, type HARVEST_EDGE, type Phase, type ProductTerms, type Slot, type TemplateDoc } from './doc.js'
import { loadPlaybookIndex, PLAYBOOK_ROW_SELECT, playbookLinks } from './load.js'
import { resolveProduct } from './resolve.js'
import { ensureCompiledRule } from './rules.js'
import type { z } from 'zod'

/** The Owner's handover choice (PB-6-7-SPEC §6, the lead's decision: B) — a source is closed only once the new home proves itself. */
export const HARVEST_HANDOVER: 'landed' | 'proven' = 'proven'

export interface HarvestRuleInput {
  playbookId: string
  market: string
  nameToken: string
  /** Resolved (resolve.ts): sections whole, skipped slots left out. */
  doc: TemplateDoc
  terms: ProductTerms
  /** Slot key → its campaign (Campaign.id) and ad group (AdGroup.id): the product's slot links (kind 'slot'). */
  links: ReadonlyMap<string, { campaignId: string; adGroupId: string }>
  /** The strategy's goal at this product. */
  phase: Phase | null
  handover: 'landed' | 'proven'
}

/** The harvest wire's start-bid modes (ads-harvest-wire.ts), as a source carries them. `fixed` is in major units. */
export type HarvestBid = { mode: 'cpc' | 'cpcPlus' | 'adGroupDefault' | 'fixed'; value?: number }

export interface HarvestRuleSource {
  adGroupId: string
  campaignId: string
  /** False in a phase that turns the harvest off: no search term is read from it, so nothing is proposed. */
  harvestFrom: boolean
  graduate: Array<'EXACT' | 'PHRASE'>
  negate: Array<'EXACT'>
  graduateProduct: boolean
  negateProduct: boolean
  negateOnLanding: boolean
  /** False: a term that graduated from here is never negated here (an edge says not to negate the source). */
  negateSource: boolean
  bid?: HarvestBid
  destinations: { EXACT?: HarvestDestination; PHRASE?: HarvestDestination; PRODUCT?: string }
}

export interface HarvestRuleAction {
  type: 'harvest_and_negate'
  v: 2
  control: 'manual'
  mode: 'both'
  playbookId: string
  market: string
  cadenceDays: 1 | 7 | null
  homeScope: string[]
  sources: HarvestRuleSource[]
}

export interface CompiledHarvestRule {
  name: string
  /** False when the phase turns the harvest off: no source is harvested from (the rule may be on, and stays idle). */
  enabled: boolean
  cadenceDays: 1 | 7 | null
  action: HarvestRuleAction
  /** Why the rule cannot be saved as compiled. */
  problems: string[]
  warnings: string[]
}

type Edge = z.infer<typeof HARVEST_EDGE>
type Match = 'EXACT' | 'PHRASE' | 'PRODUCT'
const MATCH_OF: Record<Edge['what'], Match> = { KEYWORD_EXACT: 'EXACT', KEYWORD_PHRASE: 'PHRASE', ASIN_PRODUCT: 'PRODUCT' }
const MATCH_WORDS: Record<Match, string> = { EXACT: 'an exact keyword slot', PHRASE: 'a phrase keyword slot', PRODUCT: 'a product-targeting slot' }

/** The doc's start bid in the harvest wire's modes (a fixed bid's minor units made major: the wire's unit). */
function bidOf(startBid: Edge['startBid']): HarvestBid {
  if (startBid.mode === 'cpcPlusPct') return { mode: 'cpcPlus', value: startBid.value ?? 0 }
  if (startBid.mode === 'destDefault') return { mode: 'adGroupDefault' }
  if (startBid.mode === 'fixedCents') return { mode: 'fixed', ...(startBid.value != null ? { value: startBid.value / 100 } : {}) }
  return { mode: 'cpc' }
}

const fits = (slot: Slot | undefined, match: Match) =>
  !!slot && (match === 'PRODUCT' ? slot.targeting === 'PRODUCT' : slot.targeting === 'KEYWORD' && slot.match === match)

/** Two destinations of this compile (an ad group id, or a router built here with the same key order) are the same. */
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function compileHarvestRule(input: HarvestRuleInput): CompiledHarvestRule {
  const problems: string[] = []
  const warnings: string[] = []
  const slots = new Map(input.doc.structure.slots.map((s) => [s.key, s]))
  const brand = [...new Map([input.nameToken, ...input.terms.brand].map((t) => t.trim()).filter(Boolean).map((t) => [t.toLowerCase(), t])).values()]
  const competitor = [...new Map(input.terms.competitor.map((t) => t.trim()).filter(Boolean).map((t) => [t.toLowerCase(), t])).values()]
  for (const key of input.links.keys()) {
    // PB-6c — a term's own campaign (a hero, `hero:<term>`) is no slot of the doc: a home for its term, by design.
    if (!slots.has(key) && !key.startsWith('hero:')) warnings.push(`The slot "${key}" is linked but no longer in the playbook: its campaign is a home for terms, never a source or a destination`)
  }

  // Edges → per source: what it graduates, where each match type lands, its start bids and its edges' negateSource.
  type Acc = { graduate: Set<'EXACT' | 'PHRASE'>; destinations: HarvestRuleSource['destinations']; graduateProduct: boolean; bids: HarvestBid[]; negateSource: boolean[] }
  const acc = new Map<string, Acc>()
  const unlinkedSources = new Set<string>()
  input.doc.harvest.edges.forEach((edge, i) => {
    const where = `harvest.edges.${i}`
    const match = MATCH_OF[edge.what]
    let dest: HarvestDestination
    if (typeof edge.to === 'string') {
      if (!fits(slots.get(edge.to), match)) { problems.push(`${where}: ${edge.what} goes to the slot "${edge.to}", which is not ${MATCH_WORDS[match]}`); return }
      const link = input.links.get(edge.to)
      if (!link) { warnings.push(`${where}: the slot "${edge.to}" has no campaign yet; this edge is left out until it does`); return }
      dest = link.adGroupId
    } else {
      if (match === 'PRODUCT') { problems.push(`${where}: an ASIN goes to one product-targeting slot, never through the intent router`); return }
      const picks = { BRAND: edge.to.brand, COMPETITOR: edge.to.competitor, CATEGORY: edge.to.category }
      const wrong = Object.values(picks).filter((key) => !fits(slots.get(key), match))
      if (wrong.length) { problems.push(`${where}: the router sends ${edge.what} to ${[...new Set(wrong)].map((k) => `"${k}"`).join(', ')}, not ${MATCH_WORDS[match]}`); return }
      const missing = [...new Set(Object.values(picks).filter((key) => !input.links.has(key)))]
      if (missing.length) { warnings.push(`${where}: the slot${missing.length > 1 ? 's' : ''} ${missing.map((k) => `"${k}"`).join(', ')} ${missing.length > 1 ? 'have' : 'has'} no campaign yet; this edge is left out until ${missing.length > 1 ? 'they do' : 'it does'}`); return }
      const router: IntentRouter = {
        router: 'intent',
        BRAND: input.links.get(picks.BRAND)!.adGroupId, COMPETITOR: input.links.get(picks.COMPETITOR)!.adGroupId, CATEGORY: input.links.get(picks.CATEGORY)!.adGroupId,
        brand, competitor,
      }
      dest = router
    }
    for (const from of edge.from) {
      if (!input.links.has(from)) { unlinkedSources.add(from); continue }
      const a = acc.get(from) ?? { graduate: new Set(), destinations: {}, graduateProduct: false, bids: [], negateSource: [] }
      acc.set(from, a)
      const before = match === 'PRODUCT' ? a.destinations.PRODUCT : a.destinations[match]
      if (before !== undefined && !same(before, dest)) {
        problems.push(`The slot "${from}" graduates ${match === 'PRODUCT' ? 'ASINs' : `${match.toLowerCase()} keywords`} by two harvest edges to different slots; a source has one destination per match type`)
        continue
      }
      if (match === 'PRODUCT') { a.destinations.PRODUCT = dest as string; a.graduateProduct = true }
      else { a.destinations[match] = dest; a.graduate.add(match) }
      a.bids.push(bidOf(edge.startBid))
      a.negateSource.push(edge.negateSource)
    }
  })
  for (const key of unlinkedSources) warnings.push(`The slot "${key}" has no campaign yet: it is no source until it does`)

  // The phase's cadence.
  const entry = input.phase ? input.doc.phases[input.phase] : undefined
  const cadence = entry?.harvestCadence ?? null
  const cadenceDays = cadence === 'daily' ? 1 : cadence === 'weekly' ? 7 : null
  if (!input.phase) warnings.push('The ads strategy sets no goal (phase) for this product, so no harvest cadence applies: the rule sweeps at most once a day')
  else if (!entry) warnings.push(`The playbook has no ${input.phase} phase, so no harvest cadence applies: the rule sweeps at most once a day`)
  else if (cadence === 'off') warnings.push(`The ${input.phase} phase turns the harvest off: no source is harvested from, so the rule proposes nothing until the phase changes`)

  const sources: HarvestRuleSource[] = []
  for (const slot of input.doc.structure.slots) {
    const link = input.links.get(slot.key)
    if (!link) continue
    const a = acc.get(slot.key)
    const bids = [...new Map((a?.bids ?? []).map((b) => [JSON.stringify(b), b])).values()]
    if (bids.length > 1) problems.push(`The slot "${slot.key}" graduates by harvest edges with different start bids; a source has one start bid — give its edges the same one`)
    const fixedWithout = bids.find((b) => b.mode === 'fixed' && b.value == null)
    if (fixedWithout) problems.push(`The slot "${slot.key}" graduates at a fixed start bid that names no amount`)
    sources.push({
      adGroupId: link.adGroupId,
      campaignId: link.campaignId,
      harvestFrom: cadence !== 'off',
      graduate: (['EXACT', 'PHRASE'] as const).filter((m) => a?.graduate.has(m)),
      negate: slot.targeting === 'PRODUCT' ? [] : ['EXACT'],
      graduateProduct: a?.graduateProduct ?? false,
      negateProduct: slot.targeting === 'AUTO' || slot.targeting === 'PRODUCT',
      // An edge that says not to negate its source binds the whole source: it is never closed, at the landing or after.
      negateOnLanding: input.handover === 'landed' && !!a?.negateSource.length && a.negateSource.every(Boolean),
      negateSource: (a?.negateSource ?? []).every(Boolean),
      ...(bids.length ? { bid: bids[0] } : {}),
      destinations: a?.destinations ?? {},
    })
  }
  if (!sources.length) problems.push('The product holds none of its playbook\'s slots yet: there is nothing to harvest from')

  return {
    name: `${input.nameToken} (${input.market}) — playbook harvest`.slice(0, 120),
    enabled: cadence !== 'off',
    cadenceDays,
    action: {
      type: 'harvest_and_negate', v: 2, control: 'manual', mode: 'both', playbookId: input.playbookId, market: input.market, cadenceDays,
      homeScope: [...new Set([...input.links.values()].map((l) => l.adGroupId))],
      sources,
    },
    problems: [...new Set(problems)],
    warnings: [...new Set(warnings)],
  }
}

/**
 * The slots whose ad group advertises a product outside this product's family (the product, its parent and the parent's
 * other children), by slot key, with what it advertises. Fails closed: a product ad Nexus cannot place in the family (no
 * product, and an ASIN no member has) counts as another product's. (PB-7's familyOnly asks the same of its ad groups.)
 */
async function foreignSlots(links: ReadonlyMap<string, { adGroupId: string }>, productId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!links.size) return out
  const self = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, parentId: true } })
  const root = self?.parentId ?? productId
  const members = await prisma.product.findMany({ where: { OR: [{ id: root }, { parentId: root }] }, select: { id: true, amazonAsin: true } })
  const ids = new Set([productId, ...members.map((m) => m.id)])
  const asins = new Set(members.map((m) => m.amazonAsin?.trim().toUpperCase()).filter((a): a is string => !!a))
  const ads = await prisma.adProductAd.findMany({
    where: { adGroupId: { in: [...links.values()].map((l) => l.adGroupId) }, status: { not: 'ARCHIVED' } },
    select: { adGroupId: true, productId: true, asin: true, sku: true, product: { select: { sku: true } } },
  })
  for (const [key, link] of links) {
    const foreign = ads.find((a) => a.adGroupId === link.adGroupId && (a.productId ? !ids.has(a.productId) : !(a.asin && asins.has(a.asin.trim().toUpperCase()))))
    if (foreign) out.set(key, foreign.product?.sku ?? foreign.sku ?? foreign.asin ?? 'a product Nexus cannot name')
  }
  return out
}

export type SyncHarvestRuleResult =
  | { saved: true; ruleId: string; created: boolean; changed: boolean; enabled: boolean; cadenceDays: 1 | 7 | null; keptOff?: string; warnings: string[] }
  | { saved: false; problems: string[]; warnings: string[] }

/** One product's harvest rule compiled from its playbook row as it stands now, or why it cannot be (nothing saved). */
export type HarvestRuleFor =
  | { compiled: CompiledHarvestRule; version: number; scopeMarketplace?: string | null; warnings: string[] }
  | { problems: string[]; warnings: string[] }

/**
 * PB-10 — the compile `syncHarvestRule` saves, without the save: the playbook row resolved, its slots (this product's
 * alone, rule 3) and its phase read, and the rule compiled. Drift compares it with the rule that stands.
 */
export async function compileHarvestFor(playbookId: string): Promise<HarvestRuleFor> {
  const row = await prisma.adsPlaybook.findUnique({ where: { id: playbookId }, select: PLAYBOOK_ROW_SELECT })
  if (!row || row.level !== 'PRODUCT') return { problems: ['No product playbook row has this id'], warnings: [] }
  const product = await findLiveProduct({ productId: row.scopeId })
  if (!product) return { problems: ['The playbook\'s product no longer exists or was deleted'], warnings: [] }
  const [{ index }, { catalog }] = await Promise.all([loadPlaybookIndex(row.market, row.channel), loadCatalog([product.id])])
  const resolved = resolveProduct(index, catalog.products.get(product.id) ?? product, catalog)
  const warnings = [...resolved.warnings]
  if (!resolved.doc) return { problems: resolved.problems, warnings }
  const nameToken = typeof resolved.product?.nameToken.value === 'string' ? resolved.product.nameToken.value : null
  if (!nameToken) return { problems: ['The product row names no name token: the rule\'s name and its brand words need it'], warnings }
  const terms = (resolved.product?.terms.value as ProductTerms | null) ?? { brand: [], category: [], competitor: [], competitorAsins: [], negatives: [] }

  // The product's slots: their campaigns in this market, not archived, each with its ad group.
  const slotLinks = (await playbookLinks([playbookId])).filter((l) => l.kind === 'slot')
  const campaigns = slotLinks.length
    ? new Map((await prisma.campaign.findMany({ where: { id: { in: slotLinks.map((l) => l.refId) } }, select: { id: true, status: true, marketplace: true } })).map((c) => [c.id, c]))
    : new Map<string, { id: string; status: unknown; marketplace: string | null }>()
  const links = new Map<string, { campaignId: string; adGroupId: string }>()
  const market = strategyMarketOf(row.market)
  for (const l of slotLinks) {
    const c = campaigns.get(l.refId)
    if (!c) { warnings.push(`The slot "${l.key}" is linked to a campaign Nexus no longer holds: it is left out`); continue }
    if (String(c.status) === 'ARCHIVED') { warnings.push(`The slot "${l.key}"'s campaign is archived: it is left out`); continue }
    if (strategyMarketOf(c.marketplace) !== market) { warnings.push(`The slot "${l.key}"'s campaign is not in ${row.market}: it is left out`); continue }
    if (!l.adGroupId) { warnings.push(`The slot "${l.key}" has no ad group linked yet: it is left out`); continue }
    links.set(l.key, { campaignId: l.refId, adGroupId: l.adGroupId })
  }
  // Rule 3 — a slot whose ad group also advertises another product is not this product's alone: left out, said.
  for (const [key, why] of await foreignSlots(links, product.id)) {
    links.delete(key)
    warnings.push(`The slot "${key}" is left out: its ad group also advertises ${why}, which is not this product. Its terms are never this product's harvest, and its keywords never this product's home`)
  }

  // The phase: the strategy's goal at this product.
  const goal = (await (await openStrategy(row.market, row.channel)).forProducts([product.id])).resolved.fields.get('goal')?.value
  const phase = (PHASES as readonly unknown[]).includes(goal) ? (goal as Phase) : null

  const compiled = compileHarvestRule({ playbookId, market: row.market, nameToken, doc: resolved.doc, terms, links, phase, handover: HARVEST_HANDOVER })
  warnings.push(...compiled.warnings)
  if (compiled.problems.length) return { problems: compiled.problems, warnings: [...new Set(warnings)] }
  return {
    compiled,
    version: row.version,
    // The market the rule runs in: the kept slots' campaigns' own marketplace code (all of this market).
    ...(links.size ? { scopeMarketplace: campaigns.get([...links.values()][0].campaignId)?.marketplace ?? null } : {}),
    warnings: [...new Set(warnings)],
  }
}

/**
 * Compile one product's harvest rule from its playbook row and save it once (link kind 'harvestRule', key 'harvest').
 * `enabled: true` is the playbook's START: the rule is switched on (born on), never over a switch-off a person made since
 * the last start — also in a phase that turns the harvest off, where its sources harvest nothing until the phase changes
 * (a re-sync then compiles them harvesting). `enabled: false` (build, adopt, a re-sync): a new rule is born off; an
 * existing one keeps its own switch — nothing here switches a rule off (rules.ts). A slot whose ad group also advertises
 * another product is left out, named. The playbook's build and start call this (PB-5's artifact hook); Nexus only.
 */
export async function syncHarvestRule(playbookId: string, opts: { enabled: boolean; actor?: string }): Promise<SyncHarvestRuleResult> {
  const actor = opts.actor ?? 'system:ads-playbook'
  const out = await compileHarvestFor(playbookId)
  if ('problems' in out) return { saved: false, problems: out.problems, warnings: out.warnings }
  const { compiled } = out
  const saved = await ensureCompiledRule({
    playbookId, kind: 'harvestRule', key: 'harvest', name: compiled.name, action: compiled.action as unknown as Record<string, unknown>,
    enabled: false, start: opts.enabled, compiledVersion: out.version, actor,
    ...(out.scopeMarketplace !== undefined ? { scopeMarketplace: out.scopeMarketplace } : {}),
  })
  return { saved: true, ...saved, cadenceDays: compiled.cadenceDays, warnings: out.warnings }
}
