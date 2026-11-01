import { ConflictError, DomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { markMoney } from '@nexus/factory-domain/money/marked'
import type { PIECE_RATE_VERSION_CHANGES } from '@nexus/factory-domain/people/events'
import { PEOPLE_PIECERATES_MANAGE } from '@nexus/factory-domain/people/piecerates/permissions'
import {
  CODE_PATTERN,
  cancelRefusal,
  confirmRefusal,
  editRefusal,
  publishRefusal,
  ratesOf,
  reasonProblems,
  termsProblems,
  type ChangeReason,
  type Rate,
  type RateInput,
  type VersionStatus,
} from '@nexus/factory-domain/people/piecerates/rates'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeOf, payGuarded, PieceRateRefusedError, refuseProblems, refuseVersion } from './access'
import type { VersionDetail } from './contract'
import {
  audienceOf,
  dateOf,
  day,
  inForcePlanFor,
  RATE_SELECT,
  siteOf,
  TABLE_SELECT,
  tableDetailOf,
  tableOf,
  todayOf,
  toldOf,
  VERSION_SELECT,
  versionDetailOf,
  versionOf,
  versionRowOf,
  type Db,
  type TableRow,
  type VersionRecord,
} from './store'

/**
 * The writes of piece rates (B-W2b-34; MES-254, MES-255, MES-262; design people.piecerates "Rate table", pop-ups "New
 * rate version" and "Publish rates"; c.c. arts. 2100-2101). Each is ONE command with its audit rows and events, under
 * people.piecerates.manage on the table's company and site; a rate in a body needs the pay grain (the grain filter
 * refuses it otherwise). The rules are factory-domain people/piecerates/rates (the database holds them again):
 *
 *   tables         add (code unique on the site; a style of the company or the tenant; a line of the site), change
 *                  (style, line and currency only while no version left DRAFT), archive (no draft and no rate in force)
 *   new version    a DRAFT with why it changes, its first day, provisional with the last day of its trial (MES-262), and
 *                  its rates: copied from the latest version (a new rate is a new version, never an edit) or typed; a
 *                  rate on SMV × rate per minute takes the operation's standard minutes when none is typed
 *   publish        to workers of the site (the line's by home line, or the ones chosen) on the floor and/or as a printed
 *                  sheet; a DRAFT is put in force in the same command unless asked not to: told before it applies
 *   put in force   PROVISIONAL or PUBLISHED; the open version before it ends the day before and is SUPERSEDED
 *   confirm        a provisional rate from the last day of its trial (one, or many at once: all or none)
 *   cancel         a DRAFT, with why; withdraw a publication of a DRAFT, with why
 *   paper          the office records signed paper copies of a publication (a receipt per worker; the scan optional)
 */

type VersionChange = (typeof PIECE_RATE_VERSION_CHANGES)[number]

const trimmed = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/** One command's lock on a table: making a version, putting one in force (the guard takes the same lock). */
const lockTable = (tools: CommandTools, tenantId: string, tableId: string) => tools.tx.$executeRaw`SELECT "factory_pay_lock"('factory.pay.rate-table', ${tenantId}::uuid, ${tableId}::uuid)`

const rateAudit = (rates: readonly Rate[]) =>
  rates.map((rate) => ({
    operationId: rate.operationId,
    sizeBand: rate.sizeBand,
    basis: rate.basis,
    standardMinutes: rate.standardMinutes,
    ratePerMinute: rate.ratePerMinute === null ? null : markMoney('pay', rate.ratePerMinute),
    ratePerPiece: markMoney('pay', rate.ratePerPiece),
  }))

const versionAudit = (row: VersionRecord) => ({
  versionNo: row.versionNo,
  status: row.status,
  changeReason: row.changeReason,
  changeNote: row.changeNote,
  effectiveFrom: day(row.effectiveFrom),
  effectiveTo: day(row.effectiveTo),
  provisional: row.provisional,
  trialEndsOn: day(row.trialEndsOn),
})

function emitVersion(tools: CommandTools, row: { id: string; tableId: string; siteId: string; companyId: string; versionNo: number }, change: VersionChange, status: VersionStatus): void {
  tools.emit({
    type: 'piece_rate_version.changed',
    subject: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    payload: { versionId: row.id, tableId: row.tableId, siteId: row.siteId, versionNo: row.versionNo, change, status },
  })
}

/** The rates of a body made whole: every operation of the tenant library, SMV from the operation when not typed. */
async function ratesFor(db: Db, table: Pick<TableRow, 'companyId'>, inputs: readonly RateInput[]): Promise<Rate[]> {
  const operationIds = [...new Set(inputs.map((input) => input.operationId))]
  const operations = operationIds.length === 0 ? [] : await db.operation.findMany({ where: { id: { in: operationIds } }, select: { id: true, companyId: true, standardMinutes: true, status: true } })
  const byId = new Map(operations.map((row) => [row.id, row]))
  const problems: Issue[] = []
  inputs.forEach((input, index) => {
    const operation = byId.get(input.operationId)
    if (!operation || (operation.companyId !== null && operation.companyId !== table.companyId)) problems.push({ path: `rates/${index}/operationId`, message: 'No such operation in Products › Operations for this company.' })
    else if (operation.status !== 'ACTIVE') problems.push({ path: `rates/${index}/operationId`, message: 'This operation is archived in Products › Operations.' })
  })
  refuseProblems(problems, 'Some rates name an operation that cannot be paid.')
  const filled = inputs.map((input) => (input.basis === 'SMV_RATE' && (input.standardMinutes === undefined || input.standardMinutes === null || input.standardMinutes.trim() === '') ? { ...input, standardMinutes: byId.get(input.operationId)!.standardMinutes.toString() } : input))
  const { rates, problems: rateProblems } = ratesOf(filled)
  refuseProblems(rateProblems, 'Some rates are not complete.')
  return rates
}

const rateRows = (rates: readonly Rate[], version: { id: string; siteId: string }, actorId: string) =>
  rates.map((rate) => ({
    id: newId(),
    siteId: version.siteId,
    versionId: version.id,
    operationId: rate.operationId,
    sizeBand: rate.sizeBand,
    basis: rate.basis,
    standardMinutes: rate.standardMinutes,
    ratePerMinute: rate.ratePerMinute,
    ratePerPiece: rate.ratePerPiece,
    note: rate.note,
    createdById: actorId,
  }))

const rateOfRecord = (row: { operationId: string; sizeBand: string; basis: string; standardMinutes: { toString(): string } | null; ratePerMinute: { toString(): string } | null; ratePerPiece: { toString(): string }; note: string | null }): Rate => ({
  operationId: row.operationId,
  sizeBand: row.sizeBand,
  basis: row.basis as Rate['basis'],
  standardMinutes: row.standardMinutes === null ? null : row.standardMinutes.toString(),
  ratePerMinute: row.ratePerMinute === null ? null : row.ratePerMinute.toString(),
  ratePerPiece: row.ratePerPiece.toString(),
  note: row.note,
})

// ---- tables ---------------------------------------------------------------------------------------------------------

async function styleAndLine(db: Db, companyId: string, siteId: string, body: { styleId?: string | null | undefined; lineId?: string | null | undefined }): Promise<Issue[]> {
  const problems: Issue[] = []
  if (body.styleId) {
    const style = await db.style.findUnique({ where: { id: body.styleId }, select: { companyId: true } })
    if (!style || (style.companyId !== null && style.companyId !== companyId)) problems.push({ path: 'styleId', message: 'No such style for this company.' })
  }
  if (body.lineId) {
    const line = await db.line.findFirst({ where: { id: body.lineId, siteId }, select: { id: true } })
    if (!line) problems.push({ path: 'lineId', message: 'No such line at this site.' })
  }
  return problems
}

export interface CreateTableBody {
  readonly siteId: string
  readonly code: string
  readonly name: string
  readonly styleId?: string | null | undefined
  readonly lineId?: string | null | undefined
  readonly currency?: string | undefined
  readonly note?: string | null | undefined
}

export async function createTable(caller: CommandCaller, body: CreateTableBody, idempotencyKey?: string) {
  const { context, site } = await siteOf(caller, body.siteId, PEOPLE_PIECERATES_MANAGE)
  const code = body.code.trim().toUpperCase()
  const problems: Issue[] = []
  if (!CODE_PATTERN.test(code)) problems.push({ path: 'code', message: 'A code is 1 to 20 capital letters, digits or hyphens.' })
  if (body.name.trim() === '') problems.push({ path: 'name', message: 'Give the table a name.' })
  problems.push(...(await caller.withClient((client) => styleAndLine(client, site.companyId, site.id, body))))
  refuseProblems(problems, 'This table cannot be added yet.')
  const { result, replayed } = await command(caller, { name: 'people.createPieceRateTable', idempotencyKey, input: body }, async (tools) => {
    const taken = await tools.tx.pieceRateTable.findFirst({ where: { siteId: site.id, code }, select: { id: true } })
    if (taken) throw new ValidationError(`The code ${code} is taken at this site.`, [{ path: 'code', message: 'Taken at this site.' }])
    const id = newId()
    await tools.tx.pieceRateTable.create({
      data: { id, companyId: site.companyId, siteId: site.id, code, name: body.name.trim(), styleId: body.styleId ?? null, lineId: body.lineId ?? null, currency: body.currency ?? 'EUR', note: trimmed(body.note), createdById: context.actorId },
      select: { id: true },
    })
    tools.audit({ action: 'people.createPieceRateTable', recordType: 'PieceRateTable', recordId: id, companyId: site.companyId, siteId: site.id, after: { code, name: body.name.trim(), styleId: body.styleId ?? null, lineId: body.lineId ?? null, currency: body.currency ?? 'EUR' } })
    tools.emit({ type: 'piece_rate_table.changed', subject: id, companyId: site.companyId, siteId: site.id, payload: { tableId: id, siteId: site.id, change: 'CREATED' } })
    return tableDetailOf(tools.tx, context, id, tools.now)
  })
  return { ...result, replayed }
}

export async function updateTable(
  caller: CommandCaller,
  tableId: string,
  body: { readonly version: number; readonly name?: string | undefined; readonly note?: string | null | undefined; readonly styleId?: string | null | undefined; readonly lineId?: string | null | undefined; readonly currency?: string | undefined },
  idempotencyKey?: string,
) {
  const { context, table } = await tableOf(caller, tableId, PEOPLE_PIECERATES_MANAGE)
  const problems: Issue[] = []
  if (body.name !== undefined && body.name.trim() === '') problems.push({ path: 'name', message: 'Give the table a name.' })
  problems.push(...(await caller.withClient((client) => styleAndLine(client, table.companyId, table.siteId, body))))
  refuseProblems(problems, 'This table cannot change this way.')
  const { result } = await command(caller, { name: 'people.updatePieceRateTable', idempotencyKey, input: body, record: { type: 'PieceRateTable', id: table.id, expectedVersion: body.version } }, async (tools) => {
    const before = (await tools.tx.pieceRateTable.findUnique({ where: { id: table.id }, select: TABLE_SELECT }))!
    const data = {
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.note !== undefined ? { note: trimmed(body.note) } : {}),
      ...(body.styleId !== undefined ? { styleId: body.styleId } : {}),
      ...(body.lineId !== undefined ? { lineId: body.lineId } : {}),
      ...(body.currency !== undefined ? { currency: body.currency } : {}),
    }
    const touchesFixed = (body.styleId !== undefined && body.styleId !== before.styleId) || (body.lineId !== undefined && body.lineId !== before.lineId) || (body.currency !== undefined && body.currency !== before.currency)
    if (touchesFixed && (await tools.tx.pieceRateVersion.count({ where: { tableId: table.id, status: { not: 'DRAFT' } } })) > 0) {
      throw new ConflictError('This table has rates that were put in force: its style, line and currency stay as they are. Make a new table for other ones.')
    }
    await tools.tx.pieceRateTable.update({ where: { id: table.id }, data, select: { id: true } })
    tools.audit({ action: 'people.updatePieceRateTable', recordType: 'PieceRateTable', recordId: table.id, companyId: table.companyId, siteId: table.siteId, before: { name: before.name, note: before.note, styleId: before.styleId, lineId: before.lineId, currency: before.currency }, after: data })
    tools.emit({ type: 'piece_rate_table.changed', subject: table.id, companyId: table.companyId, siteId: table.siteId, payload: { tableId: table.id, siteId: table.siteId, change: 'EDITED' } })
    return tableDetailOf(tools.tx, context, table.id, tools.now)
  })
  return result
}

export async function archiveTable(caller: CommandCaller, tableId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const { context, table } = await tableOf(caller, tableId, PEOPLE_PIECERATES_MANAGE)
  if (table.status === 'ARCHIVED') throw new ConflictError('This table is archived already.')
  const { result } = await command(caller, { name: 'people.archivePieceRateTable', idempotencyKey, input: body, record: { type: 'PieceRateTable', id: table.id, expectedVersion: body.version } }, async (tools) => {
    const open = await tools.tx.pieceRateVersion.findFirst({ where: { tableId: table.id, OR: [{ status: 'DRAFT' }, { status: { in: ['PROVISIONAL', 'PUBLISHED'] }, effectiveTo: null }] }, select: { versionNo: true, status: true } })
    if (open) {
      throw new ConflictError(
        open.status === 'DRAFT' ? `Version ${open.versionNo} is a draft: cancel it first.` : `Version ${open.versionNo} pays with no last day: a table with rates in force stays active (its rates are told to the workers).`,
      )
    }
    await tools.tx.pieceRateTable.update({ where: { id: table.id }, data: { status: 'ARCHIVED' }, select: { id: true } })
    tools.audit({ action: 'people.archivePieceRateTable', recordType: 'PieceRateTable', recordId: table.id, companyId: table.companyId, siteId: table.siteId, before: { status: 'ACTIVE' }, after: { status: 'ARCHIVED' } })
    tools.emit({ type: 'piece_rate_table.changed', subject: table.id, companyId: table.companyId, siteId: table.siteId, payload: { tableId: table.id, siteId: table.siteId, change: 'ARCHIVED' } })
    return tableDetailOf(tools.tx, context, table.id, tools.now)
  })
  return result
}

// ---- versions -------------------------------------------------------------------------------------------------------

export interface CreateVersionBody {
  readonly changeReason: ChangeReason
  readonly changeNote?: string | null | undefined
  readonly effectiveFrom: string
  readonly provisional?: boolean | undefined
  readonly trialEndsOn?: string | null | undefined
  readonly copy?: 'LATEST' | 'NONE' | undefined
  readonly rates?: readonly RateInput[] | undefined
}

/** "New rate version": a DRAFT with why, its first day, provisional with its trial, and its rates (copied or typed). */
export async function createVersion(caller: CommandCaller, tableId: string, body: CreateVersionBody, idempotencyKey?: string): Promise<VersionDetail & { replayed: boolean }> {
  const { context, table } = await tableOf(caller, tableId, PEOPLE_PIECERATES_MANAGE)
  if (table.status !== 'ACTIVE') throw new ConflictError('This table is archived: it takes no new version.')
  refuseProblems(termsProblems(body), 'This version cannot be made yet.')
  const typed = body.rates === undefined ? null : await caller.withClient((client) => ratesFor(client, table, body.rates!))
  const { result, replayed } = await command(caller, { name: 'people.createRateVersion', idempotencyKey, input: body }, async (tools) => {
    await lockTable(tools, context.tenantId, table.id)
    const latest = await tools.tx.pieceRateVersion.findFirst({ where: { tableId: table.id }, select: { versionNo: true }, orderBy: { versionNo: 'desc' } })
    const source = body.copy === 'NONE' || typed !== null ? null : await tools.tx.pieceRateVersion.findFirst({ where: { tableId: table.id, status: { not: 'CANCELLED' } }, select: { id: true }, orderBy: { versionNo: 'desc' } })
    const rates = typed ?? (source ? (await tools.tx.pieceRateEntry.findMany({ where: { versionId: source.id }, select: RATE_SELECT, orderBy: [{ sizeBand: 'asc' }, { id: 'asc' }] })).map(rateOfRecord) : [])
    const id = newId()
    const versionNo = (latest?.versionNo ?? 0) + 1
    await tools.tx.pieceRateVersion.create({
      data: {
        id,
        companyId: table.companyId,
        siteId: table.siteId,
        tableId: table.id,
        versionNo,
        changeReason: body.changeReason,
        changeNote: trimmed(body.changeNote),
        effectiveFrom: dateOf(body.effectiveFrom),
        provisional: body.provisional === true,
        trialEndsOn: body.provisional === true && body.trialEndsOn ? dateOf(body.trialEndsOn) : null,
        createdById: context.actorId,
      },
      select: { id: true },
    })
    if (rates.length > 0) await tools.tx.pieceRateEntry.createMany({ data: rateRows(rates, { id, siteId: table.siteId }, context.actorId) })
    const after = (await tools.tx.pieceRateVersion.findUnique({ where: { id }, select: VERSION_SELECT }))!
    tools.audit({ action: 'people.createRateVersion', recordType: 'PieceRateVersion', recordId: id, companyId: table.companyId, siteId: table.siteId, after: { ...versionAudit(after), copiedFrom: source?.id ?? null, rates: rateAudit(rates) } })
    emitVersion(tools, after, 'CREATED', 'DRAFT')
    return versionDetailOf(tools.tx, context, id, tools.now)
  })
  return { ...result, replayed }
}

export async function updateVersion(
  caller: CommandCaller,
  versionId: string,
  body: { readonly version: number; readonly changeReason?: ChangeReason | undefined; readonly changeNote?: string | null | undefined; readonly effectiveFrom?: string | undefined; readonly provisional?: boolean | undefined; readonly trialEndsOn?: string | null | undefined },
  idempotencyKey?: string,
): Promise<VersionDetail> {
  const { context, version: current, table } = await versionOf(caller, versionId, PEOPLE_PIECERATES_MANAGE)
  refuseVersion(editRefusal(versionRowOf(current)))
  const provisional = body.provisional ?? current.provisional
  const terms = {
    changeReason: body.changeReason ?? (current.changeReason as ChangeReason),
    changeNote: body.changeNote !== undefined ? body.changeNote : current.changeNote,
    effectiveFrom: body.effectiveFrom ?? day(current.effectiveFrom)!,
    provisional,
    trialEndsOn: !provisional ? null : body.trialEndsOn !== undefined ? body.trialEndsOn : day(current.trialEndsOn),
  }
  refuseProblems(termsProblems(terms), 'This version cannot change this way.')
  const { result } = await command(caller, { name: 'people.updateRateVersion', idempotencyKey, input: body, record: { type: 'PieceRateVersion', id: current.id, expectedVersion: body.version } }, async (tools) => {
    const before = (await tools.tx.pieceRateVersion.findUnique({ where: { id: current.id }, select: VERSION_SELECT }))!
    refuseVersion(editRefusal(versionRowOf(before)))
    await tools.tx.pieceRateVersion.update({
      where: { id: current.id },
      data: { changeReason: terms.changeReason, changeNote: trimmed(terms.changeNote), effectiveFrom: dateOf(terms.effectiveFrom), provisional: terms.provisional, trialEndsOn: terms.trialEndsOn ? dateOf(terms.trialEndsOn) : null },
      select: { id: true },
    })
    const after = (await tools.tx.pieceRateVersion.findUnique({ where: { id: current.id }, select: VERSION_SELECT }))!
    tools.audit({ action: 'people.updateRateVersion', recordType: 'PieceRateVersion', recordId: current.id, companyId: table.companyId, siteId: table.siteId, before: versionAudit(before), after: versionAudit(after) })
    emitVersion(tools, after, 'EDITED', 'DRAFT')
    return versionDetailOf(tools.tx, context, current.id, tools.now)
  })
  return result
}

/** The rates of a DRAFT, all at once (the grid's save): replaced in one command. */
export async function setRates(caller: CommandCaller, versionId: string, body: { readonly version: number; readonly rates: readonly RateInput[] }, idempotencyKey?: string): Promise<VersionDetail> {
  const { context, version: current, table } = await versionOf(caller, versionId, PEOPLE_PIECERATES_MANAGE)
  refuseVersion(editRefusal(versionRowOf(current)))
  const rates = await caller.withClient((client) => ratesFor(client, table, body.rates))
  const { result } = await command(caller, { name: 'people.setRates', idempotencyKey, input: body, record: { type: 'PieceRateVersion', id: current.id, expectedVersion: body.version } }, async (tools) => {
    const state = (await tools.tx.pieceRateVersion.findUnique({ where: { id: current.id }, select: VERSION_SELECT }))!
    refuseVersion(editRefusal(versionRowOf(state)))
    const before = (await tools.tx.pieceRateEntry.findMany({ where: { versionId: current.id }, select: RATE_SELECT })).map(rateOfRecord)
    await payGuarded(async () => {
      await tools.tx.pieceRateEntry.deleteMany({ where: { versionId: current.id } })
      if (rates.length > 0) await tools.tx.pieceRateEntry.createMany({ data: rateRows(rates, current, context.actorId) })
    })
    tools.audit({ action: 'people.setRates', recordType: 'PieceRateVersion', recordId: current.id, companyId: table.companyId, siteId: table.siteId, before: { rates: rateAudit(before) }, after: { rates: rateAudit(rates) } })
    emitVersion(tools, state, 'RATES_SET', 'DRAFT')
    return versionDetailOf(tools.tx, context, current.id, tools.now)
  })
  return result
}

export async function cancelVersion(caller: CommandCaller, versionId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string): Promise<VersionDetail> {
  const { context, version: current, table } = await versionOf(caller, versionId, PEOPLE_PIECERATES_MANAGE)
  refuseVersion(cancelRefusal(versionRowOf(current)))
  refuseProblems(reasonProblems(body.reason), 'Say why this draft is cancelled.')
  const { result } = await command(caller, { name: 'people.cancelRateVersion', idempotencyKey, input: body, record: { type: 'PieceRateVersion', id: current.id, expectedVersion: body.version } }, async (tools) => {
    const before = (await tools.tx.pieceRateVersion.findUnique({ where: { id: current.id }, select: VERSION_SELECT }))!
    refuseVersion(cancelRefusal(versionRowOf(before)))
    await payGuarded(() => tools.tx.pieceRateVersion.update({ where: { id: current.id }, data: { status: 'CANCELLED', cancelledAt: tools.now, cancelReason: body.reason.trim() }, select: { id: true } }))
    const after = (await tools.tx.pieceRateVersion.findUnique({ where: { id: current.id }, select: VERSION_SELECT }))!
    tools.audit({ action: 'people.cancelRateVersion', recordType: 'PieceRateVersion', recordId: current.id, companyId: table.companyId, siteId: table.siteId, before: versionAudit(before), after: versionAudit(after), reason: body.reason.trim() })
    emitVersion(tools, after, 'CANCELLED', 'CANCELLED')
    return versionDetailOf(tools.tx, context, current.id, tools.now)
  })
  return result
}

/** Puts a DRAFT in force inside the caller's command (under the table's lock): supersedes the open version before it. */
async function putInForceInCommand(tools: CommandTools, version: VersionRecord, table: TableRow): Promise<void> {
  const today = todayOf(tools.now)
  const { plan, refusal } = await inForcePlanFor(tools.tx, version, table, today)
  if (!plan) throw new PieceRateRefusedError(refusal!)
  for (const closed of plan.supersedes) {
    const before = (await tools.tx.pieceRateVersion.findUnique({ where: { id: closed.id }, select: VERSION_SELECT }))!
    await payGuarded(() =>
      tools.tx.pieceRateVersion.update({ where: { id: closed.id }, data: { effectiveTo: dateOf(closed.effectiveTo), status: 'SUPERSEDED', supersededAt: tools.now, version: { increment: 1 } }, select: { id: true } }),
    )
    const after = (await tools.tx.pieceRateVersion.findUnique({ where: { id: closed.id }, select: VERSION_SELECT }))!
    tools.audit({ action: 'people.supersedeRateVersion', recordType: 'PieceRateVersion', recordId: closed.id, companyId: table.companyId, siteId: table.siteId, before: versionAudit(before), after: { ...versionAudit(after), supersededBy: version.id } })
    emitVersion(tools, after, 'SUPERSEDED', 'SUPERSEDED')
  }
  await payGuarded(() => tools.tx.pieceRateVersion.update({ where: { id: version.id }, data: { status: plan.status }, select: { id: true } }))
  const after = (await tools.tx.pieceRateVersion.findUnique({ where: { id: version.id }, select: VERSION_SELECT }))!
  tools.audit({ action: 'people.putRateVersionInForce', recordType: 'PieceRateVersion', recordId: version.id, companyId: table.companyId, siteId: table.siteId, before: versionAudit(version), after: { ...versionAudit(after), supersedes: plan.supersedes.map((row) => row.id) } })
  emitVersion(tools, after, 'IN_FORCE', plan.status)
}

export interface PublishBody {
  readonly version: number
  readonly lineId?: string | null | undefined
  readonly workerIds?: readonly string[] | undefined
  readonly onFloor?: boolean | undefined
  readonly printed?: boolean | undefined
  readonly putInForce?: boolean | undefined
}

/**
 * "Publish rates" (MES-255; c.c. art. 2101 c.3): one publication of the version to workers of its site, on the floor
 * (My day) and/or as a printed sheet; a DRAFT goes in force in the same command (unless putInForce is false), so the
 * rates are told on or before their first day. Without workerIds: every ACTIVE worker of the site (the line's, by home
 * line) not told yet.
 */
export async function publish(caller: CommandCaller, versionId: string, body: PublishBody, idempotencyKey?: string): Promise<VersionDetail & { replayed: boolean }> {
  const { context, version: current, table } = await versionOf(caller, versionId, PEOPLE_PIECERATES_MANAGE)
  refuseVersion(publishRefusal(versionRowOf(current)))
  const onFloor = body.onFloor ?? true
  const printed = body.printed ?? false
  if (!onFloor && !printed) throw new ValidationError('Publish on the floor, as a printed sheet, or both.', [{ path: 'onFloor', message: 'Choose at least one.' }])
  const lineId = body.lineId === undefined ? table.lineId : body.lineId
  const { result, replayed } = await command(caller, { name: 'people.publishRates', idempotencyKey, input: body, record: { type: 'PieceRateVersion', id: current.id, expectedVersion: body.version } }, async (tools) => {
    await lockTable(tools, context.tenantId, table.id)
    const state = (await tools.tx.pieceRateVersion.findUnique({ where: { id: current.id }, select: VERSION_SELECT }))!
    refuseVersion(publishRefusal(versionRowOf(state)))
    if (lineId) {
      const line = await tools.tx.line.findFirst({ where: { id: lineId, siteId: table.siteId }, select: { id: true } })
      if (!line) throw new NotFoundError('Line not found at this site.')
    }
    const told = await toldOf(tools.tx, current.id)
    let workerIds: string[]
    if (body.workerIds !== undefined) {
      workerIds = [...new Set(body.workerIds)]
      const active = await tools.tx.worker.findMany({ where: { id: { in: workerIds }, siteId: table.siteId, status: 'ACTIVE' }, select: { id: true } })
      const ok = new Set(active.map((row) => row.id))
      const problems = workerIds.flatMap((workerId, index) => (ok.has(workerId) ? [] : [{ path: `workerIds/${index}`, message: 'Not an active worker of this site.' }]))
      refuseProblems(problems, 'Some of the chosen workers are not active workers of this site.')
    } else {
      workerIds = (await audienceOf(tools.tx, table.siteId, lineId ?? null)).map((row) => row.id).filter((workerId) => !told.has(workerId))
    }
    if (workerIds.length === 0) {
      throw new ConflictError(told.size > 0 ? 'Every active worker here has been given this version already.' : 'There is no active worker here to publish the rates to.')
    }
    const publicationId = newId()
    await payGuarded(() =>
      tools.tx.ratePublication.create({
        data: { id: publicationId, companyId: table.companyId, siteId: table.siteId, versionId: current.id, lineId: lineId ?? null, workerIds, onFloor, printed, publishedAt: tools.now, publishedById: context.actorId, createdById: context.actorId },
        select: { id: true },
      }),
    )
    tools.audit({ action: 'people.publishRates', recordType: 'RatePublication', recordId: publicationId, companyId: table.companyId, siteId: table.siteId, after: { versionId: current.id, versionNo: state.versionNo, lineId: lineId ?? null, workers: workerIds.length, onFloor, printed, publishedAt: toUtcIso(tools.now) } })
    tools.emit({ type: 'rate_publication.changed', subject: publicationId, companyId: table.companyId, siteId: table.siteId, payload: { publicationId, versionId: current.id, siteId: table.siteId, lineId: lineId ?? null, change: 'PUBLISHED', workers: workerIds.length } })
    if (state.status === 'DRAFT' && body.putInForce !== false) await putInForceInCommand(tools, state, table)
    return versionDetailOf(tools.tx, context, current.id, tools.now)
  })
  return { ...result, replayed }
}

/** A DRAFT already published, put in force (PROVISIONAL or PUBLISHED): the open version before it is superseded. */
export async function putInForce(caller: CommandCaller, versionId: string, body: { readonly version: number }, idempotencyKey?: string): Promise<VersionDetail> {
  const { context, version: current, table } = await versionOf(caller, versionId, PEOPLE_PIECERATES_MANAGE)
  refuseVersion(editRefusal(versionRowOf(current)))
  const { result } = await command(caller, { name: 'people.putRateVersionInForce', idempotencyKey, input: body, record: { type: 'PieceRateVersion', id: current.id, expectedVersion: body.version } }, async (tools) => {
    await lockTable(tools, context.tenantId, table.id)
    const state = (await tools.tx.pieceRateVersion.findUnique({ where: { id: current.id }, select: VERSION_SELECT }))!
    await putInForceInCommand(tools, state, table)
    return versionDetailOf(tools.tx, context, current.id, tools.now)
  })
  return result
}

async function confirmInCommand(tools: CommandTools, context: OfficeContext, row: VersionRecord, table: Pick<TableRow, 'companyId' | 'siteId'>): Promise<void> {
  refuseVersion(confirmRefusal(versionRowOf(row), todayOf(tools.now)))
  await payGuarded(() => tools.tx.pieceRateVersion.update({ where: { id: row.id }, data: { status: 'PUBLISHED', confirmedAt: tools.now, confirmedById: context.actorId }, select: { id: true } }))
  const after = (await tools.tx.pieceRateVersion.findUnique({ where: { id: row.id }, select: VERSION_SELECT }))!
  tools.audit({ action: 'people.confirmRateVersion', recordType: 'PieceRateVersion', recordId: row.id, companyId: table.companyId, siteId: table.siteId, before: versionAudit(row), after: versionAudit(after) })
  emitVersion(tools, after, 'CONFIRMED', 'PUBLISHED')
}

/** Confirms a provisional rate after its trial (MES-262): PROVISIONAL → PUBLISHED, who and when. */
export async function confirm(caller: CommandCaller, versionId: string, body: { readonly version: number }, idempotencyKey?: string): Promise<VersionDetail> {
  const { context, version: current, table } = await versionOf(caller, versionId, PEOPLE_PIECERATES_MANAGE)
  refuseVersion(confirmRefusal(versionRowOf(current), todayOf(serverClock.now())))
  const { result } = await command(caller, { name: 'people.confirmRateVersion', idempotencyKey, input: body, record: { type: 'PieceRateVersion', id: current.id, expectedVersion: body.version } }, async (tools) => {
    const state = (await tools.tx.pieceRateVersion.findUnique({ where: { id: current.id }, select: VERSION_SELECT }))!
    await confirmInCommand(tools, context, state, table)
    return versionDetailOf(tools.tx, context, current.id, tools.now)
  })
  return result
}

async function confirmRows(caller: CommandCaller, ids: readonly string[]) {
  const context = officeOf(caller)
  const rows = []
  for (const id of ids) {
    try {
      const { version: row, table } = await versionOf(caller, id, PEOPLE_PIECERATES_MANAGE)
      rows.push({ id, row, table, refusal: confirmRefusal(versionRowOf(row), todayOf(serverClock.now())), missing: false })
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error
      rows.push({ id, row: null, table: null, refusal: null, missing: true })
    }
  }
  return { context, rows }
}

/** The ReviewChangesModal of "Confirm n provisional rates": each row, from → to, and why one cannot be confirmed. */
export async function confirmPreview(caller: CommandCaller, body: { readonly ids: readonly string[] }) {
  const { rows } = await confirmRows(caller, [...new Set(body.ids)])
  const answer = rows.map(({ id, row, table, refusal, missing }) => ({
    id,
    table: table ? { id: table.id, code: table.code, name: table.name } : null,
    versionNo: row?.versionNo ?? null,
    from: row ? (row.status as string) : null,
    to: 'CONFIRMED' as const,
    trialEndsOn: row ? day(row.trialEndsOn) : null,
    refusal: missing ? { code: 'NOT_PROVISIONAL' as const, message: 'Rate version not found.' } : refusal,
    version: row?.version ?? null,
  }))
  return { rows: answer, canConfirm: answer.filter((row) => row.refusal === null).length }
}

/** "Confirm n provisional rates": all or none, each at the version the screen read. */
export async function confirmMany(caller: CommandCaller, body: { readonly items: readonly { readonly id: string; readonly version: number }[] }, idempotencyKey?: string) {
  const items = body.items
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new ValidationError('Each version once.', [{ path: 'items', message: 'A version is listed twice.' }])
  const { context, rows } = await confirmRows(
    caller,
    items.map((item) => item.id),
  )
  const problems: Issue[] = []
  rows.forEach(({ row, refusal, missing }, index) => {
    if (missing) problems.push({ path: `items/${index}/id`, message: 'Rate version not found.' })
    else if (refusal) problems.push({ path: `items/${index}`, message: refusal.message })
    else if (row!.version !== items[index]!.version) problems.push({ path: `items/${index}/version`, message: `This version changed since it was read; it is now at ${row!.version}.` })
  })
  if (problems.length > 0) throw new DomainError('conflict', problems.length === 1 ? problems[0]!.message : `${problems.length} of these rates cannot be confirmed; nothing was confirmed.`, problems)
  const { result } = await command(caller, { name: 'people.confirmRateVersions', idempotencyKey, input: body }, async (tools) => {
    const confirmed = []
    for (const [index, entry] of rows.entries()) {
      const { count } = await tools.tx.pieceRateVersion.updateMany({ where: { id: entry.id, version: items[index]!.version }, data: { version: { increment: 1 } } })
      if (count !== 1) throw new ConflictError('A rate changed while confirming; nothing was confirmed. Reload and try again.')
      const state = (await tools.tx.pieceRateVersion.findUnique({ where: { id: entry.id }, select: VERSION_SELECT }))!
      await confirmInCommand(tools, context, state, entry.table!)
      confirmed.push({ id: entry.id, versionNo: state.versionNo, tableId: state.tableId })
    }
    return { confirmed }
  })
  return result
}

// ---- publications ---------------------------------------------------------------------------------------------------

async function publicationOf(caller: CommandCaller, publicationId: string) {
  const found = await caller.withClient((client) => client.ratePublication.findUnique({ where: { id: publicationId }, select: { id: true, versionId: true, siteId: true, status: true, workerIds: true, version: true } }))
  if (!found) throw new NotFoundError('Publication not found.')
  const { context, version, table } = await versionOf(caller, found.versionId, PEOPLE_PIECERATES_MANAGE)
  return { context, publication: found, version, table }
}

/** Withdraws a wrong publication while its version is still a DRAFT (with why); otherwise it stands. */
export async function withdraw(caller: CommandCaller, publicationId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string): Promise<VersionDetail> {
  const { context, publication, version: owner, table } = await publicationOf(caller, publicationId)
  if (publication.status !== 'PUBLISHED') throw new ConflictError('This publication was withdrawn already.')
  if (owner.status !== 'DRAFT') {
    throw new PieceRateRefusedError({ code: 'NOT_DRAFT', message: `Version ${owner.versionNo} is ${owner.status.toLowerCase()}: its publications stand (the receipts and the rates in force rest on them).` })
  }
  refuseProblems(reasonProblems(body.reason), 'Say why this publication is withdrawn.')
  const { result } = await command(caller, { name: 'people.withdrawRatePublication', idempotencyKey, input: body, record: { type: 'RatePublication', id: publication.id, expectedVersion: body.version } }, async (tools) => {
    await payGuarded(() => tools.tx.ratePublication.update({ where: { id: publication.id }, data: { status: 'WITHDRAWN', withdrawnAt: tools.now, withdrawnById: context.actorId, withdrawReason: body.reason.trim() }, select: { id: true } }))
    tools.audit({ action: 'people.withdrawRatePublication', recordType: 'RatePublication', recordId: publication.id, companyId: table.companyId, siteId: table.siteId, before: { status: 'PUBLISHED' }, after: { status: 'WITHDRAWN' }, reason: body.reason.trim() })
    tools.emit({ type: 'rate_publication.changed', subject: publication.id, companyId: table.companyId, siteId: table.siteId, payload: { publicationId: publication.id, versionId: owner.id, siteId: table.siteId, lineId: null, change: 'WITHDRAWN', workers: publication.workerIds.length } })
    return versionDetailOf(tools.tx, context, owner.id, tools.now)
  })
  return result
}

/** The office records signed paper copies of a publication: a receipt per worker (a worker read once is not added again). */
export async function paperReceipts(caller: CommandCaller, publicationId: string, body: { readonly workerIds: readonly string[]; readonly paperFileId?: string | null | undefined }, idempotencyKey?: string) {
  const { context, publication, version: owner, table } = await publicationOf(caller, publicationId)
  if (publication.status !== 'PUBLISHED') throw new ConflictError('This publication was withdrawn: nobody acknowledges it.')
  const workerIds = [...new Set(body.workerIds)]
  const problems: Issue[] = []
  const told = new Set(publication.workerIds)
  const workers = await caller.withClient((client) => client.worker.findMany({ where: { id: { in: workerIds } }, select: { id: true, status: true, employeeId: true } }))
  const byId = new Map(workers.map((row) => [row.id, row]))
  workerIds.forEach((workerId, index) => {
    const worker = byId.get(workerId)
    if (!told.has(workerId) || !worker) problems.push({ path: `workerIds/${index}`, message: 'This publication did not go to this worker.' })
    else if (worker.status !== 'ACTIVE') problems.push({ path: `workerIds/${index}`, message: 'This worker is not active: an inactive worker acknowledges nothing.' })
    else if (worker.employeeId === null) problems.push({ path: `workerIds/${index}`, message: 'Link this floor sign-in to its employee first (People › Employees): the reading is recorded on the person.' })
  })
  if (body.paperFileId) {
    const file = await caller.withClient((client) => client.storedFile.findUnique({ where: { id: body.paperFileId! }, select: { recordType: true, recordId: true } }))
    if (!file || file.recordType !== 'RatePublication' || file.recordId !== publication.id) problems.push({ path: 'paperFileId', message: 'The signed copy is a file of this publication.' })
  }
  refuseProblems(problems, 'Some paper receipts cannot be recorded.')
  const { result } = await command(caller, { name: 'people.recordPaperReceipts', idempotencyKey, input: body }, async (tools) => {
    const existing = await tools.tx.rateAcknowledgement.findMany({ where: { publicationId: publication.id, workerId: { in: workerIds } }, select: { workerId: true } })
    const already = new Set(existing.map((row) => row.workerId))
    const fresh = workerIds.filter((workerId) => !already.has(workerId))
    for (const workerId of fresh) {
      const id = newId()
      await payGuarded(() =>
        tools.tx.rateAcknowledgement.create({
          data: { id, siteId: table.siteId, publicationId: publication.id, versionId: owner.id, employeeId: byId.get(workerId)!.employeeId!, workerId, channel: 'PAPER', paperFileId: body.paperFileId ?? null, serverTime: tools.now, createdById: context.actorId },
          select: { id: true },
        }),
      )
      tools.audit({ action: 'people.recordPaperReceipt', recordType: 'RateAcknowledgement', recordId: id, companyId: table.companyId, siteId: table.siteId, after: { publicationId: publication.id, versionId: owner.id, workerId, channel: 'PAPER', paperFileId: body.paperFileId ?? null } })
    }
    if (fresh.length > 0) {
      tools.emit({ type: 'rate.read', subject: publication.id, companyId: table.companyId, siteId: table.siteId, payload: { publicationId: publication.id, versionId: owner.id, siteId: table.siteId, channel: 'PAPER', receipts: fresh.length } })
    } else {
      tools.audit({ action: 'people.recordPaperReceipt', recordType: 'RatePublication', recordId: publication.id, companyId: table.companyId, siteId: table.siteId, after: { unchanged: true, already: already.size } })
    }
    return { ...(await versionDetailOf(tools.tx, context, owner.id, tools.now)), recorded: fresh.length, already: already.size }
  })
  return result
}
