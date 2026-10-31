import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { CERTIFICATES_MANAGE, CERTIFICATES_VIEW } from '@nexus/factory-domain/compliance/certificates/permissions'
import {
  addDays,
  addYears,
  certificateMachine,
  certificateNextStatuses,
  certificateProblems,
  daysToExpiry,
  isCertificateEditable,
  type CertificateFacts,
  type CertificateFields,
  type CertificateStatus,
} from '@nexus/factory-domain/compliance/certificates/rules'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type ScopeColumns } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayRange, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSpec, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { ApiError } from '../../../core/errors'
import { serverClock, type Clock } from '../../../core/time'
import { retainFilesInCommand } from '../../../platform/files/files'
import type { CertificateDetail, CertificateView, CoverageView } from './contract'

/**
 * The certificate register (QHS-103, PRD-280; Reg. (EU) 2016/425 art. 8, Annex V; EN 17092), office side: list and read
 * the certificates (the screens SCR-050 and SCR-051), type one in as a DRAFT and edit it, register it (DRAFT → VALID,
 * with the notified body's PDF on the record: a StoredFile of record type "Certificate", kind CERTIFICATE), suspend,
 * reinstate and withdraw it. Every write is one command() with its audit row; every move is checked by the domain's
 * certificate machine inside the command, before the …_product_guards trigger would refuse it. The scheduler expires
 * certificates (expiry.ts); coverage is coverage.ts; the gate is gate.ts.
 *
 * Scope: a certificate belongs to its company (null: held by a brand, for every company) and its holder party; each
 * one is checked with can(), lists are filtered with scopeWhere(). A certificate the caller may not view is not found.
 */

export const CERTIFICATE_SCOPE: ScopeColumns = { company: { field: 'companyId', nullable: true }, party: { field: 'holderPartyId', nullable: true } }

let clock: Clock = serverClock
/** Test only: the clock of the register's commands and of "today" (default the server clock). */
export function useCertificatesClock(next: Clock | undefined): void {
  clock = next ?? serverClock
}
export const certificatesClock = (): Clock => clock
/** The business date now (Europe/Rome). */
export const todayOf = (at: Clock = clock): BusinessDate => businessDate(at.now())

/** command() on the register's clock. */
export function certificateCommand<Result, State extends string = string, Facts = undefined>(
  caller: CommandCaller,
  spec: CommandSpec<State, Facts>,
  work: (tools: CommandTools) => Promise<Result>,
) {
  return runCommand(caller, spec, work, { ...COMMAND_SETTINGS, clock })
}

export const CERTIFICATE_SELECT = {
  id: true,
  companyId: true,
  holderPartyId: true,
  standard: true,
  ppeClass: true,
  number: true,
  notifiedBodyName: true,
  notifiedBodyNumber: true,
  modelReference: true,
  validFrom: true,
  validTo: true,
  status: true,
  statusReason: true,
  statusChangedAt: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.CertificateSelect
export type CertificateRow = Prisma.CertificateGetPayload<{ select: typeof CERTIFICATE_SELECT }>

export const COVERAGE_SELECT = {
  id: true,
  certificateId: true,
  styleId: true,
  itemId: true,
  colourwayIds: true,
  sizes: true,
  allowsMadeToMeasure: true,
  note: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  style: { select: { id: true, code: true, name: true } },
  item: { select: { id: true, code: true, name: true } },
} as const satisfies Prisma.CertificateCoverageSelect
export type CoverageRow = Prisma.CertificateCoverageGetPayload<{ select: typeof COVERAGE_SELECT }>

/** A @db.Date column as a calendar day, and back. */
export const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
export const dateColumn = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)

export function officeOf(caller: CommandCaller): RequestContext {
  const context = caller.factoryContext
  if (!context) throw new ApiError('unauthenticated')
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

const scopeOf = (row: { companyId: string | null; holderPartyId: string | null }) => ({ companyId: row.companyId, partyId: row.holderPartyId })

export function mayManage(caller: CommandCaller, row: { companyId: string | null; holderPartyId: string | null }): void {
  if (!can(actorOf(officeOf(caller)), CERTIFICATES_MANAGE, scopeOf(row))) throw new ForbiddenError()
}

export const fieldsOf = (row: CertificateRow): CertificateFields => ({
  companyId: row.companyId,
  holderPartyId: row.holderPartyId,
  standard: row.standard,
  ppeClass: row.ppeClass,
  number: row.number,
  notifiedBodyName: row.notifiedBodyName,
  notifiedBodyNumber: row.notifiedBodyNumber,
  modelReference: row.modelReference,
  validFrom: dayOf(row.validFrom),
  validTo: dayOf(row.validTo),
})

/** What the audit rows record of a certificate. */
const audited = (row: CertificateRow) => ({ ...fieldsOf(row), status: row.status, statusReason: row.statusReason, note: row.note })

export function certificateView(row: CertificateRow, coverageCount: number, today: BusinessDate = todayOf()): CertificateView {
  return {
    id: row.id,
    companyId: row.companyId,
    holderPartyId: row.holderPartyId,
    standard: row.standard,
    ppeClass: row.ppeClass,
    number: row.number,
    notifiedBodyName: row.notifiedBodyName,
    notifiedBodyNumber: row.notifiedBodyNumber,
    modelReference: row.modelReference,
    validFrom: dayOf(row.validFrom),
    validTo: dayOf(row.validTo),
    status: row.status,
    statusReason: row.statusReason,
    statusChangedAt: row.statusChangedAt ? toUtcIso(row.statusChangedAt) : null,
    note: row.note,
    daysToExpiry: daysToExpiry(dayOf(row.validTo), today),
    nextStatuses: [...certificateNextStatuses(row.status)],
    coverageCount,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

export function coverageView(row: CoverageRow): CoverageView {
  return {
    id: row.id,
    certificateId: row.certificateId,
    styleId: row.styleId,
    itemId: row.itemId,
    style: row.style,
    item: row.item,
    colourwayIds: [...row.colourwayIds],
    sizes: [...row.sizes],
    allowsMadeToMeasure: row.allowsMadeToMeasure,
    note: row.note,
    status: row.status,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

/** The certificate's PDF from the notified body: an available CERTIFICATE file of the record, in PDF. */
const PDF_WHERE = (certificateId: string) =>
  ({ recordType: 'Certificate', recordId: certificateId, kind: 'CERTIFICATE', status: 'AVAILABLE', contentType: 'application/pdf' }) as const satisfies Prisma.StoredFileWhereInput

export async function hasCertificatePdf(client: FactoryClient | CommandTx, certificateId: string): Promise<boolean> {
  return (await client.storedFile.findFirst({ where: PDF_WHERE(certificateId), select: { id: true } })) !== null
}

/** Reg. (EU) 2016/425 art. 8(3): the technical documentation is kept 10 years after the last unit is placed on the market. */
export const PDF_RETENTION_YEARS = 10

/**
 * How long a certificate's PDF is kept at least: to the end (Europe/Rome) of the day ten years after its last valid
 * day, the last day a unit it covers can be placed on the market.
 */
export const pdfRetainUntil = (validTo: BusinessDate): Date => businessDayRange(addYears(validTo, PDF_RETENTION_YEARS)).end

/** Inside a move into VALID: the certificate's PDFs are kept at least until pdfRetainUntil (files module, audited). */
async function retainCertificatePdfs(tools: Pick<CommandTools, 'tx' | 'audit'>, certificateId: string, validTo: BusinessDate): Promise<void> {
  const files = await tools.tx.storedFile.findMany({ where: PDF_WHERE(certificateId), select: { id: true } })
  const reason = `The certificate's PDF is kept ${PDF_RETENTION_YEARS} years after its last valid day, ${validTo} (Reg. (EU) 2016/425 art. 8(3)).`
  await retainFilesInCommand(tools, files.map((file) => file.id), pdfRetainUntil(validTo), reason)
}

/** The facts of a move, read inside the command (after its row lock). */
export async function certificateFacts(tx: CommandTx, certificateId: string, today: BusinessDate, reason: string | null): Promise<CertificateFacts> {
  const row = await tx.certificate.findUniqueOrThrow({ where: { id: certificateId }, select: CERTIFICATE_SELECT })
  return { certificate: fieldsOf(row), today, pdfAvailable: await hasCertificatePdf(tx, certificateId), reason }
}

/** The certificate with its coverage, as SCR-051 shows it. */
export async function certificateDetail(client: FactoryClient | CommandTx, certificateId: string, today: BusinessDate = todayOf()): Promise<CertificateDetail> {
  const row = await client.certificate.findUnique({ where: { id: certificateId }, select: CERTIFICATE_SELECT })
  if (!row) throw new NotFoundError('Certificate not found.')
  const coverage = await client.certificateCoverage.findMany({ where: { certificateId }, select: COVERAGE_SELECT, orderBy: [{ status: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] })
  return {
    ...certificateView(row, coverage.filter((entry) => entry.status === 'ACTIVE').length, today),
    coverage: coverage.map(coverageView),
    hasPdf: await hasCertificatePdf(client, certificateId),
  }
}

/** A certificate the caller may view, or not found. */
export async function readCertificate(caller: CommandCaller, certificateId: string): Promise<CertificateRow> {
  const context = officeOf(caller)
  if (!isUuid(certificateId)) throw new NotFoundError('Certificate not found.')
  const row = await caller.withClient((client) => client.certificate.findUnique({ where: { id: certificateId }, select: CERTIFICATE_SELECT }))
  if (!row || !can(actorOf(context), CERTIFICATES_VIEW, scopeOf(row))) throw new NotFoundError('Certificate not found.')
  return row
}

export async function getCertificate(caller: CommandCaller, certificateId: string): Promise<CertificateDetail> {
  await readCertificate(caller, certificateId)
  return caller.withClient((client) => certificateDetail(client, certificateId))
}

export interface ListQuery {
  readonly status?: CertificateStatus | undefined
  readonly expiringWithinDays?: number | undefined
  readonly styleId?: string | undefined
  readonly itemId?: string | undefined
}

/** SCR-050: the certificates the caller may view, by last valid day; "expiring soon" = VALID and ending within N days. */
export async function listCertificates(caller: CommandCaller, query: ListQuery): Promise<{ certificates: CertificateView[]; today: BusinessDate }> {
  const context = officeOf(caller)
  const today = todayOf()
  const covering = query.styleId || query.itemId ? { coverage: { some: { status: 'ACTIVE' as const, ...(query.styleId ? { styleId: query.styleId } : {}), ...(query.itemId ? { itemId: query.itemId } : {}) } } } : {}
  const where: Prisma.CertificateWhereInput = {
    AND: [
      scopeWhere(actorOf(context), CERTIFICATES_VIEW, CERTIFICATE_SCOPE) as Prisma.CertificateWhereInput,
      query.status ? { status: query.status } : {},
      query.expiringWithinDays !== undefined ? { status: 'VALID', validTo: { gte: dateColumn(today), lte: dateColumn(addDays(today, query.expiringWithinDays)) } } : {},
      covering,
    ],
  }
  const rows = await caller.withClient((client) =>
    client.certificate.findMany({
      where,
      select: { ...CERTIFICATE_SELECT, _count: { select: { coverage: { where: { status: 'ACTIVE' } } } } },
      orderBy: [{ validTo: 'asc' }, { number: 'asc' }, { id: 'asc' }],
      take: 500,
    }),
  )
  return { certificates: rows.map(({ _count, ...row }) => certificateView(row, _count.coverage, today)), today }
}

export interface CertificateInput {
  readonly companyId?: string | null | undefined
  readonly holderPartyId?: string | null | undefined
  readonly standard: string
  readonly ppeClass?: string | null | undefined
  readonly number: string
  readonly notifiedBodyName: string
  readonly notifiedBodyNumber: string
  readonly modelReference?: string | null | undefined
  readonly validFrom: BusinessDate
  readonly validTo: BusinessDate
  readonly note?: string | null | undefined
}

const atBody = (issues: readonly Issue[]): Issue[] => issues.map((issue) => ({ path: `body/${issue.path}`, message: issue.message }))
const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'
const duplicate = (fields: { notifiedBodyNumber: string; number: string }) =>
  new ConflictError(`Notified body ${fields.notifiedBodyNumber} already has a certificate ${fields.number} in the register.`)

/** The holder company and party exist in the tenant; the number is not in the register yet (but for `except`). */
async function checkReferences(caller: CommandCaller, fields: CertificateFields, except?: string): Promise<void> {
  const problems: Issue[] = []
  await caller.withClient(async (client) => {
    if (fields.companyId && !(await client.company.findUnique({ where: { id: fields.companyId }, select: { id: true } }))) {
      problems.push({ path: 'body/companyId', message: 'Not a company of the tenant.' })
    }
    if (fields.holderPartyId && !(await client.party.findUnique({ where: { id: fields.holderPartyId }, select: { id: true } }))) {
      problems.push({ path: 'body/holderPartyId', message: 'Not a party of the tenant.' })
    }
    if (problems.length > 0) throw new ValidationError('The certificate is not valid.', problems)
    const taken = await client.certificate.findFirst({
      where: { notifiedBodyNumber: fields.notifiedBodyNumber, number: fields.number, ...(except ? { id: { not: except } } : {}) },
      select: { id: true },
    })
    if (taken) throw duplicate(fields)
  })
}

const fieldsFrom = (input: CertificateInput): CertificateFields => ({
  companyId: input.companyId ?? null,
  holderPartyId: input.holderPartyId ?? null,
  standard: input.standard.trim(),
  ppeClass: input.ppeClass?.trim() || null,
  number: input.number.trim(),
  notifiedBodyName: input.notifiedBodyName.trim(),
  notifiedBodyNumber: input.notifiedBodyNumber.trim(),
  modelReference: input.modelReference?.trim() || null,
  validFrom: input.validFrom,
  validTo: input.validTo,
})

const columns = (fields: CertificateFields, note: string | null) => ({
  companyId: fields.companyId,
  holderPartyId: fields.holderPartyId,
  standard: fields.standard,
  ppeClass: fields.ppeClass,
  number: fields.number,
  notifiedBodyName: fields.notifiedBodyName,
  notifiedBodyNumber: fields.notifiedBodyNumber,
  modelReference: fields.modelReference,
  validFrom: dateColumn(fields.validFrom),
  validTo: dateColumn(fields.validTo),
  note,
})

/** B-W2b-23: what a person did to a certificate, once per command (the search index follows it; live screens refetch). */
type CertificateChange = 'CREATED' | 'EDITED' | 'ISSUED' | 'SUSPENDED' | 'REINSTATED' | 'WITHDRAWN'
function certificateChanged(emit: CommandTools['emit'], row: Pick<CertificateRow, 'id' | 'companyId' | 'number' | 'status'>, change: CertificateChange): void {
  emit({ type: 'compliance.certificate_changed', subject: row.id, companyId: row.companyId, payload: { certificateId: row.id, number: row.number, status: row.status, change } })
}

/** compliance.certificates.create: a DRAFT certificate, typed in from the notified body's document. */
export async function createCertificate(caller: CommandCaller, input: CertificateInput, idempotencyKey?: string): Promise<CertificateDetail> {
  const fields = fieldsFrom(input)
  const note = input.note?.trim() || null
  const problems = certificateProblems(fields)
  if (problems.length > 0) throw new ValidationError('The certificate is not valid.', atBody(problems))
  mayManage(caller, fields)
  await checkReferences(caller, fields)
  try {
    const { result } = await certificateCommand(caller, { name: 'compliance.certificates.create', idempotencyKey, input }, async ({ tx, audit, emit, now, context }) => {
      const id = newId()
      const row = await tx.certificate.create({
        data: { id, ...columns(fields, note), status: 'DRAFT', createdAt: now, updatedAt: now, createdById: context.audience === 'office' ? context.actorId : null },
        select: CERTIFICATE_SELECT,
      })
      audit({ recordType: 'Certificate', recordId: id, companyId: row.companyId, after: audited(row) })
      certificateChanged(emit, row, 'CREATED')
      return certificateDetail(tx, id, businessDate(now))
    })
    return result
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicate(fields)
    throw error
  }
}

export interface UpdateInput extends Partial<CertificateInput> {
  readonly version: number
}

const draftOnly = (row: { status: string; number: string }) =>
  new InvalidStateError(`Certificate ${row.number} is ${row.status}: only a draft is edited. A registered certificate changes only its status; a new or extended certificate is a new one.`)

/** compliance.certificates.update: edits a DRAFT (version-guarded). */
export async function updateCertificate(caller: CommandCaller, certificateId: string, input: UpdateInput, idempotencyKey?: string): Promise<CertificateDetail> {
  const before = await readCertificate(caller, certificateId)
  mayManage(caller, before)
  if (!isCertificateEditable(before.status)) throw draftOnly(before)
  // A field left out keeps its value; null clears an optional one.
  const { version: _version, note: newNote, ...changes } = input
  const sent = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)) as Partial<CertificateInput>
  const fields = fieldsFrom({ ...fieldsOf(before), ...sent })
  const note = newNote === undefined ? before.note : newNote?.trim() || null
  const problems = certificateProblems(fields)
  if (problems.length > 0) throw new ValidationError('The certificate is not valid.', atBody(problems))
  // Moving it to another company or holder needs manage over the new one too.
  mayManage(caller, fields)
  await checkReferences(caller, fields, certificateId)
  try {
    const { result } = await certificateCommand(
      caller,
      { name: 'compliance.certificates.update', idempotencyKey, input: { certificateId, ...input }, record: { type: 'Certificate', id: certificateId, expectedVersion: input.version } },
      async ({ tx, audit, emit, now }) => {
        // The row is locked now: a move that committed meanwhile is seen here.
        const locked = await tx.certificate.findUniqueOrThrow({ where: { id: certificateId }, select: { status: true, number: true } })
        if (!isCertificateEditable(locked.status)) throw draftOnly(locked)
        const row = await tx.certificate.update({ where: { id: certificateId }, data: columns(fields, note), select: CERTIFICATE_SELECT })
        audit({ recordType: 'Certificate', recordId: certificateId, companyId: row.companyId, before: audited(before), after: audited(row) })
        certificateChanged(emit, row, 'EDITED')
        return certificateDetail(tx, certificateId, businessDate(now))
      },
    )
    return result
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicate(fields)
    throw error
  }
}

/** The status moves a person makes, with their command and the status they reach. */
export const MOVES = {
  issue: 'VALID',
  suspend: 'SUSPENDED',
  reinstate: 'VALID',
  withdraw: 'WITHDRAWN',
} as const satisfies Record<string, CertificateStatus>
export type Move = keyof typeof MOVES
const MOVE_CHANGES = { issue: 'ISSUED', suspend: 'SUSPENDED', reinstate: 'REINSTATED', withdraw: 'WITHDRAWN' } as const satisfies Record<Move, CertificateChange>

export interface MoveInput {
  readonly version: number
  readonly reason?: string | null | undefined
}

/**
 * compliance.certificates.issue | suspend | reinstate | withdraw: one move of the certificate machine, checked inside the
 * command with the facts it needs (the PDF on the record for VALID, a reason for SUSPENDED and WITHDRAWN). Issue
 * registers a draft (Reg. 2016/425 Annex V: the notified body's certificate, typed in and filed) and keeps its PDF at
 * least ten years after its last valid day (art. 8(3)); reinstate makes a suspended certificate VALID again; withdraw
 * is final.
 */
export async function moveCertificate(caller: CommandCaller, certificateId: string, move: Move, input: MoveInput, idempotencyKey?: string): Promise<CertificateDetail> {
  const before = await readCertificate(caller, certificateId)
  mayManage(caller, before)
  const to = MOVES[move]
  if (move === 'issue' && before.status !== 'DRAFT') throw new InvalidStateError(`Certificate ${before.number} is ${before.status}: only a draft is registered.`)
  if (move === 'reinstate' && before.status !== 'SUSPENDED') throw new InvalidStateError(`Certificate ${before.number} is ${before.status}: only a suspended certificate is reinstated.`)
  const reason = input.reason?.trim() || null
  const today = todayOf()
  const { result } = await certificateCommand(
    caller,
    {
      name: `compliance.certificates.${move}`,
      idempotencyKey,
      input: { certificateId, ...input },
      record: {
        type: 'Certificate',
        id: certificateId,
        expectedVersion: input.version,
        transition: { machine: certificateMachine, to, facts: (tx) => certificateFacts(tx, certificateId, today, reason) },
      },
    },
    async ({ tx, audit, emit, now, record }) => {
      const statusReason = move === 'issue' ? null : reason
      const row = await tx.certificate.update({ where: { id: certificateId }, data: { statusReason, statusChangedAt: now }, select: CERTIFICATE_SELECT })
      // Registered (or reinstated): its PDF is kept, in the same transaction as the move.
      if (to === 'VALID') await retainCertificatePdfs({ tx, audit }, certificateId, dayOf(row.validTo))
      audit({
        recordType: 'Certificate',
        recordId: certificateId,
        companyId: row.companyId,
        before: { status: record!.from, statusReason: before.statusReason },
        after: { status: row.status, statusReason: row.statusReason },
        ...(reason ? { reason } : {}),
      })
      certificateChanged(emit, row, MOVE_CHANGES[move])
      return certificateDetail(tx, certificateId, businessDate(now))
    },
  )
  return result
}
