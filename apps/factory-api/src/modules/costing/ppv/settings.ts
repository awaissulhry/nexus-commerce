import type { Prisma } from '@nexus/factory-db'
import { DomainError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { COSTING_ACTUALS_MANAGE } from '@nexus/factory-domain/costing/landed/permissions'
import type { PpvAt } from '@nexus/factory-domain/costing/ppv/rules'
import { ACCOUNTANT_WAITS, PPV_AT_WORDS, settingsWords, type ActualSettingsBody, type ActualSettingsView, type SettingsRefusal } from '@nexus/factory-domain/costing/ppv/settings'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { peopleNames } from '../../accounting/store'
import { contextOf } from '../../product/materials/store'
import type { Reader } from '../actual/store'

/**
 * The actual-cost settings of a company (B-W2b-407; GATE-ACCOUNTANT; ActualCostSettings, B-W2b-376): read by the purchase
 * price variance, cost of goods sold and landed cost before they write anything, and kept by a person with
 * costing.actuals.manage (a fresh step-up: the accountant's word). The row's id is the company's id (the tenant-wide row's
 * id is the tenant's); the company's row wins, then the tenant's, then the defaults: RECEIPT, 5 %, the switch OFF. The
 * switch is on only on a company's own row (the database holds it too). Also here: the database's own refusals of these
 * tables in words (`refusalOf`), and who may act on a company.
 */

const COLUMNS = { id: true, companyId: true, closeTolerancePct: true, ppvAt: true, postingsOn: true, postingsOnAt: true, postingsOnById: true, version: true } as const satisfies Prisma.ActualCostSettingsSelect
type Row = Prisma.ActualCostSettingsGetPayload<{ select: typeof COLUMNS }>

export interface ActualSettings {
  readonly companyId: string
  readonly own: Row | null
  readonly ppvAt: PpvAt
  readonly ppvAtFrom: 'COMPANY' | 'TENANT' | 'DEFAULT'
  readonly closeTolerancePct: string
  readonly postingsOn: boolean
  readonly postingsOnAt: Date | null
  readonly postingsOnById: string | null
}

/** A company's settings in force (its own row, the tenant-wide one, the defaults). */
export async function actualSettingsOf(db: Reader, companyId: string): Promise<ActualSettings> {
  const rows = await db.actualCostSettings.findMany({ where: { OR: [{ companyId }, { companyId: null }] }, select: COLUMNS, orderBy: { id: 'asc' } })
  const own = rows.find((row) => row.companyId === companyId) ?? null
  const tenant = rows.find((row) => row.companyId === null) ?? null
  const from = own ?? tenant
  return {
    companyId,
    own,
    ppvAt: (from?.ppvAt ?? 'RECEIPT') as PpvAt,
    ppvAtFrom: own ? 'COMPANY' : tenant ? 'TENANT' : 'DEFAULT',
    closeTolerancePct: (from?.closeTolerancePct ?? '5').toString(),
    postingsOn: own?.postingsOn ?? false,
    postingsOnAt: own?.postingsOn ? own.postingsOnAt : null,
    postingsOnById: own?.postingsOn ? own.postingsOnById : null,
  }
}

/** The words a company's figures wait with while its switch is off; null while on. */
export async function waitsOf(db: Reader, companyId: string | undefined): Promise<string | null> {
  if (!companyId) return null
  return (await actualSettingsOf(db, companyId)).postingsOn ? null : ACCOUNTANT_WAITS
}

const refused = (code: SettingsRefusal, message: string): DomainError => new DomainError('conflict', message, [{ path: `refusal/${code}`, message }])

/** A check_violation of the actual-cost tables ('cost: …', the …_cost_actuals_w2b_guards) in words, as a 409; else the error. */
export function refusalOf(error: unknown): unknown {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
  if (cause?.originalCode !== '23514' || typeof cause.originalMessage !== 'string' || !cause.originalMessage.startsWith('cost: ')) return error
  const words = cause.originalMessage.slice('cost: '.length)
  const message = `${words.charAt(0).toUpperCase()}${words.slice(1)}${words.endsWith('.') ? '' : '.'}`
  return new DomainError('conflict', message, [{ path: 'refusal/DATABASE', message }])
}

/** The company exists for the caller with the permission (else 404: the caller may not know it exists). */
export async function assertCompany(caller: CommandCaller, companyId: string, permission: Permission = COSTING_VIEW): Promise<RequestContext> {
  const context = contextOf(caller)
  const row = isUuid(companyId) ? await caller.withClient((db) => db.company.findUnique({ where: { id: companyId }, select: { id: true } })) : null
  if (!row || !can(actorOf(context), COSTING_VIEW, { companyId })) throw new NotFoundError('Company not found.')
  if (permission !== COSTING_VIEW && !can(actorOf(context), permission, { companyId })) throw new ForbiddenError()
  return context
}

async function viewOf(db: Reader, context: RequestContext, settings: ActualSettings): Promise<ActualSettingsView> {
  const names = await peopleNames(db, [settings.postingsOnById])
  const manage = can(actorOf(context), COSTING_ACTUALS_MANAGE, { companyId: settings.companyId })
  return {
    companyId: settings.companyId,
    settingsId: settings.own?.id ?? null,
    version: settings.own?.version ?? null,
    ppvAt: settings.ppvAt,
    ppvAtFrom: settings.ppvAtFrom,
    ppvAtWords: PPV_AT_WORDS[settings.ppvAt],
    closeTolerancePct: settings.closeTolerancePct,
    postingsOn: settings.postingsOn,
    postingsOnAt: settings.postingsOnAt ? toUtcIso(settings.postingsOnAt) : null,
    postingsOnBy: settings.postingsOnById ? { id: settings.postingsOnById, name: names.get(settings.postingsOnById) ?? '' } : null,
    waits: settings.postingsOn ? null : ACCOUNTANT_WAITS,
    words: settingsWords({ ppvAt: settings.ppvAt, postingsOn: settings.postingsOn, postingsOnDay: settings.postingsOnAt ? businessDate(settings.postingsOnAt) : null }),
    can: { manage, changePpvAt: manage && !settings.postingsOn },
  }
}

/** GET /costing/actuals/settings?companyId */
export async function actualSettingsView(caller: CommandCaller, companyId: string): Promise<ActualSettingsView> {
  const context = await assertCompany(caller, companyId)
  return caller.withClient(async (db) => viewOf(db, context, await actualSettingsOf(db, companyId)))
}

/**
 * PUT /costing/actuals/settings: switch the company's figures on or off, or choose where its purchase price variance is
 * taken (only while off). The company's own row is made at the first change (the tenant-wide values copied: the
 * company keeps what it followed). Nothing changing is refused in words.
 */
export async function saveActualSettings(caller: CommandCaller, body: ActualSettingsBody, idempotencyKey?: string): Promise<{ settings: ActualSettingsView; replayed: boolean }> {
  await assertCompany(caller, body.companyId, COSTING_ACTUALS_MANAGE)
  const before = await caller.withClient((db) => actualSettingsOf(db, body.companyId))
  const { result, replayed } = await command(
    caller,
    {
      name: 'costing.saveActualSettings',
      idempotencyKey,
      input: body,
      ...(before.own ? { record: { type: 'ActualCostSettings' as const, id: before.own.id, ...(body.version === undefined ? {} : { expectedVersion: body.version }) } } : {}),
    },
    async (tools) => {
      const { tx, now } = tools
      if (tools.context.audience !== 'office') throw new ForbiddenError()
      const current = await actualSettingsOf(tx, body.companyId)
      const ppvAt = body.ppvAt ?? current.ppvAt
      const postingsOn = body.postingsOn ?? current.postingsOn
      const fields = [...(ppvAt !== current.ppvAt || (body.ppvAt !== undefined && current.ppvAtFrom !== 'COMPANY') ? (['ppvAt'] as const) : []), ...(postingsOn !== current.postingsOn ? (['postingsOn'] as const) : [])]
      if (fields.length === 0) throw refused('NOTHING_CHANGES', 'Nothing changes: the settings are already so.')
      if (ppvAt !== current.ppvAt && current.postingsOn && postingsOn) {
        throw refused('PPV_AT_WHILE_ON', 'Where the purchase price variance is taken changes only while the figures for the accountant are off: a change while they are written would take one purchase twice, at the receipt and at the invoice. Switch them off first.')
      }
      const on = postingsOn ? { postingsOn: true, postingsOnAt: current.postingsOn ? current.postingsOnAt : now, postingsOnById: current.postingsOn ? current.postingsOnById : tools.context.actorId } : { postingsOn: false, postingsOnAt: null, postingsOnById: null }
      const row = current.own
        ? await tx.actualCostSettings.update({ where: { id: current.own.id }, data: { ppvAt, ...on, updatedAt: now }, select: COLUMNS })
        : await tx.actualCostSettings.create({ data: { id: body.companyId, companyId: body.companyId, ppvAt, closeTolerancePct: current.closeTolerancePct, ...on, createdAt: now, updatedAt: now, createdById: tools.context.actorId }, select: COLUMNS })
      tools.audit({
        action: 'costing.saveActualSettings',
        recordType: 'ActualCostSettings',
        recordId: row.id,
        companyId: body.companyId,
        before: { ppvAt: current.ppvAt, postingsOn: current.postingsOn },
        after: { ppvAt, postingsOn },
        ...(body.reason ? { reason: body.reason } : {}),
      })
      tools.emit({ type: 'actual_cost_settings.changed', subject: row.id, companyId: body.companyId, payload: { settingsId: row.id, companyId: body.companyId, fields: [...fields], postingsOn } })
      return viewOf(tx, tools.context, await actualSettingsOf(tx, body.companyId))
    },
  )
  return { settings: result, replayed }
}

/** The HARD lock (the accountant's) a company's day is inside, in words; null when open. Every figure here is dated now. */
export async function hardLockWords(db: Reader, companyId: string, day: string): Promise<string | null> {
  const at = new Date(`${day}T00:00:00.000Z`)
  const lock = await db.periodLock.findFirst({ where: { companyId, status: 'LOCKED', level: 'HARD', periodStart: { lte: at }, periodEnd: { gte: at } }, select: { periodStart: true, periodEnd: true } })
  return lock ? `Today is inside the closed period ${lock.periodStart.toISOString().slice(0, 10)} to ${lock.periodEnd.toISOString().slice(0, 10)} (a HARD lock, the accountant's): it is written once the lock is lifted.` : null
}
