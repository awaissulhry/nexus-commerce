import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { thresholdOf } from '@nexus/factory-domain/alerts/kinds'
import { ALERTS_VIEW } from '@nexus/factory-domain/alerts/permissions'
import { placeCovers } from '@nexus/factory-domain/alerts/rules'
import { CERTIFICATES_MANAGE } from '@nexus/factory-domain/compliance/certificates/permissions'
import { daysBetween, daysToExpiry } from '@nexus/factory-domain/compliance/certificates/rules'
import {
  alreadyAppliedRefusal,
  appliedRefusal,
  isOpenRenewal,
  RENEWAL_RESTARTED,
  renewalNextStep,
  renewalTask,
  renewalWindowOf,
  stageDay,
  startRefusal,
  successorRefusal,
  windowPhase,
  type Locale,
  type RenewalCertificate,
  type RenewalRefusal,
} from '@nexus/factory-domain/compliance/renewals/rules'
import { ConflictError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { clearInCommand } from '../../../platform/alerts/raise'
import { lockKind, placeNames, RULE_COLUMNS, tenantIdOf } from '../../../platform/alerts/store'
import { accessOf, createTask, TASK_COLUMNS } from '../../../platform/tasks/tasks'
import { cancelTimersOfRecord } from '../../../platform/timers/service'
import { CERTIFICATE_SCOPE, certificateCommand, certificatesClock, dayOf, mayManage, officeOf, readCertificate, todayOf } from '../certificates/certificates'
import type { RenewalsView } from './contract'

/**
 * Certificate renewals (B-W2a-66; QHS-105 expiry alerts, PRD-283 the 12-to-6-month window; rules factory-domain
 * compliance/renewals). The Renewals tab of a certificate (SCR-051 `?tab=renewals`):
 *
 *   GET  …/renewals            the validity with the window, the alert stages (the CERTIFICATE_EXPIRING rules with their
 *                              timers and, for alerts.view, the alerts they raised and how many people were told), the
 *                              renewal (its task and checklist, the application day), the successor or the certificate it
 *                              renews, the certificates that may be linked as the successor, and the log
 *   POST …/renewals/start      the renewal task on the certificate (platform/tasks createTask: the usual steps in words,
 *                              due the window's last day), then ONE command on the certificate (its version) that logs it
 *   POST …/renewals/applied    the day the application went to the notified body (typed in: nothing is sent)
 *   POST …/renewals/successor  the new, registered certificate linked (Certificate.successorId, set once): in ONE command,
 *                              under the CERTIFICATE_EXPIRING kind's lock, the old certificate's timers are cancelled and
 *                              its unresolved expiry alerts cleared (the alert engine's window leaves renewed ones out)
 *
 * B-W2b-17 (B-W2a-66's gap): each renewal is a CertificateRenewal row (W2b schema wave 2) — STARTED with its window,
 * task and language; APPLIED with the day, reference, note and whether it was in the window (once); RENEWED with the new
 * certificate; CANCELLED with why (a new start after its task was closed cancels the open one). "One open renewal per
 * certificate" is held here: every write is a command on the certificate's version (the commands of one certificate take
 * turns). An application or a link without a started renewal starts one in the same command (no task). The log and
 * the renewal shown are read from the rows (the audit rows stay, as for every command). compliance.certificates.view to
 * read, .manage to write (over the certificate's company and holder); the alerts are shown with alerts.view only.
 */

export const RENEWAL_COMMANDS = { start: 'compliance.renewals.start', applied: 'compliance.renewals.applied', link: 'compliance.renewals.link' } as const

type Reader = FactoryClient | CommandTx

/** The office context (the routes are office only: certificates' officeOf refuses any other audience). */
const officeContextOf = (caller: CommandCaller): OfficeContext => officeOf(caller) as OfficeContext

/** A renewal step refused by its rule: 409 with `refusal/<CODE>`. */
export class RenewalRefusedError extends ConflictError {
  override name = 'RenewalRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: RenewalRefusal) {
    super(refusal.message)
    this.issues = [{ path: `refusal/${refusal.code}`, message: refusal.message }]
  }
}

const refuse = (refusal: RenewalRefusal | null): void => {
  if (refusal) throw new RenewalRefusedError(refusal)
}

const RENEWAL_SELECT = {
  id: true,
  number: true,
  status: true,
  standard: true,
  ppeClass: true,
  companyId: true,
  holderPartyId: true,
  notifiedBodyName: true,
  notifiedBodyNumber: true,
  validFrom: true,
  validTo: true,
  successorId: true,
  version: true,
} as const satisfies Prisma.CertificateSelect
type RenewalRow = Prisma.CertificateGetPayload<{ select: typeof RENEWAL_SELECT }>

const REF_SELECT = { id: true, number: true, standard: true, status: true, validFrom: true, validTo: true } as const satisfies Prisma.CertificateSelect
const refOf = (row: Prisma.CertificateGetPayload<{ select: typeof REF_SELECT }>) => ({ id: row.id, number: row.number, standard: row.standard, status: row.status, validFrom: dayOf(row.validFrom), validTo: dayOf(row.validTo) })

export const renewalFacts = (row: RenewalRow): RenewalCertificate => ({
  id: row.id,
  number: row.number,
  status: row.status,
  companyId: row.companyId,
  holderPartyId: row.holderPartyId,
  validFrom: dayOf(row.validFrom),
  validTo: dayOf(row.validTo),
  successorId: row.successorId,
})

const RENEWAL_COLUMNS = {
  id: true,
  status: true,
  windowOpensOn: true,
  windowClosesOn: true,
  taskId: true,
  language: true,
  startedAt: true,
  startedById: true,
  appliedOn: true,
  applicationReference: true,
  applicationNote: true,
  appliedInWindow: true,
  appliedAt: true,
  appliedById: true,
  newCertificateId: true,
  renewedAt: true,
  renewedById: true,
  cancelledAt: true,
  cancelledById: true,
  cancelReason: true,
  version: true,
} as const satisfies Prisma.CertificateRenewalSelect
type RenewalRecord = Prisma.CertificateRenewalGetPayload<{ select: typeof RENEWAL_COLUMNS }>

const textOf = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

/** The certificate's renewals, oldest first. */
async function renewalsOf(db: Reader, certificateId: string): Promise<RenewalRecord[]> {
  return db.certificateRenewal.findMany({ where: { certificateId }, orderBy: [{ startedAt: 'asc' }, { id: 'asc' }], select: RENEWAL_COLUMNS })
}

/** The renewal the tab shows: the open one (STARTED or APPLIED), else the newest not cancelled. */
function currentOf(rows: readonly RenewalRecord[]): RenewalRecord | null {
  const open = rows.filter((row) => isOpenRenewal(row.status))
  return open.at(-1) ?? rows.filter((row) => row.status !== 'CANCELLED').at(-1) ?? null
}

/** The renewal task's status (any reader: whether a renewal is still open does not depend on who asks). */
async function taskStatusOf(db: Reader, taskId: string | null): Promise<string | null> {
  if (!taskId) return null
  return (await db.task.findUnique({ where: { id: taskId }, select: { status: true } }))?.status ?? null
}

async function namesOf(db: Reader, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].filter((id): id is string => typeof id === 'string'))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
}

/** The Renewals tab, read with this client as this person. */
export async function renewalsView(db: Reader, actor: Actor, personId: string, certificateId: string, today: BusinessDate): Promise<RenewalsView> {
  const row = await db.certificate.findUniqueOrThrow({ where: { id: certificateId }, select: { ...RENEWAL_SELECT, successor: { select: REF_SELECT }, renews: { select: REF_SELECT } } })
  const validTo = dayOf(row.validTo)
  const scope = { companyId: row.companyId, partyId: row.holderPartyId }
  const window = renewalWindowOf(validTo)

  // The alert stages: every CERTIFICATE_EXPIRING rule whose place covers the certificate, latest timer and alert each.
  const rules = (await db.alertRule.findMany({ where: { ruleKind: 'CERTIFICATE_EXPIRING' }, select: RULE_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).filter((rule) => placeCovers(rule, { companyId: row.companyId, siteId: null }))
  const { roles } = await placeNames(db, rules)
  const timers = rules.length
    ? await db.dueTimer.findMany({ where: { recordType: 'Certificate', recordId: certificateId, ruleId: { in: rules.map((rule) => rule.id) } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, ruleId: true, status: true, fireAt: true, firedAt: true, cancelReason: true } })
    : []
  const seesAlerts = can(actor, ALERTS_VIEW, scope)
  const alerts = seesAlerts && rules.length
    ? await db.alert.findMany({ where: { recordType: 'Certificate', recordId: certificateId, ruleKind: 'CERTIFICATE_EXPIRING' }, orderBy: [{ occurrence: 'desc' }], select: { id: true, ruleId: true, state: true, raisedAt: true, resolvedAt: true, occurrence: true } })
    : []
  const stages = []
  for (const rule of rules) {
    const threshold = thresholdOf('CERTIFICATE_EXPIRING', rule.threshold) as { daysBefore: number; workingDays: boolean }
    const timer = timers.find((entry) => entry.ruleId === rule.id) ?? null
    const alert = alerts.find((entry) => entry.ruleId === rule.id) ?? null
    const told = alert ? await db.notification.count({ where: { eventType: 'alert.raised', anchor: `alert:${alert.id}` } }) : 0
    stages.push({
      ruleId: rule.id,
      name: rule.name,
      daysBefore: threshold.daysBefore,
      workingDays: threshold.workingDays,
      enabled: rule.enabled,
      builtIn: rule.builtIn,
      severity: rule.severity,
      recipientRole: rule.recipientRoleId ? { id: rule.recipientRoleId, name: roles.get(rule.recipientRoleId) ?? '' } : null,
      fireOn: timer && timer.status !== 'CANCELLED' ? businessDate(timer.fireAt) : stageDay(validTo, threshold.daysBefore),
      timer: timer ? { id: timer.id, status: timer.status, fireAt: toUtcIso(timer.fireAt), firedAt: timer.firedAt ? toUtcIso(timer.firedAt) : null, cancelReason: timer.cancelReason } : null,
      alert: alert ? { id: alert.id, state: alert.state, raisedAt: toUtcIso(alert.raisedAt), resolvedAt: alert.resolvedAt ? toUtcIso(alert.resolvedAt) : null, occurrence: alert.occurrence, told } : null,
    })
  }
  stages.sort((a, b) => b.daysBefore - a.daysBefore || (a.ruleId < b.ruleId ? -1 : 1))

  const rows = await renewalsOf(db, certificateId)
  const current = currentOf(rows)
  const taskRow = current?.taskId ? await db.task.findUnique({ where: { id: current.taskId }, select: TASK_COLUMNS }) : null
  const visibleTask = taskRow && accessOf(actor, personId, taskRow).relation !== null ? taskRow : null
  const checklist = Array.isArray(visibleTask?.checklist) ? (visibleTask!.checklist as Record<string, unknown>[]) : []
  const names = await namesOf(db, [...rows.flatMap((entry) => [entry.startedById, entry.appliedById, entry.renewedById]), visibleTask?.assigneeId, ...checklist.map((item) => textOf(item.doneById))])
  const appliedOn = current?.appliedOn ? dayOf(current.appliedOn) : null
  const successorNumbers = new Map(
    (await db.certificate.findMany({ where: { id: { in: rows.flatMap((entry) => (entry.newCertificateId ? [entry.newCertificateId] : [])) } }, select: { id: true, number: true } })).map((entry) => [entry.id, entry.number]),
  )

  const mayManageIt = can(actor, CERTIFICATES_MANAGE, scope)
  const candidates =
    mayManageIt && row.successorId === null
      ? await db.certificate.findMany({
          where: {
            AND: [
              scopeWhere(actor, CERTIFICATES_MANAGE, CERTIFICATE_SCOPE) as Prisma.CertificateWhereInput,
              { id: { not: row.id }, status: 'VALID', companyId: row.companyId, holderPartyId: row.holderPartyId, validFrom: { gt: row.validFrom }, renews: { is: null } },
            ],
          },
          orderBy: [{ validFrom: 'asc' }, { number: 'asc' }],
          take: 50,
          select: REF_SELECT,
        })
      : []

  let carriedOver: RenewalsView['carriedOver'] = null
  if (row.successor) {
    const coverage = await db.certificateCoverage.findMany({ where: { certificateId: { in: [row.id, row.successor.id] }, status: 'ACTIVE', styleId: { not: null } }, select: { certificateId: true, styleId: true, style: { select: { code: true, name: true } } } })
    const theirs = new Set(coverage.filter((entry) => entry.certificateId === row.successor!.id).map((entry) => entry.styleId))
    carriedOver = coverage
      .filter((entry) => entry.certificateId === row.id && entry.style)
      .map((entry) => ({ styleId: entry.styleId!, code: entry.style!.code, name: entry.style!.name, covered: theirs.has(entry.styleId) }))
      .sort((a, b) => a.code.localeCompare(b.code))
  }

  const taskStatus = taskRow?.status ?? null
  const started = current !== null && current.status !== 'CANCELLED' && taskStatus !== 'CANCELLED'
  return {
    today,
    certificate: {
      id: row.id,
      number: row.number,
      status: row.status,
      standard: row.standard,
      ppeClass: row.ppeClass,
      companyId: row.companyId,
      holderPartyId: row.holderPartyId,
      notifiedBodyName: row.notifiedBodyName,
      notifiedBodyNumber: row.notifiedBodyNumber,
      validFrom: dayOf(row.validFrom),
      validTo,
      daysToExpiry: daysToExpiry(validTo, today),
      version: row.version,
    },
    window: { ...window, phase: windowPhase(validTo, today) },
    stages,
    renewal: current
      ? {
          /** B-W2b-17: the renewal's row (CertificateRenewal) and its state. */
          id: current.id,
          status: current.status,
          startedAt: toUtcIso(current.startedAt),
          startedBy: current.startedById ? (names.get(current.startedById) ?? null) : null,
          taskId: current.taskId,
          task: visibleTask
            ? {
                id: visibleTask.id,
                title: visibleTask.title,
                status: visibleTask.status as 'OPEN' | 'DONE' | 'CANCELLED',
                dueDate: visibleTask.dueDate ? dayOf(visibleTask.dueDate) : null,
                assignee: visibleTask.assigneeId ? (names.get(visibleTask.assigneeId) ?? null) : null,
                checklist: checklist.map((item) => ({ text: String(item.text ?? ''), done: item.done === true, doneAt: textOf(item.doneAt), doneBy: textOf(item.doneById) ? (names.get(String(item.doneById)) ?? null) : null })),
              }
            : null,
          appliedOn,
          reference: current.applicationReference,
          note: current.applicationNote,
          inWindow: current.appliedInWindow,
          window: { opens: dayOf(current.windowOpensOn), closes: dayOf(current.windowClosesOn) },
        }
      : null,
    successor: row.successor ? refOf(row.successor) : null,
    renews: row.renews ? refOf(row.renews) : null,
    candidates: candidates.map(refOf),
    carriedOver,
    nextStep: renewalNextStep({ status: row.status, successorId: row.successorId, started, appliedOn }),
    // Each renewal's steps from its row, oldest first (a cancelled renewal's own start and application stay in the log).
    log: rows
      .flatMap((entry) => [
        { at: entry.startedAt, action: 'STARTED' as const, byId: entry.startedById, detail: dayOf(entry.windowClosesOn) },
        ...(entry.appliedAt ? [{ at: entry.appliedAt, action: 'APPLIED' as const, byId: entry.appliedById, detail: entry.appliedOn ? dayOf(entry.appliedOn) : null }] : []),
        ...(entry.renewedAt ? [{ at: entry.renewedAt, action: 'RENEWED' as const, byId: entry.renewedById, detail: entry.newCertificateId ? (successorNumbers.get(entry.newCertificateId) ?? null) : null }] : []),
      ])
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .map((entry) => ({ at: toUtcIso(entry.at), action: entry.action, by: entry.byId ? (names.get(entry.byId) ?? null) : null, detail: entry.detail })),
  }
}

/** GET /compliance/certificates/:certificateId/renewals. */
export async function getRenewals(caller: CommandCaller, certificateId: string): Promise<RenewalsView> {
  const context = officeContextOf(caller)
  await readCertificate(caller, certificateId)
  return caller.withClient((db) => renewalsView(db, actorOf(context), context.actorId, certificateId, todayOf()))
}

const answer = async (caller: CommandCaller, certificateId: string) => ({ renewals: await getRenewals(caller, certificateId) })

/** The certificate row for a write, at the version the screen read (409 otherwise). */
async function writable(caller: CommandCaller, certificateId: string, version: number): Promise<RenewalRow> {
  await readCertificate(caller, certificateId)
  const row = await caller.withClient((db) => db.certificate.findUniqueOrThrow({ where: { id: certificateId }, select: RENEWAL_SELECT }))
  mayManage(caller, row)
  if (row.version !== version) throw new StaleVersionError('Certificate', certificateId, row.version, version)
  return row
}

/** Inside a command: the certificate (its row already locked by the version bump). */
const lockedRow = (tx: CommandTx, certificateId: string) => tx.certificate.findUniqueOrThrow({ where: { id: certificateId }, select: RENEWAL_SELECT })

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)
const asDay = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)

/**
 * Inside a certificate's command: its open renewal (STARTED or APPLIED, the newest), else one started now — no task, the
 * window of the certificate's validity — for an application or a link recorded without a start.
 */
async function openRenewalIn(tools: CommandTools, certificate: RenewalRow): Promise<RenewalRecord> {
  const { tx, now } = tools
  const open = (await renewalsOf(tx, certificate.id)).filter((row) => isOpenRenewal(row.status)).at(-1)
  if (open) return open
  const window = renewalWindowOf(dayOf(certificate.validTo))
  const id = newId()
  return tx.certificateRenewal.create({
    data: { id, certificateId: certificate.id, status: 'STARTED', windowOpensOn: asDay(window.opens), windowClosesOn: asDay(window.closes), taskId: null, language: 'it', startedAt: now, startedById: actorIdOf(tools), createdAt: now, updatedAt: now, createdById: actorIdOf(tools) },
    select: RENEWAL_COLUMNS,
  })
}

export interface StartBody {
  readonly version: number
  readonly assigneeId?: string | null | undefined
  readonly language?: Locale | undefined
}

/** POST /compliance/certificates/:certificateId/renewals/start. */
export async function startRenewal(caller: CommandCaller, certificateId: string, body: StartBody, idempotencyKey?: string) {
  const row = await writable(caller, certificateId, body.version)
  // Still open: a STARTED or APPLIED renewal whose task is open. (An open renewal without a task — started by recording
  // its application, or before tasks — takes the new task; one whose task was closed gives way to a new renewal.)
  const openTask = async (db: Reader) => {
    const open = (await renewalsOf(db, certificateId)).filter((row) => isOpenRenewal(row.status))
    for (const row of open) if (row.taskId !== null && (await taskStatusOf(db, row.taskId)) === 'OPEN') return true
    return false
  }
  refuse(startRefusal(renewalFacts(row), await caller.withClient(openTask)))
  const facts = renewalFacts(row)
  const words = renewalTask({ number: row.number, notifiedBodyName: row.notifiedBodyName, notifiedBodyNumber: row.notifiedBodyNumber, validTo: facts.validTo }, body.language ?? 'it')
  const { task } = await createTask(
    caller,
    {
      title: words.title,
      description: words.description,
      record: { type: 'Certificate', id: certificateId },
      ...(body.assigneeId === undefined ? {} : { assigneeId: body.assigneeId }),
      dueDate: words.dueDate,
      checklist: words.checklist.map((text) => ({ text })),
    },
    idempotencyKey ? `${idempotencyKey}:task` : undefined,
  )
  const window = renewalWindowOf(facts.validTo)
  await certificateCommand(
    caller,
    { name: RENEWAL_COMMANDS.start, idempotencyKey, input: { certificateId, ...body }, record: { type: 'Certificate', id: certificateId, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now } = tools
      const locked = await lockedRow(tx, certificateId)
      // A replay of this start (same task) answers the renewal it made.
      const mine = await tx.certificateRenewal.findFirst({ where: { certificateId, taskId: task.id }, select: { id: true } })
      if (mine) return { taskId: task.id, windowOpens: window.opens, windowCloses: window.closes, renewalId: mine.id }
      const open = (await renewalsOf(tx, certificateId)).filter((row) => isOpenRenewal(row.status))
      let stillOpen = false
      for (const row of open) if (row.taskId !== null && (await taskStatusOf(tx, row.taskId)) === 'OPEN') stillOpen = true
      refuse(startRefusal(renewalFacts(locked), stillOpen))
      // An open renewal without a task takes this one (its task is named once).
      const taskless = open.filter((row) => row.taskId === null).at(-1)
      if (taskless) {
        await tx.certificateRenewal.update({ where: { id: taskless.id }, data: { taskId: task.id, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
        const after = { taskId: task.id, windowOpens: window.opens, windowCloses: window.closes, renewalId: taskless.id }
        tools.audit({ recordType: 'Certificate', recordId: certificateId, companyId: locked.companyId, after })
        tools.emit({ type: 'compliance.renewal_started', subject: certificateId, companyId: locked.companyId, payload: { certificateId, number: locked.number, taskId: task.id, windowOpens: window.opens, windowCloses: window.closes } })
        return after
      }
      // An open renewal whose task was closed without it gives way to the new one (cancelled, with why).
      for (const row of open) {
        await tx.certificateRenewal.update({ where: { id: row.id }, data: { status: 'CANCELLED', cancelledAt: now, cancelledById: actorIdOf(tools), cancelReason: RENEWAL_RESTARTED, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
        tools.audit({ action: 'compliance.renewals.cancel', recordType: 'CertificateRenewal', recordId: row.id, companyId: locked.companyId, before: { status: row.status }, after: { status: 'CANCELLED', cancelReason: RENEWAL_RESTARTED } })
      }
      const renewalId = newId()
      await tx.certificateRenewal.create({
        data: { id: renewalId, certificateId, status: 'STARTED', windowOpensOn: asDay(window.opens), windowClosesOn: asDay(window.closes), taskId: task.id, language: body.language ?? 'it', startedAt: now, startedById: actorIdOf(tools), createdAt: now, updatedAt: now, createdById: actorIdOf(tools) },
        select: { id: true },
      })
      const after = { taskId: task.id, windowOpens: window.opens, windowCloses: window.closes, renewalId }
      tools.audit({ recordType: 'Certificate', recordId: certificateId, companyId: locked.companyId, after })
      tools.emit({ type: 'compliance.renewal_started', subject: certificateId, companyId: locked.companyId, payload: { certificateId, number: locked.number, taskId: task.id, windowOpens: window.opens, windowCloses: window.closes } })
      return after
    },
  )
  return answer(caller, certificateId)
}

export interface AppliedBody {
  readonly version: number
  readonly appliedOn: BusinessDate
  readonly reference?: string | null | undefined
  readonly note?: string | null | undefined
}

/** POST /compliance/certificates/:certificateId/renewals/applied. */
export async function recordApplication(caller: CommandCaller, certificateId: string, body: AppliedBody, idempotencyKey?: string) {
  await writable(caller, certificateId, body.version)
  await certificateCommand(
    caller,
    { name: RENEWAL_COMMANDS.applied, idempotencyKey, input: { certificateId, ...body }, record: { type: 'Certificate', id: certificateId, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now } = tools
      const locked = await lockedRow(tx, certificateId)
      const facts = renewalFacts(locked)
      refuse(appliedRefusal(facts, body.appliedOn, todayOf(certificatesClock())))
      const renewal = await openRenewalIn(tools, locked)
      refuse(alreadyAppliedRefusal(locked, renewal.appliedOn ? dayOf(renewal.appliedOn) : null))
      const window = { opens: dayOf(renewal.windowOpensOn), closes: dayOf(renewal.windowClosesOn) }
      const inWindow = daysBetween(window.opens, body.appliedOn) >= 0 && daysBetween(body.appliedOn, window.closes) >= 0
      const after = { appliedOn: body.appliedOn, reference: body.reference?.trim() || null, note: body.note?.trim() || null, inWindow, renewalId: renewal.id }
      await tx.certificateRenewal.update({
        where: { id: renewal.id },
        data: { status: 'APPLIED', appliedOn: asDay(body.appliedOn), applicationReference: after.reference, applicationNote: after.note, appliedInWindow: inWindow, appliedAt: now, appliedById: actorIdOf(tools), version: { increment: 1 }, updatedAt: now },
        select: { id: true },
      })
      tools.audit({ recordType: 'Certificate', recordId: certificateId, companyId: locked.companyId, after })
      tools.emit({ type: 'compliance.renewal_applied', subject: certificateId, companyId: locked.companyId, payload: { certificateId, number: locked.number, appliedOn: body.appliedOn, inWindow } })
      return after
    },
  )
  return answer(caller, certificateId)
}

/** POST /compliance/certificates/:certificateId/renewals/successor. */
export async function linkSuccessor(caller: CommandCaller, certificateId: string, body: { readonly version: number; readonly successorId: string }, idempotencyKey?: string) {
  const old = await writable(caller, certificateId, body.version)
  await readCertificate(caller, body.successorId)
  const successorOf = (db: Reader) => db.certificate.findUniqueOrThrow({ where: { id: body.successorId }, select: { ...RENEWAL_SELECT, renews: { select: { id: true } } } })
  const successor = await caller.withClient(successorOf)
  mayManage(caller, successor)
  refuse(successorRefusal(renewalFacts(old), renewalFacts(successor), successor.renews?.id ?? null))
  await certificateCommand(
    caller,
    { name: RENEWAL_COMMANDS.link, idempotencyKey, input: { certificateId, ...body }, record: { type: 'Certificate', id: certificateId, expectedVersion: body.version } },
    async (tools) => {
      const { tx } = tools
      // The expiry alerts' lock (the alert engine and the timers take it first too), then the successor read under a share lock.
      await lockKind(tx, tenantIdOf(tools.context), 'CERTIFICATE_EXPIRING')
      await tx.$queryRaw`SELECT id FROM "Certificate" WHERE id = ${body.successorId}::uuid FOR SHARE`
      const locked = await lockedRow(tx, certificateId)
      const next = await successorOf(tx)
      refuse(successorRefusal(renewalFacts(locked), renewalFacts(next), next.renews?.id ?? null))
      await tx.certificate.update({ where: { id: certificateId }, data: { successorId: next.id }, select: { id: true } })
      // B-W2b-17: the renewal row is RENEWED with the new certificate (one is started now when none was).
      const renewal = await openRenewalIn(tools, locked)
      await tx.certificateRenewal.update({ where: { id: renewal.id }, data: { status: 'RENEWED', newCertificateId: next.id, renewedAt: tools.now, renewedById: actorIdOf(tools), version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
      const timersCancelled = await cancelTimersOfRecord(tools, { type: 'Certificate', id: certificateId }, `Renewed by certificate ${next.number}: no more expiry alerts for ${locked.number}.`)
      const open = await tx.alert.findMany({ where: { recordType: 'Certificate', recordId: certificateId, ruleKind: 'CERTIFICATE_EXPIRING', state: { not: 'RESOLVED' } }, select: { id: true } })
      let alertsCleared = 0
      for (const alert of open) if (await clearInCommand(tools, alert.id)) alertsCleared++
      const after = { successorId: next.id, successorNumber: next.number, timersCancelled, alertsCleared, renewalId: renewal.id }
      tools.audit({ recordType: 'Certificate', recordId: certificateId, companyId: locked.companyId, before: { successorId: null }, after })
      tools.emit({ type: 'compliance.certificate_renewed', subject: certificateId, companyId: locked.companyId, payload: { certificateId, number: locked.number, successorId: next.id, successorNumber: next.number } })
      return after
    },
  )
  return answer(caller, certificateId)
}
