/**
 * Negative Targeting page — NFIX follow-up (2026-10-11): EVERY step of a request that waits, before a person approves or
 * rejects it here. GET /api/advertising/waste/waiting/:approvalId. Read only.
 *
 * Why: the approvals service decides a request as a whole — a change plan's steps are approved TOGETHER (it has no
 * approve-one-step; "untick steps" makes a smaller plan and DROPS the rest, which is not approving one step alone). So a
 * plan the Brain or Claude asked that holds a negative and, say, a bid or a price change is approved whole from this page
 * too: the review lists every step (what, where, from → to), the ones this page does not show included, and says so.
 *
 *   steps   each step's fate, its words and where it lands (the Approvals page's own reader: approval-target.ts
 *           resolveRequest), through the reader's money filter (a hidden preview says so, never a guess)
 *   onPage  whether the step is one of this page's kinds (a pause, a negative, its removal)
 */
import prisma from '../../../db.js'
import type { QueueChange } from '@nexus/shared/approval-queue'
import { storedOutputOf, type ToolPrincipal } from '../../agents/call-tool.js'
import { getTool } from '../../agents/tool-registry.js'
import { PLAN_TOOL } from '../../agents/tool-types.js'
import { resolveRequest } from '../../agent-fleet/approval-target.js'
import { masterCurrency } from '../../fx-rate.service.js'
import { labelFor } from '../bid-grid.service.js'
import { adGroupHref, campaignHref, plainWords, WASTE_TOOLS } from './pure.js'
import { isWasteRequest } from './write.js'

export interface WaitingStep {
  step: number
  tool: string
  /** The kind in the page's words ("Add negatives", "Pause", a bid change …). */
  words: string
  /** One of this page's kinds (a pause, a negative, its removal). */
  onPage: boolean
  /** pending · executing · done · skipped · failed (a single request: its own status). */
  status: string
  /** Where it lands, when the request names one. */
  where: { name: string; href: string | null } | null
  /** Every before → after line its preview gives, in plain words. */
  changes: QueueChange[]
  changeCount: number
  summary: string | null
  /** Why its lines are not shown (the reader may not see that kind's preview). */
  hidden: string | null
}

export interface WaitingSteps {
  approvalId: string
  status: string
  /** A change plan: its steps run together when approved. */
  plan: boolean
  title: string | null
  steps: WaitingStep[]
  /** Steps that are not this page's kinds (each listed in `steps`). */
  offPage: number
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const recs = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.map(rec) : [])
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : [])
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** One change read from a step's own arguments, and where it lands. */
interface ArgLine { change: QueueChange; place: { name: string; href: string | null } | null }

/** The names a step's arguments point at (one read of each kind for the whole request). */
interface Names {
  groups: Map<string, { name: string; campaignId: string; campaign: string; ext: string | null; extCampaign: string | null }>
  campaigns: Map<string, { name: string; ext: string | null }>
  targets: Map<string, { text: string; kind: string; expressionType: string; isNegative: boolean; level: string | null; adGroupId: string }>
}

async function namesOf(steps: ReadonlyArray<{ args: unknown }>): Promise<Names> {
  const groupIds = new Set<string>(), campaignIds = new Set<string>(), targetIds = new Set<string>(), extGroups = new Set<string>(), extCampaigns = new Set<string>()
  for (const { args } of steps) {
    const a = rec(args)
    for (const id of [...strs(a.adGroupIds), ...recs(a.negatives).map((n) => str(n.adGroupId)).filter((x): x is string => !!x)]) groupIds.add(id)
    for (const id of [...strs(a.campaignIds), ...recs(a.negatives).map((n) => str(n.campaignId)).filter((x): x is string => !!x)]) campaignIds.add(id)
    for (const id of [...strs(a.targetIds), ...strs(a.negativeIds)]) targetIds.add(id)
    if (str(a.externalAdGroupId)) extGroups.add(str(a.externalAdGroupId)!)
    if (str(a.externalCampaignId)) extCampaigns.add(str(a.externalCampaignId)!)
  }
  const targets = targetIds.size ? await prisma.adTarget.findMany({ where: { id: { in: [...targetIds] } }, select: { id: true, adGroupId: true, expressionValue: true, expressionType: true, kind: true, isNegative: true, negativeLevel: true } }) : []
  for (const t of targets) groupIds.add(t.adGroupId)
  const groups = groupIds.size || extGroups.size
    ? await prisma.adGroup.findMany({
      where: { OR: [...(groupIds.size ? [{ id: { in: [...groupIds] } }] : []), ...(extGroups.size ? [{ externalAdGroupId: { in: [...extGroups] } }] : [])] },
      select: { id: true, name: true, externalAdGroupId: true, campaign: { select: { id: true, name: true, externalCampaignId: true } } },
    })
    : []
  const campaigns = campaignIds.size || extCampaigns.size
    ? await prisma.campaign.findMany({ where: { OR: [...(campaignIds.size ? [{ id: { in: [...campaignIds] } }] : []), ...(extCampaigns.size ? [{ externalCampaignId: { in: [...extCampaigns] } }] : [])] }, select: { id: true, name: true, externalCampaignId: true } })
    : []
  return {
    groups: new Map(groups.map((g) => [g.id, { name: g.name, campaignId: g.campaign.id, campaign: g.campaign.name, ext: g.externalAdGroupId, extCampaign: g.campaign.externalCampaignId }])),
    campaigns: new Map(campaigns.map((c) => [c.id, { name: c.name, ext: c.externalCampaignId }])),
    targets: new Map(targets.map((t) => [t.id, { text: t.expressionValue, kind: String(t.kind ?? ''), expressionType: t.expressionType, isNegative: t.isNegative, level: t.negativeLevel, adGroupId: t.adGroupId }])),
  }
}

const negWord = (match: unknown, asin = false) => (asin ? 'Negative product' : /PHRASE/i.test(String(match ?? '')) ? 'Negative phrase' : 'Negative exact')

/**
 * A step with no preview stored (or none this reader may see) still names what it changes and where, from its own
 * arguments: the words of each negative, keyword or target and its campaign › ad group (or the whole campaign).
 */
export function argLines(tool: string, args: unknown, names: Names): ArgLine[] {
  const a = rec(args)
  const groupPlace = (id: string | null) => {
    const g = id ? names.groups.get(id) : undefined
    return g ? { name: `${g.campaign} › ${g.name}`, href: adGroupHref(g.campaignId, id!) } : null
  }
  const campaignPlace = (id: string | null) => {
    const c = id ? names.campaigns.get(id) : undefined
    return c ? { name: `${c.name} · whole campaign`, href: campaignHref(id!) } : null
  }
  const out: ArgLine[] = []
  if (tool === 'add-negative-targets') {
    for (const n of recs(a.negatives)) {
      const asin = str(n.asin)
      const text = str(n.text) ?? asin
      if (!text) continue
      out.push({ change: { label: `${negWord(n.matchType, !str(n.text) && !!asin)} "${!str(n.text) && asin ? asin.toUpperCase() : text}"`, from: null, to: 'Added' }, place: str(n.adGroupId) ? groupPlace(str(n.adGroupId)) : campaignPlace(str(n.campaignId)) })
    }
    const campaignScope = a.scope === 'CAMPAIGN'
    const places = campaignScope ? strs(a.campaignIds).map(campaignPlace) : strs(a.adGroupIds).map(groupPlace)
    for (const k of recs(a.keywords)) {
      const text = str(k.text)
      if (text) for (const place of places) out.push({ change: { label: `${negWord(k.matchType)} "${text}"`, from: null, to: 'Added' }, place })
    }
    if (!campaignScope) for (const asin of strs(a.asins)) for (const place of places) out.push({ change: { label: `Negative product "${asin.toUpperCase()}"`, from: null, to: 'Added' }, place })
  } else if (tool === 'create-negative-keyword') {
    const text = str(a.keywordText)
    const g = [...names.groups.entries()].find(([, x]) => x.ext === str(a.externalAdGroupId) && (!str(a.externalCampaignId) || x.extCampaign === str(a.externalCampaignId)))
    const c = [...names.campaigns.entries()].find(([, x]) => x.ext === str(a.externalCampaignId))
    if (text) out.push({ change: { label: `${negWord(a.matchType)} "${text}"`, from: null, to: 'Added' }, place: g ? groupPlace(g[0]) : c ? campaignPlace(c[0]) : null })
  } else if (tool === 'retire-negatives') {
    for (const id of strs(a.negativeIds)) {
      const t = names.targets.get(id)
      if (!t) { out.push({ change: { label: 'A negative Nexus no longer holds', from: 'Standing', to: 'Removed' }, place: null }); continue }
      const g = names.groups.get(t.adGroupId)
      out.push({ change: { label: `${negWord(t.expressionType, t.kind === 'PRODUCT')} "${t.kind === 'PRODUCT' ? t.text.toUpperCase() : t.text}"`, from: 'Standing', to: 'Removed' }, place: t.level === 'CAMPAIGN' && g ? campaignPlaceOf(g) : groupPlace(t.adGroupId) })
    }
    for (const n of recs(a.negatives)) {
      const text = str(n.text) ?? str(n.asin)
      if (text) out.push({ change: { label: `${negWord(n.matchType, !str(n.text))} "${text}"`, from: 'Standing', to: 'Removed' }, place: str(n.adGroupId) ? groupPlace(str(n.adGroupId)) : campaignPlace(str(n.campaignId)) })
    }
  } else if (tool === 'pause-ads' || tool === 'enable-ads') {
    const [from, to] = tool === 'pause-ads' ? ['Running', 'Paused'] : ['Paused', 'Running']
    for (const id of strs(a.targetIds)) {
      const t = names.targets.get(id)
      if (!t) continue
      out.push({ change: { label: labelFor(t.text, t.kind || 'UNKNOWN', t.expressionType).label, from, to }, place: groupPlace(t.adGroupId) })
    }
    for (const id of strs(a.adGroupIds)) out.push({ change: { label: 'Ad group', from, to }, place: groupPlace(id) })
    for (const id of strs(a.campaignIds)) out.push({ change: { label: 'Campaign', from, to }, place: campaignPlace(id) })
  }
  return out
}
const campaignPlaceOf = (g: { campaignId: string; campaign: string }) => ({ name: `${g.campaign} · whole campaign`, href: campaignHref(g.campaignId) })

/** The request's steps as a reader may see them; null when it is not a request this page decides. */
export async function waitingSteps(approvalId: string, reader: ToolPrincipal): Promise<WaitingSteps | null> {
  if (!(await isWasteRequest(approvalId))) return null
  const ap = await prisma.agentApproval.findUnique({ where: { id: approvalId }, select: { id: true, toolName: true, status: true, args: true, preview: true, summary: true } })
  if (!ap) return null
  const plan = ap.toolName === PLAN_TOOL
  const raw = plan
    ? await prisma.agentPlanStep.findMany({ where: { approvalId }, orderBy: { position: 'asc' }, select: { position: true, toolName: true, status: true, args: true, preview: true } })
    : [{ position: 1, toolName: ap.toolName, status: ap.status, args: ap.args, preview: ap.preview }]
  const visible = storedOutputOf(reader)
  const ctx = { masterCurrency: masterCurrency() }
  // A page step whose preview is not stored (or says no lines) is named from its own arguments: one read for all.
  const names = await namesOf(raw.filter((s) => (WASTE_TOOLS as readonly string[]).includes(s.toolName)))
  const steps = raw.map((s): WaitingStep => {
    const tool = getTool(s.toolName)
    const onPage = (WASTE_TOOLS as readonly string[]).includes(s.toolName)
    const shown = s.preview == null ? null : visible(s.toolName, s.preview)
    const r = shown == null ? null : resolveRequest(s.toolName, s.args, shown, ctx)
    const target = r?.target ?? null
    const fromArgs = onPage && !r?.changes.length ? argLines(s.toolName, s.args, names) : []
    // One place for every line: it is the step's Where; several: each line names its own.
    const places = [...new Set(fromArgs.map((l) => l.place?.name ?? ''))]
    const onePlace = fromArgs.length > 0 && places.length === 1 && !!fromArgs[0].place
    return {
      step: s.position,
      tool: s.toolName,
      words: plainWords(s.toolName) !== s.toolName ? plainWords(s.toolName)! : tool?.title ?? s.toolName,
      onPage,
      status: s.status,
      where: target?.name ? { name: target.name, href: target.href ?? null } : onePlace ? fromArgs[0].place : null,
      changes: fromArgs.length ? fromArgs.map((l) => (onePlace || !l.place ? l.change : { ...l.change, label: `${l.change.label} · ${l.place.name}` })) : r?.changes ?? [],
      changeCount: fromArgs.length || (r?.changeCount ?? 0),
      summary: r?.summary ? plainWords(r.summary) : null,
      hidden: s.preview != null && shown == null && !fromArgs.length ? `Its details need the permissions of ${tool?.title ?? 'that kind of change'}.` : null,
    }
  })
  return {
    approvalId: ap.id,
    status: ap.status,
    plan,
    title: plan ? (String(rec(ap.args).title ?? '').trim() || null) : null,
    steps,
    offPage: steps.filter((s) => !s.onPage).length,
  }
}
