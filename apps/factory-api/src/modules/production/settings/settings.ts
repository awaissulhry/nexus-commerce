import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { MONITORING_CHANGES } from '@nexus/factory-domain/production/events'
import {
  basisReasonProblems,
  changeNeedsReason,
  changeNeedsStepUp,
  floorRulesStatus,
  legalBasisProblems,
  monitoringChangeOf,
  monitoringImpact,
  scanSubjectChangeProblems,
  scanSubjectOf,
  type MonitoringBasis,
  type MonitoringChange,
  type ScanSubject,
} from '@nexus/factory-domain/production/settings/monitoring'
import { PRODUCTION_SETTINGS_MANAGE, PRODUCTION_SETTINGS_VIEW } from '@nexus/factory-domain/production/settings/permissions'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'
import type { AffectedView, ChangeResult, RulesView, SiteView } from './contract'
import { hasAcknowledgedNotice, scanSubjectFor } from './subject'

/**
 * A site's floor rules (B-W1-37; A2 SCR-074; MES-278, PLT-208): the monitoring switch and its legal basis, read and
 * changed by the office (production.settings.view | manage over the site's company and the site). The row has the
 * site's own id; a site without one names workers (the default). Every change is ONE command on the row (its version
 * bump locks it): an audit row with the reason, and the event production.monitoring_changed. Nothing here touches a
 * scan or a cut log: they keep what they recorded. The floor reads its own site's scan subject (`floorRules`).
 */

type Change = (typeof MONITORING_CHANGES)[number]

const RULES_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  scanSubject: true,
  monitoringBasis: true,
  monitoringReference: true,
  monitoringRecordedAt: true,
  monitoringRecordedById: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.ProductionSettingsSelect

type RulesRow = Prisma.ProductionSettingsGetPayload<{ select: typeof RULES_SELECT }>
const SITE_SELECT = { id: true, companyId: true, code: true, name: true } as const satisfies Prisma.SiteSelect

type Reader = Pick<CommandTx, 'productionSettings' | 'user' | 'workOrder' | 'worker' | 'device'>

function officeContextOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

function floorContextOf(caller: CommandCaller): FloorContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'floor') throw new ForbiddenError()
  return context
}

const mayOn = (context: OfficeContext, permission: Permission, site: SiteView): boolean => can(actorOf(context), permission, { companyId: site.companyId, siteId: site.id })

/** The site, when the caller may see its rules (else 404) and do `permission` on them (else 403). */
async function siteOf(caller: CommandCaller, siteId: string, permission: Permission): Promise<{ context: OfficeContext; site: SiteView }> {
  const context = officeContextOf(caller)
  const site = isUuid(siteId) ? await caller.withClient((client) => client.site.findUnique({ where: { id: siteId }, select: SITE_SELECT })) : null
  if (!site || !mayOn(context, PRODUCTION_SETTINGS_VIEW, site)) throw new NotFoundError('Site not found.')
  if (!mayOn(context, permission, site)) throw new ForbiddenError()
  return { context, site }
}

const readRow = (db: Pick<CommandTx, 'productionSettings'>, siteId: string): Promise<RulesRow | null> => db.productionSettings.findUnique({ where: { id: siteId }, select: RULES_SELECT })

async function rulesView(db: Pick<CommandTx, 'user'>, row: RulesRow | null): Promise<RulesView> {
  let legalBasis: RulesView['legalBasis'] = null
  if (row?.monitoringBasis && row.monitoringReference && row.monitoringRecordedAt) {
    const by = row.monitoringRecordedById ? await db.user.findUnique({ where: { id: row.monitoringRecordedById }, select: { displayName: true } }) : null
    legalBasis = {
      kind: row.monitoringBasis as MonitoringBasis,
      reference: row.monitoringReference,
      recordedAt: toUtcIso(row.monitoringRecordedAt),
      recordedById: row.monitoringRecordedById,
      recordedByName: by?.displayName ?? null,
    }
  }
  return {
    scanSubject: scanSubjectOf(row as { scanSubject: ScanSubject } | null),
    isDefault: row === null,
    legalBasis,
    version: row?.version ?? null,
    updatedAt: row ? toUtcIso(row.updatedAt) : null,
  }
}

/** Counts only (one query each, in order: never parallel queries on one transaction client). */
async function affectedAt(db: Pick<CommandTx, 'workOrder' | 'worker' | 'device'>, siteId: string): Promise<AffectedView> {
  const openWorkOrders = await db.workOrder.count({ where: { siteId, status: { in: ['RELEASED', 'IN_PROGRESS'] } } })
  const workersActive = await db.worker.count({ where: { siteId, status: 'ACTIVE' } })
  const workersAcknowledged = await db.worker.count({ where: { siteId, status: 'ACTIVE', noticeAcks: { some: {} } } })
  const devicesWithoutStation = await db.device.count({ where: { siteId, status: 'ACTIVE', stationId: null } })
  return { openWorkOrders, workersActive, workersNotAcknowledged: workersActive - workersAcknowledged, devicesWithoutStation }
}

const statusOf = (rules: RulesView, affected?: AffectedView) =>
  floorRulesStatus({ scanSubject: rules.scanSubject, basisOnRecord: rules.legalBasis !== null, workersActive: affected?.workersActive, workersNotAcknowledged: affected?.workersNotAcknowledged })

function ifSwitched(rules: RulesView, affected: AffectedView) {
  const to: ScanSubject = rules.scanSubject === 'WORKER' ? 'STATION' : 'WORKER'
  const change = monitoringChangeOf(rules.scanSubject, to)
  return {
    to,
    needsStepUp: changeNeedsStepUp(change),
    needsReason: changeNeedsReason(change),
    needsLegalBasis: to === 'WORKER' && rules.legalBasis === null,
    words: monitoringImpact(rules.scanSubject, to, affected),
  }
}

async function detailOf(db: Reader, site: SiteView, row: RulesRow | null) {
  const rules = await rulesView(db, row)
  const affected = await affectedAt(db, site.id)
  return { site, rules, status: statusOf(rules, affected), affected, ifSwitched: ifSwitched(rules, affected) }
}

/** production.settings.view: every site the caller's grants reach, with its floor rules (the default when it has none). */
export async function listRules(caller: CommandCaller, query: { companyId?: string | undefined }) {
  const context = officeContextOf(caller)
  const where: Prisma.SiteWhereInput = {
    AND: [scopeWhere(actorOf(context), PRODUCTION_SETTINGS_VIEW, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput, query.companyId ? { companyId: query.companyId } : {}],
  }
  return caller.withClient(async (client) => {
    const sites = await client.site.findMany({ where, select: SITE_SELECT, orderBy: [{ companyId: 'asc' }, { code: 'asc' }] })
    const rows = await client.productionSettings.findMany({ where: { id: { in: sites.map((site) => site.id) } }, select: RULES_SELECT })
    const byId = new Map(rows.map((row) => [row.id, row]))
    const answer = []
    for (const site of sites) {
      const rules = await rulesView(client, byId.get(site.id) ?? null)
      answer.push({ site, rules, status: statusOf(rules) })
    }
    return { sites: answer }
  })
}

/** production.settings.view: one site's floor rules, what they mean, and what switching them would reach (counts). */
export async function getRules(caller: CommandCaller, siteId: string) {
  const { site } = await siteOf(caller, siteId, PRODUCTION_SETTINGS_VIEW)
  return caller.withClient(async (client) => detailOf(client, site, await readRow(client, site.id)))
}

const trimmedOrNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/** What the audit row keeps of the rules (the reference included: the audit log is office only). */
const auditOf = (row: RulesRow | null) =>
  row
    ? {
        scanSubject: row.scanSubject,
        monitoringBasis: row.monitoringBasis,
        monitoringReference: row.monitoringReference,
        monitoringRecordedAt: row.monitoringRecordedAt ? toUtcIso(row.monitoringRecordedAt) : null,
        monitoringRecordedById: row.monitoringRecordedById,
      }
    : null

interface LegalBasisBody {
  readonly kind: string
  readonly reference: string
}

interface WriteSpec {
  readonly name: 'production.changeScanSubject' | 'production.recordLegalBasis'
  readonly site: SiteView
  readonly context: OfficeContext
  readonly existing: RulesRow | null
  readonly version: number | undefined
  readonly input: unknown
  readonly idempotencyKey: string | undefined
  readonly to: ScanSubject
  readonly expectedChange: MonitoringChange
  readonly basis: LegalBasisBody | null
  readonly reason: string | null
}

/** ONE command on the site's floor rules row: create it the first time, else change it at the version read. */
async function writeRules(caller: CommandCaller, spec: WriteSpec): Promise<ChangeResult> {
  const { site, context, existing } = spec
  const { result } = await command(
    caller,
    {
      name: spec.name,
      idempotencyKey: spec.idempotencyKey,
      input: spec.input,
      ...(existing ? { record: { type: 'ProductionSettings' as const, id: site.id, expectedVersion: spec.version } } : {}),
    },
    async (tools) => {
      // The row is locked by the version bump (when it existed); a change made since the read is never overwritten.
      const before = existing ? await readRow(tools.tx, site.id) : null
      const from = scanSubjectOf(before as { scanSubject: ScanSubject } | null)
      const change = monitoringChangeOf(from, spec.to)
      if (change !== spec.expectedChange || (before?.monitoringBasis ?? null) !== (existing?.monitoringBasis ?? null)) {
        throw new ConflictError('The floor rules of this site just changed; reload them and apply again.')
      }
      const basis = spec.basis
        ? { monitoringBasis: spec.basis.kind as MonitoringBasis, monitoringReference: spec.basis.reference.trim(), monitoringRecordedAt: tools.now, monitoringRecordedById: context.actorId }
        : {}
      if (before) {
        await tools.tx.productionSettings.update({ where: { id: site.id }, data: { scanSubject: spec.to, ...basis }, select: { id: true } })
      } else {
        const { count } = await tools.tx.productionSettings.createMany({
          data: [{ id: site.id, companyId: site.companyId, siteId: site.id, scanSubject: spec.to, ...basis, createdById: context.actorId }],
          skipDuplicates: true,
        })
        if (count !== 1) throw new ConflictError('The floor rules of this site were just saved by someone else; reload them and apply again.')
      }
      const after = (await readRow(tools.tx, site.id))!
      const eventChange: Change = change === 'WIDEN' ? 'WIDENED' : change === 'NARROW' ? 'NARROWED' : before?.monitoringBasis ? 'BASIS_REPLACED' : 'BASIS_RECORDED'
      tools.audit({
        action: spec.name,
        recordType: 'ProductionSettings',
        recordId: site.id,
        companyId: site.companyId,
        siteId: site.id,
        before: auditOf(before),
        after: auditOf(after),
        ...(spec.reason ? { reason: spec.reason } : {}),
      })
      tools.emit({
        type: 'production.monitoring_changed',
        subject: site.id,
        companyId: site.companyId,
        siteId: site.id,
        payload: { siteId: site.id, scanSubject: spec.to, previous: from, change: eventChange, basisOnRecord: after.monitoringBasis !== null },
      })
      const detail = await detailOf(tools.tx, site, after)
      return { ...detail, changed: true, change: eventChange, words: change === 'NONE' ? [] : monitoringImpact(from, spec.to, detail.affected) }
    },
  )
  return result
}

async function unchanged(caller: CommandCaller, site: SiteView): Promise<ChangeResult> {
  const detail = await caller.withClient(async (client) => detailOf(client, site, await readRow(client, site.id)))
  return { ...detail, changed: false, change: null, words: [] }
}

function refuse(problems: Issue[], message: string): void {
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : message, problems)
}

const sameBasis = (row: RulesRow | null, basis: LegalBasisBody): boolean => row?.monitoringBasis === basis.kind && row.monitoringReference === basis.reference.trim()

export interface ChangeScanSubjectInput {
  readonly scanSubject: ScanSubject
  readonly reason?: string | null | undefined
  readonly legalBasis?: LegalBasisBody | undefined
  readonly version?: number | undefined
}

/**
 * production.settings.manage: who the site's floor records name from now on. WORKER needs a legal basis on record (sent
 * with the change, or recorded before); widening (STATION → WORKER) also needs a reason and a step-up (`stepUp`, after
 * the rules: a refused change asks for no code); narrowing never asks. Records already made are not touched.
 */
export async function changeScanSubject(
  caller: CommandCaller,
  siteId: string,
  body: ChangeScanSubjectInput,
  options: { readonly stepUp: () => void; readonly idempotencyKey?: string | undefined },
): Promise<ChangeResult> {
  const { context, site } = await siteOf(caller, siteId, PRODUCTION_SETTINGS_MANAGE)
  const existing = await caller.withClient((client) => readRow(client, site.id))
  if (!existing && body.version !== undefined) throw new NotFoundError('This site has no floor rules yet; apply without a version.')
  const from = scanSubjectOf(existing as { scanSubject: ScanSubject } | null)
  const change = monitoringChangeOf(from, body.scanSubject)
  const basis = body.legalBasis ?? null
  const reason = trimmedOrNull(body.reason)
  refuse(
    [
      ...(basis ? legalBasisProblems(basis, 'body/legalBasis') : []),
      ...scanSubjectChangeProblems({ from, to: body.scanSubject, basisOnRecord: basis !== null || existing?.monitoringBasis != null, reason }),
    ],
    'The floor rules cannot change this way.',
  )
  const newBasis = basis && !sameBasis(existing, basis) ? basis : null
  if (change === 'NONE' && !newBasis && existing) return unchanged(caller, site)
  if (changeNeedsStepUp(change)) options.stepUp()
  return writeRules(caller, {
    name: 'production.changeScanSubject',
    site,
    context,
    existing,
    version: body.version,
    input: { siteId: site.id, ...body },
    idempotencyKey: options.idempotencyKey,
    to: body.scanSubject,
    expectedChange: change,
    basis: newBasis,
    reason,
  })
}

export interface RecordLegalBasisInput extends LegalBasisBody {
  readonly reason?: string | null | undefined
  readonly version?: number | undefined
}

/**
 * production.settings.manage: records the legal basis for naming workers, or replaces it (a renewed agreement, an
 * authorisation that came later). It changes nothing about who records name; it is never removed (the audit log keeps
 * every earlier one). The same basis again changes nothing.
 */
export async function recordLegalBasis(caller: CommandCaller, siteId: string, body: RecordLegalBasisInput, idempotencyKey?: string): Promise<ChangeResult> {
  const { context, site } = await siteOf(caller, siteId, PRODUCTION_SETTINGS_MANAGE)
  const reason = trimmedOrNull(body.reason)
  refuse([...legalBasisProblems(body, 'body'), ...basisReasonProblems(reason)], 'The legal basis is not complete.')
  const existing = await caller.withClient((client) => readRow(client, site.id))
  if (!existing && body.version !== undefined) throw new NotFoundError('This site has no floor rules yet; record the basis without a version.')
  if (sameBasis(existing, body)) return unchanged(caller, site)
  const subject = scanSubjectOf(existing as { scanSubject: ScanSubject } | null)
  return writeRules(caller, {
    name: 'production.recordLegalBasis',
    site,
    context,
    existing,
    version: body.version,
    input: { siteId: site.id, ...body },
    idempotencyKey,
    to: subject,
    expectedChange: 'NONE',
    basis: { kind: body.kind, reference: body.reference },
    reason,
  })
}

/**
 * production.settings.view: who at the site has acknowledged the information notice. Counts for every viewer; names
 * only with production.settings.manage over the site (they are never even read otherwise). Sorted by name: no order
 * here says anything about what a person did.
 */
export async function listNoticeAcks(caller: CommandCaller, siteId: string) {
  const { context, site } = await siteOf(caller, siteId, PRODUCTION_SETTINGS_VIEW)
  const withNames = mayOn(context, PRODUCTION_SETTINGS_MANAGE, site)
  return caller.withClient(async (client) => {
    const workers = await client.worker.findMany({
      where: { siteId: site.id, status: 'ACTIVE' },
      select: { id: true, displayName: withNames, noticeAcks: { select: { noticeVersion: true, channel: true, serverTime: true }, orderBy: [{ noticeVersion: 'asc' }, { id: 'asc' }] } },
      orderBy: withNames ? [{ displayName: 'asc' }, { id: 'asc' }] : [{ id: 'asc' }],
    })
    const acknowledged = workers.filter((worker) => worker.noticeAcks.length > 0).length
    const perVersion = new Map<string, number>()
    for (const worker of workers) for (const version of new Set(worker.noticeAcks.map((ack) => ack.noticeVersion))) perVersion.set(version, (perVersion.get(version) ?? 0) + 1)
    return {
      site,
      workers: { active: workers.length, acknowledged, notAcknowledged: workers.length - acknowledged },
      versions: [...perVersion].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([noticeVersion, count]) => ({ noticeVersion, workers: count })),
      people: withNames
        ? workers.map((worker) => ({
            workerId: worker.id,
            displayName: (worker as { displayName: string }).displayName,
            acknowledged: worker.noticeAcks.length > 0,
            acknowledgements: worker.noticeAcks.map((ack) => ({ noticeVersion: ack.noticeVersion, channel: ack.channel, acknowledgedAt: toUtcIso(ack.serverTime) })),
          }))
        : null,
    }
  })
}

/** floor.work: the device's own site's scan subject, and whether the signed-in worker acknowledged the notice. Never the legal basis. */
export async function floorRules(caller: CommandCaller) {
  const context = floorContextOf(caller)
  return caller.withClient(async (client) => ({
    siteId: context.siteId,
    scanSubject: await scanSubjectFor(client, context.siteId),
    workerAcknowledged: await hasAcknowledgedNotice(client, context.siteId, context.actorId),
  }))
}
