/**
 * ADS PLAYBOOK PB-5a — ADOPT: bind a product's existing campaigns to the slots of its playbook (Nexus only). Nothing is
 * sent to Amazon and nothing at a campaign changes — not its bids, its allowlist or its rules: the playbook learns which
 * of the campaigns it already runs plays which slot, so a later build makes only what is missing. The playbook's own
 * hourly plans follow its slots (PB-8, rank.ts: created switched off; a campaign another hourly plan holds is never
 * taken, its role is refused by name).
 *
 *   candidates  the market's non-archived Sponsored Products campaigns whose product ads advertise one of the product
 *               family's ASINs, linked to no playbook yet (one campaign plays one slot of one playbook)
 *   matching    a slot named in `bind` (asked); else a campaign named as the slot would be named (named); else the one
 *               campaign whose shape — targeting, match type, intent, as a capture reads it (capture.ts slotShape) —
 *               is the slot's (shape). Two for one slot: ambiguous, bound only when `bind` names one. A campaign that
 *               plays no free slot is listed outside, with why.
 *   writes      the slot links (origin adopted) — a slot whose campaign was archived has its stale link replaced — the
 *               portfolio link when every bound campaign shares one and no other playbook holds it (named otherwise),
 *               and the row's state DRAFT → BUILT (never lowered from RUNNING), with one version row (op adopt) — one
 *               transaction. `unbind` takes adopted links off again (the undo of an adopt).
 */
import { createHash } from 'node:crypto'
import { adProductRefusal } from '@nexus/shared/ads-ad-product'
import prisma from '../../../db.js'
import { classifyTarget, extractBlueprint, type SourceCampaign } from '../../ads-core/ads-blueprint.js'
import { productFamily } from '../ads-strategy/load.js'
import { ARTIFACT_COMPILERS, compileArtifacts, type ArtifactCompiler } from './artifacts.js'
import { loadProductPlaybook } from './build-preview.js'
import { slotShape } from './capture.js'
import type { Slot, TemplateDoc } from './doc.js'
import { loadCaptureSource } from './load.js'
import { recordPlaybookApply, type PlaybookApplyWriter } from './write.js'

/** A campaign that may play a slot, with the shape it plays. */
export interface AdoptCandidate {
  campaignId: string
  name: string
  adGroupId: string | null
  portfolioId: string | null
  shape: { targeting: Slot['targeting']; match?: Slot['match']; intent: Slot['intent'] }
}

export interface SlotBinding { slot: string; campaignId: string; name: string; adGroupId: string | null; why: 'asked' | 'named' | 'shape' }

export interface MatchResult {
  bindings: SlotBinding[]
  ambiguous: Array<{ slot: string; campaignIds: string[] }>
  outside: Array<{ campaignId: string; name: string; why: string }>
  /** Free slots no candidate plays. */
  empty: string[]
  problems: string[]
}

const norm = (s: string) => s.trim().toLowerCase()

/** The name the playbook gives a slot's campaign (compile.ts, the same pattern). */
export function slotName(doc: TemplateDoc, slot: Slot, productToken: string, market: string): string {
  return doc.structure.naming.pattern
    .split('{product}').join(productToken)
    .split('{market}').join(market)
    .split('{parts}').join(slot.nameParts.join(doc.structure.naming.partSeparator))
    .trim()
}

/** Does a campaign of this shape play this slot? Auto and product targeting carry no match type or intent. */
const plays = (slot: Slot, shape: AdoptCandidate['shape']) =>
  slot.targeting === shape.targeting && (slot.targeting !== 'KEYWORD' || (slot.match === shape.match && slot.intent === shape.intent))

/**
 * Which candidate plays which slot (pure). `linked`: slots the playbook already holds (never bound again); `unbind`:
 * slots being taken off (left free); `market`: for the slot names.
 */
export function matchSlots(
  doc: TemplateDoc, productToken: string, candidates: readonly AdoptCandidate[],
  bind: ReadonlyArray<{ slot: string; campaignId: string }> = [], unbind: readonly string[] = [],
  opts: { market?: string; linked?: ReadonlySet<string> } = {},
): MatchResult {
  const out: MatchResult = { bindings: [], ambiguous: [], outside: [], empty: [], problems: [] }
  const linked = opts.linked ?? new Set<string>()
  const off = new Set(unbind)
  const slots = doc.structure.slots
  const byId = new Map(candidates.map((c) => [c.campaignId, c]))
  const used = new Set<string>()
  const taken = new Set<string>()
  const take = (slot: Slot, c: AdoptCandidate, why: SlotBinding['why']) => {
    out.bindings.push({ slot: slot.key, campaignId: c.campaignId, name: c.name, adGroupId: c.adGroupId, why })
    used.add(c.campaignId)
    taken.add(slot.key)
  }

  // Asked.
  for (const b of bind) {
    const slot = slots.find((s) => s.key === b.slot)
    const c = byId.get(b.campaignId)
    if (!slot) { out.problems.push(`bind: the playbook has no slot "${b.slot}"`); continue }
    if (linked.has(slot.key)) { out.problems.push(`bind: slot "${slot.key}" is already held by a live campaign`); continue }
    if (off.has(slot.key)) { out.problems.push(`bind: slot "${slot.key}" is also in unbind`); continue }
    if (!c) { out.problems.push(`bind: campaign ${b.campaignId} cannot be adopted here (not found in this market, archived, advertising none of the product's ASINs, or already in a playbook)`); continue }
    if (taken.has(slot.key)) { out.problems.push(`bind: slot "${slot.key}" is named twice`); continue }
    if (used.has(c.campaignId)) { out.problems.push(`bind: campaign ${c.campaignId} is named for two slots`); continue }
    take(slot, c, 'asked')
  }
  const free = slots.filter((s) => !linked.has(s.key) && !off.has(s.key) && !taken.has(s.key))

  // Named as the playbook would name it.
  if (opts.market) {
    for (const slot of free) {
      const name = norm(slotName(doc, slot, productToken, opts.market))
      const hits = candidates.filter((c) => !used.has(c.campaignId) && norm(c.name) === name)
      if (hits.length === 1) take(slot, hits[0], 'named')
    }
  }

  // The one campaign of the slot's shape.
  for (const slot of free.filter((s) => !taken.has(s.key))) {
    const hits = candidates.filter((c) => !used.has(c.campaignId) && plays(slot, c.shape))
    if (hits.length === 1) take(slot, hits[0], 'shape')
    else if (hits.length > 1) out.ambiguous.push({ slot: slot.key, campaignIds: hits.map((c) => c.campaignId) })
    else out.empty.push(slot.key)
  }

  const ambiguousIds = new Set(out.ambiguous.flatMap((a) => a.campaignIds))
  for (const c of candidates) {
    if (used.has(c.campaignId)) continue
    const why = ambiguousIds.has(c.campaignId)
      ? `one of several campaigns that could play slot ${out.ambiguous.filter((a) => a.campaignIds.includes(c.campaignId)).map((a) => `"${a.slot}"`).join(', ')}: name it with bind`
      : slots.some((s) => plays(s, c.shape))
        ? 'the slot of its shape is already held'
        : 'it plays no slot of this playbook'
    out.outside.push({ campaignId: c.campaignId, name: c.name, why })
  }
  return out
}

export interface AdoptPlan {
  market: string
  product: { productId: string; sku: string }
  playbook: { id: string; version: number; state: string | null; label: string }
  compiledTemplateVersion: number | null
  doc: TemplateDoc
  nameToken: string
  bindings: SlotBinding[]
  unbinds: Array<{ slot: string; campaignId: string }>
  ambiguous: MatchResult['ambiguous']
  outside: MatchResult['outside']
  empty: string[]
  problems: string[]
  /** The portfolio every bound campaign shares, when the playbook links none yet. */
  portfolioId: string | null
  /** The slots already held (stay as they are). */
  linked: Array<{ slot: string; campaignId: string }>
  warnings: string[]
  /** Fingerprint of what is bound and unbound, and the row it is written against. */
  basis: string
}

/** The candidates for one product in one market: SP campaigns advertising one of its family's ASINs, in no playbook. */
async function candidatesOf(productId: string, market: string, productToken: string, warnings: string[]): Promise<AdoptCandidate[]> {
  const family = await productFamily(productId)
  const asins = (await prisma.product.findMany({ where: { id: { in: family }, deletedAt: null, amazonAsin: { not: null } }, select: { amazonAsin: true } }))
    .map((p) => p.amazonAsin!).filter(Boolean)
  if (!asins.length) return []
  const rows = await prisma.campaign.findMany({
    where: { marketplace: market, status: { not: 'ARCHIVED' }, adGroups: { some: { productAds: { some: { asin: { in: asins }, status: { not: 'ARCHIVED' } } } } } },
    select: { id: true, name: true, type: true, adProduct: true },
  })
  const sp = rows.filter((c) => !adProductRefusal({ type: c.type == null ? null : String(c.type), adProduct: c.adProduct }))
  const inPlaybooks = new Set((await prisma.adsPlaybookLink.findMany({ where: { kind: 'slot', refId: { in: sp.map((c) => c.id) } }, select: { refId: true } })).map((l) => l.refId))
  const ids = sp.filter((c) => !inPlaybooks.has(c.id)).map((c) => c.id)
  if (!ids.length) return []
  const source = await loadCaptureSource({ campaignIds: ids, marketplace: market })
  const groups = await prisma.adGroup.findMany({ where: { campaignId: { in: ids }, status: { not: 'ARCHIVED' } }, select: { id: true, campaignId: true } })
  const groupsOf = new Map<string, string[]>()
  for (const g of groups) groupsOf.set(g.campaignId, [...(groupsOf.get(g.campaignId) ?? []), g.id])
  const blueprint = extractBlueprint(source.campaigns.map((c) => c.source), { productToken, competitorTokens: [] })
  return source.campaigns.map((c, i) => {
    const role = blueprint.campaigns[i].role
    const shape = shapeOf(c.source, role, productToken, warnings)
    const own = groupsOf.get(c.id) ?? []
    return { campaignId: c.id, name: c.source.name, adGroupId: own.length === 1 ? own[0] : null, portfolioId: c.portfolioId, shape }
  })
}

/** The shape a campaign plays, read as a capture reads it. */
function shapeOf(source: SourceCampaign, role: string, productToken: string, warnings: string[]): AdoptCandidate['shape'] {
  const targets = source.adGroups.flatMap((g) => g.targets)
  const positives = targets.filter((t) => !t.isNegative).map((t) => ({
    text: t.expressionValue.trim(), match: t.expressionType.toUpperCase().replace(/^NEGATIVE_/, '').replace(/^_/, ''), kind: t.kind,
    targetClass: classifyTarget(t, productToken, [], role),
  }))
  return slotShape(role, source, positives, warnings, source.name)
}

const basisOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 32)

/** An adopt planned: nothing written. */
export async function planAdopt(args: {
  market: string; productId?: string; sku?: string; channel?: string
  bind?: ReadonlyArray<{ slot: string; campaignId: string }>; unbind?: readonly string[]
}): Promise<{ data: AdoptPlan } | { status: 400 | 404; error: string }> {
  const loaded = await loadProductPlaybook(args)
  if ('error' in loaded) return loaded
  const { market, product, resolved, row, links } = loaded
  if (!row) return { status: 400, error: `${product.sku} has no product playbook row in ${market}: set one (set-ads-playbook) before adopting campaigns into it.` }
  const doc = resolved.doc
  if (!doc) return { status: 400, error: `The playbook does not compile yet: ${resolved.problems.join('; ') || 'no template'}.` }
  const nameToken = (resolved.product?.nameToken.value as string | null) ?? null
  if (!nameToken) return { status: 400, error: 'The product row names no name token: adopting matches campaigns by it.' }
  const warnings: string[] = []
  const mine = links.filter((l) => l.playbookId === row.id)
  // unbind — only an adopted link of this playbook is taken off (a built campaign is archived instead).
  const unbinds: AdoptPlan['unbinds'] = []
  const problems: string[] = []
  for (const key of args.unbind ?? []) {
    const link = (await prisma.adsPlaybookLink.findFirst({ where: { playbookId: row.id, kind: 'slot', key }, select: { refId: true, origin: true } }))
    if (!link) problems.push(`unbind: slot "${key}" is not linked`)
    else if (link.origin !== 'adopted') problems.push(`unbind: slot "${key}" was built by the playbook, not adopted: archive its campaign instead (archive-ads)`)
    else unbinds.push({ slot: key, campaignId: link.refId })
  }
  const candidates = await candidatesOf(product.id, market, nameToken, warnings)
  const linkedKeys = new Set(mine.filter((l) => !unbinds.some((u) => u.slot === l.key)).map((l) => l.key))
  const matched = matchSlots(doc, nameToken, candidates, args.bind ?? [], args.unbind ?? [], { market, linked: linkedKeys })
  // The portfolio every bound campaign shares, when the playbook holds none yet.
  const hasPortfolio = await prisma.adsPlaybookLink.count({ where: { playbookId: row.id, kind: 'portfolio' } })
  const portfolios = new Set(matched.bindings.map((b) => candidates.find((c) => c.campaignId === b.campaignId)?.portfolioId ?? null))
  const shared = portfolios.size === 1 ? [...portfolios][0] : null
  // A portfolio another playbook holds is that playbook's: named, not linked again (one portfolio, one playbook).
  const heldBy = shared ? await prisma.adsPlaybookLink.findFirst({ where: { kind: 'portfolio', refId: shared, NOT: { playbookId: row.id } }, select: { playbookId: true } }) : null
  if (heldBy) warnings.push(`The campaigns share portfolio ${shared}, which another product's playbook holds: it is not linked to this one.`)
  const portfolioId = !hasPortfolio && !heldBy && shared && !shared.startsWith('local-pf-') ? shared : null
  const bindings = matched.bindings
  return {
    data: {
      market, product: { productId: product.id, sku: product.sku },
      playbook: { id: row.id, version: row.version, state: row.state, label: row.label },
      compiledTemplateVersion: resolved.template.value?.version ?? null,
      doc, nameToken, bindings, unbinds,
      ambiguous: matched.ambiguous, outside: matched.outside, empty: matched.empty,
      problems: [...problems, ...matched.problems],
      portfolioId,
      linked: mine.filter((l) => linkedKeys.has(l.key)).map((l) => ({ slot: l.key, campaignId: l.refId })),
      warnings,
      basis: basisOf({ row: [row.id, row.version], bindings: bindings.map((b) => [b.slot, b.campaignId]), unbinds: unbinds.map((u) => [u.slot, u.campaignId]), portfolioId }),
    },
  }
}

class SlotTaken extends Error {
  constructor(readonly slot: string) { super(`slot ${slot} is taken`) }
}

/**
 * Write an adopt in ONE transaction: the links (a campaign another playbook took meanwhile refuses the whole adopt),
 * the unbinds, the portfolio link, the row's state and its version row. Then the artifacts hook (mode adopt).
 */
export async function applyAdopt(plan: AdoptPlan, writer: PlaybookApplyWriter & { changeSetId?: string | null }, opts: { compilers?: readonly ArtifactCompiler[] } = {}): Promise<{ bound: number; unbound: number; errors: string[] } | { error: string }> {
  try {
    await prisma.$transaction(async (tx) => {
      for (const u of plan.unbinds) {
        const gone = await tx.adsPlaybookLink.deleteMany({ where: { playbookId: plan.playbook.id, kind: 'slot', key: u.slot, refId: u.campaignId, origin: 'adopted' } })
        if (gone.count !== 1) throw new Error(`slot "${u.slot}" moved since this adopt was planned`)
      }
      for (const b of plan.bindings) {
        const data = { refId: b.campaignId, adGroupId: b.adGroupId, origin: 'adopted', compiledVersion: plan.playbook.version, updatedBy: writer.updatedBy }
        // A slot whose campaign was archived (an undone build) still holds its link: replaced, as a build replaces it.
        const stale = await tx.adsPlaybookLink.findFirst({ where: { playbookId: plan.playbook.id, kind: 'slot', key: b.slot }, select: { id: true, refId: true } })
        if (stale) {
          const held = await tx.campaign.findUnique({ where: { id: stale.refId }, select: { status: true } })
          if (held && String(held.status) !== 'ARCHIVED') throw new SlotTaken(b.slot)
          await tx.adsPlaybookLink.update({ where: { id: stale.id }, data })
        } else {
          await tx.adsPlaybookLink.create({ data: { playbookId: plan.playbook.id, kind: 'slot', key: b.slot, ...data } })
        }
      }
      // The portfolio, unless another playbook took it since the plan (then it is left to that one).
      if (plan.portfolioId && !(await tx.adsPlaybookLink.findFirst({ where: { kind: 'portfolio', refId: plan.portfolioId }, select: { id: true } }))) {
        await tx.adsPlaybookLink.create({ data: { playbookId: plan.playbook.id, kind: 'portfolio', key: 'portfolio', refId: plan.portfolioId, origin: 'adopted', compiledVersion: plan.playbook.version, updatedBy: writer.updatedBy } })
      }
      const slotsLeft = await tx.adsPlaybookLink.count({ where: { playbookId: plan.playbook.id, kind: 'slot' } })
      const state = plan.playbook.state === 'RUNNING' ? 'RUNNING'
        : slotsLeft ? (plan.playbook.state === 'STOPPED' ? 'STOPPED' : 'BUILT')
        : (plan.playbook.state ?? 'DRAFT')
      const recorded = await recordPlaybookApply(plan.playbook.id, {
        op: 'adopt', state, compiledVersion: plan.playbook.version, compiledTemplateVersion: plan.compiledTemplateVersion,
        reason: `adopt: ${plan.bindings.length} bound, ${plan.unbinds.length} unbound`,
      }, writer, tx)
      if (!recorded) throw new Error('the playbook row is gone')
    })
  } catch (error) {
    if (error instanceof SlotTaken) return { error: `Slot "${error.slot}" is held by a live campaign since this adopt was planned: nothing was saved. Ask for it again.` }
    if ((error as { code?: string } | null)?.code === 'P2002') return { error: 'A campaign it binds was linked to a playbook since this adopt was planned: nothing was saved. Ask for it again.' }
    return { error: `Nothing was saved: ${(error as Error).message}` }
  }
  // The artifacts hook, after the links — on an unbind too, so a campaign taken off leaves the playbook's own artifacts
  // (PB-8 never moves an adopted campaign out of an hourly plan the playbook did not make: it refuses its role).
  const errors: string[] = []
  const compilers = opts.compilers ?? ARTIFACT_COMPILERS
  if (compilers.length && (plan.bindings.length || plan.unbinds.length)) {
    const links = await prisma.adsPlaybookLink.findMany({ where: { playbookId: plan.playbook.id }, select: { kind: true, key: true, refId: true, adGroupId: true, origin: true } })
    const rankRole = (key: string) => plan.doc.structure.slots.find((s) => s.key === key)?.rankRole ?? 'none'
    const result = await compileArtifacts({
      playbookId: plan.playbook.id, market: plan.market, productId: plan.product.productId, nameToken: plan.nameToken, doc: plan.doc,
      slots: links.filter((l) => l.kind === 'slot').map((l) => ({ key: l.key, campaignId: l.refId, adGroupId: l.adGroupId, origin: l.origin === 'built' ? 'built' : 'adopted', rankRole: rankRole(l.key) })),
      mode: 'adopt', actor: (writer.actor.startsWith('user:') ? writer.actor : `user:${writer.actorUserId ?? 'unknown'}`) as `user:${string}`,
      changeSetId: writer.changeSetId ?? null, compiledVersion: plan.playbook.version,
    }, links.filter((l) => l.kind !== 'slot' && l.kind !== 'portfolio'), compilers)
    errors.push(...result.errors)
    for (const l of result.links) {
      // An artifact the playbook holds already keeps its link (its refId follows a group made again).
      try {
        const mine = await prisma.adsPlaybookLink.findFirst({ where: { playbookId: plan.playbook.id, kind: l.kind, key: l.key }, select: { id: true } })
        const data = { refId: l.refId, origin: 'built', compiledVersion: plan.playbook.version, updatedBy: writer.updatedBy }
        if (mine) await prisma.adsPlaybookLink.update({ where: { id: mine.id }, data })
        else await prisma.adsPlaybookLink.create({ data: { playbookId: plan.playbook.id, kind: l.kind, key: l.key, ...data } })
      } catch (e) { errors.push(`link ${l.kind} ${l.key}: ${(e as Error).message.slice(0, 160)}`) }
    }
  }
  return { bound: plan.bindings.length, unbound: plan.unbinds.length, errors }
}
