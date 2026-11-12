import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, parseInstant, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { PURCHASING_SUBCONTRACT_TERMS } from '@nexus/factory-domain/purchasing/subcontract-depth/permissions'
import {
  draftHeld,
  draftProblems,
  expiresInDays,
  inForceOn,
  LAW,
  nextRevision,
  signProblems,
  supersededReason,
  terminateProblems,
  termsWords,
  type AgreementFacts,
  type AgreementStatus,
} from '@nexus/factory-domain/purchasing/subcontract-depth/terms'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { retainFilesInCommand } from '../../../platform/files/files'
import { tenantOf } from '../../shipping/cells'
import { dayOf, dayValue, officeContextOf, type Reader } from '../store'
import { nameOf, officeOrder } from '../subcontracting/store'
import { inWords } from './guarded'

/**
 * The written terms with a workshop (B-W2b-331; SCM-049; L. 192/1998 art. 2; design purchasing.subcontracting "Written
 * terms link (W2b)", record Documents "terms"; factory-db SubcontractAgreement, B-W2b-287). Office only: read with
 * purchasing.view over the agreement's company and workshop, written with purchasing.subcontract.terms. Every write is ONE
 * command on the agreement (its version bump holds the row) under the lock of its company and workshop
 * (`factory.subcontract-agreement|tenant|company|party`), so two revisions never take one number and two signatures never
 * meet.
 *
 *   write      a DRAFT revision (the next number of the company's revisions with the workshop), its title and days
 *   edit       a DRAFT's title, days and the signed file it will carry (a file of the revision or of the workshop)
 *   delete     a DRAFT only
 *   sign       DRAFT → SIGNED with when and its signed file; the revision in force is SUPERSEDED first in the same act
 *              (ended when the new one was signed); the signed file is then kept 10 years (c.c. art. 2220)
 *   end        SIGNED → TERMINATED with when and why
 *   order      GET …/orders/:id/terms: the revision that covered the order's date, or why none did, in words
 *
 * The signed file is uploaded through the files routes (record type SubcontractAgreement and the revision's id, or the
 * workshop's Party), then named here.
 */

const TEN_YEARS_MS = 3_652 * 86_400_000

export const AGREEMENT_COLUMNS = {
  id: true,
  companyId: true,
  partyId: true,
  revision: true,
  title: true,
  termsFileId: true,
  status: true,
  signedAt: true,
  validFrom: true,
  validUntil: true,
  endedAt: true,
  endReason: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.SubcontractAgreementSelect
type AgreementRow = Prisma.SubcontractAgreementGetPayload<{ select: typeof AGREEMENT_COLUMNS }>

export const factsOf = (row: AgreementRow): AgreementFacts => ({
  id: row.id,
  revision: row.revision,
  status: row.status as AgreementStatus,
  title: row.title,
  validFrom: dayOf(row.validFrom)!,
  validUntil: dayOf(row.validUntil),
  signedAt: row.signedAt,
  endedAt: row.endedAt,
  termsFileId: row.termsFileId,
})

/** The company's revisions with the workshop, newest first. */
export const agreementsOf = (db: Reader, companyId: string, partyId: string): Promise<AgreementRow[]> =>
  db.subcontractAgreement.findMany({ where: { companyId, partyId }, select: AGREEMENT_COLUMNS, orderBy: [{ revision: 'desc' }, { id: 'asc' }] })

const today = (): BusinessDate => businessDate(new Date())
const iso = (value: Date | null): string | null => (value ? toUtcIso(value) : null)
const scopeOf = (row: { companyId: string; partyId: string }) => ({ companyId: row.companyId, partyId: row.partyId })
const may = (context: OfficeContext, permission: typeof PURCHASING_VIEW | typeof PURCHASING_SUBCONTRACT_TERMS, row: { companyId: string; partyId: string }) => can(actorOf(context), permission, scopeOf(row))

async function lockTerms(tools: CommandTools, companyId: string, partyId: string): Promise<void> {
  await tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.subcontract-agreement', ${tenantOf(tools.context)}::text, ${companyId}::text, ${partyId}::text), 0))`
}

/** The agreements as the screens read them (company, workshop, signed file, in force today, what may be done and why not). */
async function agreementViews(db: Reader, context: OfficeContext, rows: readonly AgreementRow[]) {
  const companies = new Map((await db.company.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.companyId))] } }, select: { id: true, code: true, legalName: true, tradeName: true } })).map((row) => [row.id, row]))
  const parties = new Map((await db.party.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.partyId))] } }, select: { id: true, code: true, legalName: true, tradeName: true } })).map((row) => [row.id, row]))
  const files = new Map(
    (await db.storedFile.findMany({ where: { id: { in: rows.flatMap((row) => (row.termsFileId ? [row.termsFileId] : [])) } }, select: { id: true, originalName: true, contentType: true, status: true, availableAt: true } })).map((row) => [row.id, row]),
  )
  const day = today()
  const byPair = new Map<string, AgreementFacts[]>()
  for (const row of rows) byPair.set(`${row.companyId}|${row.partyId}`, [...(byPair.get(`${row.companyId}|${row.partyId}`) ?? []), factsOf(row)])
  return rows.map((row) => {
    const facts = factsOf(row)
    const inForce = inForceOn(byPair.get(`${row.companyId}|${row.partyId}`) ?? [], day)
    const writer = may(context, PURCHASING_SUBCONTRACT_TERMS, row)
    const noWriter = writer ? null : 'You may read these terms; writing them needs purchasing.subcontract.terms.'
    const company = companies.get(row.companyId)
    const party = parties.get(row.partyId)
    const file = row.termsFileId ? files.get(row.termsFileId) : undefined
    return {
      id: row.id,
      revision: row.revision,
      title: row.title,
      status: facts.status,
      company: { id: row.companyId, code: company?.code ?? '', name: company ? (company.tradeName ?? company.legalName) : '' },
      workshop: { id: row.partyId, code: party?.code ?? '', name: party ? nameOf(party) : '' },
      validFrom: facts.validFrom,
      validUntil: facts.validUntil,
      signedAt: iso(row.signedAt),
      endedAt: iso(row.endedAt),
      endReason: row.endReason,
      file: file ? { id: file.id, originalName: file.originalName, contentType: file.contentType, status: file.status, availableAt: iso(file.availableAt) } : null,
      inForceToday: inForce?.id === row.id,
      expiresInDays: inForce?.id === row.id ? expiresInDays(facts, day) : null,
      version: row.version,
      createdAt: toUtcIso(row.createdAt),
      updatedAt: toUtcIso(row.updatedAt),
      actions: {
        edit: noWriter ?? draftHeld(facts),
        delete: noWriter ?? draftHeld(facts),
        sign: noWriter ?? draftHeld(facts) ?? (row.termsFileId ? null : 'Attach the signed terms first (a file of this revision or of the workshop).'),
        terminate: noWriter ?? (facts.status === 'SIGNED' ? null : `Revision ${row.revision} is ${facts.status.toLowerCase()}: only the signed revision in force is ended.`),
      },
    }
  })
}
export type AgreementView = Awaited<ReturnType<typeof agreementViews>>[number]

/** The agreement the caller may see (purchasing.view, else 404) and act on with `permission` (else 403). */
async function readAgreement(caller: CommandCaller, agreementId: string, permission: typeof PURCHASING_VIEW | typeof PURCHASING_SUBCONTRACT_TERMS = PURCHASING_VIEW): Promise<{ context: OfficeContext; row: AgreementRow }> {
  const context = officeContextOf(caller)
  const row = isUuid(agreementId) ? await caller.withClient((client) => client.subcontractAgreement.findUnique({ where: { id: agreementId }, select: AGREEMENT_COLUMNS })) : null
  if (!row || !may(context, PURCHASING_VIEW, row)) throw new NotFoundError('Subcontract terms not found.')
  if (!may(context, permission, row)) throw new ForbiddenError()
  return { context, row }
}

const one = async (caller: CommandCaller, context: OfficeContext, id: string) =>
  caller.withClient(async (client) => (await agreementViews(client, context, [await client.subcontractAgreement.findUniqueOrThrow({ where: { id }, select: AGREEMENT_COLUMNS })]))[0]!)

export interface AgreementQuery {
  readonly partyId?: string | undefined
  readonly companyId?: string | undefined
  readonly status?: AgreementStatus | undefined
}

/** GET /purchasing/subcontracting/agreements — every revision the caller may see, by workshop and company, newest first. */
export async function listAgreements(caller: CommandCaller, query: AgreementQuery) {
  const context = officeContextOf(caller)
  return caller.withClient(async (client) => {
    const rows = await client.subcontractAgreement.findMany({
      where: {
        AND: [
          scopeWhere(actorOf(context), PURCHASING_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.SubcontractAgreementWhereInput,
          query.partyId ? { partyId: query.partyId } : {},
          query.companyId ? { companyId: query.companyId } : {},
          query.status ? { status: query.status } : {},
        ],
      },
      select: AGREEMENT_COLUMNS,
      orderBy: [{ partyId: 'asc' }, { companyId: 'asc' }, { revision: 'desc' }, { id: 'asc' }],
      take: 500,
    })
    return { items: await agreementViews(client, context, rows) }
  })
}

/** GET /purchasing/subcontracting/agreements/:agreementId */
export async function getAgreement(caller: CommandCaller, agreementId: string) {
  const { context, row } = await readAgreement(caller, agreementId)
  return { agreement: await one(caller, context, row.id) }
}

export interface CreateAgreementInput {
  readonly companyId: string
  readonly partyId: string
  readonly title: string
  readonly validFrom: BusinessDate
  readonly validUntil?: BusinessDate | null | undefined
  readonly termsFileId?: string | null | undefined
}

const refuse = (problems: readonly Issue[]) => new ValidationError(problems.length === 1 ? problems[0]!.message : 'The terms are not valid as they stand.', problems)

/** POST /purchasing/subcontracting/agreements — a DRAFT revision of the company's terms with the workshop. */
export async function createAgreement(caller: CommandCaller, input: CreateAgreementInput, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const scope = { companyId: input.companyId, partyId: input.partyId }
  if (!may(context, PURCHASING_VIEW, scope)) throw new NotFoundError('Workshop not found.')
  if (!may(context, PURCHASING_SUBCONTRACT_TERMS, scope)) throw new ForbiddenError()
  const problems = draftProblems({ title: input.title, validFrom: input.validFrom, validUntil: input.validUntil ?? null })
  if (problems.length > 0) throw refuse(problems)
  const id = newId()
  await inWords(() =>
    command(caller, { name: 'purchasing.subcontract.terms.write', idempotencyKey, input }, async (tools) => {
      const { tx } = tools
      const company = await tx.company.findUnique({ where: { id: input.companyId }, select: { id: true } })
      if (!company) throw refuse([{ path: 'body/companyId', message: 'Not a company of this business.' }])
      const party = await tx.party.findUnique({ where: { id: input.partyId }, select: { id: true, companyId: true, roles: true, status: true, legalName: true, tradeName: true } })
      if (!party || (party.companyId !== null && party.companyId !== input.companyId)) throw refuse([{ path: 'body/partyId', message: 'Not a workshop of the company.' }])
      if (!party.roles.includes('SUBCONTRACTOR')) throw refuse([{ path: 'body/partyId', message: `${nameOf(party)} is no subcontractor: give it the SUBCONTRACTOR role first.` }])
      if (party.status === 'ARCHIVED') throw refuse([{ path: 'body/partyId', message: `${nameOf(party)} is archived.` }])
      await lockTerms(tools, input.companyId, input.partyId)
      const revision = nextRevision(await agreementsOf(tx, input.companyId, input.partyId))
      await tx.subcontractAgreement.create({
        data: {
          id,
          companyId: input.companyId,
          partyId: input.partyId,
          revision,
          title: input.title.trim(),
          termsFileId: input.termsFileId ?? null,
          validFrom: dayValue(input.validFrom),
          validUntil: input.validUntil ? dayValue(input.validUntil) : null,
          createdAt: tools.now,
          updatedAt: tools.now,
          createdById: context.actorId,
        },
        select: { id: true },
      })
      tools.audit({ action: 'purchasing.subcontract.terms.write', recordType: 'SubcontractAgreement', recordId: id, companyId: input.companyId, after: { revision, title: input.title.trim(), validFrom: input.validFrom, validUntil: input.validUntil ?? null, termsFileId: input.termsFileId ?? null, partyId: input.partyId } })
      tools.emit({ type: 'subcontract_agreement.changed', subject: id, companyId: input.companyId, payload: { agreementId: id, partyId: input.partyId, revision, status: 'DRAFT', change: 'WRITTEN', supersededId: null } })
      return { id }
    }),
  )
  return { agreement: await one(caller, context, id) }
}

export interface UpdateAgreementInput {
  readonly version: number
  readonly title?: string | undefined
  readonly validFrom?: BusinessDate | undefined
  readonly validUntil?: BusinessDate | null | undefined
  readonly termsFileId?: string | null | undefined
}

/** PATCH /purchasing/subcontracting/agreements/:agreementId — a DRAFT's title, days and the signed file it will carry. */
export async function updateAgreement(caller: CommandCaller, agreementId: string, input: UpdateAgreementInput, idempotencyKey?: string) {
  const { context, row } = await readAgreement(caller, agreementId, PURCHASING_SUBCONTRACT_TERMS)
  await inWords(() =>
    command(caller, { name: 'purchasing.subcontract.terms.edit', idempotencyKey, input: { agreementId, ...input }, record: { type: 'SubcontractAgreement', id: agreementId, expectedVersion: input.version } }, async (tools) => {
      const before = (await tools.tx.subcontractAgreement.findUniqueOrThrow({ where: { id: agreementId }, select: AGREEMENT_COLUMNS }))!
      const held = draftHeld(factsOf(before))
      if (held) throw new ConflictError(held)
      const validFrom = input.validFrom ?? dayOf(before.validFrom)!
      const validUntil = input.validUntil !== undefined ? input.validUntil : dayOf(before.validUntil)
      const problems = draftProblems({ title: input.title, validFrom, validUntil })
      if (problems.length > 0) throw refuse(problems)
      const data = {
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(input.validFrom !== undefined ? { validFrom: dayValue(input.validFrom) } : {}),
        ...(input.validUntil !== undefined ? { validUntil: input.validUntil ? dayValue(input.validUntil) : null } : {}),
        ...(input.termsFileId !== undefined ? { termsFileId: input.termsFileId } : {}),
      }
      await tools.tx.subcontractAgreement.update({ where: { id: agreementId }, data: { ...data, updatedAt: tools.now }, select: { id: true } })
      tools.audit({
        action: 'purchasing.subcontract.terms.edit',
        recordType: 'SubcontractAgreement',
        recordId: agreementId,
        companyId: row.companyId,
        before: { title: before.title, validFrom: dayOf(before.validFrom), validUntil: dayOf(before.validUntil), termsFileId: before.termsFileId },
        after: { title: input.title?.trim() ?? before.title, validFrom, validUntil, termsFileId: input.termsFileId !== undefined ? input.termsFileId : before.termsFileId },
      })
      tools.emit({ type: 'subcontract_agreement.changed', subject: agreementId, companyId: row.companyId, payload: { agreementId, partyId: row.partyId, revision: row.revision, status: 'DRAFT', change: 'EDITED', supersededId: null } })
      return { id: agreementId }
    }),
  )
  return { agreement: await one(caller, context, agreementId) }
}

/** DELETE /purchasing/subcontracting/agreements/:agreementId?version= — a DRAFT only. */
export async function deleteAgreement(caller: CommandCaller, agreementId: string, query: { readonly version: number }, idempotencyKey?: string) {
  const { row } = await readAgreement(caller, agreementId, PURCHASING_SUBCONTRACT_TERMS)
  await inWords(() =>
    command(caller, { name: 'purchasing.subcontract.terms.delete', idempotencyKey, input: { agreementId, version: query.version }, record: { type: 'SubcontractAgreement', id: agreementId, expectedVersion: query.version } }, async (tools) => {
      const before = await tools.tx.subcontractAgreement.findUniqueOrThrow({ where: { id: agreementId }, select: AGREEMENT_COLUMNS })
      const held = draftHeld(factsOf(before))
      if (held) throw new ConflictError(held)
      await tools.tx.subcontractAgreement.delete({ where: { id: agreementId }, select: { id: true } })
      tools.audit({ action: 'purchasing.subcontract.terms.delete', recordType: 'SubcontractAgreement', recordId: agreementId, companyId: row.companyId, before: { revision: before.revision, title: before.title, status: before.status } })
      tools.emit({ type: 'subcontract_agreement.changed', subject: agreementId, companyId: row.companyId, payload: { agreementId, partyId: row.partyId, revision: row.revision, status: 'DRAFT', change: 'DELETED', supersededId: null } })
      return { id: agreementId }
    }),
  )
  return { deleted: agreementId }
}

export interface SignInput {
  readonly version: number
  readonly signedAt?: string | undefined
  readonly termsFileId?: string | undefined
}

/**
 * POST /purchasing/subcontracting/agreements/:agreementId/sign — DRAFT → SIGNED with its signed file; the revision in force
 * for the company and workshop is SUPERSEDED first in the same command (ended when this one was signed).
 */
export async function signAgreement(caller: CommandCaller, agreementId: string, input: SignInput, idempotencyKey?: string) {
  const { context, row } = await readAgreement(caller, agreementId, PURCHASING_SUBCONTRACT_TERMS)
  await inWords(() =>
    command(caller, { name: 'purchasing.subcontract.terms.sign', idempotencyKey, input: { agreementId, ...input }, record: { type: 'SubcontractAgreement', id: agreementId, expectedVersion: input.version } }, async (tools) => {
      const { tx, now } = tools
      await lockTerms(tools, row.companyId, row.partyId)
      const before = await tx.subcontractAgreement.findUniqueOrThrow({ where: { id: agreementId }, select: AGREEMENT_COLUMNS })
      const signedAt = input.signedAt ? parseInstant(input.signedAt)! : now
      const fileId = input.termsFileId ?? before.termsFileId
      const file = fileId ? await tx.storedFile.findUnique({ where: { id: fileId }, select: { status: true, companyId: true, recordType: true, recordId: true } }) : null
      const problems = signProblems(factsOf(before), signedAt, { file, companyId: row.companyId, partyId: row.partyId }, now)
      if (problems[0]?.path === 'body/version') throw new ConflictError(problems[0].message)
      const current = (await agreementsOf(tx, row.companyId, row.partyId)).find((other) => other.status === 'SIGNED' && other.id !== agreementId)
      if (current?.signedAt && signedAt.getTime() < current.signedAt.getTime()) {
        problems.push({ path: 'body/signedAt', message: `Revision ${current.revision} in force was signed on ${businessDate(current.signedAt)}: this one is signed after it.` })
      }
      if (problems.length > 0) throw refuse(problems)
      if (current) {
        await tx.subcontractAgreement.update({
          where: { id: current.id },
          data: { status: 'SUPERSEDED', endedAt: signedAt, endReason: supersededReason(before.revision, before.title), version: { increment: 1 }, updatedAt: now },
          select: { id: true },
        })
        tools.audit({ action: 'purchasing.subcontract.terms.supersede', recordType: 'SubcontractAgreement', recordId: current.id, companyId: row.companyId, before: { status: 'SIGNED' }, after: { status: 'SUPERSEDED', endedAt: toUtcIso(signedAt), byRevision: before.revision } })
        tools.emit({ type: 'subcontract_agreement.changed', subject: current.id, companyId: row.companyId, payload: { agreementId: current.id, partyId: row.partyId, revision: current.revision, status: 'SUPERSEDED', change: 'ENDED', supersededId: null } })
      }
      await tx.subcontractAgreement.update({ where: { id: agreementId }, data: { status: 'SIGNED', signedAt, termsFileId: fileId!, updatedAt: now }, select: { id: true } })
      // The signed terms are kept ten years (c.c. art. 2220): the file cannot be deleted before.
      await retainFilesInCommand(tools, [fileId!], new Date(signedAt.getTime() + TEN_YEARS_MS), `Signed subcontract terms, revision ${before.revision} (${LAW}), kept ten years.`)
      tools.audit({
        action: 'purchasing.subcontract.terms.sign',
        recordType: 'SubcontractAgreement',
        recordId: agreementId,
        companyId: row.companyId,
        before: { status: 'DRAFT' },
        after: { status: 'SIGNED', signedAt: toUtcIso(signedAt), termsFileId: fileId, supersededId: current?.id ?? null },
      })
      tools.emit({ type: 'subcontract_agreement.changed', subject: agreementId, companyId: row.companyId, payload: { agreementId, partyId: row.partyId, revision: before.revision, status: 'SIGNED', change: 'SIGNED', supersededId: current?.id ?? null } })
      return { id: agreementId, supersededId: current?.id ?? null }
    }),
  )
  return { agreement: await one(caller, context, agreementId) }
}

export interface TerminateInput {
  readonly version: number
  readonly endedAt?: string | undefined
  readonly reason: string
}

/** POST /purchasing/subcontracting/agreements/:agreementId/terminate — SIGNED → TERMINATED with when and why. */
export async function terminateAgreement(caller: CommandCaller, agreementId: string, input: TerminateInput, idempotencyKey?: string) {
  const { context, row } = await readAgreement(caller, agreementId, PURCHASING_SUBCONTRACT_TERMS)
  await inWords(() =>
    command(caller, { name: 'purchasing.subcontract.terms.end', idempotencyKey, input: { agreementId, ...input }, record: { type: 'SubcontractAgreement', id: agreementId, expectedVersion: input.version } }, async (tools) => {
      const before = await tools.tx.subcontractAgreement.findUniqueOrThrow({ where: { id: agreementId }, select: AGREEMENT_COLUMNS })
      const endedAt = input.endedAt ? parseInstant(input.endedAt)! : tools.now
      const problems = terminateProblems(factsOf(before), endedAt, input.reason, tools.now)
      if (problems.length > 0) {
        if (problems[0]!.path === 'body/version') throw new ConflictError(problems[0]!.message)
        throw refuse(problems)
      }
      await tools.tx.subcontractAgreement.update({ where: { id: agreementId }, data: { status: 'TERMINATED', endedAt, endReason: input.reason.trim(), updatedAt: tools.now }, select: { id: true } })
      tools.audit({ action: 'purchasing.subcontract.terms.end', recordType: 'SubcontractAgreement', recordId: agreementId, companyId: row.companyId, before: { status: 'SIGNED' }, after: { status: 'TERMINATED', endedAt: toUtcIso(endedAt) }, reason: input.reason.trim() })
      tools.emit({ type: 'subcontract_agreement.changed', subject: agreementId, companyId: row.companyId, payload: { agreementId, partyId: row.partyId, revision: before.revision, status: 'TERMINATED', change: 'ENDED', supersededId: null } })
      return { id: agreementId }
    }),
  )
  return { agreement: await one(caller, context, agreementId) }
}

/**
 * GET /purchasing/subcontracting/orders/:subcontractOrderId/terms — the written terms that covered the order (the signed
 * revision of its company and workshop whose days hold the order's date), the revisions with the workshop, or why none
 * covered it, in words.
 */
export async function orderTerms(caller: CommandCaller, orderId: string) {
  const { context, order } = await officeOrder(caller, orderId)
  return caller.withClient(async (client) => {
    const party = await client.party.findUnique({ where: { id: order.partyId }, select: { legalName: true, tradeName: true } })
    const rows = may(context, PURCHASING_VIEW, { companyId: order.companyId, partyId: order.partyId }) ? await agreementsOf(client, order.companyId, order.partyId) : []
    const day = dayOf(order.orderDate)!
    const facts = rows.map(factsOf)
    const covering = inForceOn(facts, day)
    const views = await agreementViews(client, context, rows)
    return {
      order: { id: order.id, number: order.number, orderDate: day, companyId: order.companyId, workshop: { id: order.partyId, name: party ? nameOf(party) : '' } },
      covering: covering ? views.find((view) => view.id === covering.id)! : null,
      words: termsWords(facts, day, party ? nameOf(party) : 'the workshop'),
      law: LAW,
      revisions: views,
    }
  })
}
