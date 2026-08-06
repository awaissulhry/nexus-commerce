/**
 * NAF.B — shadow grading (plan D3): for every analyst finding, record what
 * the deterministic engine independently proposed for the same entity, so
 * agent-vs-engine agreement is measurable from day one.
 *
 * The engine's proposals ARE the observation payload the analyst cited —
 * so grading is a pure match of finding → cited payload, snapshotted into
 * AgentShadowGrade at grade time (observation rows expire and refresh in
 * place; AdsRuleSuggestion truncates and destroys history, so neither can
 * be graded against later). Deterministic code only, per L8.
 *
 * agrees=false is NOT an error: an analyst finding the engine didn't
 * propose is either the analyst adding judgment or hallucinating — which
 * one is exactly what the Phase B gate reads the disagreement list for.
 */
import { Prisma } from '@nexus/database'
import prisma from '../../db.js'

export interface ShadowVerdict {
  agrees: boolean
  /** The matching engine rows — empty array = engine proposed nothing. */
  engineProposal: unknown[]
  disagreementReason?: string
}

interface FindingLike {
  kind: string
  entityId: string
}

function asArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : []
}

/** Split '<externalCampaignId>:<query>' on the FIRST colon — queries can
 *  contain colons (the AdsRuleSuggestion composite-id precedent). */
function splitCompositeId(entityId: string): { head: string; tail: string } {
  const i = entityId.indexOf(':')
  if (i < 0) return { head: entityId, tail: '' }
  return { head: entityId.slice(0, i), tail: entityId.slice(i + 1) }
}

/**
 * Pure matcher. Returns null when the observation is not engine evidence
 * (e.g. cron-health) — such findings are simply not shadow-gradeable.
 */
export function matchFinding(
  finding: FindingLike,
  observationKey: string,
  payload: unknown,
): ShadowVerdict | null {
  const p = (payload ?? {}) as Record<string, unknown>

  if (observationKey === 'negative-candidates') {
    if (finding.kind === 'waste_theme') {
      const gram = splitCompositeId(finding.entityId).tail.toLowerCase()
      const rows = asArray(p.ngramWasteful).filter(
        (r) => String(r.gram ?? '').toLowerCase() === gram,
      )
      return rows.length > 0
        ? { agrees: true, engineProposal: rows }
        : {
            agrees: false,
            engineProposal: [],
            disagreementReason: `engine's wasteful n-grams did not propose "${gram}"`,
          }
    }
    const { head, tail } = splitCompositeId(finding.entityId)
    const rows = [...asArray(p.negatives), ...asArray(p.productNegatives)].filter(
      (r) =>
        String(r.externalCampaignId ?? '') === head &&
        String(r.query ?? '').toLowerCase() === tail.toLowerCase(),
    )
    return rows.length > 0
      ? { agrees: true, engineProposal: rows }
      : {
          agrees: false,
          engineProposal: [],
          disagreementReason: `engine did not propose "${tail}" as a negative in campaign ${head}`,
        }
  }

  if (observationKey === 'harvest-candidates') {
    if (finding.kind === 'product_harvest_candidate') {
      const asin = finding.entityId.toLowerCase()
      const rows = asArray(p.productGraduations).filter(
        (r) => String(r.query ?? '').toLowerCase() === asin,
      )
      return rows.length > 0
        ? { agrees: true, engineProposal: rows }
        : {
            agrees: false,
            engineProposal: [],
            disagreementReason: `engine did not propose ASIN ${finding.entityId} for graduation`,
          }
    }
    const { head, tail } = splitCompositeId(finding.entityId)
    const rows = asArray(p.graduations).filter(
      (r) =>
        String(r.externalCampaignId ?? '') === head &&
        String(r.query ?? '').toLowerCase() === tail.toLowerCase(),
    )
    return rows.length > 0
      ? { agrees: true, engineProposal: rows }
      : {
          agrees: false,
          engineProposal: [],
          disagreementReason: `engine did not propose "${tail}" for graduation in campaign ${head}`,
        }
  }

  if (observationKey === 'bid-proposals') {
    const rows = asArray(p.proposals).filter(
      (r) => String(r.targetId ?? '') === finding.entityId,
    )
    if (rows.length === 0) {
      return {
        agrees: false,
        engineProposal: [],
        disagreementReason: `engine proposed no bid change for target ${finding.entityId}`,
      }
    }
    const delta = Number(rows[0]!.deltaCents ?? 0)
    const wantsDown = finding.kind === 'bid_above_target'
    const engineDown = delta < 0
    if (wantsDown === engineDown) return { agrees: true, engineProposal: rows }
    return {
      agrees: false,
      engineProposal: rows,
      disagreementReason:
        `direction mismatch: finding says ${wantsDown ? 'lower' : 'raise'}, ` +
        `engine delta is ${delta > 0 ? '+' : ''}${delta}c`,
    }
  }

  return null // not engine evidence — not gradeable
}

/** Grade every finding of the given runs against its cited observation. */
export async function gradeFindings(
  runIds: string[],
): Promise<{ graded: number; skipped: number }> {
  const findings = await prisma.agentFinding.findMany({
    where: { runId: { in: runIds } },
  })
  let graded = 0
  let skipped = 0
  for (const f of findings) {
    const obsId = f.evidenceRefs[0]
    const obs = obsId
      ? await prisma.agentObservation.findUnique({ where: { id: obsId } })
      : null
    const verdict = obs
      ? matchFinding({ kind: f.kind, entityId: f.entityId }, obs.key, obs.payload)
      : null
    if (!verdict || !obs) {
      skipped++
      continue
    }
    await prisma.agentShadowGrade.upsert({
      where: { findingId: f.id },
      create: {
        findingId: f.id,
        engineKey: obs.key,
        engineProposal: verdict.engineProposal as Prisma.InputJsonValue,
        agrees: verdict.agrees,
        disagreementReason: verdict.disagreementReason ?? null,
      },
      update: {
        engineKey: obs.key,
        engineProposal: verdict.engineProposal as Prisma.InputJsonValue,
        agrees: verdict.agrees,
        disagreementReason: verdict.disagreementReason ?? null,
        gradedAt: new Date(),
      },
    })
    graded++
  }
  return { graded, skipped }
}
