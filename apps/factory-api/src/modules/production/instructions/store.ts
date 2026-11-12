import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { PRODUCTION_INSTRUCTIONS_VIEW } from '@nexus/factory-domain/production/instructions/permissions'
import { asWords, type MediaKind, type Refusal, type VersionStatus, type Words } from '@nexus/factory-domain/production/instructions/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import type { Reader } from '../scans/store'

/**
 * The work instructions' rows and access (B-W2b-214): what ./office.ts, ./write.ts, ./floor.ts and ./acks.ts read and
 * write through. Every read names its columns and selects no relation. An instruction is a company's
 * (WorkInstruction.companyId): every office read and write asks can() over that company. The floor reads the published and
 * superseded versions only (the floor role's grant and policy); it never reads an acknowledgement (the system scope does,
 * for "is Seen due").
 */

export type Db = Reader

export const INSTRUCTION = {
  id: true,
  companyId: true,
  number: true,
  operationId: true,
  styleId: true,
  styleRevisionId: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.WorkInstructionSelect
export type InstructionRow = Prisma.WorkInstructionGetPayload<{ select: typeof INSTRUCTION }>

export const VERSION = {
  id: true,
  instructionId: true,
  number: true,
  status: true,
  changeNote: true,
  authorId: true,
  approvedById: true,
  publishedAt: true,
  acknowledgementRequired: true,
  supersededAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.WorkInstructionVersionSelect
export type VersionRow = Prisma.WorkInstructionVersionGetPayload<{ select: typeof VERSION }>

export const STEP = {
  id: true,
  versionId: true,
  sortOrder: true,
  code: true,
  textI18n: true,
  critical: true,
  safetyNoteI18n: true,
  icon: true,
  requiredTick: true,
} as const satisfies Prisma.WorkInstructionStepSelect
export type StepRow = Prisma.WorkInstructionStepGetPayload<{ select: typeof STEP }>

export const MEDIA = {
  id: true,
  versionId: true,
  stepId: true,
  fileId: true,
  kind: true,
  sortOrder: true,
  captionI18n: true,
} as const satisfies Prisma.WorkInstructionMediaSelect
export type MediaRow = Prisma.WorkInstructionMediaGetPayload<{ select: typeof MEDIA }>

export const SETTING = {
  id: true,
  seq: true,
  machineClassId: true,
  stitchType: true,
  needle: true,
  thread: true,
  stitchesPerCm: true,
  tension: true,
  foot: true,
  notes: true,
} as const satisfies Prisma.OperationMachineSettingSelect
export type SettingRow = Prisma.OperationMachineSettingGetPayload<{ select: typeof SETTING }>

export const INSTRUCTION_RECORD = 'WorkInstruction'
export const VERSION_RECORD = 'WorkInstructionVersion'
export const ACK_RECORD = 'InstructionAcknowledgement'
/** The record type of the media's files (StoredFile.recordType, recordId = the instruction). */
export const FILE_RECORD = 'WorkInstruction'

// ---- access ------------------------------------------------------------------------------------------------------------------

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

export const may = (context: OfficeContext, permission: Permission, companyId: string): boolean => can(actorOf(context), permission, { companyId })
export const viewWhere = (context: OfficeContext) => scopeWhere(actorOf(context), PRODUCTION_INSTRUCTIONS_VIEW, { company: 'companyId' })

export function assertMay(context: OfficeContext, permission: Permission, companyId: string, words: string): void {
  if (!may(context, permission, companyId)) throw new ForbiddenError(words)
}

/** A refusal in words with its code (`refusal/<CODE>`), answered 409. */
export class InstructionRefusedError extends ConflictError {
  override name = 'InstructionRefusedError'
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

export const refuse = (refusal: Refusal, more: readonly Issue[] = []): never => {
  throw new InstructionRefusedError(refusal.code, refusal.message, more)
}

interface DriverCause {
  readonly originalCode?: unknown
  readonly originalMessage?: unknown
}

/** The database's words of a guard of …_routings_instructions_w2b_guards ("product: …"), as a sentence. */
function sentenceOf(message: string): string {
  const text = message.replace(/^product:\s*/, '').trim()
  const first = text.charAt(0).toUpperCase() + text.slice(1)
  return /[.!?]$/.test(first) ? first : `${first}.`
}

/**
 * The database's own refusal of a write here, in its words, never a 500 (the lead's rule for W2b-4): a guard's check
 * violation, or a unique index (one ACTIVE instruction per operation and revision, one PUBLISHED version, one Seen per device
 * and event). The commands say every one of them first; this is the last line.
 */
export function databaseRefusal(error: unknown): Refusal | null {
  if (!(error instanceof Error)) return null
  const known = error as Error & { code?: unknown; meta?: { driverAdapterError?: { cause?: DriverCause }; target?: unknown } }
  const cause = known.meta?.driverAdapterError?.cause
  if (cause?.originalCode === '23514' && typeof cause.originalMessage === 'string') return { code: 'DATABASE_REFUSED', message: sentenceOf(cause.originalMessage) }
  if (known.code === 'P2002' || cause?.originalCode === '23505') return { code: 'ALREADY_EXISTS', message: 'Someone did the same at the same moment: open the record again and look at it as it stands now.' }
  return null
}

export async function inWords<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    const refusal = databaseRefusal(error)
    if (refusal) refuse(refusal)
    throw error
  }
}

// ---- reads ---------------------------------------------------------------------------------------------------------------------

/** The instruction, when the caller may see it (else 404: another company's instruction is not said to exist). */
export async function readInstruction(db: Db, context: OfficeContext, instructionId: string): Promise<InstructionRow> {
  const row = isUuid(instructionId) ? await db.workInstruction.findUnique({ where: { id: instructionId }, select: INSTRUCTION }) : null
  if (!row || !may(context, PRODUCTION_INSTRUCTIONS_VIEW, row.companyId)) throw new NotFoundError('Work instruction not found.')
  return row
}

export async function readVersion(db: Db, instruction: Pick<InstructionRow, 'id'>, versionId: string): Promise<VersionRow> {
  const row = isUuid(versionId) ? await db.workInstructionVersion.findUnique({ where: { id: versionId }, select: VERSION }) : null
  if (!row || row.instructionId !== instruction.id) throw new NotFoundError('Version not found.')
  return row
}

export const versionsOf = (db: Db, instructionIds: readonly string[]): Promise<VersionRow[]> =>
  instructionIds.length === 0 ? Promise.resolve([]) : db.workInstructionVersion.findMany({ where: { instructionId: { in: [...new Set(instructionIds)] } }, select: VERSION, orderBy: [{ number: 'desc' }] })

/** The commands that write a version's content: who ran one on a draft never approves it (factory-domain publishRefusal). */
export const SAVE_ACTIONS = ['production.createInstruction', 'production.draftInstructionVersion', 'production.saveInstructionVersion', 'production.bringTypedSteps'] as const

/** Who saved a change to each version (its author included), from the version's audit rows. */
export async function editorsOf(db: Db, versionIds: readonly string[]): Promise<Map<string, string[]>> {
  const editors = new Map<string, string[]>()
  if (versionIds.length === 0) return editors
  const rows = await db.auditLog.findMany({ where: { recordType: VERSION_RECORD, recordId: { in: [...new Set(versionIds)] }, action: { in: [...SAVE_ACTIONS] } }, select: { recordId: true, actorId: true }, distinct: ['recordId', 'actorId'] })
  for (const row of rows) editors.set(row.recordId, [...(editors.get(row.recordId) ?? []), row.actorId])
  return editors
}

export const stepsOf = (db: Db, versionIds: readonly string[]): Promise<StepRow[]> =>
  versionIds.length === 0 ? Promise.resolve([]) : db.workInstructionStep.findMany({ where: { versionId: { in: [...new Set(versionIds)] } }, select: STEP, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] })

export const mediaOf = (db: Db, versionIds: readonly string[]): Promise<MediaRow[]> =>
  versionIds.length === 0 ? Promise.resolve([]) : db.workInstructionMedia.findMany({ where: { versionId: { in: [...new Set(versionIds)] } }, select: MEDIA, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] })

export interface FileFacts {
  readonly id: string
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly status: string
}

export async function filesOf(db: Db, fileIds: readonly string[]): Promise<Map<string, FileFacts>> {
  const ids = [...new Set(fileIds)]
  if (ids.length === 0) return new Map()
  const rows = await db.storedFile.findMany({ where: { id: { in: ids } }, select: { id: true, originalName: true, contentType: true, sizeBytes: true, status: true } })
  return new Map(rows.map((row) => [row.id, { id: row.id, originalName: row.originalName, contentType: row.contentType, sizeBytes: Number(row.sizeBytes), status: row.status as string }]))
}

export interface OperationRef {
  readonly id: string
  readonly companyId: string | null
  readonly code: string
  readonly name: string
  readonly nameI18n: Words
  readonly status: string
}

export async function operationsOf(db: Db, operationIds: readonly string[]): Promise<Map<string, OperationRef>> {
  const ids = [...new Set(operationIds)]
  if (ids.length === 0) return new Map()
  const rows = await db.operation.findMany({ where: { id: { in: ids } }, select: { id: true, companyId: true, code: true, name: true, nameI18n: true, status: true } })
  return new Map(rows.map((row) => [row.id, { id: row.id, companyId: row.companyId, code: row.code, name: row.name, nameI18n: asWords(row.nameI18n), status: row.status as string }]))
}

export interface RevisionRef {
  readonly id: string
  readonly styleId: string
  readonly revision: number
  readonly status: string
  readonly style: { readonly id: string; readonly code: string; readonly name: string; readonly companyId: string | null }
}

export async function revisionsOf(db: Db, revisionIds: readonly (string | null)[]): Promise<Map<string, RevisionRef>> {
  const ids = [...new Set(revisionIds.filter((id): id is string => typeof id === 'string'))]
  if (ids.length === 0) return new Map()
  const revisions = await db.styleRevision.findMany({ where: { id: { in: ids } }, select: { id: true, styleId: true, revision: true, status: true } })
  const styles = new Map((await db.style.findMany({ where: { id: { in: [...new Set(revisions.map((row) => row.styleId))] } }, select: { id: true, code: true, name: true, companyId: true } })).map((row) => [row.id, row]))
  return new Map(revisions.flatMap((row) => {
    const style = styles.get(row.styleId)
    return style ? [[row.id, { id: row.id, styleId: row.styleId, revision: row.revision, status: row.status as string, style }] as const] : []
  }))
}

/** The machine classes' words. */
export async function classesOf(db: Db, ids: readonly (string | null)[]): Promise<Map<string, { readonly code: string; readonly labelIt: string; readonly labelEn: string }>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string'))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.machineClass.findMany({ where: { id: { in: wanted } }, select: { id: true, code: true, labelIt: true, labelEn: true } })).map((row) => [row.id, row]))
}

export const statusOf = (row: Pick<VersionRow, 'status'>): VersionStatus => row.status as VersionStatus
export const kindOf = (row: Pick<MediaRow, 'kind'>): MediaKind => row.kind as MediaKind

/** Words of a JSON column, or null for none. */
export const wordsOrNull = (value: Prisma.JsonValue | null): Words | null => {
  const words = asWords(value)
  return Object.keys(words).length > 0 ? words : null
}
