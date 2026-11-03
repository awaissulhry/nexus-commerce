import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { DefectClass } from '@nexus/factory-domain/quality/defects/rules'
import { QUALITY_PLANS_APPROVE, QUALITY_PLANS_MANAGE, QUALITY_PLANS_VIEW } from '@nexus/factory-domain/quality/plans/permissions'
import {
  approverRefusal,
  CATEGORY_WORDS,
  CHECK_TYPE_WORDS,
  CHIP_KIND_WORDS,
  contentProblems,
  samplingWords,
  specWords,
  STAGE_WORDS,
  VERSION_STATUS_WORDS,
  type CheckContent,
  type CheckType,
  type Chip,
  type ChipKind,
  type Frequency,
  type PlanStage,
  type SamplingDraft,
  type SamplingMethod,
  type VersionContent,
  type VersionStatus,
} from '@nexus/factory-domain/quality/plans/rules'
import type { Uom } from '@nexus/factory-domain/product/units/units'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import type { PlanRow, VersionView } from './contract'

/**
 * The inspection plans' rows, views and checks (B-W2b-92): what ./plans.ts reads and ./commands.ts writes through. A plan
 * is a company's (InspectionPlan.companyId, never null): every read and write asks can() over that company.
 */

export type Db = CommandTx

export const PLAN_COLUMNS = {
  id: true,
  companyId: true,
  code: true,
  stage: true,
  name: true,
  ownerId: true,
  appliesTo: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.InspectionPlanSelect
export type PlanDbRow = Prisma.InspectionPlanGetPayload<{ select: typeof PLAN_COLUMNS }>

export const VERSION_COLUMNS = {
  id: true,
  companyId: true,
  planId: true,
  number: true,
  status: true,
  changeNote: true,
  authorId: true,
  samplingMethod: true,
  aqlProfileId: true,
  fixedSampleSize: true,
  frequency: true,
  frequencyValue: true,
  stopAtReject: true,
  approvedById: true,
  approvedAt: true,
  approvalSha256: true,
  retiredById: true,
  retiredAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.InspectionPlanVersionSelect
export type VersionDbRow = Prisma.InspectionPlanVersionGetPayload<{ select: typeof VERSION_COLUMNS }>

export const CHECK_COLUMNS = {
  id: true,
  planVersionId: true,
  sortOrder: true,
  code: true,
  labelIt: true,
  labelEn: true,
  labelI18n: true,
  type: true,
  checkClass: true,
  mandatory: true,
  photoRequired: true,
  nominal: true,
  tolerance: true,
  uom: true,
  choices: true,
} as const satisfies Prisma.InspectionPlanCheckSelect
export type CheckDbRow = Prisma.InspectionPlanCheckGetPayload<{ select: typeof CHECK_COLUMNS }>

export const PLAN_SCOPE = { company: 'companyId' } as const
export const PLAN_RECORD = 'InspectionPlan'
export const VERSION_RECORD = 'InspectionPlanVersion'
/** The audit actions that read back as facts: who saved a draft (never its approver), and who asked for approval. */
export const SAVE_ACTIONS = ['quality.draftPlanVersion', 'quality.savePlanVersion', 'quality.createPlan', 'quality.addStarterPlans'] as const
export const SUBMIT_ACTION = 'quality.submitPlanVersion'

// ---- access ------------------------------------------------------------------------------------------------------------

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

export const mayView = (context: OfficeContext, companyId: string): boolean => can(actorOf(context), QUALITY_PLANS_VIEW, { companyId })
export const mayManage = (context: OfficeContext, companyId: string): boolean => can(actorOf(context), QUALITY_PLANS_MANAGE, { companyId })
export const mayApprove = (context: OfficeContext, companyId: string): boolean => can(actorOf(context), QUALITY_PLANS_APPROVE, { companyId })
export const viewWhere = (context: OfficeContext) => scopeWhere(actorOf(context), QUALITY_PLANS_VIEW, PLAN_SCOPE)

export function assertManage(context: OfficeContext, companyId: string): void {
  if (!mayManage(context, companyId)) throw new ForbiddenError("You keep inspection plans only for the companies your role reaches (quality.plans.manage).")
}

/** A refusal in words with its code (`refusal/<CODE>`), answered 409. */
export class PlanRefusedError extends ConflictError {
  override name = 'PlanRefusedError'
  override readonly issues: readonly Issue[]
  constructor(
    readonly refusal: string,
    message: string,
    more: readonly Issue[] = [],
  ) {
    super(message)
    this.issues = [{ path: `refusal/${refusal}`, message }, ...more]
  }
}

/** The plan, when the caller may see it (else 404: another company's plan is not said to exist). */
export async function readPlan(db: Pick<Db, 'inspectionPlan'>, context: OfficeContext, planId: string): Promise<PlanDbRow> {
  const row = isUuid(planId) ? await db.inspectionPlan.findUnique({ where: { id: planId }, select: PLAN_COLUMNS }) : null
  if (!row || !mayView(context, row.companyId)) throw new NotFoundError('Inspection plan not found.')
  return row
}

export async function readVersion(db: Pick<Db, 'inspectionPlanVersion'>, plan: Pick<PlanDbRow, 'id'>, versionId: string): Promise<VersionDbRow> {
  const row = isUuid(versionId) ? await db.inspectionPlanVersion.findUnique({ where: { id: versionId }, select: VERSION_COLUMNS }) : null
  if (!row || row.planId !== plan.id) throw new NotFoundError('Plan version not found.')
  return row
}

export const readChecks = (db: Pick<Db, 'inspectionPlanCheck'>, versionIds: readonly string[]): Promise<CheckDbRow[]> =>
  versionIds.length === 0 ? Promise.resolve([]) : db.inspectionPlanCheck.findMany({ where: { planVersionId: { in: [...versionIds] } }, select: CHECK_COLUMNS, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] })

// ---- content -----------------------------------------------------------------------------------------------------------

const decimal = (value: Prisma.Decimal | null): string | null => (value === null ? null : value.toFixed(3))
export const wordsOf = (value: Prisma.JsonValue | null | undefined): Record<string, string> =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}
export const chipsOf = (value: Prisma.JsonValue | null | undefined): Chip[] =>
  Array.isArray(value) ? value.flatMap((chip) => (chip && typeof chip === 'object' && !Array.isArray(chip) && typeof chip.kind === 'string' && typeof chip.value === 'string' ? [{ kind: chip.kind as ChipKind, value: chip.value }] : [])) : []

export function contentOfCheck(row: CheckDbRow): CheckContent {
  return {
    code: row.code,
    labelIt: row.labelIt,
    labelEn: row.labelEn,
    labelI18n: wordsOf(row.labelI18n),
    type: row.type as CheckType,
    checkClass: (row.checkClass as DefectClass | null) ?? null,
    mandatory: row.mandatory,
    photoRequired: row.photoRequired,
    nominal: decimal(row.nominal),
    tolerance: decimal(row.tolerance),
    uom: (row.uom as Uom | null) ?? null,
    choices: [...row.choices],
  }
}

export const samplingOf = (row: VersionDbRow): SamplingDraft => ({
  samplingMethod: row.samplingMethod as SamplingMethod,
  aqlProfileId: row.aqlProfileId,
  fixedSampleSize: row.fixedSampleSize,
  frequency: (row.frequency as Frequency | null) ?? null,
  frequencyValue: row.frequencyValue,
  stopAtReject: row.stopAtReject,
})

export const versionContentOf = (row: VersionDbRow, checks: readonly CheckDbRow[]): VersionContent => ({
  number: row.number,
  sampling: samplingOf(row),
  checks: checks.filter((check) => check.planVersionId === row.id).map(contentOfCheck),
})

// ---- names, usage, profiles --------------------------------------------------------------------------------------------

export type Names = ReadonlyMap<string, string>

export async function userNames(db: Pick<Db, 'user'>, ids: readonly (string | null | undefined)[]): Promise<Names> {
  const wanted = [...new Set(ids.filter((value): value is string => typeof value === 'string'))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
}

export const personOf = (names: Names, id: string | null): { id: string; name: string } | null => (id ? { id, name: names.get(id) ?? '?' } : null)

export interface Usage {
  readonly final: number
  readonly incoming: number
  readonly inProcess: number
  readonly records: number
}
export const NO_USE: Usage = Object.freeze({ final: 0, incoming: 0, inProcess: 0, records: 0 })

/** How many records ran on each version (final, incoming, in-process), as far as the caller's sites reach. */
export async function usageOf(db: Pick<Db, 'inspection' | 'incomingInspection' | 'inProcessCheck'>, versionIds: readonly string[]): Promise<Map<string, Usage>> {
  const used = new Map<string, { final: number; incoming: number; inProcess: number }>()
  if (versionIds.length === 0) return new Map()
  const where = { planVersionId: { in: [...versionIds] } }
  const add = (versionId: string | null, key: 'final' | 'incoming' | 'inProcess', count: number) => {
    if (!versionId) return
    const entry = used.get(versionId) ?? { final: 0, incoming: 0, inProcess: 0 }
    entry[key] += count
    used.set(versionId, entry)
  }
  // One after the other: a transaction client runs one statement at a time.
  for (const row of await db.inspection.groupBy({ by: ['planVersionId'], where, _count: { _all: true } })) add(row.planVersionId, 'final', row._count._all)
  for (const row of await db.incomingInspection.groupBy({ by: ['planVersionId'], where, _count: { _all: true } })) add(row.planVersionId, 'incoming', row._count._all)
  for (const row of await db.inProcessCheck.groupBy({ by: ['planVersionId'], where, _count: { _all: true } })) add(row.planVersionId, 'inProcess', row._count._all)
  return new Map([...used].map(([versionId, entry]) => [versionId, { ...entry, records: entry.final + entry.incoming + entry.inProcess }]))
}

export type ProfileRow = { id: string; code: string; name: string; inspectionLevel: string; aqlMajor: Prisma.Decimal; aqlMinor: Prisma.Decimal; active: boolean }

export async function profilesOf(db: Pick<Db, 'aqlProfile'>, ids: readonly (string | null)[]): Promise<Map<string, ProfileRow>> {
  const wanted = [...new Set(ids.filter((value): value is string => typeof value === 'string'))]
  if (wanted.length === 0) return new Map()
  const rows = await db.aqlProfile.findMany({ where: { id: { in: wanted } }, select: { id: true, code: true, name: true, inspectionLevel: true, aqlMajor: true, aqlMinor: true, active: true } })
  return new Map(rows.map((row) => [row.id, row]))
}

/** Who saved a change to each version (its author included): the people who may not approve it. */
export async function editorsOf(db: Pick<Db, 'auditLog'>, versionIds: readonly string[]): Promise<Map<string, string[]>> {
  const editors = new Map<string, string[]>()
  if (versionIds.length === 0) return editors
  const rows = await db.auditLog.findMany({ where: { recordType: VERSION_RECORD, recordId: { in: [...versionIds] }, action: { in: [...SAVE_ACTIONS] } }, select: { recordId: true, actorId: true }, distinct: ['recordId', 'actorId'] })
  for (const row of rows) editors.set(row.recordId, [...(editors.get(row.recordId) ?? []), row.actorId])
  return editors
}

/**
 * The draft's ask for approval, when nothing changed since: the ask records the row version it left (`atVersion`), and
 * every save bumps it, so an ask older than the last save no longer matches (inside a command too, where this command's
 * own audit rows are not written yet).
 */
export async function submittedOf(db: Pick<Db, 'auditLog'>, row: Pick<VersionDbRow, 'id' | 'version'>): Promise<{ by: string; at: Date; note: string | null } | null> {
  const asks = await db.auditLog.findMany({ where: { recordType: VERSION_RECORD, recordId: row.id, action: SUBMIT_ACTION }, select: { actorId: true, at: true, reason: true, after: true }, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: 20 })
  const ask = asks.find((entry) => atVersionOf(entry.after) === row.version)
  return ask ? { by: ask.actorId, at: ask.at, note: ask.reason } : null
}

const atVersionOf = (after: Prisma.JsonValue | null): number | null => (after && typeof after === 'object' && !Array.isArray(after) && typeof after.atVersion === 'number' ? after.atVersion : null)

// ---- chips in words ----------------------------------------------------------------------------------------------------

/** The records the chips name, in words ("JKT-01 Moto jacket"); a category by its words; "?" when out of sight. */
export async function chipLabels(db: Pick<Db, 'style' | 'item' | 'party' | 'operation'>, chips: readonly Chip[], language: 'it' | 'en' = 'en'): Promise<Map<string, string>> {
  const ids = (kind: ChipKind) => [...new Set(chips.filter((chip) => chip.kind === kind && isUuid(chip.value)).map((chip) => chip.value))]
  const labels = new Map<string, string>()
  const styles = ids('STYLE')
  const items = ids('MATERIAL')
  const parties = [...new Set([...ids('SUPPLIER'), ...ids('CUSTOMER')])]
  const operations = ids('OPERATION')
  if (styles.length > 0) for (const row of await db.style.findMany({ where: { id: { in: styles } }, select: { id: true, code: true, name: true } })) labels.set(`STYLE|${row.id}`, `${row.code} ${row.name}`)
  if (items.length > 0) for (const row of await db.item.findMany({ where: { id: { in: items } }, select: { id: true, code: true, name: true } })) labels.set(`MATERIAL|${row.id}`, `${row.code} ${row.name}`)
  if (parties.length > 0) {
    for (const row of await db.party.findMany({ where: { id: { in: parties } }, select: { id: true, code: true, legalName: true, tradeName: true } })) {
      const name = `${row.code} ${row.tradeName?.trim() || row.legalName}`
      labels.set(`SUPPLIER|${row.id}`, name)
      labels.set(`CUSTOMER|${row.id}`, name)
    }
  }
  if (operations.length > 0) for (const row of await db.operation.findMany({ where: { id: { in: operations } }, select: { id: true, code: true, name: true } })) labels.set(`OPERATION|${row.id}`, `${row.code} ${row.name}`)
  for (const chip of chips) if (chip.kind === 'CATEGORY') labels.set(`CATEGORY|${chip.value}`, CATEGORY_WORDS[chip.value]?.[language] ?? chip.value)
  return labels
}

export const chipViews = (chips: readonly Chip[], labels: ReadonlyMap<string, string>) =>
  chips.map((chip) => ({ kind: chip.kind, value: chip.value, label: labels.get(`${chip.kind}|${chip.value}`) ?? '?', kindWords: { ...CHIP_KIND_WORDS[chip.kind] } }))

// ---- views -------------------------------------------------------------------------------------------------------------

const both = <T>(make: (language: 'it' | 'en') => T): { it: T; en: T } => ({ it: make('it'), en: make('en') })

export function samplingView(row: VersionDbRow, profiles: ReadonlyMap<string, ProfileRow>) {
  const sampling = samplingOf(row)
  const profile = row.aqlProfileId ? (profiles.get(row.aqlProfileId) ?? null) : null
  const named = profile ? { code: profile.code, name: profile.name } : null
  return {
    ...sampling,
    aqlProfileId: row.aqlProfileId,
    fixedSampleSize: row.fixedSampleSize,
    frequency: sampling.frequency ?? null,
    frequencyValue: row.frequencyValue,
    stopAtReject: row.stopAtReject,
    profile: profile ? { id: profile.id, code: profile.code, name: profile.name, inspectionLevel: profile.inspectionLevel, aqlMajor: profile.aqlMajor.toString(), aqlMinor: profile.aqlMinor.toString(), active: profile.active } : null,
    words: {
      sample: both((l) => samplingWords(sampling, l, named).sample),
      frequency: sampling.frequency ? both((l) => samplingWords(sampling, l, named).frequency ?? '') : null,
      stop: both((l) => samplingWords(sampling, l, named).stop),
    },
  }
}

export function checkView(row: CheckDbRow) {
  const content = contentOfCheck(row)
  const spec = specWords(content, 'en')
  return {
    id: row.id,
    sortOrder: row.sortOrder,
    ...content,
    choices: [...content.choices],
    labelI18n: { ...content.labelI18n },
    typeWords: { it: CHECK_TYPE_WORDS[content.type].it, en: CHECK_TYPE_WORDS[content.type].en },
    takesResult: CHECK_TYPE_WORDS[content.type].takesResult,
    spec: spec === null ? null : { it: specWords(content, 'it')!, en: spec },
  }
}

export interface VersionFacts {
  readonly checks: readonly CheckDbRow[]
  readonly usage: ReadonlyMap<string, Usage>
  readonly names: Names
  readonly profiles: ReadonlyMap<string, ProfileRow>
  readonly submitted: { by: string; at: Date; note: string | null } | null
}

export function versionView(row: VersionDbRow, facts: VersionFacts): VersionView {
  const checks = facts.checks.filter((check) => check.planVersionId === row.id)
  const content = versionContentOf(row, checks)
  return {
    id: row.id,
    planId: row.planId,
    number: row.number,
    status: row.status as VersionStatus,
    statusWords: { ...VERSION_STATUS_WORDS[row.status as VersionStatus] },
    changeNote: row.changeNote,
    author: personOf(facts.names, row.authorId),
    approvedBy: personOf(facts.names, row.approvedById),
    approvedAt: row.approvedAt ? toUtcIso(row.approvedAt) : null,
    approvalSha256: row.approvalSha256,
    retiredBy: personOf(facts.names, row.retiredById),
    retiredAt: row.retiredAt ? toUtcIso(row.retiredAt) : null,
    sampling: samplingView(row, facts.profiles),
    checks: checks.map(checkView),
    usedBy: facts.usage.get(row.id) ?? NO_USE,
    submitted: row.status === 'DRAFT' && facts.submitted ? { by: personOf(facts.names, facts.submitted.by), at: toUtcIso(facts.submitted.at), note: facts.submitted.note } : null,
    problems: row.status === 'DRAFT' ? contentProblems(content).map((problem) => ({ path: problem.path, message: problem.message })) : null,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

/** Everything a version's view needs, read in one go. */
export async function versionFacts(db: Db, rows: readonly VersionDbRow[], submittedFor: string | null = null): Promise<VersionFacts> {
  const ids = rows.map((row) => row.id)
  const checks = await readChecks(db, ids)
  const usage = await usageOf(db, ids)
  const draft = submittedFor ? rows.find((row) => row.id === submittedFor && row.status === 'DRAFT') : undefined
  const submitted = draft ? await submittedOf(db, draft) : null
  const names = await userNames(db, [...rows.flatMap((row) => [row.authorId, row.approvedById, row.retiredById]), submitted?.by])
  const profiles = await profilesOf(db, rows.map((row) => row.aqlProfileId))
  return { checks, usage, names, profiles, submitted }
}

/** Why this person may not approve the draft now, in words; null when they may (content problems are told apart). */
export function approveHeld(context: OfficeContext, plan: Pick<PlanDbRow, 'companyId'>, draft: VersionDbRow | null, editors: readonly string[]): string | null {
  if (!draft) return 'There is no draft to approve.'
  if (!mayApprove(context, plan.companyId)) return 'Approving a plan version needs quality.plans.approve for this company.'
  return approverRefusal({ number: draft.number, status: draft.status as VersionStatus, authorId: draft.authorId, editorIds: editors, approverId: context.actorId })?.message ?? null
}

export function planRowOf(plan: PlanDbRow, versions: readonly VersionDbRow[], extra: { labels: ReadonlyMap<string, string>; names: Names; usage: ReadonlyMap<string, Usage>; submittedDrafts: ReadonlySet<string> }): PlanRow {
  const mine = versions.filter((row) => row.planId === plan.id).sort((a, b) => b.number - a.number)
  const approved = mine.find((row) => row.status === 'APPROVED') ?? null
  const draft = mine.find((row) => row.status === 'DRAFT') ?? null
  const status: VersionStatus = approved ? 'APPROVED' : draft ? 'DRAFT' : 'RETIRED'
  const last = [plan.updatedAt, ...mine.map((row) => row.updatedAt)].reduce((a, b) => (a > b ? a : b))
  return {
    id: plan.id,
    companyId: plan.companyId,
    code: plan.code,
    name: plan.name,
    stage: plan.stage as PlanStage,
    stageWords: { ...STAGE_WORDS[plan.stage as PlanStage] },
    appliesTo: chipViews(chipsOf(plan.appliesTo), extra.labels),
    approved: approved ? { id: approved.id, number: approved.number } : null,
    draft: draft ? { id: draft.id, number: draft.number, submitted: extra.submittedDrafts.has(draft.id) } : null,
    status,
    statusWords: { ...VERSION_STATUS_WORDS[status] },
    latestNumber: mine[0]?.number ?? 0,
    owner: personOf(extra.names, plan.ownerId),
    usedBy: mine.reduce((sum, row) => sum + (extra.usage.get(row.id)?.records ?? 0), 0),
    lastChangeAt: toUtcIso(last),
    version: plan.version,
  }
}

/** The drafts asked for approval with nothing changed since (see submittedOf). */
export async function submittedDrafts(db: Pick<Db, 'auditLog'>, drafts: readonly Pick<VersionDbRow, 'id' | 'version'>[]): Promise<Set<string>> {
  if (drafts.length === 0) return new Set()
  const current = new Map(drafts.map((row) => [row.id, row.version] as const))
  const rows = await db.auditLog.findMany({ where: { recordType: VERSION_RECORD, recordId: { in: [...current.keys()] }, action: SUBMIT_ACTION }, select: { recordId: true, after: true } })
  return new Set(rows.filter((row) => atVersionOf(row.after) === current.get(row.recordId)).map((row) => row.recordId))
}
