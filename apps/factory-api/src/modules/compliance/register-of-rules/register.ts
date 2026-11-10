import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { RULES_MANAGE } from '@nexus/factory-domain/compliance/register-of-rules/permissions'
import { entryProblems, namesEntry, raisedKind, standardLabel, type RegulationKind, type RegulationStatus } from '@nexus/factory-domain/compliance/register-of-rules/rules'
import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { COMMAND_SETTINGS, runCommand, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import { assertMayKeep, officeOf, rulesClock, rulesGuarded } from './common'
import type { ChangeView, EntryView } from './contract'
import { CERTIFICATE_REF, CHANGE_SELECT, changeViews, citing, ENTRY_SELECT, entryViews, stylesCovered, todayOf, visibleCertificates, type EntryRow } from './store'
import { raiseChangeInCommand } from './watch'

/**
 * The register of laws and standards in use (B-W2b-249; PRD-273; design compliance.settings › rm-regs): one entry per
 * edition, its Official Journal citation, its status and what cites it. Reading needs compliance.certificates.view (any
 * grant: the register is the tenant's); keeping it needs compliance.rules.manage over every company. Each write is ONE
 * command with its audit row and `compliance_rules.standard_changed`.
 *
 * Moving an entry to SUPERSEDED (a new edition took over) or WITHDRAWN raises a change in the same command (the watch,
 * watch.ts) naming the registered certificates that cite it — unless a change of the entry is still open, which covers
 * it. A row typed by mistake is removed while nothing names it (a certificate typing it, a change, a requirement, a
 * successor): refused in words otherwise.
 */

const WHAT = 'The register of laws and standards'

export interface ListQuery {
  readonly kind?: RegulationKind | undefined
  readonly status?: RegulationStatus | undefined
  readonly q?: string | undefined
}

/** GET /compliance/rules/standards */
export async function listEntries(request: FastifyRequest, query: ListQuery) {
  const context = officeOf(request)
  const actor = actorOf(context)
  const filters: Prisma.RegulationOrStandardWhereInput[] = []
  if (query.kind) filters.push({ kind: query.kind })
  if (query.status) filters.push({ status: query.status })
  if (query.q) filters.push({ OR: [{ code: { contains: query.q, mode: 'insensitive' } }, { title: { contains: query.q, mode: 'insensitive' } }, { edition: { contains: query.q, mode: 'insensitive' } }] })
  const entries = await request.withClient(async (db) => {
    const rows = await db.regulationOrStandard.findMany({ where: { AND: filters }, select: ENTRY_SELECT, orderBy: [{ kind: 'asc' }, { code: 'asc' }, { edition: 'asc' }, { id: 'asc' }] })
    return entryViews(db, rows, actor)
  })
  return { entries, asOf: toUtcIso(rulesClock().now()), mayManage: mayWrite(actor, RULES_MANAGE, null) }
}

/** GET /compliance/rules/standards/:standardId */
export async function getEntry(request: FastifyRequest, standardId: string) {
  const context = officeOf(request)
  const actor = actorOf(context)
  const now = rulesClock().now()
  return request.withClient(async (db) => {
    const row = await db.regulationOrStandard.findUnique({ where: { id: standardId }, select: ENTRY_SELECT })
    if (!row) throw new NotFoundError('There is no such entry in the register.')
    const [entry] = await entryViews(db, [row], actor)
    const certificates = citing(await visibleCertificates(db, actor), row)
    const styles = await stylesCovered(db, certificates.map((certificate) => certificate.id))
    const supersedes = await db.regulationOrStandard.findMany({ where: { supersededById: standardId }, select: { id: true, code: true, edition: true }, orderBy: [{ code: 'asc' }, { edition: 'asc' }] })
    const changes = await db.standardChange.findMany({ where: { OR: [{ standardId }, { newStandardId: standardId }] }, select: CHANGE_SELECT, orderBy: [{ noticedAt: 'desc' }, { id: 'desc' }] })
    return {
      entry: entry!,
      certificates: certificates.map((certificate) => ({
        id: certificate.id,
        number: certificate.number,
        standard: certificate.standard,
        status: certificate.status,
        validTo: certificate.validTo.toISOString().slice(0, 10),
        companyId: certificate.companyId,
        holderPartyId: certificate.holderPartyId,
        styles: styles.get(certificate.id)?.length ?? 0,
      })),
      supersedes: supersedes.map((other) => ({ id: other.id, label: standardLabel(other.code, other.edition) })),
      changes: await changeViews(db, changes, todayOf(now)),
      asOf: toUtcIso(now),
    }
  })
}

const auditOf = (row: Pick<EntryRow, 'code' | 'edition' | 'title' | 'kind' | 'status' | 'ojReference' | 'ojDate' | 'supersededById' | 'link'>) => ({
  code: row.code,
  edition: row.edition,
  title: row.title,
  kind: row.kind,
  status: row.status,
  ojReference: row.ojReference,
  ojDate: row.ojDate ? row.ojDate.toISOString().slice(0, 10) : null,
  supersededById: row.supersededById,
  link: row.link,
})

const dateOf = (value: BusinessDate | null | undefined): Date | null | undefined => (value === undefined ? undefined : value === null ? null : new Date(`${value}T00:00:00.000Z`))

function check(problems: ReturnType<typeof entryProblems>): void {
  if (problems.length > 0) throw new ValidationError('The register entry is not valid.', problems)
}

export interface CreateBody {
  readonly code: string
  readonly edition?: string | null | undefined
  readonly title: string
  readonly titleI18n?: Record<string, string> | null | undefined
  readonly kind: RegulationKind
  readonly ojReference?: string | null | undefined
  readonly ojDate?: BusinessDate | null | undefined
  readonly link?: string | null | undefined
  readonly note?: string | null | undefined
  readonly status?: RegulationStatus | undefined
}

const takenWords = (code: string, edition: string | null) => `The register already has ${standardLabel(code, edition)}: edit that entry, or give this one another edition.`

/** POST /compliance/rules/standards */
export async function createEntry(caller: CommandCaller, body: CreateBody, key: string | null | undefined): Promise<{ entry: EntryView }> {
  const context = officeOf(caller)
  assertMayKeep(context, RULES_MANAGE, null, WHAT)
  check(entryProblems(body))
  const edition = body.edition ?? null
  const { result } = await rulesGuarded(
    () =>
      runCommand(
        caller,
        { name: 'compliance.rules.createStandard', idempotencyKey: key, input: body },
        async ({ tx, now, audit, emit }) => {
          const twin = await tx.regulationOrStandard.findFirst({ where: { code: body.code, edition }, select: { id: true } })
          if (twin) throw new ConflictError(takenWords(body.code, edition))
          const id = newId()
          const row = await tx.regulationOrStandard.create({
            data: {
              id,
              code: body.code,
              edition,
              title: body.title,
              ...(body.titleI18n ? { titleI18n: body.titleI18n } : {}),
              kind: body.kind,
              status: body.status ?? 'IN_FORCE',
              ojReference: body.ojReference ?? null,
              ojDate: dateOf(body.ojDate) ?? null,
              link: body.link ?? null,
              note: body.note ?? null,
              createdAt: now,
              updatedAt: now,
              createdById: context.actorId,
            },
            select: ENTRY_SELECT,
          })
          audit({ recordType: 'RegulationOrStandard', recordId: id, companyId: null, after: auditOf(row) })
          emit({ type: 'compliance_rules.standard_changed', subject: id, companyId: null, payload: { standardId: id, code: row.code, edition: row.edition, status: row.status as RegulationStatus, change: 'CREATED' } })
          return { entry: (await entryViews(tx, [row], actorOf(context)))[0]! }
        },
        { ...COMMAND_SETTINGS, clock: rulesClock() },
      ),
    { taken: takenWords(body.code, edition) },
  )
  return result
}

export interface EditBody {
  readonly version: number
  readonly code?: string | undefined
  readonly edition?: string | null | undefined
  readonly title?: string | undefined
  readonly titleI18n?: Record<string, string> | null | undefined
  readonly kind?: RegulationKind | undefined
  readonly ojReference?: string | null | undefined
  readonly ojDate?: BusinessDate | null | undefined
  readonly link?: string | null | undefined
  readonly note?: string | null | undefined
  readonly status?: RegulationStatus | undefined
  readonly supersededById?: string | null | undefined
  readonly reason?: string | undefined
  readonly transitionEndsOn?: BusinessDate | null | undefined
}

/** PATCH /compliance/rules/standards/:standardId */
export async function editEntry(caller: CommandCaller, standardId: string, body: EditBody, key: string | null | undefined): Promise<{ entry: EntryView; raised: ChangeView | null }> {
  const context = officeOf(caller)
  assertMayKeep(context, RULES_MANAGE, null, WHAT)
  const { result } = await rulesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.rules.editStandard', idempotencyKey: key, input: { standardId, ...body }, record: { type: 'RegulationOrStandard', id: standardId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit, emit } = tools
        const before = await tx.regulationOrStandard.findUniqueOrThrow({ where: { id: standardId }, select: ENTRY_SELECT })
        const status = body.status ?? (before.status as RegulationStatus)
        // A successor is kept only while SUPERSEDED: leaving SUPERSEDED clears it unless the body says otherwise.
        const supersededById = body.supersededById !== undefined ? body.supersededById : status === 'SUPERSEDED' ? before.supersededById : null
        check(entryProblems({ ...body, status, supersededById }))
        const code = body.code ?? before.code
        const edition = body.edition !== undefined ? body.edition : before.edition
        if (code !== before.code || edition !== before.edition) {
          const twin = await tx.regulationOrStandard.findFirst({ where: { code, edition, id: { not: standardId } }, select: { id: true } })
          if (twin) throw new ConflictError(takenWords(code, edition))
        }
        if (supersededById === standardId) throw new ValidationError('The register entry is not valid.', [{ path: 'body/supersededById', message: 'An entry is not superseded by itself.' }])
        if (supersededById && !(await tx.regulationOrStandard.findUnique({ where: { id: supersededById }, select: { id: true } }))) {
          throw new ValidationError('The register entry is not valid.', [{ path: 'body/supersededById', message: 'Name an entry of the register (add the new edition first).' }])
        }
        const raising = raisedKind(before.status as RegulationStatus, status)
        const openChange = raising ? await tx.standardChange.findFirst({ where: { standardId, status: { not: 'CLOSED' } }, select: { id: true } }) : null
        if (raising && !openChange && !body.reason) {
          throw new ValidationError('Say what changed.', [{ path: 'body/reason', message: `Moving ${standardLabel(before.code, before.edition)} to ${status} raises a change of the watch: say what changed, in words (the Official Journal's notice).` }])
        }
        const row = await tx.regulationOrStandard.update({
          where: { id: standardId },
          data: {
            code,
            edition,
            ...(body.title !== undefined ? { title: body.title } : {}),
            ...(body.titleI18n !== undefined ? { titleI18n: body.titleI18n === null ? (null as unknown as Prisma.InputJsonValue) : body.titleI18n } : {}),
            ...(body.kind !== undefined ? { kind: body.kind } : {}),
            ...(body.ojReference !== undefined ? { ojReference: body.ojReference } : {}),
            ...(body.ojDate !== undefined ? { ojDate: dateOf(body.ojDate) ?? null } : {}),
            ...(body.link !== undefined ? { link: body.link } : {}),
            ...(body.note !== undefined ? { note: body.note } : {}),
            status,
            supersededById,
            updatedAt: now,
          },
          select: ENTRY_SELECT,
        })
        const moved = status !== before.status
        audit({ recordType: 'RegulationOrStandard', recordId: standardId, companyId: null, before: auditOf(before), after: auditOf(row), ...(body.reason ? { reason: body.reason } : {}) })
        emit({ type: 'compliance_rules.standard_changed', subject: standardId, companyId: null, payload: { standardId, code: row.code, edition: row.edition, status, change: moved ? 'STATUS' : 'EDITED' } })
        let raised: ChangeView | null = null
        if (raising && !openChange) {
          const change = await raiseChangeInCommand(tools, row, {
            kind: raising,
            whatChanged: body.reason!,
            sourceReference: row.ojReference,
            transitionEndsOn: body.transitionEndsOn ?? null,
            newStandardId: supersededById,
            raisedBy: 'REGISTER',
          })
          raised = (await changeViews(tx, [change], todayOf(now)))[0]!
        }
        return { entry: (await entryViews(tx, [row], actorOf(context)))[0]!, raised }
      },
      { ...COMMAND_SETTINGS, clock: rulesClock() },
    ),
  )
  return result
}

/** DELETE /compliance/rules/standards/:standardId?version= — a row typed by mistake, while nothing names it. */
export async function deleteEntry(caller: CommandCaller, standardId: string, version: number, key: string | null | undefined): Promise<{ deleted: string }> {
  const context = officeOf(caller)
  assertMayKeep(context, RULES_MANAGE, null, WHAT)
  const { result } = await rulesGuarded(
    () =>
      runCommand(
        caller,
        { name: 'compliance.rules.deleteStandard', idempotencyKey: key, input: { standardId, version } },
        async ({ tx, audit, emit }) => {
          await tx.$queryRaw`SELECT id FROM "RegulationOrStandard" WHERE id = ${standardId}::uuid FOR UPDATE`
          const row = await tx.regulationOrStandard.findUnique({ where: { id: standardId }, select: ENTRY_SELECT })
          if (!row) throw new NotFoundError('There is no such entry in the register.')
          if (row.version !== version) throw new ConflictError(`This entry changed since it was read (version ${version}); it is now at version ${row.version}. Reload it.`)
          const label = standardLabel(row.code, row.edition)
          const certificates = (await tx.certificate.findMany({ select: CERTIFICATE_REF })).filter((certificate) => namesEntry(certificate.standard, row))
          if (certificates.length > 0) throw new ConflictError(`${label} is cited by certificate ${certificates[0]!.number}${certificates.length > 1 ? ` and ${certificates.length - 1} more` : ''}: it stays in the register (mark it superseded or withdrawn instead).`)
          const named =
            (await tx.standardChange.count({ where: { OR: [{ standardId }, { newStandardId: standardId }] } })) +
            (await tx.complianceRequirement.count({ where: { regulationId: standardId } })) +
            (await tx.regulationOrStandard.count({ where: { supersededById: standardId } }))
          if (named > 0) throw new ConflictError(`${label} is named by a change of the watch, a requirement or another entry: it stays in the register (mark it superseded or withdrawn instead).`)
          await tx.regulationOrStandard.delete({ where: { id: standardId } })
          audit({ recordType: 'RegulationOrStandard', recordId: standardId, companyId: null, before: auditOf(row) })
          emit({ type: 'compliance_rules.standard_changed', subject: standardId, companyId: null, payload: { standardId, code: row.code, edition: row.edition, status: row.status as RegulationStatus, change: 'DELETED' } })
          return { deleted: standardId }
        },
        { ...COMMAND_SETTINGS, clock: rulesClock() },
      ),
    { named: 'Another record still names this entry: it stays in the register (mark it superseded or withdrawn instead).' },
  )
  return result
}
