/**
 * NAF.H — H1: derive the entity graph from what the substrate already
 * knows (spec Part 11: "the graph makes them one"). Four derivations:
 *
 *   VARIANT_OF        variation → parent product (ProductVariation)
 *   TARGETS           campaign → variation it advertises (AdProductAd)
 *   COMPETES_WITH     campaign ↔ campaign sharing a positive keyword in
 *                     the same marketplace (canonical order halves pairs)
 *   CANNIBALIZES      demoted campaign → ACOS winner on a shared keyword
 *                     (rank-self-competition's ranking, as edges)
 *   SHARES_INVENTORY  campaigns in DIFFERENT marketplaces advertising the
 *                     same variation — their spend draws one EU pool
 *                     (the proven zeroing-DE-zeroes-IT reality)
 *
 * All source='derived' and reconciled idempotently: present pairs upsert
 * open (validTo=NULL), vanished pairs soft-close (validTo=now). Nightly,
 * deterministic, $0.
 */
import prisma from '../../db.js'
import { normKeyword } from '../advertising/keyword-conflicts.service.js'
import { detectSelfCompetition } from '../advertising/rank-self-competition.js'

export interface DerivationSummary {
  relation: string
  upserted: number
  closed: number
}

interface DesiredEdge {
  fromType: string
  fromId: string
  toType: string
  toId: string
  weight?: number
  properties?: Record<string, unknown>
}

async function reconcileEdges(
  relation: string,
  desired: DesiredEdge[],
): Promise<DerivationSummary> {
  const now = new Date()
  const open = await prisma.graphEdge.findMany({
    where: { relation, source: 'derived', validTo: null },
    select: { id: true, fromType: true, fromId: true, toType: true, toId: true },
  })
  const key = (e: { fromType: string; fromId: string; toType: string; toId: string }) =>
    `${e.fromType}|${e.fromId}|${e.toType}|${e.toId}`
  const desiredKeys = new Set(desired.map(key))
  const toClose = open.filter((e) => !desiredKeys.has(key(e))).map((e) => e.id)
  if (toClose.length > 0) {
    await prisma.graphEdge.updateMany({
      where: { id: { in: toClose } },
      data: { validTo: now },
    })
  }
  for (const d of desired) {
    await prisma.graphEdge.upsert({
      where: {
        fromType_fromId_toType_toId_relation: {
          fromType: d.fromType,
          fromId: d.fromId,
          toType: d.toType,
          toId: d.toId,
          relation,
        },
      },
      create: {
        fromType: d.fromType,
        fromId: d.fromId,
        toType: d.toType,
        toId: d.toId,
        relation,
        source: 'derived',
        weight: d.weight ?? null,
        properties: (d.properties ?? undefined) as never,
      },
      update: {
        validTo: null,
        weight: d.weight ?? null,
        properties: (d.properties ?? undefined) as never,
      },
    })
  }
  return { relation, upserted: desired.length, closed: toClose.length }
}

export async function deriveVariantOf(): Promise<DerivationSummary> {
  const variations = await prisma.productVariation.findMany({
    select: { id: true, productId: true },
  })
  return reconcileEdges(
    'VARIANT_OF',
    variations.map((v) => ({
      fromType: 'variation',
      fromId: v.id,
      toType: 'product',
      toId: v.productId,
    })),
  )
}

export interface TargetPair {
  campaignId: string
  marketplace: string
  productId: string
}

/** campaign →TARGETS→ product it advertises. On this catalogue Product IS
 *  the SKU-level entity (ProductVariation is empty and AdProductAd.sku is
 *  null; the ad's productId FK is the live link — verified on prod
 *  2026-08-06). Also returns the raw pairs so SHARES_INVENTORY derives
 *  without re-reading. */
export async function deriveTargets(): Promise<{
  summary: DerivationSummary
  pairs: TargetPair[]
}> {
  const ads = await prisma.adProductAd.findMany({
    where: { status: { not: 'ARCHIVED' }, productId: { not: null } },
    select: {
      productId: true,
      asin: true,
      adGroup: {
        select: { campaign: { select: { id: true, marketplace: true, status: true } } },
      },
    },
  })

  const seen = new Set<string>()
  const pairs: TargetPair[] = []
  const desired: DesiredEdge[] = []
  for (const ad of ads) {
    const campaign = ad.adGroup.campaign
    if (campaign.status === 'ARCHIVED') continue
    const productId = ad.productId!
    const k = `${campaign.id}|${productId}`
    if (seen.has(k)) continue
    seen.add(k)
    pairs.push({
      campaignId: campaign.id,
      marketplace: campaign.marketplace ?? 'IT',
      productId,
    })
    desired.push({
      fromType: 'campaign',
      fromId: campaign.id,
      toType: 'product',
      toId: productId,
      properties: { asin: ad.asin },
    })
  }
  return { summary: await reconcileEdges('TARGETS', desired), pairs }
}

export async function deriveKeywordCompetition(): Promise<{
  competesWith: DerivationSummary
  cannibalizes: DerivationSummary
}> {
  const targets = await prisma.adTarget.findMany({
    where: {
      kind: 'KEYWORD',
      isNegative: false,
      status: 'ENABLED',
      expressionType: { in: ['EXACT', 'PHRASE'] },
    },
    select: {
      expressionValue: true,
      expressionType: true,
      adGroup: {
        select: {
          campaign: {
            // Campaign aggregates are Decimal EUROS (spend/sales), unlike
            // the cents columns on targets — converted below.
            select: { id: true, marketplace: true, status: true, spend: true, sales: true },
          },
        },
      },
    },
  })

  interface CampaignAgg {
    id: string
    marketplace: string
    keywords: Set<string>
    spendCents: number
    salesCents: number
  }
  const campaigns = new Map<string, CampaignAgg>()
  for (const t of targets) {
    const c = t.adGroup.campaign
    if (c.status !== 'ENABLED') continue
    const agg = campaigns.get(c.id) ?? {
      id: c.id,
      marketplace: c.marketplace ?? 'IT',
      keywords: new Set<string>(),
      spendCents: Math.round(Number(c.spend ?? 0) * 100),
      salesCents: Math.round(Number(c.sales ?? 0) * 100),
    }
    agg.keywords.add(`${normKeyword(t.expressionValue)}|${t.expressionType}`)
    campaigns.set(c.id, agg)
  }

  // COMPETES_WITH — shared keywords within a marketplace, canonical order.
  const overlap = new Map<string, { a: string; b: string; kws: string[] }>()
  const byMarketKw = new Map<string, string[]>()
  for (const c of campaigns.values()) {
    for (const kw of c.keywords) {
      const key = `${c.marketplace}|${kw}`
      byMarketKw.set(key, [...(byMarketKw.get(key) ?? []), c.id])
    }
  }
  for (const [key, ids] of byMarketKw) {
    if (ids.length < 2) continue
    const kw = key.split('|').slice(1).join('|')
    const sorted = [...new Set(ids)].sort()
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const pk = `${sorted[i]}|${sorted[j]}`
        const o = overlap.get(pk) ?? { a: sorted[i]!, b: sorted[j]!, kws: [] }
        o.kws.push(kw)
        overlap.set(pk, o)
      }
    }
  }
  const competesWith = await reconcileEdges(
    'COMPETES_WITH',
    [...overlap.values()].map((o) => ({
      fromType: 'campaign',
      fromId: o.a,
      toType: 'campaign',
      toId: o.b,
      weight: o.kws.length,
      properties: { sharedKeywords: o.kws.slice(0, 10) },
    })),
  )

  // CANNIBALIZES — rank-self-competition's ACOS ranking per marketplace.
  const byMarket = new Map<string, CampaignAgg[]>()
  for (const c of campaigns.values()) {
    byMarket.set(c.marketplace, [...(byMarket.get(c.marketplace) ?? []), c])
  }
  const cannibal: DesiredEdge[] = []
  for (const group of byMarket.values()) {
    const result = detectSelfCompetition(
      group.map((c) => ({
        campaignId: c.id,
        keywords: [...c.keywords],
        isAuto: false, // AUTO contests need family scoping; keyword contests are the graph's job
        acos: c.salesCents > 0 ? c.spendCents / c.salesCents : null,
        spendCents: c.spendCents,
      })),
    )
    for (const conflict of result.conflicts) {
      const demoted = new Set(conflict.demoted)
      const winner = conflict.campaigns.find((id) => !demoted.has(id))
      if (!winner) continue
      for (const loser of conflict.demoted) {
        cannibal.push({
          fromType: 'campaign',
          fromId: loser,
          toType: 'campaign',
          toId: winner,
          properties: { on: conflict.on },
        })
      }
    }
  }
  // dedupe (a loser can cannibalise the same winner on many keywords)
  const seenPair = new Map<string, DesiredEdge>()
  for (const e of cannibal) {
    const k = `${e.fromId}|${e.toId}`
    const existing = seenPair.get(k)
    if (existing) {
      const ons = (existing.properties!.on as string) + `, ${e.properties!.on as string}`
      existing.properties = { on: ons.split(', ').slice(0, 10).join(', ') }
    } else {
      seenPair.set(k, e)
    }
  }
  const cannibalizes = await reconcileEdges('CANNIBALIZES', [...seenPair.values()])

  return { competesWith, cannibalizes }
}

export async function deriveSharedInventory(
  pairs: TargetPair[],
): Promise<DerivationSummary> {
  const byProduct = new Map<string, TargetPair[]>()
  for (const p of pairs) {
    byProduct.set(p.productId, [...(byProduct.get(p.productId) ?? []), p])
  }
  const shared = new Map<string, { a: string; b: string; productIds: Set<string> }>()
  for (const [productId, group] of byProduct) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const x = group[i]!
        const y = group[j]!
        if (x.marketplace === y.marketplace) continue // same listing, not a cross-pool draw
        const [a, b] = [x.campaignId, y.campaignId].sort()
        const k = `${a}|${b}`
        const s = shared.get(k) ?? { a: a!, b: b!, productIds: new Set<string>() }
        s.productIds.add(productId)
        shared.set(k, s)
      }
    }
  }
  return reconcileEdges(
    'SHARES_INVENTORY',
    [...shared.values()].map((s) => ({
      fromType: 'campaign',
      fromId: s.a,
      toType: 'campaign',
      toId: s.b,
      weight: s.productIds.size,
      properties: { productIds: [...s.productIds].slice(0, 20) },
    })),
  )
}

export async function deriveAllEdges(): Promise<DerivationSummary[]> {
  const variantOf = await deriveVariantOf()
  const { summary: targets, pairs } = await deriveTargets()
  const sharedInventory = await deriveSharedInventory(pairs)
  const { competesWith, cannibalizes } = await deriveKeywordCompetition()
  return [variantOf, targets, sharedInventory, competesWith, cannibalizes]
}
