import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { STAGE_WORDS, type Chip, type Frequency, type PlanStage } from '@nexus/factory-domain/quality/plans/rules'
import { QUALITY_TRIGGERS_MANAGE, QUALITY_TRIGGERS_VIEW } from '@nexus/factory-domain/quality/triggers/permissions'
import {
  becauseText,
  dueWords,
  EVENT_RULES,
  EVENT_WORDS,
  FREQUENCY_FORM_WORDS,
  frequencyText,
  inOrder,
  RECORD_KIND_WORDS,
  recordKindOf,
  TRIGGER_EVENTS,
  type RuleFacts,
  type TriggerEvent,
} from '@nexus/factory-domain/quality/triggers/rules'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { chipLabels, chipsOf, chipViews } from '../plans/store'
import type { RuleView } from './contract'

/**
 * The inspection triggers' rows, views and access (B-W2b-101). A rule is a company's (InspectionTrigger.companyId): every
 * office read and write asks can() over that company. The worker's handler reads them in the tenant's system scope (the
 * floor has no grant on the table).
 */

export type Db = CommandTx

export const TRIGGER_COLUMNS = {
  id: true,
  companyId: true,
  sortOrder: true,
  event: true,
  appliesTo: true,
  planId: true,
  frequency: true,
  frequencyValue: true,
  // B-W2b-213: within how many hours what the rule opens is due (null: no due time).
  dueHours: true,
  active: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.InspectionTriggerSelect
export type TriggerRow = Prisma.InspectionTriggerGetPayload<{ select: typeof TRIGGER_COLUMNS }>

export const TRIGGER_RECORD = 'InspectionTrigger'
/**
 * B-W2b-213: the records a rule opened (openedByTriggerId on the three records; a foreign key with Restrict): a rule that
 * opened any is kept, switched off instead of deleted, so each record keeps the rule that opened it.
 */
export async function recordsOpenedBy(db: Pick<Db, 'inspection' | 'incomingInspection' | 'inProcessCheck'>, triggerId: string): Promise<number> {
  const where = { openedByTriggerId: triggerId }
  return (await db.inspection.count({ where })) + (await db.incomingInspection.count({ where })) + (await db.inProcessCheck.count({ where }))
}

/** The rule's own audit trail of what it did (read back as "opened" and "skipped"). */
export const OPENED_ACTION = 'quality.inspectionOpenedByRule'
export const SKIPPED_ACTION = 'quality.inspectionSkippedByRule'
export const TRIGGER_SCOPE = { company: 'companyId' } as const

// ---- access ------------------------------------------------------------------------------------------------------------

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

export const mayView = (context: OfficeContext, companyId: string): boolean => can(actorOf(context), QUALITY_TRIGGERS_VIEW, { companyId })
export const mayManage = (context: OfficeContext, companyId: string): boolean => can(actorOf(context), QUALITY_TRIGGERS_MANAGE, { companyId })
export const viewWhere = (context: OfficeContext) => scopeWhere(actorOf(context), QUALITY_TRIGGERS_VIEW, TRIGGER_SCOPE)

export function assertManage(context: OfficeContext, companyId: string): void {
  if (!mayManage(context, companyId)) throw new ForbiddenError('You keep the inspection rules only for the companies your role reaches (quality.triggers.manage).')
}

/** A refusal in words with its code (`refusal/<CODE>`), answered 409. */
export class TriggerRefusedError extends ConflictError {
  override name = 'TriggerRefusedError'
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

/** The rule, when the caller may see it (else 404: another company's rule is not said to exist). */
export async function readRule(db: Pick<Db, 'inspectionTrigger'>, context: OfficeContext, triggerId: string): Promise<TriggerRow> {
  const row = isUuid(triggerId) ? await db.inspectionTrigger.findUnique({ where: { id: triggerId }, select: TRIGGER_COLUMNS }) : null
  if (!row || !mayView(context, row.companyId)) throw new NotFoundError('Inspection rule not found.')
  return row
}

export const lockCompanyRules = (tx: Db, companyId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.inspection-triggers', current_setting('factory.tenant_id', true), ${companyId}::text), 0))`

// ---- plans -------------------------------------------------------------------------------------------------------------

export interface PlanFacts {
  readonly id: string
  readonly companyId: string
  readonly code: string
  readonly name: string
  readonly stage: PlanStage
  readonly appliesTo: readonly Chip[]
  /** The version records open on now; null: none approved. */
  readonly approved: { readonly id: string; readonly number: number; readonly frequency: Frequency | null; readonly frequencyValue: number | null } | null
}

export async function plansOf(db: Pick<Db, 'inspectionPlan' | 'inspectionPlanVersion'>, planIds: readonly string[]): Promise<Map<string, PlanFacts>> {
  const ids = [...new Set(planIds.filter(isUuid))]
  if (ids.length === 0) return new Map()
  const plans = await db.inspectionPlan.findMany({ where: { id: { in: ids } }, select: { id: true, companyId: true, code: true, name: true, stage: true, appliesTo: true } })
  const approved = await db.inspectionPlanVersion.findMany({ where: { planId: { in: ids }, status: 'APPROVED' }, select: { id: true, planId: true, number: true, frequency: true, frequencyValue: true } })
  const byPlan = new Map(approved.map((row) => [row.planId, row] as const))
  return new Map(
    plans.map((plan) => {
      const version = byPlan.get(plan.id)
      return [plan.id, { id: plan.id, companyId: plan.companyId, code: plan.code, name: plan.name, stage: plan.stage as PlanStage, appliesTo: chipsOf(plan.appliesTo), approved: version ? { id: version.id, number: version.number, frequency: (version.frequency as Frequency | null) ?? null, frequencyValue: version.frequencyValue } : null }] as const
    }),
  )
}

/** The rule as the deciding order sees it; null when its plan is gone or of a stage no rule opens. */
export function ruleFactsOf(row: TriggerRow, plan: PlanFacts | undefined): (RuleFacts & { readonly row: TriggerRow; readonly plan: PlanFacts }) | null {
  if (!plan) return null
  const recordKind = recordKindOf(plan.stage, row.frequency as Frequency)
  if (!recordKind) return null
  return { id: row.id, sortOrder: row.sortOrder, recordKind, chips: chipsOf(row.appliesTo), planChips: plan.appliesTo, row, plan }
}

// ---- references ----------------------------------------------------------------------------------------------------------

/** The records the chips name exist, are the company's own or the group's, and play the part (a supplier, a customer). */
export async function chipRefsProblems(db: Pick<Db, 'style' | 'item' | 'party' | 'operation'>, companyId: string, chips: readonly Chip[]): Promise<Issue[]> {
  const problems: Issue[] = []
  const ours = (row: { companyId: string | null } | null | undefined) => !!row && (row.companyId === null || row.companyId === companyId)
  for (const [index, chip] of chips.entries()) {
    const at = `appliesTo/${index}/value`
    if (chip.kind === 'CATEGORY' || !isUuid(chip.value)) continue
    if (chip.kind === 'STYLE' && !ours(await db.style.findUnique({ where: { id: chip.value }, select: { companyId: true } }))) problems.push({ path: at, message: 'Not a style of this company.' })
    if (chip.kind === 'MATERIAL' && !ours(await db.item.findUnique({ where: { id: chip.value }, select: { companyId: true } }))) problems.push({ path: at, message: 'Not a material of this company.' })
    if (chip.kind === 'OPERATION' && !ours(await db.operation.findUnique({ where: { id: chip.value }, select: { companyId: true } }))) problems.push({ path: at, message: 'Not an operation of this company.' })
    if (chip.kind === 'SUPPLIER' || chip.kind === 'CUSTOMER') {
      const party = await db.party.findUnique({ where: { id: chip.value }, select: { roles: true } })
      const roles: readonly string[] = party?.roles ?? []
      if (chip.kind === 'SUPPLIER' && !roles.includes('SUPPLIER') && !roles.includes('SUBCONTRACTOR')) problems.push({ path: at, message: 'Not a supplier or a workshop.' })
      if (chip.kind === 'CUSTOMER' && !roles.includes('CUSTOMER') && !roles.includes('BRAND')) problems.push({ path: at, message: 'Not a customer or a brand.' })
    }
  }
  return problems
}

/** "applies because …" in Italian and English: a category's label is in each language, a record's is its code and name. */
export async function becauseWords(db: Pick<Db, 'style' | 'item' | 'party' | 'operation'>, head: string, because: readonly Chip[]): Promise<{ it: string; en: string }> {
  const words = async (language: 'it' | 'en') => {
    const labels = await chipLabels(db, because, language)
    return `${head} ${becauseText(because.map((chip) => ({ kind: chip.kind, label: labels.get(`${chip.kind}|${chip.value}`) ?? '?' })), language)}`
  }
  return { it: await words('it'), en: await words('en') }
}

// ---- what a rule did ----------------------------------------------------------------------------------------------------

export interface Activity {
  readonly opened: number
  readonly openedAt: Date | null
  readonly skipped: number
  readonly skippedAt: Date | null
  readonly skippedWords: { it: string; en: string } | null
}
const NO_ACTIVITY: Activity = Object.freeze({ opened: 0, openedAt: null, skipped: 0, skippedAt: null, skippedWords: null })

const wordsIn = (after: Prisma.JsonValue | null): { it: string; en: string } | null => {
  const words = after && typeof after === 'object' && !Array.isArray(after) ? after.words : null
  return words && typeof words === 'object' && !Array.isArray(words) && typeof words.it === 'string' && typeof words.en === 'string' ? { it: words.it, en: words.en } : null
}

/** The rules' audit trail since `since`: how many records each opened and how often it opened nothing (the latest why). */
export async function activityOf(db: Pick<Db, 'auditLog'>, ruleIds: readonly string[], since: Date): Promise<Map<string, Activity>> {
  if (ruleIds.length === 0) return new Map()
  const where = { recordType: TRIGGER_RECORD, recordId: { in: [...ruleIds] }, action: { in: [OPENED_ACTION, SKIPPED_ACTION] }, at: { gte: since } }
  const counts = await db.auditLog.groupBy({ by: ['recordId', 'action'], where, _count: { _all: true }, _max: { at: true } })
  const latestSkips = await db.auditLog.findMany({ where: { ...where, action: SKIPPED_ACTION }, select: { recordId: true, at: true, after: true }, orderBy: [{ at: 'desc' }, { id: 'desc' }], distinct: ['recordId'] })
  const skipWords = new Map(latestSkips.map((row) => [row.recordId, wordsIn(row.after)] as const))
  const found = new Map<string, Activity>()
  for (const row of counts) {
    const entry = { ...(found.get(row.recordId) ?? NO_ACTIVITY) }
    if (row.action === OPENED_ACTION) Object.assign(entry, { opened: row._count._all, openedAt: row._max.at ?? null })
    else Object.assign(entry, { skipped: row._count._all, skippedAt: row._max.at ?? null, skippedWords: skipWords.get(row.recordId) ?? null })
    found.set(row.recordId, entry)
  }
  return found
}

// ---- views -------------------------------------------------------------------------------------------------------------

const both = (make: (language: 'it' | 'en') => string): { it: string; en: string } => ({ it: make('it'), en: make('en') })

export function ruleView(row: TriggerRow, position: number, plan: PlanFacts | undefined, labels: ReadonlyMap<string, string>, activity: Activity | undefined): RuleView {
  const frequency = row.frequency as Frequency
  const event = row.event as TriggerEvent
  const kind = plan ? recordKindOf(plan.stage, frequency) : null
  const done = activity ?? NO_ACTIVITY
  return {
    id: row.id,
    companyId: row.companyId,
    position,
    sortOrder: row.sortOrder,
    event,
    eventWords: { ...EVENT_WORDS[event] },
    appliesTo: chipViews(chipsOf(row.appliesTo), labels),
    plan: plan
      ? { id: plan.id, code: plan.code, name: plan.name, stage: plan.stage, stageWords: { ...STAGE_WORDS[plan.stage] }, approved: plan.approved ? { id: plan.approved.id, number: plan.approved.number } : null, appliesTo: chipViews(plan.appliesTo, labels) }
      : { id: row.planId, code: '?', name: '?', stage: 'INCOMING', stageWords: { it: '?', en: '?' }, approved: null, appliesTo: [] },
    frequency,
    frequencyValue: row.frequencyValue,
    frequencyWords: both((l) => frequencyText(frequency, row.frequencyValue, l)),
    recordKind: kind,
    recordKindWords: kind ? { ...RECORD_KIND_WORDS[kind] } : null,
    dueHours: row.dueHours,
    dueWords: dueWords(row.dueHours),
    active: row.active,
    opened: { last30Days: done.opened, lastAt: done.openedAt ? toUtcIso(done.openedAt) : null },
    skipped: { last30Days: done.skipped, lastAt: done.skippedAt ? toUtcIso(done.skippedAt) : null, lastWords: done.skippedWords },
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

export const LOOKBACK_MS = 30 * 24 * 3_600_000

/** The rules of the companies a reader sees (or of one company), in each company's order, as views. */
export async function ruleViews(db: Db, where: Prisma.InspectionTriggerWhereInput, now: Date): Promise<RuleView[]> {
  const rows = await db.inspectionTrigger.findMany({ where, select: TRIGGER_COLUMNS })
  const all = await db.inspectionTrigger.findMany({ where: { companyId: { in: [...new Set(rows.map((row) => row.companyId))] } }, select: { id: true, companyId: true, sortOrder: true } })
  const positions = new Map<string, number>()
  const byCompany = new Map<string, { id: string; sortOrder: number }[]>()
  for (const row of all) byCompany.set(row.companyId, [...(byCompany.get(row.companyId) ?? []), row])
  for (const list of byCompany.values()) inOrder(list).forEach((row, index) => positions.set(row.id, index + 1))
  const plans = await plansOf(db, rows.map((row) => row.planId))
  const chips = [...rows.flatMap((row) => chipsOf(row.appliesTo)), ...[...plans.values()].flatMap((plan) => plan.appliesTo)]
  const labels = await chipLabels(db, chips)
  const activity = await activityOf(db, rows.map((row) => row.id), new Date(now.getTime() - LOOKBACK_MS))
  return rows
    .map((row) => ruleView(row, positions.get(row.id) ?? 0, plans.get(row.planId), labels, activity.get(row.id)))
    .sort((a, b) => a.companyId.localeCompare(b.companyId) || a.position - b.position)
}

/** What each event can do now, for the rule form. */
export function eventsView() {
  return TRIGGER_EVENTS.map((event) => {
    const rule = EVENT_RULES[event]
    return {
      event,
      words: { ...EVENT_WORDS[event] },
      available: rule.held === null,
      held: rule.held ? { ...rule.held } : null,
      stages: [...rule.stages],
      frequencies: rule.frequencies.map((frequency) => ({
        frequency,
        words: { ...FREQUENCY_FORM_WORDS[frequency] },
        takesValue: frequency === 'PERCENT_OF_OPERATIONS' || frequency === 'EVERY_NTH_BUNDLE',
      })),
      chipKinds: [...rule.chipKinds],
    }
  })
}
