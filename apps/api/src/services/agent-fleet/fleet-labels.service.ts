/**
 * FX.1 — names, not IDs (design contract rule 2). One resolver turns the
 * fleet's entity references into human labels, server-side, in two batch
 * queries. The UI never shows `218394…` or `cms1f5…` when a name exists;
 * unknown ids are OMITTED from the maps (the client falls back to the raw
 * id) — a missing label is honest, a guessed one is not.
 *
 * Reference shapes handled:
 *  - args.externalCampaignId / args.sourceExternalCampaignId
 *  - entityIds with a leading ≥10-digit token (`218394170642485:giacca…`)
 *    or that ARE a bare external campaign id
 *  - args.targetId / entityIds that look like cuids → AdTarget rows
 */
import prisma from '../../db.js'

export interface FleetLabels {
  campaigns: Record<string, { name: string; marketplace: string | null }>
  targets: Record<
    string,
    { text: string; matchType: string; campaignName: string; marketplace: string | null }
  >
}

const EXT_CAMPAIGN_RE = /^\d{10,}$/
const CUID_RE = /^c[a-z0-9]{20,}$/

export async function resolveFleetLabels(refs: {
  args: Array<Record<string, unknown>>
  entityIds: string[]
}): Promise<FleetLabels> {
  const campaignIds = new Set<string>()
  const targetIds = new Set<string>()

  for (const a of refs.args) {
    for (const key of ['externalCampaignId', 'sourceExternalCampaignId']) {
      const v = a[key]
      if (typeof v === 'string' && EXT_CAMPAIGN_RE.test(v)) campaignIds.add(v)
    }
    const t = a.targetId
    if (typeof t === 'string' && CUID_RE.test(t)) targetIds.add(t)
  }
  for (const e of refs.entityIds) {
    const head = e.split(':')[0] ?? ''
    if (EXT_CAMPAIGN_RE.test(head)) campaignIds.add(head)
    else if (EXT_CAMPAIGN_RE.test(e)) campaignIds.add(e)
    else if (CUID_RE.test(e)) targetIds.add(e)
  }

  const out: FleetLabels = { campaigns: {}, targets: {} }

  if (campaignIds.size > 0) {
    const rows = await prisma.campaign.findMany({
      where: { externalCampaignId: { in: [...campaignIds] } },
      select: { externalCampaignId: true, name: true, marketplace: true },
    })
    for (const r of rows) {
      out.campaigns[r.externalCampaignId!] = { name: r.name, marketplace: r.marketplace }
    }
  }
  if (targetIds.size > 0) {
    const rows = await prisma.adTarget.findMany({
      where: { id: { in: [...targetIds] } },
      select: {
        id: true,
        expressionValue: true,
        expressionType: true,
        adGroup: { select: { campaign: { select: { name: true, marketplace: true } } } },
      },
    })
    for (const r of rows) {
      out.targets[r.id] = {
        text: r.expressionValue,
        matchType: r.expressionType,
        campaignName: r.adGroup.campaign.name,
        marketplace: r.adGroup.campaign.marketplace,
      }
    }
  }
  return out
}

/** Convenience: pull the reference material out of plan items / approvals /
 *  findings in one pass, then resolve. */
export function collectRefs(rows: {
  items?: Array<{ args?: unknown }>
  findings?: Array<{ entityId: string }>
}): { args: Array<Record<string, unknown>>; entityIds: string[] } {
  return {
    args: (rows.items ?? [])
      .map((i) => i.args)
      .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object'),
    entityIds: (rows.findings ?? []).map((f) => f.entityId),
  }
}
