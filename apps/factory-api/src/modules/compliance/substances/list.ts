import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { SUBSTANCES_MANAGE } from '@nexus/factory-domain/compliance/substances/permissions'
import { substanceProblems, SUBSTANCE_LIMITS, type SubstanceList, type SubstanceStatus } from '@nexus/factory-domain/compliance/substances/rules'
import { NPE_FAMILY, REACH_URL, STARTER_RULES, STARTER_SUBSTANCES } from '@nexus/factory-domain/compliance/substances/starter'
import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { runCommand, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import { assertMayKeep, mayReadCompany, officeOf } from '../register-of-rules/common'
import { substanceReach, substancesClock, substancesGuarded, substancesSettings } from './common'
import { RULE_SELECT, SUBSTANCE_SELECT, substanceView, versionsById, type Reader, type SubstanceRow, type SubstanceView } from './store'

/**
 * The restricted substance list (B-W2b-250; PRD-318; design compliance.tests › Substance list): the substances with their
 * CAS and EC numbers, the lists they are on, the Annex XVII entries and the Candidate List version that added them, and
 * per substance the rules that restrict it (the design's Limit, Unit, Material scope, Test method and Source). Reading
 * needs compliance.certificates.view (tenant-wide rows and those of the companies it reaches); keeping it needs
 * compliance.substances.manage over the row's company (a tenant-wide row: every company). Each write is ONE command with
 * its audit row and `compliance_substances.substance_changed`. A substance is archived, never deleted; one ACTIVE row per
 * CAS number; its CAS and EC numbers are given once (a wrong one: archive it and add the right one).
 *
 * The starter list (POST …/starter, the empty state's "Load the starter list") adds what is missing of factory-domain's
 * STARTER_SUBSTANCES and STARTER_RULES, tenant-wide, in one command.
 */

const WHAT = 'A substance'

export interface ListQuery {
  readonly list?: SubstanceList | undefined
  readonly group?: string | undefined
  readonly status?: SubstanceStatus | 'ALL' | undefined
  readonly q?: string | undefined
}

/** GET /compliance/substances */
export async function listSubstances(request: FastifyRequest, query: ListQuery) {
  const actor = actorOf(officeOf(request))
  const filters: Prisma.RestrictedSubstanceWhereInput[] = [substanceReach(actor) as Prisma.RestrictedSubstanceWhereInput]
  const status = query.status ?? 'ACTIVE'
  if (status !== 'ALL') filters.push({ status })
  if (query.list) filters.push({ lists: { has: query.list } })
  if (query.group) filters.push({ groupCode: query.group })
  if (query.q) {
    filters.push({
      OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { casNumber: { contains: query.q } }, { ecNumber: { contains: query.q } }, { groupCode: { contains: query.q.toUpperCase() } }],
    })
  }
  return request.withClient(async (db) => {
    const rows = await db.restrictedSubstance.findMany({ where: { AND: filters }, select: SUBSTANCE_SELECT, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: SUBSTANCE_LIMITS.list + 1 })
    const rules = await db.substanceRule.findMany({ where: { status: 'ACTIVE' }, select: RULE_SELECT, orderBy: [{ key: 'asc' }] })
    const versions = await versionsById(db)
    return {
      substances: rows.slice(0, SUBSTANCE_LIMITS.list).map((row) => substanceView(row, rules, versions)),
      more: rows.length > SUBSTANCE_LIMITS.list,
      asOf: toUtcIso(substancesClock().now()),
      mayManage: mayWrite(actor, SUBSTANCES_MANAGE, null),
    }
  })
}

async function readSubstance(db: Reader, request: CommandCaller, substanceId: string): Promise<SubstanceRow> {
  const row = isUuid(substanceId) ? await db.restrictedSubstance.findUnique({ where: { id: substanceId }, select: SUBSTANCE_SELECT }) : null
  if (!row || !mayReadCompany(actorOf(officeOf(request)), row.companyId)) throw new NotFoundError('There is no such substance on the list.')
  return row
}

/** GET /compliance/substances/:substanceId — the substance, every rule that restricts it (archived ones too) and the declaration lines naming it. */
export async function getSubstance(request: FastifyRequest, substanceId: string) {
  return request.withClient(async (db) => {
    const row = await readSubstance(db, request, substanceId)
    const rules = await db.substanceRule.findMany({ where: { OR: [{ substanceId }, ...(row.groupCode ? [{ substanceGroup: row.groupCode }] : [])] }, select: RULE_SELECT, orderBy: [{ key: 'asc' }] })
    const declarations = await db.supplierDeclarationLine.count({ where: { substanceId } })
    return { substance: substanceView(row, rules, await versionsById(db)), declarationLines: declarations, asOf: toUtcIso(substancesClock().now()) }
  })
}

const auditOf = (row: SubstanceRow) => ({
  companyId: row.companyId,
  casNumber: row.casNumber,
  ecNumber: row.ecNumber,
  name: row.name,
  groupCode: row.groupCode,
  lists: [...row.lists],
  annexXviiEntries: [...row.annexXviiEntries],
  svhcListVersionId: row.svhcListVersionId,
  note: row.note,
  status: row.status,
})

function check(issues: ReturnType<typeof substanceProblems>): void {
  if (issues.length > 0) throw new ValidationError('The substance is not valid.', issues)
}

/** The ACTIVE substance that already has this CAS number, or this family's name (no CAS), other than `except`. */
async function twinOf(tx: CommandTx, fields: { readonly casNumber: string | null; readonly name: string }, except: string | null): Promise<SubstanceRow | null> {
  const where: Prisma.RestrictedSubstanceWhereInput = fields.casNumber
    ? { casNumber: fields.casNumber, status: 'ACTIVE' }
    : { casNumber: null, name: { equals: fields.name, mode: 'insensitive' }, status: 'ACTIVE' }
  return tx.restrictedSubstance.findFirst({ where: { AND: [where, ...(except ? [{ id: { not: except } }] : [])] }, select: SUBSTANCE_SELECT })
}

const twinWords = (twin: SubstanceRow) => (twin.casNumber ? `CAS ${twin.casNumber} is on the list already (${twin.name}): edit that substance.` : `The family ${twin.name} is on the list already: edit it.`)

async function assertVersion(tx: CommandTx, versionId: string | null | undefined): Promise<void> {
  if (versionId && !(await tx.svhcListVersion.findUnique({ where: { id: versionId }, select: { id: true } }))) {
    throw new ValidationError('The substance is not valid.', [{ path: 'body/svhcListVersionId', message: 'Name a Candidate List version that is recorded (record it first).' }])
  }
}

export interface CreateBody {
  readonly companyId?: string | null | undefined
  readonly casNumber?: string | null | undefined
  readonly ecNumber?: string | null | undefined
  readonly name: string
  readonly nameI18n?: Record<string, string> | null | undefined
  readonly groupCode?: string | null | undefined
  readonly lists: readonly SubstanceList[]
  readonly annexXviiEntries?: readonly string[] | undefined
  readonly svhcListVersionId?: string | null | undefined
  readonly note?: string | null | undefined
}

/** POST /compliance/substances */
export async function createSubstance(caller: CommandCaller, body: CreateBody, key: string | null | undefined): Promise<{ substance: SubstanceView }> {
  const context = officeOf(caller)
  const companyId = body.companyId ?? null
  assertMayKeep(context, SUBSTANCES_MANAGE, companyId, WHAT)
  const fields = {
    casNumber: body.casNumber ?? null,
    ecNumber: body.ecNumber ?? null,
    name: body.name,
    nameI18n: body.nameI18n ?? null,
    groupCode: body.groupCode ?? null,
    lists: [...body.lists],
    annexXviiEntries: [...(body.annexXviiEntries ?? [])],
    svhcListVersionId: body.svhcListVersionId ?? null,
    note: body.note ?? null,
  }
  check(substanceProblems(fields))
  const { result } = await substancesGuarded(
    () =>
      runCommand(
        caller,
        { name: 'compliance.substances.create', idempotencyKey: key, input: body },
        async ({ tx, now, audit, emit }) => {
          const twin = await twinOf(tx, fields, null)
          if (twin) throw new ConflictError(twinWords(twin))
          await assertVersion(tx, fields.svhcListVersionId)
          const id = newId()
          const row = await tx.restrictedSubstance.create({
            data: { id, companyId, ...fields, nameI18n: fields.nameI18n ?? undefined, createdAt: now, updatedAt: now, createdById: context.actorId },
            select: SUBSTANCE_SELECT,
          })
          audit({ recordType: 'RestrictedSubstance', recordId: id, companyId, after: auditOf(row) })
          emit({ type: 'compliance_substances.substance_changed', subject: id, companyId, payload: { substanceId: id, casNumber: row.casNumber, groupCode: row.groupCode, change: 'CREATED', by: 'PERSON' } })
          const rules = await tx.substanceRule.findMany({ where: { status: 'ACTIVE' }, select: RULE_SELECT })
          return { substance: substanceView(row, rules, await versionsById(tx)) }
        },
        substancesSettings(),
      ),
    { taken: fields.casNumber ? `CAS ${fields.casNumber} is on the list already: edit that substance.` : undefined },
  )
  return result
}

export interface EditBody {
  readonly version: number
  readonly casNumber?: string | null | undefined
  readonly ecNumber?: string | null | undefined
  readonly name?: string | undefined
  readonly nameI18n?: Record<string, string> | null | undefined
  readonly groupCode?: string | null | undefined
  readonly lists?: readonly SubstanceList[] | undefined
  readonly annexXviiEntries?: readonly string[] | undefined
  readonly svhcListVersionId?: string | null | undefined
  readonly note?: string | null | undefined
  readonly status?: SubstanceStatus | undefined
}

/** PATCH /compliance/substances/:substanceId — edit, archive (status ARCHIVED) or restore (ACTIVE). */
export async function editSubstance(caller: CommandCaller, substanceId: string, body: EditBody, key: string | null | undefined): Promise<{ substance: SubstanceView }> {
  const context = officeOf(caller)
  const current = await caller.withClient((db) => readSubstance(db, caller, substanceId))
  assertMayKeep(context, SUBSTANCES_MANAGE, current.companyId, WHAT)
  const { result } = await substancesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.substances.edit', idempotencyKey: key, input: { substanceId, ...body }, record: { type: 'RestrictedSubstance', id: substanceId, expectedVersion: body.version } },
      async ({ tx, now, audit, emit }) => {
        const before = await tx.restrictedSubstance.findUniqueOrThrow({ where: { id: substanceId }, select: SUBSTANCE_SELECT })
        const given = <K extends keyof EditBody>(name: K) => body[name] !== undefined
        if (given('casNumber') && before.casNumber !== null && body.casNumber !== before.casNumber) {
          throw new ConflictError(`The CAS number of ${before.name} is given once (${before.casNumber}): archive it and add the right one.`)
        }
        if (given('ecNumber') && before.ecNumber !== null && body.ecNumber !== before.ecNumber) {
          throw new ConflictError(`The EC number of ${before.name} is given once (${before.ecNumber}): archive it and add the right one.`)
        }
        const next = {
          casNumber: given('casNumber') ? (body.casNumber ?? null) : before.casNumber,
          ecNumber: given('ecNumber') ? (body.ecNumber ?? null) : before.ecNumber,
          name: body.name ?? before.name,
          nameI18n: given('nameI18n') ? (body.nameI18n ?? null) : (before.nameI18n as Record<string, string> | null),
          groupCode: given('groupCode') ? (body.groupCode ?? null) : before.groupCode,
          lists: body.lists ? [...body.lists] : ([...before.lists] as SubstanceList[]),
          annexXviiEntries: body.annexXviiEntries ? [...body.annexXviiEntries] : [...before.annexXviiEntries],
          svhcListVersionId: given('svhcListVersionId') ? (body.svhcListVersionId ?? null) : before.svhcListVersionId,
          note: given('note') ? (body.note ?? null) : before.note,
        }
        check(substanceProblems(next))
        const status = body.status ?? (before.status as SubstanceStatus)
        if (status === 'ACTIVE') {
          const twin = await twinOf(tx, next, substanceId)
          if (twin) throw new ConflictError(twinWords(twin))
        }
        if (given('svhcListVersionId')) await assertVersion(tx, next.svhcListVersionId)
        // A JSON column is cleared to the database's NULL by its own statement (Prisma would write a JSON null).
        if (next.nameI18n === null && before.nameI18n !== null) await tx.$executeRaw`UPDATE "RestrictedSubstance" SET "nameI18n" = NULL WHERE "id" = ${substanceId}::uuid`
        const { nameI18n, ...columns } = next
        const row = await tx.restrictedSubstance.update({
          where: { id: substanceId },
          data: { ...columns, ...(nameI18n !== null ? { nameI18n } : {}), status, updatedAt: now },
          select: SUBSTANCE_SELECT,
        })
        const change = status !== before.status ? (status === 'ARCHIVED' ? 'ARCHIVED' : 'RESTORED') : 'EDITED'
        audit({ recordType: 'RestrictedSubstance', recordId: substanceId, companyId: row.companyId, before: auditOf(before), after: auditOf(row) })
        emit({ type: 'compliance_substances.substance_changed', subject: substanceId, companyId: row.companyId, payload: { substanceId, casNumber: row.casNumber, groupCode: row.groupCode, change, by: 'PERSON' } })
        const rules = await tx.substanceRule.findMany({ where: { status: 'ACTIVE' }, select: RULE_SELECT })
        return { substance: substanceView(row, rules, await versionsById(tx)) }
      },
      substancesSettings(),
    ),
    { taken: 'Another ACTIVE substance has this CAS number: archive one of them first.' },
  )
  return result
}

/**
 * POST /compliance/substances/starter — loads what is missing of the starter list, tenant-wide, in one command: a
 * substance by its CAS number (a family by its name) among the ACTIVE ones, a rule by its key (whatever its state: a rule
 * a person archived stays archived). Entry 72 and the PFAS screening come in switched off with the Owner's reason.
 */
export async function loadStarter(caller: CommandCaller, key: string | null | undefined) {
  const context = officeOf(caller)
  assertMayKeep(context, SUBSTANCES_MANAGE, null, 'The starter list')
  const { result } = await substancesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.substances.loadStarter', idempotencyKey: key, input: { starter: 'REACH Annex XVII' } },
      async ({ tx, now, audit, emit }) => {
        const addedSubstances: string[] = []
        const byCas = new Map<string, string>()
        let npe: string | null = null
        for (const starter of STARTER_SUBSTANCES) {
          const twin = await twinOf(tx, { casNumber: starter.casNumber, name: starter.name }, null)
          if (twin) {
            // A company's own row stays its own: a tenant-wide starter rule names only a tenant-wide substance.
            if (twin.companyId === null && starter.casNumber) byCas.set(starter.casNumber, twin.id)
            if (twin.companyId === null && starter.name === NPE_FAMILY) npe = twin.id
            continue
          }
          const id = newId()
          const row = await tx.restrictedSubstance.create({
            data: {
              id,
              companyId: null,
              casNumber: starter.casNumber,
              ecNumber: starter.ecNumber,
              name: starter.name,
              groupCode: starter.groupCode,
              lists: [...starter.lists],
              annexXviiEntries: [...starter.annexXviiEntries],
              note: starter.note,
              createdAt: now,
              updatedAt: now,
              createdById: context.actorId,
            },
            select: SUBSTANCE_SELECT,
          })
          if (starter.casNumber) byCas.set(starter.casNumber, id)
          if (starter.name === NPE_FAMILY) npe = id
          addedSubstances.push(starter.casNumber ?? starter.name)
          audit({ action: 'compliance.substances.loadStarter', recordType: 'RestrictedSubstance', recordId: id, companyId: null, after: auditOf(row) })
          emit({ type: 'compliance_substances.substance_changed', subject: id, companyId: null, payload: { substanceId: id, casNumber: row.casNumber, groupCode: row.groupCode, change: 'CREATED', by: 'STARTER' } })
        }
        const addedRules: string[] = []
        for (const starter of STARTER_RULES) {
          if (await tx.substanceRule.findFirst({ where: { key: starter.key }, select: { id: true } })) continue
          const substanceId = starter.substance === null ? null : 'cas' in starter.substance ? (byCas.get(starter.substance.cas) ?? null) : npe
          if (starter.substance !== null && substanceId === null) continue
          const id = newId()
          const off = starter.offReason !== null
          await tx.substanceRule.create({
            data: {
              id,
              companyId: null,
              key: starter.key,
              code: starter.code,
              name: starter.name,
              substanceId,
              substanceGroup: starter.substanceGroup,
              materialKinds: [...starter.materialKinds],
              scopeNote: starter.scopeNote,
              limitValue: starter.limitValue,
              limitUnit: starter.limitUnit,
              limitBound: starter.limitBound,
              testMethod: starter.testMethod,
              evidence: starter.evidence,
              exemptPpe: starter.exemptPpe,
              exemptNaturalLeather: starter.exemptNaturalLeather,
              source: 'LAW',
              legalReference: starter.legalReference,
              legalUrl: REACH_URL,
              switchedOn: !off,
              offReason: starter.offReason,
              ...(off ? { switchedAt: now, switchedById: context.actorId } : {}),
              createdAt: now,
              updatedAt: now,
              createdById: context.actorId,
            },
            select: { id: true },
          })
          addedRules.push(starter.key)
          audit({
            action: 'compliance.substances.loadStarter',
            recordType: 'SubstanceRule',
            recordId: id,
            companyId: null,
            after: { key: starter.key, code: starter.code, substanceId, substanceGroup: starter.substanceGroup, limitValue: starter.limitValue, limitUnit: starter.limitUnit, limitBound: starter.limitBound, switchedOn: !off, offReason: starter.offReason },
          })
          emit({ type: 'compliance_substances.rule_changed', subject: id, companyId: null, payload: { ruleId: id, key: starter.key, code: starter.code, switchedOn: !off, change: 'CREATED', by: 'STARTER' } })
        }
        if (addedSubstances.length === 0 && addedRules.length === 0) {
          // Every command records an audit row: loading a list that is complete is recorded too.
          audit({ action: 'compliance.substances.loadStarter', recordType: 'Tenant', recordId: context.tenantId, companyId: null, after: { added: 0 } })
        }
        return {
          substances: { added: addedSubstances.length, kept: STARTER_SUBSTANCES.length - addedSubstances.length },
          rules: { added: addedRules.length, kept: STARTER_RULES.length - addedRules.length },
          addedSubstances,
          addedRules,
        }
      },
      substancesSettings(),
    ),
  )
  return result
}
