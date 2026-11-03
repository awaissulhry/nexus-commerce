import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { InspectionLevel } from '@nexus/factory-domain/quality/aql/iso2859'
import { QUALITY_AQL_MANAGE, QUALITY_AQL_VIEW } from '@nexus/factory-domain/quality/aql/permissions'
import { aqlWords, LEVEL_WORDS, levelText } from '@nexus/factory-domain/quality/aql/sampling'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import type { AssignmentView, ProfileView } from './contract'

/**
 * The reads of AQL profiles and their assignments (B-W2b-93): the columns, the views, the usage counts, who may see and
 * keep a company's profiles. Every read names its columns and runs as the caller (row-level security keeps the tenant;
 * the company is checked here with can(), as every table's company is kept by the API).
 */

export type Reader = FactoryClient | CommandTx

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

export const mayView = (context: OfficeContext, companyId: string): boolean => can(actorOf(context), QUALITY_AQL_VIEW, { companyId }) || can(actorOf(context), QUALITY_AQL_MANAGE, { companyId })
export const mayManage = (context: OfficeContext, companyId: string): boolean => can(actorOf(context), QUALITY_AQL_MANAGE, { companyId })

export function assertManage(context: OfficeContext, companyId: string): void {
  if (!mayManage(context, companyId)) throw new ForbiddenError("A company's AQL profiles are kept with quality.aql.manage over that company.")
}

export const PROFILE_COLUMNS = {
  id: true,
  companyId: true,
  code: true,
  name: true,
  inspectionLevel: true,
  aqlCritical: true,
  aqlMajor: true,
  aqlMinor: true,
  isDefault: true,
  active: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.AqlProfileSelect
export type ProfileRow = Prisma.AqlProfileGetPayload<{ select: typeof PROFILE_COLUMNS }>

export const ASSIGNMENT_COLUMNS = { id: true, companyId: true, profileId: true, customerId: true, styleId: true, active: true, version: true, createdAt: true, updatedAt: true } as const satisfies Prisma.AqlProfileAssignmentSelect
export type AssignmentRow = Prisma.AqlProfileAssignmentGetPayload<{ select: typeof ASSIGNMENT_COLUMNS }>

export async function readProfile(db: Reader, profileId: string): Promise<ProfileRow | null> {
  return isUuid(profileId) ? db.aqlProfile.findUnique({ where: { id: profileId }, select: PROFILE_COLUMNS }) : null
}

/** A profile as an office caller may reach it: not found outside its grants, forbidden to keep without manage. */
export async function profileFor(caller: CommandCaller, profileId: string, keep: boolean): Promise<{ context: OfficeContext; row: ProfileRow }> {
  const context = officeOf(caller)
  const row = await caller.withClient((client) => readProfile(client, profileId))
  if (!row || !mayView(context, row.companyId)) throw new NotFoundError('AQL profile not found.')
  if (keep) assertManage(context, row.companyId)
  return { context, row }
}

export async function readAssignment(db: Reader, assignmentId: string): Promise<AssignmentRow | null> {
  return isUuid(assignmentId) ? db.aqlProfileAssignment.findUnique({ where: { id: assignmentId }, select: ASSIGNMENT_COLUMNS }) : null
}

export interface Usage {
  readonly customers: number
  readonly styles: number
  readonly pairs: number
  readonly inspections: number
}
const NO_USE: Usage = { customers: 0, styles: 0, pairs: 0, inspections: 0 }

/** How many active assignments (customers, styles, a style of one customer) and inspections name each profile. */
export async function usageOf(db: Reader, profileIds: readonly string[]): Promise<Map<string, Usage>> {
  const used = new Map<string, Usage>()
  if (profileIds.length === 0) return used
  const bump = (id: string, key: keyof Usage, by: number) => used.set(id, { ...(used.get(id) ?? NO_USE), [key]: (used.get(id) ?? NO_USE)[key] + by })
  // One after the other: a transaction client runs one statement at a time.
  const rows = await db.aqlProfileAssignment.findMany({ where: { profileId: { in: [...profileIds] }, active: true }, select: { profileId: true, customerId: true, styleId: true } })
  for (const row of rows) bump(row.profileId, row.customerId && row.styleId ? 'pairs' : row.customerId ? 'customers' : 'styles', 1)
  for (const row of await db.inspection.groupBy({ by: ['aqlProfileId'], where: { aqlProfileId: { in: [...profileIds] } }, _count: { _all: true } })) if (row.aqlProfileId) bump(row.aqlProfileId, 'inspections', row._count._all)
  return used
}

export function profileView(row: ProfileRow, usage: Usage | undefined): ProfileView {
  const level = row.inspectionLevel as InspectionLevel
  const use = usage ?? NO_USE
  return {
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    name: row.name,
    inspectionLevel: level,
    levelText: levelText(level),
    levelWords: { ...LEVEL_WORDS[level] },
    aqlCritical: aqlWords(row.aqlCritical.toString()),
    aqlMajor: aqlWords(row.aqlMajor.toString()),
    aqlMinor: aqlWords(row.aqlMinor.toString()),
    isDefault: row.isDefault,
    active: row.active,
    note: row.note,
    usedBy: { customers: use.customers, styles: use.styles, pairs: use.pairs },
    inspections: use.inspections,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

export const auditedProfile = (row: ProfileRow) => ({
  code: row.code,
  name: row.name,
  inspectionLevel: row.inspectionLevel,
  aqlCritical: row.aqlCritical.toString(),
  aqlMajor: row.aqlMajor.toString(),
  aqlMinor: row.aqlMinor.toString(),
  isDefault: row.isDefault,
  active: row.active,
  note: row.note,
})

/** The names an assignment shows: its profile's code, the customer's name, the style's code and name. */
export async function assignmentViews(db: Reader, rows: readonly AssignmentRow[]): Promise<AssignmentView[]> {
  const profileIds = [...new Set(rows.map((row) => row.profileId))]
  const customerIds = [...new Set(rows.flatMap((row) => (row.customerId ? [row.customerId] : [])))]
  const styleIds = [...new Set(rows.flatMap((row) => (row.styleId ? [row.styleId] : [])))]
  const profiles = new Map((await db.aqlProfile.findMany({ where: { id: { in: profileIds } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const customers = await partyNames(db, customerIds)
  const styles = new Map((styleIds.length ? await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, name: true } }) : []).map((row) => [row.id, row]))
  return rows.map((row) => ({
    id: row.id,
    companyId: row.companyId,
    profileId: row.profileId,
    profileCode: profiles.get(row.profileId) ?? '',
    customer: row.customerId ? { id: row.customerId, name: customers.get(row.customerId) ?? null } : null,
    style: row.styleId ? { id: row.styleId, code: styles.get(row.styleId)?.code ?? null, name: styles.get(row.styleId)?.name ?? null } : null,
    active: row.active,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }))
}

/** A party's name as the office shows it (its trade name, else its registered name). */
export async function partyNames(db: Reader, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await db.party.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, legalName: true, tradeName: true } })
  return new Map(rows.map((row) => [row.id, row.tradeName?.trim() || row.legalName]))
}

/** One writer of a company's profiles at a time (codes, the default). */
export async function lockCompanyProfiles(tx: CommandTx, companyId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.aql-profiles', current_setting('factory.tenant_id', true), ${companyId}::text), 0))`
}

/** One writer of a customer and style pair's assignment at a time (one active row per pair). */
export async function lockPair(tx: CommandTx, companyId: string, customerId: string | null, styleId: string | null): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.aql-assignment', current_setting('factory.tenant_id', true), ${companyId}::text, ${customerId ?? '-'}::text, ${styleId ?? '-'}::text), 0))`
}
