import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { CLAIMS_APPROVE, CLAIMS_MANAGE, CLAIMS_VIEW } from '@nexus/factory-domain/compliance/claims/permissions'
import { blockReasons, claimStateOf, validityOf, type BlockReason, type ClaimKind, type ClaimScope, type ClaimState, type ClaimStatus, type EvidenceFact, type UseKind } from '@nexus/factory-domain/compliance/claims/rules'
import { DomainError, ForbiddenError } from '@nexus/factory-domain/core/errors'
import { can, holds, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate, type Clock } from '@nexus/factory-domain/core/time'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { peopleNames } from '../../../platform/alerts/store'
import { officeOf as labelsOfficeOf } from '../labels/store'

/**
 * The claims register's rows as the screens show them (B-W2b-264; recall.prisma SustainabilityClaim, ClaimUse): one read
 * each for the evidence files, the styles and materials named, the claims replaced and replacing, the uses and the office
 * people who drafted, approved or withdrew. What a claim reads as today (DRAFT, APPROVED, BLOCKED, RETIRED) is factory-domain's
 * `claimStateOf` over its evidence files. No money; no person but the office people of the record's history.
 */

export type Reader = FactoryClient | CommandTx

export const officeOf = (caller: CommandCaller): OfficeContext => labelsOfficeOf(caller)

let clock: Clock = serverClock
/** Test only: the module clock (today, the commands' time). */
export function useClaimsClock(next: Clock | undefined): void {
  clock = next ?? serverClock
}
export const claimsClock = (): Clock => clock
/** Today in Rome (the guards' "today"). */
export const todayOf = (now: Date = clock.now()): BusinessDate => businessDate(now)
export const dayOf = (value: Date | null): BusinessDate | null => (value === null ? null : value.toISOString().slice(0, 10))
export const dateOf = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)
const iso = (value: Date | null): string | null => (value === null ? null : toUtcIso(value))

export const CLAIM_SELECT = {
  id: true,
  companyId: true,
  code: true,
  kind: true,
  wording: true,
  phraseKey: true,
  scope: true,
  styleId: true,
  itemId: true,
  scopeNote: true,
  evidenceFileIds: true,
  validUntil: true,
  status: true,
  approvedAt: true,
  approvedById: true,
  withdrawnAt: true,
  withdrawnById: true,
  withdrawReason: true,
  supersedesId: true,
  note: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.SustainabilityClaimSelect

export interface ClaimRow {
  readonly id: string
  readonly companyId: string
  readonly code: string
  readonly kind: ClaimKind
  readonly wording: Prisma.JsonValue
  readonly phraseKey: string | null
  readonly scope: ClaimScope
  readonly styleId: string | null
  readonly itemId: string | null
  readonly scopeNote: string | null
  readonly evidenceFileIds: string[]
  readonly validUntil: Date | null
  readonly status: ClaimStatus
  readonly approvedAt: Date | null
  readonly approvedById: string | null
  readonly withdrawnAt: Date | null
  readonly withdrawnById: string | null
  readonly withdrawReason: string | null
  readonly supersedesId: string | null
  readonly note: string | null
  readonly version: number
  readonly createdAt: Date
  readonly createdById: string | null
}

export const USE_SELECT = {
  id: true,
  claimId: true,
  kind: true,
  recordType: true,
  recordId: true,
  label: true,
  note: true,
  createdAt: true,
  createdById: true,
  endedAt: true,
  endedById: true,
  version: true,
} as const satisfies Prisma.ClaimUseSelect

export type UseRow = Prisma.ClaimUseGetPayload<{ select: typeof USE_SELECT }>

const FILE_SELECT = { id: true, originalName: true, kind: true, category: true, contentType: true, sizeBytes: true, status: true, expiresOn: true, recordType: true, recordId: true, availableAt: true } as const satisfies Prisma.StoredFileSelect
type FileRow = Prisma.StoredFileGetPayload<{ select: typeof FILE_SELECT }>

/** The words per language as stored (an object of strings), else none. */
export function wordingOfRow(value: Prisma.JsonValue): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [language, text] of Object.entries(value)) if (typeof text === 'string') out[language] = text
  return out
}

// ---- who may do what ---------------------------------------------------------------------------------------------------------

/** The claims a person reads: those of the companies the read reaches (and of the screen's company, when it names one). */
export function claimScope(context: OfficeContext, permission: Permission = CLAIMS_VIEW): Prisma.SustainabilityClaimWhereInput {
  return { AND: [scopeWhere(actorOf(context), permission, { company: 'companyId' }) as Prisma.SustainabilityClaimWhereInput, context.companyId ? { companyId: context.companyId } : {}] }
}

export const mayRead = (context: OfficeContext, companyId: string): boolean => can(actorOf(context), CLAIMS_VIEW, { companyId })
export const mayManage = (context: OfficeContext, companyId: string): boolean => can(actorOf(context), CLAIMS_MANAGE, { companyId })
export const mayApprove = (context: OfficeContext, companyId: string): boolean => can(actorOf(context), CLAIMS_APPROVE, { companyId })
/** Whether the person holds the permission for the screen's company (or anywhere, without one): the page's buttons. */
export const holdsHere = (context: OfficeContext, permission: Permission): boolean => (context.companyId ? can(actorOf(context), permission, { companyId: context.companyId }) : holds(actorOf(context), permission))

export function assertManage(context: OfficeContext, companyId: string): void {
  if (!mayManage(context, companyId)) throw new ForbiddenError('The claims register of this company is kept by a role that keeps it (compliance.claims.manage).')
}

// ---- the database's refusal in words ------------------------------------------------------------------------------------------

type DriverCause = { originalCode?: unknown; originalMessage?: unknown }
const causeOf = (error: unknown): DriverCause | undefined => (error as { meta?: { driverAdapterError?: { cause?: DriverCause } } } | null)?.meta?.driverAdapterError?.cause
const capital = (words: string): string => `${words.charAt(0).toUpperCase()}${words.slice(1)}`
const PREFIXES = ['recall: ', 'compliance: '] as const

/**
 * Runs a write; the database's refusal becomes a 409 in words (never a 500): a guard's own sentence (B-W2b-222's `recall:`
 * claim guards), a unique key (`taken`, the caller's words: the code), or a reference that refuses. Anything else is rethrown.
 */
export async function guarded<T>(work: () => Promise<T>, words: { readonly taken?: string; readonly named?: string } = {}): Promise<T> {
  try {
    return await work()
  } catch (error) {
    const cause = causeOf(error)
    const code = (error as { code?: unknown } | null)?.code
    if ((cause?.originalCode === '23514' || cause?.originalCode === '23001') && typeof cause.originalMessage === 'string') {
      const prefix = PREFIXES.find((value) => (cause.originalMessage as string).startsWith(value))
      if (prefix) {
        const message = capital(cause.originalMessage.slice(prefix.length))
        throw new DomainError('conflict', message.endsWith('.') ? message : `${message}.`, [{ path: 'refusal/DATABASE', message }])
      }
    }
    if (code === 'P2002' || cause?.originalCode === '23505') throw new DomainError('conflict', words.taken ?? 'This clashes with a row that exists already.', words.taken ? [{ path: 'refusal/CODE_TAKEN', message: words.taken }] : [])
    if (code === 'P2003' || cause?.originalCode === '23503') throw new DomainError('conflict', words.named ?? 'Another record still names this one, or this one names a record that is not there.')
    throw error
  }
}

// ---- reading the facts ----------------------------------------------------------------------------------------------------------

/** The evidence files named, as a claim reads them (an id the reader cannot see reads as MISSING). */
export async function evidenceFiles(db: Reader, ids: Iterable<string>): Promise<Map<string, FileRow>> {
  const wanted = [...new Set(ids)]
  if (wanted.length === 0) return new Map()
  const rows = await db.storedFile.findMany({ where: { id: { in: wanted } }, select: FILE_SELECT })
  return new Map(rows.map((row) => [row.id, row]))
}

export const factOf = (id: string, file: FileRow | undefined): EvidenceFact => ({ id, status: file ? file.status : 'MISSING', expiresOn: file ? dayOf(file.expiresOn) : null })

/** What a claim reads as today, from its evidence files. */
export function stateOf(row: Pick<ClaimRow, 'status' | 'validUntil' | 'evidenceFileIds'>, files: ReadonlyMap<string, FileRow>, today: BusinessDate): { state: ClaimState; reasons: BlockReason[] } {
  const claim = { status: row.status, validUntil: dayOf(row.validUntil), evidenceFileIds: row.evidenceFileIds }
  const facts = row.evidenceFileIds.map((id) => factOf(id, files.get(id)))
  return { state: claimStateOf(claim, facts, today), reasons: row.status === 'APPROVED' ? blockReasons(claim, facts, today) : [] }
}

const evidenceViewOf = (id: string, file: FileRow | undefined) => ({
  id,
  name: file?.originalName ?? '?',
  kind: file?.kind ?? 'DOCUMENT',
  category: file?.category ?? null,
  contentType: file?.contentType ?? '',
  sizeBytes: file?.sizeBytes ?? 0,
  status: file ? file.status : ('MISSING' as const),
  expiresOn: file ? dayOf(file.expiresOn) : null,
  recordType: file?.recordType ?? null,
  recordId: file?.recordId ?? null,
  availableAt: file ? iso(file.availableAt) : null,
})

export type ClaimView = Awaited<ReturnType<typeof claimViews>>[number]

/**
 * The claims as the screens show them: their evidence with each file's state and expiry, the style or material named, the
 * claim each replaces and the one replacing it, where each is used now, and who drafted, approved or withdrew it.
 */
export async function claimViews(db: Reader, context: OfficeContext | null, rows: readonly ClaimRow[], today: BusinessDate) {
  if (rows.length === 0) return []
  const files = await evidenceFiles(db, rows.flatMap((row) => row.evidenceFileIds))
  const styleIds = [...new Set(rows.map((row) => row.styleId).filter((value): value is string => value !== null))]
  const itemIds = [...new Set(rows.map((row) => row.itemId).filter((value): value is string => value !== null))]
  const styles = styleIds.length > 0 ? new Map((await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row])) : new Map<string, { id: string; code: string; name: string }>()
  const items = itemIds.length > 0 ? new Map((await db.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row])) : new Map<string, { id: string; code: string; name: string }>()
  const ids = rows.map((row) => row.id)
  const replacedIds = [...new Set(rows.map((row) => row.supersedesId).filter((value): value is string => value !== null))]
  const replaced = replacedIds.length > 0 ? new Map((await db.sustainabilityClaim.findMany({ where: { id: { in: replacedIds } }, select: { id: true, code: true, status: true } })).map((row) => [row.id, row])) : new Map<string, { id: string; code: string; status: ClaimStatus }>()
  // The newest claim replacing each one (a withdrawn replacement leaves room for another: the newest counts).
  const replacing = new Map<string, { id: string; code: string; status: ClaimStatus }>()
  for (const row of await db.sustainabilityClaim.findMany({ where: { supersedesId: { in: ids } }, select: { id: true, code: true, status: true, supersedesId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })) {
    if (row.supersedesId && (row.status !== 'WITHDRAWN' || !replacing.has(row.supersedesId))) replacing.set(row.supersedesId, { id: row.id, code: row.code, status: row.status })
  }
  const uses = await db.claimUse.findMany({ where: { claimId: { in: ids } }, select: { claimId: true, kind: true, endedAt: true } })
  const names = await peopleNames(db, rows.flatMap((row) => [row.createdById, row.approvedById, row.withdrawnById]))
  const person = (id: string | null) => (id ? { id, name: names.get(id) ?? '?' } : null)
  return rows.map((row) => {
    const { state, reasons } = stateOf(row, files, today)
    const mine = uses.filter((use) => use.claimId === row.id)
    const live = mine.filter((use) => use.endedAt === null)
    const style = row.styleId ? styles.get(row.styleId) : undefined
    const item = row.itemId ? items.get(row.itemId) : undefined
    return {
      id: row.id,
      companyId: row.companyId,
      code: row.code,
      kind: row.kind,
      wording: wordingOfRow(row.wording),
      phraseKey: row.phraseKey,
      scope: row.scope,
      style: row.styleId ? { id: row.styleId, code: style?.code ?? '?', name: style?.name ?? '?' } : null,
      material: row.itemId ? { id: row.itemId, code: item?.code ?? '?', name: item?.name ?? '?' } : null,
      scopeNote: row.scopeNote,
      evidence: row.evidenceFileIds.map((id) => evidenceViewOf(id, files.get(id))),
      validUntil: dayOf(row.validUntil),
      validity: validityOf(dayOf(row.validUntil), today),
      status: row.status,
      state,
      blockReasons: reasons,
      approvedAt: iso(row.approvedAt),
      approvedBy: person(row.approvedById),
      withdrawnAt: iso(row.withdrawnAt),
      withdrawnBy: person(row.withdrawnById),
      withdrawReason: row.withdrawReason,
      supersedes: row.supersedesId ? (replaced.get(row.supersedesId) ?? { id: row.supersedesId, code: '?', status: 'WITHDRAWN' as const }) : null,
      supersededBy: replacing.get(row.id) ?? null,
      uses: { live: live.length, ended: mine.length - live.length, kinds: [...new Set(live.map((use) => use.kind as UseKind))] },
      note: row.note,
      createdAt: toUtcIso(row.createdAt),
      createdBy: person(row.createdById),
      version: row.version,
      canManage: context ? mayManage(context, row.companyId) : false,
      canApprove: context ? mayApprove(context, row.companyId) : false,
    }
  })
}

/** The uses as the Where used tab shows them: the record in words, who recorded and who ended them. */
export async function useViews(db: Reader, uses: readonly UseRow[]) {
  const styleIds = uses.filter((use) => use.recordType === 'Style').map((use) => use.recordId)
  const labelIds = uses.filter((use) => use.recordType === 'LabelTemplate').map((use) => use.recordId)
  const styles = styleIds.length > 0 ? await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, name: true } }) : []
  const labels = labelIds.length > 0 ? await db.labelTemplate.findMany({ where: { id: { in: labelIds } }, select: { id: true, code: true, name: true } }) : []
  const records = new Map([...styles, ...labels].map((row) => [row.id, { code: row.code, name: row.name }]))
  const names = await peopleNames(db, uses.flatMap((use) => [use.createdById, use.endedById]))
  const person = (id: string | null) => (id ? { id, name: names.get(id) ?? '?' } : null)
  return uses.map((use) => ({
    id: use.id,
    kind: use.kind as UseKind,
    recordType: use.recordType,
    recordId: use.recordId,
    record: records.get(use.recordId) ?? null,
    label: use.label,
    note: use.note,
    createdAt: toUtcIso(use.createdAt),
    createdBy: person(use.createdById),
    endedAt: iso(use.endedAt),
    endedBy: person(use.endedById),
    version: use.version,
  }))
}
