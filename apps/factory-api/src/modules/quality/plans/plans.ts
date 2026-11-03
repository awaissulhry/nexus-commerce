import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { otherFloorLanguages } from '@nexus/factory-domain/quality/defects/vocabulary'
import { labelIn } from '@nexus/factory-domain/quality/defects/rules'
import { printableChecklist } from '@nexus/factory-domain/quality/plans/checklist'
import { chipsMatch, compareVersions, PLAN_LIMITS, PLAN_STAGES, STAGE_WORDS, VERSION_STATUS_WORDS, type PlanStage, type VersionStatus } from '@nexus/factory-domain/quality/plans/rules'
import { missingStarterPlans, STARTER_PLANS } from '@nexus/factory-domain/quality/plans/starter'
import type { CommandCaller } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import type { PlanRow } from './contract'
import {
  approveHeld,
  chipLabels,
  chipsOf,
  editorsOf,
  mayApprove,
  mayManage,
  mayView,
  officeOf,
  planRowOf,
  readPlan,
  readVersion,
  samplingView,
  checkView,
  submittedDrafts,
  usageOf,
  userNames,
  versionContentOf,
  versionFacts,
  versionView,
  VERSION_COLUMNS,
  viewWhere,
  PLAN_COLUMNS,
  NO_USE,
  profilesOf,
  readChecks,
  type Db,
  type PlanDbRow,
  type VersionDbRow,
} from './store'

/**
 * The inspection plans' reads (B-W2b-92; QHS-008, QHS-009, QHS-016; design quality.plans SCR-077):
 *
 *   GET /quality/plans                                   the Plans grid: every plan of the companies the caller reaches
 *                                                        (stage, applies to, version in force, draft, owner, used by,
 *                                                        last change), counts per stage and of drafts waiting approval
 *   GET /quality/plans/starter?companyId=                the leather-apparel starter set, each plan said missing or not
 *   GET /quality/plans/:planId                           the plan record: versions, the version the builder opens with
 *                                                        its checks and sampling, the comparison with the approved one,
 *                                                        "applies to 14 styles", the rules that name it, what the caller
 *                                                        may do (an author's own draft says why it is not theirs to approve)
 *   GET /quality/plans/:planId/versions/:versionId       one version, compared with another (default: the approved one),
 *                                                        and the newest records that ran on it (QHS-016)
 *   GET …/versions/:versionId/checklist?language=        the printable checklist (design pl-print)
 *   GET /quality/plan-versions/:versionId?language=      the version a record runs on, frozen, for any office or floor
 *                                                        screen (the bench shows it): words in the person's language
 */

// ---- the Plans grid ----------------------------------------------------------------------------------------------------

export interface ListQuery {
  readonly companyId?: string | undefined
  readonly stage?: PlanStage | undefined
  readonly status?: VersionStatus | undefined
  readonly q?: string | undefined
}

/** The grid's rows (newest plan code first within a stage order), as the caller's grants reach. */
export async function listPlans(caller: CommandCaller, query: ListQuery): Promise<{ plans: PlanRow[]; truncated: boolean; counts: { byStage: Record<string, number>; waitingApproval: number }; stages: { stage: PlanStage; it: string; en: string }[]; canManage: boolean; canApprove: boolean }> {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const db = client as unknown as Db
    const q = query.q?.trim()
    const filter: Prisma.InspectionPlanWhereInput = {
      ...(query.companyId ? { companyId: query.companyId } : {}),
      ...(query.stage ? { stage: query.stage } : {}),
      ...(q ? { OR: [{ code: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] } : {}),
    }
    const limit = PLAN_LIMITS.plansPerCompany
    const found = await db.inspectionPlan.findMany({ where: { AND: [viewWhere(context) as Prisma.InspectionPlanWhereInput, filter] }, select: PLAN_COLUMNS, orderBy: [{ code: 'asc' }], take: limit + 1 })
    const truncated = found.length > limit
    const plans = found.slice(0, limit)
    const versions = await db.inspectionPlanVersion.findMany({ where: { planId: { in: plans.map((plan) => plan.id) } }, select: VERSION_COLUMNS })
    const usage = await usageOf(db, versions.map((row) => row.id))
    const submitted = await submittedDrafts(db, versions.filter((row) => row.status === 'DRAFT'))
    const names = await userNames(db, plans.map((plan) => plan.ownerId))
    const labels = await chipLabels(db, plans.flatMap((plan) => chipsOf(plan.appliesTo)))
    const rows = plans
      .map((plan) => planRowOf(plan, versions, { labels, names, usage, submittedDrafts: submitted }))
      .filter((row) => !query.status || row.status === query.status)
      .sort((a, b) => PLAN_STAGES.indexOf(a.stage) - PLAN_STAGES.indexOf(b.stage) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    const byStage = Object.fromEntries(PLAN_STAGES.map((stage) => [stage, rows.filter((row) => row.stage === stage).length]))
    const companies = [...new Set(plans.map((plan) => plan.companyId))]
    return {
      plans: rows,
      truncated,
      counts: { byStage, waitingApproval: rows.filter((row) => row.draft?.submitted).length },
      stages: PLAN_STAGES.map((stage) => ({ stage, ...STAGE_WORDS[stage] })),
      canManage: query.companyId ? mayManage(context, query.companyId) : (companies.length > 0 ? companies : [context.companyId].filter((value): value is string => !!value)).some((company) => mayManage(context, company)),
      canApprove: query.companyId ? mayApprove(context, query.companyId) : (companies.length > 0 ? companies : [context.companyId].filter((value): value is string => !!value)).some((company) => mayApprove(context, company)),
    }
  })
}

// ---- the starter set ---------------------------------------------------------------------------------------------------

export async function readStarter(caller: CommandCaller, query: { readonly companyId: string }) {
  const context = officeOf(caller)
  if (!mayView(context, query.companyId)) throw new NotFoundError('Company not found.')
  return caller.withClient(async (client) => {
    const taken = new Set((await client.inspectionPlan.findMany({ where: { companyId: query.companyId }, select: { code: true } })).map((row) => row.code))
    const missing = new Set(missingStarterPlans(taken).map((plan) => plan.code))
    return { plans: STARTER_PLANS.map((plan) => ({ code: plan.code, stage: plan.stage, stageWords: { ...STAGE_WORDS[plan.stage] }, name: { ...plan.name }, checks: plan.checks.length, missing: missing.has(plan.code) })) }
  })
}

// ---- the plan record ---------------------------------------------------------------------------------------------------

/** "applies to 14 styles" (materials for an incoming plan): the company's own and tenant-wide ones the chips reach. */
async function previewOf(db: Db, plan: PlanDbRow): Promise<{ subject: 'styles' | 'materials'; count: number; outOf: number }> {
  const chips = chipsOf(plan.appliesTo)
  const owned = { OR: [{ companyId: plan.companyId }, { companyId: null }] }
  if (plan.stage === 'INCOMING') {
    const items = await db.item.findMany({ where: { AND: [owned, { status: 'ACTIVE' }] }, select: { id: true, kind: true } })
    return { subject: 'materials', outOf: items.length, count: items.filter((item) => chipsMatch(chips, { MATERIAL: [item.id], CATEGORY: [item.kind] }, 'pass').matches).length }
  }
  const styles = await db.style.findMany({ where: { AND: [owned, { status: { not: 'ARCHIVED' } }] }, select: { id: true, productType: true, brandPartyId: true } })
  return { subject: 'styles', outOf: styles.length, count: styles.filter((style) => chipsMatch(chips, { STYLE: [style.id], CATEGORY: [style.productType], CUSTOMER: [style.brandPartyId] }, 'pass').matches).length }
}

/** The record of one plan, as GET /quality/plans/:planId and every write answer it. */
export async function planRecordIn(db: Db, context: OfficeContext, planId: string) {
  const plan = await readPlan(db, context, planId)
  const versions = await db.inspectionPlanVersion.findMany({ where: { planId: plan.id }, select: VERSION_COLUMNS, orderBy: { number: 'desc' } })
  const approved = versions.find((row) => row.status === 'APPROVED') ?? null
  const draft = versions.find((row) => row.status === 'DRAFT') ?? null
  const current = draft ?? approved ?? versions[0]
  if (!current) throw new NotFoundError('This plan has no version.')
  const facts = await versionFacts(db, versions, draft?.id ?? null)
  const editors = await editorsOf(db, draft ? [draft.id] : [])
  const names = await userNames(db, [plan.ownerId, ...versions.flatMap((row) => [row.authorId, row.approvedById, row.retiredById]), facts.submitted?.by])
  const allNames = new Map([...facts.names, ...names])
  const labels = await chipLabels(db, chipsOf(plan.appliesTo))
  const row = planRowOf(plan, versions, { labels, names: allNames, usage: facts.usage, submittedDrafts: new Set(facts.submitted && draft ? [draft.id] : []) })
  const rules = await db.inspectionTrigger.count({ where: { planId: plan.id, active: true } })
  const comparison = compareVersions(approved && approved.id !== current.id ? versionContentOf(approved, facts.checks) : null, versionContentOf(current, facts.checks))
  return {
    plan: row,
    versions: versions.map((version) => ({
      id: version.id,
      number: version.number,
      status: version.status as VersionStatus,
      statusWords: { ...VERSION_STATUS_WORDS[version.status as VersionStatus] },
      changeNote: version.changeNote,
      author: { id: version.authorId, name: allNames.get(version.authorId) ?? '?' },
      approvedBy: version.approvedById ? { id: version.approvedById, name: allNames.get(version.approvedById) ?? '?' } : null,
      approvedAt: version.approvedAt ? toUtcIso(version.approvedAt) : null,
      retiredAt: version.retiredAt ? toUtcIso(version.retiredAt) : null,
      checks: facts.checks.filter((check) => check.planVersionId === version.id).length,
      usedBy: facts.usage.get(version.id) ?? NO_USE,
      createdAt: toUtcIso(version.createdAt),
    })),
    current: versionView(current, { ...facts, names: allNames, submitted: current.id === draft?.id ? facts.submitted : null }),
    comparison: { ...comparison, added: [...comparison.added], removed: [...comparison.removed], changed: comparison.changed.map((entry) => ({ code: entry.code, changes: [...entry.changes] })), moved: [...comparison.moved], sampling: [...comparison.sampling] },
    preview: await previewOf(db, plan),
    rules,
    may: { manage: mayManage(context, plan.companyId), approve: !approveHeld(context, plan, draft, draft ? (editors.get(draft.id) ?? []) : []), approveHeld: approveHeld(context, plan, draft, draft ? (editors.get(draft.id) ?? []) : []) },
  }
}

export async function readPlanRecord(caller: CommandCaller, planId: string) {
  const context = officeOf(caller)
  return caller.withClient((client) => planRecordIn(client as unknown as Db, context, planId))
}

// ---- one version -------------------------------------------------------------------------------------------------------

const RECORDS_SHOWN = 50

/** The newest records that ran on a version (QHS-016), as far as the caller's sites reach. */
async function recordsOn(db: Db, versionId: string) {
  const final = await db.inspection.findMany({ where: { planVersionId: versionId }, select: { id: true, number: true, status: true, siteId: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: RECORDS_SHOWN })
  const incoming = await db.incomingInspection.findMany({ where: { planVersionId: versionId }, select: { id: true, number: true, status: true, siteId: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: RECORDS_SHOWN })
  const inProcess = await db.inProcessCheck.findMany({ where: { planVersionId: versionId }, select: { id: true, kind: true, status: true, siteId: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: RECORDS_SHOWN })
  return [
    ...final.map((row) => ({ kind: 'FINAL' as const, id: row.id, number: row.number, status: row.status, siteId: row.siteId, at: row.createdAt })),
    ...incoming.map((row) => ({ kind: 'INCOMING' as const, id: row.id, number: row.number, status: row.status, siteId: row.siteId, at: row.createdAt })),
    ...inProcess.map((row) => ({ kind: 'IN_PROCESS' as const, id: row.id, number: null, status: `${row.kind} ${row.status}`, siteId: row.siteId, at: row.createdAt })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, RECORDS_SHOWN)
    .map((row) => ({ ...row, at: toUtcIso(row.at) }))
}

export async function readVersionRecord(caller: CommandCaller, planId: string, versionId: string, query: { readonly compare?: string | undefined }) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const db = client as unknown as Db
    const plan = await readPlan(db, context, planId)
    const version = await readVersion(db, plan, versionId)
    const versions = await db.inspectionPlanVersion.findMany({ where: { planId: plan.id }, select: VERSION_COLUMNS })
    const draft = versions.find((row) => row.status === 'DRAFT') ?? null
    let against: VersionDbRow | null
    if (query.compare) {
      against = versions.find((row) => row.id === query.compare) ?? null
      if (!against) throw new ValidationError('Compare with a version of the same plan.', [{ path: 'querystring/compare', message: 'Not a version of this plan.' }])
    } else {
      against = versions.find((row) => row.status === 'APPROVED' && row.id !== version.id) ?? null
    }
    const facts = await versionFacts(db, against ? [version, against] : [version], version.status === 'DRAFT' ? version.id : null)
    const comparison = compareVersions(against ? versionContentOf(against, facts.checks) : null, versionContentOf(version, facts.checks))
    const editors = await editorsOf(db, draft ? [draft.id] : [])
    const held = approveHeld(context, plan, draft, draft ? (editors.get(draft.id) ?? []) : [])
    return {
      version: versionView(version, facts),
      comparison: { ...comparison, added: [...comparison.added], removed: [...comparison.removed], changed: comparison.changed.map((entry) => ({ code: entry.code, changes: [...entry.changes] })), moved: [...comparison.moved], sampling: [...comparison.sampling] },
      records: await recordsOn(db, version.id),
      may: { manage: mayManage(context, plan.companyId), approve: held === null, approveHeld: held },
    }
  })
}

// ---- the printable checklist -------------------------------------------------------------------------------------------

export async function readChecklist(caller: CommandCaller, planId: string, versionId: string, query: { readonly language?: string | undefined }) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const db = client as unknown as Db
    const plan = await readPlan(db, context, planId)
    const version = await readVersion(db, plan, versionId)
    const facts = await versionFacts(db, [version])
    const sites = await db.site.findMany({ where: { companyId: plan.companyId }, select: { floorLocales: true } })
    const languages = ['it', 'en', ...otherFloorLanguages(sites)]
    const language = query.language ?? 'it'
    if (!languages.includes(language)) throw new ValidationError(`Print in ${languages.join(', ')}.`, [{ path: 'querystring/language', message: `Not a language of this company's benches: ${languages.join(', ')}.` }])
    const profile = version.aqlProfileId ? (facts.profiles.get(version.aqlProfileId) ?? null) : null
    const printable = printableChecklist(
      {
        plan: { code: plan.code, name: plan.name, stage: plan.stage as PlanStage },
        version: { number: version.number, status: version.status as VersionStatus, approvedByName: version.approvedById ? (facts.names.get(version.approvedById) ?? null) : null, approvedAt: version.approvedAt ? toUtcIso(version.approvedAt) : null, changeNote: version.changeNote },
        sampling: versionContentOf(version, facts.checks).sampling,
        profile: profile ? { code: profile.code, name: profile.name } : null,
        checks: versionContentOf(version, facts.checks).checks,
      },
      language,
    )
    return { ...printable, lines: [...printable.lines], rows: printable.rows.map((row) => ({ ...row, choices: [...row.choices] })), signatures: [...printable.signatures], languages }
  })
}

// ---- the version a record runs on --------------------------------------------------------------------------------------

/** The language of an office or floor person: asked, else their own (the worker's or the user's), else Italian. */
async function personalLanguage(client: Pick<Db, 'worker' | 'user'>, caller: CommandCaller): Promise<string> {
  const context = caller.factoryContext
  if (!context || (context.audience !== 'office' && context.audience !== 'floor')) return 'it'
  if (context.audience === 'floor') return (await client.worker.findUnique({ where: { id: context.actorId }, select: { locale: true } }))?.locale ?? 'it'
  return (await client.user.findUnique({ where: { id: context.actorId }, select: { locale: true } }))?.locale ?? 'it'
}

export async function readFrozenVersion(caller: CommandCaller, versionId: string, query: { readonly language?: string | undefined }) {
  return caller.withClient(async (client) => {
    const db = client as unknown as Db
    const version = isUuid(versionId) ? await db.inspectionPlanVersion.findUnique({ where: { id: versionId }, select: VERSION_COLUMNS }) : null
    if (!version) throw new NotFoundError('Plan version not found.')
    const plan = await db.inspectionPlan.findUnique({ where: { id: version.planId }, select: PLAN_COLUMNS })
    if (!plan) throw new NotFoundError('Plan version not found.')
    // Not versionFacts: the floor reads no person (User) and no record counts, only the checks and the profile.
    const checks = await readChecks(db, [version.id])
    const profiles = await profilesOf(db, [version.aqlProfileId])
    const language = query.language ?? (await personalLanguage(db, caller))
    return {
      plan: { id: plan.id, code: plan.code, name: plan.name, stage: plan.stage as PlanStage, stageWords: { ...STAGE_WORDS[plan.stage as PlanStage] } },
      version: { id: version.id, number: version.number, status: version.status as VersionStatus, statusWords: { ...VERSION_STATUS_WORDS[version.status as VersionStatus] }, approvedAt: version.approvedAt ? toUtcIso(version.approvedAt) : null, approvalSha256: version.approvalSha256 },
      sampling: samplingView(version, profiles),
      checks: checks.map((check) => {
        const view = checkView(check)
        return { ...view, label: labelIn(view, language), missing: language !== 'it' && language !== 'en' && view.labelI18n[language] === undefined }
      }),
      language,
    }
  })
}
