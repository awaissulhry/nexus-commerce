/**
 * HARVEST ENGINE — skip and unskip (POST /api/advertising/harvest/skip, /unskip): a person hides a term for 7 days, 30 days
 * or for good; it stays hidden (state SKIPPED) and the brain does not decide it meanwhile. Nexus only, at once; unskip is
 * its undo. Kept on the term's harvest record (one per product × market × term): a term with no record gets one that holds
 * only the skip.
 */
import { randomUUID } from 'node:crypto'
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../../db.js'
import { parseCandidateId } from './ids.js'

const DAY = 86_400_000
export const MAX_SKIP_IDS = 5000

export interface SkipAnswer { changed: number; until: string | null; forGood: boolean; ids: string[]; refused: Array<{ id: string; why: string }> }

/**
 * M8 (HCORE review) — the products the ids name must be this business's (the workspace-scoped read): an id of another
 * business's (or an unknown) product answers 404 and nothing changes, as everywhere else on the harvest API.
 */
export async function unknownProducts(ids: readonly string[]): Promise<string[]> {
  const products = [...new Set(ids.map((id) => parseCandidateId(id)?.productId).filter((x): x is string => !!x))]
  if (!products.length) return []
  const known = new Set((await prisma.product.findMany({ where: { id: { in: products }, deletedAt: null }, select: { id: true } })).map((p) => p.id))
  return products.filter((p) => !known.has(p))
}

/** Skip these candidates for `days` (7 or 30) or for good (null). */
export async function skipCandidates(ids: readonly string[], days: 7 | 30 | null, by: string, now: Date = new Date()): Promise<SkipAnswer | { error: string; status: 404 }> {
  const unknown = await unknownProducts(ids)
  if (unknown.length) return { error: `Product ${unknown[0]} was not found in this business: nothing was skipped.`, status: 404 }
  const until = days == null ? null : new Date(now.getTime() + days * DAY)
  const out: SkipAnswer = { changed: 0, until: until?.toISOString() ?? null, forGood: days == null, ids: [], refused: [] }
  for (const raw of [...new Set(ids)].slice(0, MAX_SKIP_IDS)) {
    const c = parseCandidateId(raw)
    if (!c) { out.refused.push({ id: raw, why: 'not a candidate id (market|productId|term)' }); continue }
    const key = { product_market_term: workspaceKey({ productId: c.productId, marketplace: c.market, term: c.term }) }
    const skip = { skippedUntil: until, skippedForGood: days == null, skippedBy: by, skippedAt: now }
    const was = await prisma.adsBrainHarvest.findUnique({ where: key as never, select: { id: true } })
    if (was) await prisma.adsBrainHarvest.update({ where: { id: was.id }, data: skip })
    else {
      await prisma.adsBrainHarvest.create({
        data: {
          productId: c.productId, marketplace: c.market, term: c.term, isAsin: /^b0[a-z0-9]{8}$/i.test(c.term), status: 'HELD', level: 'OBSERVE', destinationKind: 'NONE',
          sources: [], heldBy: 'skipped by a person', why: 'skipped by a person: hidden from the harvest candidates', evidence: {}, digest: '', runId: `skip-${randomUUID()}`,
          decidedAt: now, checkedAt: now, changedAt: now, actorKind: 'PERSON', actorId: by.replace(/^user:/, '') || null, ...skip,
        },
      })
    }
    out.changed++
    out.ids.push(raw)
  }
  return out
}

/** Unskip these candidates (the undo of a skip). */
export async function unskipCandidates(ids: readonly string[]): Promise<SkipAnswer | { error: string; status: 404 }> {
  const unknown = await unknownProducts(ids)
  if (unknown.length) return { error: `Product ${unknown[0]} was not found in this business: nothing was unskipped.`, status: 404 }
  const out: SkipAnswer = { changed: 0, until: null, forGood: false, ids: [], refused: [] }
  for (const raw of [...new Set(ids)].slice(0, MAX_SKIP_IDS)) {
    const c = parseCandidateId(raw)
    if (!c) { out.refused.push({ id: raw, why: 'not a candidate id (market|productId|term)' }); continue }
    const key = { product_market_term: workspaceKey({ productId: c.productId, marketplace: c.market, term: c.term }) }
    const was = await prisma.adsBrainHarvest.findUnique({ where: key as never, select: { id: true, skippedUntil: true, skippedForGood: true } })
    if (!was || (!was.skippedForGood && !was.skippedUntil)) { out.refused.push({ id: raw, why: 'it is not skipped' }); continue }
    await prisma.adsBrainHarvest.update({ where: { id: was.id }, data: { skippedUntil: null, skippedForGood: false, skippedBy: null, skippedAt: null } })
    out.changed++
    out.ids.push(raw)
  }
  return out
}
