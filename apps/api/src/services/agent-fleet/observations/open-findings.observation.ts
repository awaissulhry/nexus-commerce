/**
 * NAF.C — the director's evidence: open analyst findings (with shadow-
 * grade agreement) plus the exact tool contracts the plan's items must
 * use. Caps counted; findings ranked severity-then-confidence.
 */
import prisma from '../../../db.js'
import type { ObservationBuilder } from '../observation-builder.js'

const FINDINGS_CAP = 40
const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
}

const TOOL_CONTRACTS = [
  {
    tool: 'create-negative-keyword',
    args: '{ externalCampaignId, keywordText, matchType: "NEGATIVE_EXACT"|"NEGATIVE_PHRASE", scope: "AD_GROUP"|"CAMPAIGN", externalAdGroupId?, marketplace? }',
    use: 'for waste_term findings — ids come from the finding entityId "<externalCampaignId>:<query>"',
  },
  {
    tool: 'graduate-keyword',
    args: '{ query, sourceExternalCampaignId, sourceExternalAdGroupId?, destExternalCampaignId?, bidCents? }',
    use: 'for harvest_candidate findings',
  },
  {
    tool: 'set-target-bid',
    args: '{ targetId, proposedBidCents }',
    use: 'for bid_above_target / bid_below_target findings — targetId is the finding entityId',
  },
]

export const openFindingsBuilder: ObservationBuilder = {
  key: 'open-findings',
  ttlMinutes: 60,
  async build() {
    const since = new Date(Date.now() - 14 * 24 * 3600_000)
    const rows = await prisma.agentFinding.findMany({
      where: {
        status: 'open',
        expiresAt: { gt: new Date() },
        createdAt: { gte: since },
        charterKey: { not: 'fleet-selftest' },
      },
      select: {
        id: true,
        charterKey: true,
        entityType: true,
        entityId: true,
        entityName: true,
        kind: true,
        severity: true,
        confidence: true,
        observation: true,
        rationale: true,
        dataVintage: true,
      },
    })
    const grades = await prisma.agentShadowGrade.findMany({
      where: { findingId: { in: rows.map((r) => r.id) } },
      select: { findingId: true, agrees: true, disagreementReason: true },
    })
    const gradeById = new Map(grades.map((g) => [g.findingId, g]))

    const ranked = [...rows].sort(
      (a, b) =>
        (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
        Number(b.confidence) - Number(a.confidence),
    )
    const shown = ranked.slice(0, FINDINGS_CAP).map((f) => ({
      findingId: f.id,
      charter: f.charterKey,
      kind: f.kind,
      entityType: f.entityType,
      entityId: f.entityId,
      entityName: f.entityName,
      severity: f.severity,
      confidence: Number(f.confidence),
      observation: f.observation,
      rationale: f.rationale,
      engineAgrees: gradeById.get(f.id)?.agrees ?? null,
      engineDisagreement: gradeById.get(f.id)?.disagreementReason ?? null,
    }))

    return {
      payload: {
        scope: 'account',
        counts: {
          openTotal: rows.length,
          shown: shown.length,
          trimmed: Math.max(0, rows.length - shown.length),
        },
        caveats: [
          'Every finding you do NOT include in items MUST appear in dropped with a real reason.',
          'engineAgrees=false means the deterministic engine did not propose this — weigh the analyst rationale harder.',
        ],
        toolContracts: TOOL_CONTRACTS,
        findings: shown,
      },
      dataVintage: new Date(),
    }
  },
}
