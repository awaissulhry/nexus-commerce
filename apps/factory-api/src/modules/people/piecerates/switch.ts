import type { Prisma } from '@nexus/factory-db'
import { ConflictError, DomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { PIECE_PAY_SWITCH_CHANGES } from '@nexus/factory-domain/people/events'
import { PEOPLE_PIECERATES_MANAGE, PEOPLE_PIECERATES_SWITCH, PEOPLE_PIECERATES_VIEW } from '@nexus/factory-domain/people/piecerates/permissions'
import { IN_FORCE_STATUSES, inForceOn, reasonProblems } from '@nexus/factory-domain/people/piecerates/rates'
import { preconditionsOf, preconditionTextProblems, startProblems, stopDayOf, windowsAfterRestart, type SwitchFacts, type SwitchWindow } from '@nexus/factory-domain/people/piecerates/switch'
import { scanSubjectOf, type MonitoringBasis, type ScanSubject } from '@nexus/factory-domain/production/settings/monitoring'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { legalGateFor } from '../privacy/gate'
import { payGuarded, refuseProblems } from './access'
import type { SwitchView } from './contract'
import { dateOf, day, siteOf, todayOf, versionRowOf, type Db, type SiteRow } from './store'

/**
 * The legal switch of piece pay at a site (B-W2b-34; W2b plan §3 GATE-PIECE-PAY; design people.piecerates "Legal switch"
 * and "Start piece pay"; factory-db PiecePaySwitch: one row per site with the site's id, OFF by default, the guard checks
 * the legal preconditions again when it turns ON). Rules: factory-domain people/piecerates/switch.
 *
 *   GET  /people/piece-rates/sites/:siteId/switch                     the switch, its preconditions in words, candidates
 *   PUT  …/switch/preconditions   people.piecerates.manage             the CCNL and article, the worker notice, the DPIA, the
 *                                                                      labour consultant, the scheme (while OFF; the note
 *                                                                      always)
 *   POST …/switch/start           people.piecerates.switch + step-up   from a day not in the past, every precondition met
 *   POST …/switch/stop            people.piecerates.switch, no code    from today (or its first day if still to come)
 *
 * B-W2b-27's switch-off of the PERFORMANCE legal gate stops piece pay at the site in the same command
 * (`stopPiecePayInCommand`): piece pay is one person's work figures (Statuto art. 4 c.1).
 */

type SwitchChange = (typeof PIECE_PAY_SWITCH_CHANGES)[number]

export const SWITCH_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  state: true,
  ccnlName: true,
  ccnlArticle: true,
  workerNoticeId: true,
  dpiaId: true,
  consultantName: true,
  consultantAgreedOn: true,
  schemeId: true,
  preconditionsNote: true,
  onFrom: true,
  switchedOnAt: true,
  switchedOnById: true,
  offFrom: true,
  switchedOffAt: true,
  switchedOffById: true,
  offReason: true,
  earlierWindows: true,
  version: true,
} as const satisfies Prisma.PiecePaySwitchSelect
export type SwitchRow = Prisma.PiecePaySwitchGetPayload<{ select: typeof SWITCH_SELECT }>

const SCHEME_SELECT = { id: true, name: true, kind: true, status: true, siteId: true, lineId: true, validFrom: true, validTo: true } as const satisfies Prisma.IncentiveSchemeSelect
type SchemeRow = Prisma.IncentiveSchemeGetPayload<{ select: typeof SCHEME_SELECT }>

const schemeView = (row: SchemeRow) => ({ id: row.id, name: row.name, kind: row.kind, status: row.status, validFrom: day(row.validFrom)!, validTo: day(row.validTo), lineId: row.lineId })
const windowOf = (row: SwitchRow | null): SwitchWindow => ({ state: (row?.state ?? 'OFF') as 'OFF' | 'ON', onFrom: day(row?.onFrom ?? null), offFrom: day(row?.offFrom ?? null) })
const earlierOf = (row: SwitchRow | null): { from: string; to: string }[] => (Array.isArray(row?.earlierWindows) ? (row.earlierWindows as { from: string; to: string }[]) : [])

/** What the site and the company have on record towards piece pay, for a first day (read in the caller's or the command's scope). */
async function factsFor(db: Db, site: SiteRow, row: SwitchRow | null, onFrom: BusinessDate, today: BusinessDate): Promise<SwitchFacts & { readonly activeWorkerIds: readonly string[] }> {
  const rules = await db.productionSettings.findUnique({ where: { id: site.id }, select: { scanSubject: true, monitoringBasis: true, monitoringReference: true } })
  const gate = await legalGateFor(db, site.id, 'PERFORMANCE')
  const notice = row?.workerNoticeId ? await db.privacyNotice.findUnique({ where: { id: row.workerNoticeId }, select: { id: true, label: true, kind: true, status: true } }) : null
  const dpia = row?.dpiaId ? await db.privacyDpia.findUnique({ where: { id: row.dpiaId }, select: { id: true, versionNo: true, status: true } }) : null
  const scheme = row?.schemeId ? await db.incentiveScheme.findUnique({ where: { id: row.schemeId }, select: SCHEME_SELECT }) : null
  const versions = await db.pieceRateVersion.findMany({
    where: { siteId: site.id, status: { in: [...IN_FORCE_STATUSES] }, table: { status: 'ACTIVE' } },
    select: { id: true, versionNo: true, status: true, effectiveFrom: true, effectiveTo: true, provisional: true, trialEndsOn: true },
  })
  const inForce = versions.filter((version) => inForceOn(versionRowOf(version), onFrom))
  const workers = await db.worker.findMany({ where: { siteId: site.id, status: 'ACTIVE' }, select: { id: true } })
  const told = new Set(
    inForce.length === 0 ? [] : (await db.ratePublication.findMany({ where: { versionId: { in: inForce.map((version) => version.id) }, status: 'PUBLISHED' }, select: { workerIds: true } })).flatMap((publication) => publication.workerIds),
  )
  const codes = await db.payrollCodeMapping.findMany({ where: { companyId: site.companyId, kind: 'EARNING', status: 'ACTIVE' }, select: { ourCode: true, providerCode: true }, orderBy: { ourCode: 'asc' } })
  return {
    today,
    onFrom,
    scanSubject: scanSubjectOf(rules as { scanSubject: ScanSubject } | null),
    siteBasis: rules?.monitoringBasis && rules.monitoringReference ? { kind: rules.monitoringBasis as MonitoringBasis, reference: rules.monitoringReference } : null,
    performanceGateOpen: gate.open,
    ccnlName: row?.ccnlName ?? null,
    ccnlArticle: row?.ccnlArticle ?? null,
    workerNotice: notice,
    dpia,
    consultantName: row?.consultantName ?? null,
    consultantAgreedOn: day(row?.consultantAgreedOn ?? null),
    scheme: scheme ? { id: scheme.id, name: scheme.name, status: scheme.status, siteId: scheme.siteId, validFrom: day(scheme.validFrom)!, validTo: day(scheme.validTo) } : null,
    siteId: site.id,
    ratesInForce: inForce.length,
    activeWorkers: workers.length,
    workersNotTold: workers.filter((worker) => !told.has(worker.id)).length,
    earningCodes: codes.length,
    unmappedEarningCodes: codes.filter((code) => code.providerCode === null || code.providerCode.trim() === '').map((code) => code.ourCode),
    activeWorkerIds: workers.map((worker) => worker.id),
  }
}

/** The number of preconditions not met at each site, for today (the overview's "missing"). */
export async function missingBySite(db: Db, sites: readonly SiteRow[], today: BusinessDate): Promise<Map<string, number>> {
  const answer = new Map<string, number>()
  if (sites.length === 0) return answer
  const rows = await db.piecePaySwitch.findMany({ where: { siteId: { in: sites.map((site) => site.id) } }, select: SWITCH_SELECT })
  const byId = new Map(rows.map((row) => [row.siteId, row]))
  for (const site of sites) {
    const row = byId.get(site.id) ?? null
    if (row?.state === 'ON') {
      answer.set(site.id, 0)
      continue
    }
    answer.set(site.id, preconditionsOf(await factsFor(db, site, row, today, today)).filter((item) => !item.met).length)
  }
  return answer
}

export async function switchViewOf(db: Db, context: OfficeContext, site: SiteRow, now: Date, onFromAsked?: BusinessDate): Promise<SwitchView> {
  const today = todayOf(now)
  const row = await db.piecePaySwitch.findUnique({ where: { id: site.id }, select: SWITCH_SELECT })
  const onFrom = row?.state === 'ON' ? day(row.onFrom)! : onFromAsked && onFromAsked > today ? onFromAsked : today
  const facts = await factsFor(db, site, row, onFrom, today)
  const preconditions = preconditionsOf(facts)
  const userIds = [row?.switchedOnById, row?.switchedOffById].filter((value): value is string => typeof value === 'string')
  const users = userIds.length === 0 ? [] : await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } })
  const nameOf = new Map(users.map((user) => [user.id, user.displayName]))
  const scheme = row?.schemeId ? await db.incentiveScheme.findUnique({ where: { id: row.schemeId }, select: SCHEME_SELECT }) : null
  const acks = facts.workerNotice
    ? new Set((await db.workerNoticeAck.findMany({ where: { noticeId: facts.workerNotice.id, workerId: { in: [...facts.activeWorkerIds] } }, select: { workerId: true } })).map((ack) => ack.workerId)).size
    : 0
  const notices = await db.privacyNotice.findMany({ where: { companyId: site.companyId, kind: 'WORKER_FLOOR', status: 'PUBLISHED' }, select: { id: true, label: true, status: true }, orderBy: { versionNo: 'desc' } })
  const dpias = await db.privacyDpia.findMany({ where: { companyId: site.companyId, status: 'STORED' }, select: { id: true, versionNo: true, status: true }, orderBy: { versionNo: 'desc' } })
  const schemes = await db.incentiveScheme.findMany({ where: { companyId: site.companyId, OR: [{ siteId: null }, { siteId: site.id }], status: { in: ['ACTIVE', 'DRAFT'] } }, select: SCHEME_SELECT, orderBy: { validFrom: 'desc' } })
  const actor = actorOf(context)
  const scope = { companyId: site.companyId, siteId: site.id }
  return {
    site,
    today,
    state: windowOf(row).state,
    onFrom: day(row?.onFrom ?? null),
    switchedOnAt: row?.switchedOnAt ? toUtcIso(row.switchedOnAt) : null,
    switchedOnByName: row?.switchedOnById ? (nameOf.get(row.switchedOnById) ?? null) : null,
    offFrom: day(row?.offFrom ?? null),
    switchedOffAt: row?.switchedOffAt ? toUtcIso(row.switchedOffAt) : null,
    switchedOffByName: row?.switchedOffById ? (nameOf.get(row.switchedOffById) ?? null) : null,
    offReason: row?.offReason ?? null,
    earlierWindows: earlierOf(row),
    recorded: {
      ccnlName: row?.ccnlName ?? null,
      ccnlArticle: row?.ccnlArticle ?? null,
      workerNotice: facts.workerNotice ? { id: facts.workerNotice.id, label: facts.workerNotice.label, status: facts.workerNotice.status } : null,
      dpia: facts.dpia,
      consultantName: row?.consultantName ?? null,
      consultantAgreedOn: day(row?.consultantAgreedOn ?? null),
      scheme: scheme ? schemeView(scheme) : null,
      preconditionsNote: row?.preconditionsNote ?? null,
    },
    preconditions,
    canStart: row?.state !== 'ON' && preconditions.every((item) => item.met),
    noticeReadBy: facts.workerNotice ? { read: acks, of: facts.activeWorkers } : null,
    candidates: { notices, dpias, schemes: schemes.map(schemeView) },
    version: row?.version ?? null,
    canManage: can(actor, PEOPLE_PIECERATES_MANAGE, scope),
    canSwitch: can(actor, PEOPLE_PIECERATES_SWITCH, scope),
  }
}

/** people.piecerates.view: the switch of a site, what it rests on, and what it still needs (for a first day asked). */
export async function switchView(caller: CommandCaller, siteId: string, query: { onFrom?: string | undefined }): Promise<SwitchView> {
  const { context, site } = await siteOf(caller, siteId, PEOPLE_PIECERATES_VIEW)
  return caller.withClient((client) => switchViewOf(client, context, site, serverClock.now(), query.onFrom))
}

const switchAudit = (row: SwitchRow | null) =>
  row
    ? {
        state: row.state,
        ccnlName: row.ccnlName,
        ccnlArticle: row.ccnlArticle,
        workerNoticeId: row.workerNoticeId,
        dpiaId: row.dpiaId,
        consultantName: row.consultantName,
        consultantAgreedOn: day(row.consultantAgreedOn),
        schemeId: row.schemeId,
        onFrom: day(row.onFrom),
        offFrom: day(row.offFrom),
      }
    : null

function emitSwitch(tools: CommandTools, site: Pick<SiteRow, 'id' | 'companyId'>, row: SwitchRow, change: SwitchChange, by: 'OFFICE' | 'GATE_OFF'): void {
  tools.emit({
    type: 'piece_pay.switched',
    subject: site.id,
    companyId: site.companyId,
    siteId: site.id,
    payload: { siteId: site.id, change, state: row.state as 'OFF' | 'ON', onFrom: day(row.onFrom), offFrom: day(row.offFrom), by },
  })
}

export interface PreconditionsBody {
  readonly version?: number | undefined
  readonly ccnlName?: string | null | undefined
  readonly ccnlArticle?: string | null | undefined
  readonly workerNoticeId?: string | null | undefined
  readonly dpiaId?: string | null | undefined
  readonly consultantName?: string | null | undefined
  readonly consultantAgreedOn?: string | null | undefined
  readonly schemeId?: string | null | undefined
  readonly preconditionsNote?: string | null | undefined
}

const PRECONDITION_FIELDS = ['ccnlName', 'ccnlArticle', 'workerNoticeId', 'dpiaId', 'consultantName', 'consultantAgreedOn', 'schemeId'] as const
const text = (value: string | null | undefined): string | null | undefined => (value === undefined ? undefined : value === null || value.trim() === '' ? null : value.trim())

/** people.piecerates.manage: records what piece pay rests on (while OFF; the note at any time). The first write makes the row, OFF. */
export async function recordPreconditions(caller: CommandCaller, siteId: string, body: PreconditionsBody, idempotencyKey?: string): Promise<SwitchView> {
  const { context, site } = await siteOf(caller, siteId, PEOPLE_PIECERATES_MANAGE)
  refuseProblems(preconditionTextProblems(body), 'Some of what piece pay rests on is not written right.')
  const current = await caller.withClient((client) => client.piecePaySwitch.findUnique({ where: { id: site.id }, select: SWITCH_SELECT }))
  if (current && body.version === undefined) throw new ValidationError('Send the version you read.', [{ path: 'version', message: 'Required once the switch has a record.' }])
  if (current?.state === 'ON' && PRECONDITION_FIELDS.some((field) => body[field] !== undefined && (text(body[field] as string | null) ?? null) !== (field === 'consultantAgreedOn' ? day(current.consultantAgreedOn) : current[field]))) {
    throw new ConflictError(`Piece pay is on at this site (from ${day(current.onFrom)}): what it rests on stays as it is while it runs. Stop it first; the note may change.`)
  }
  const problems: Issue[] = []
  await caller.withClient(async (client) => {
    if (body.workerNoticeId) {
      const notice = await client.privacyNotice.findUnique({ where: { id: body.workerNoticeId }, select: { companyId: true, kind: true } })
      if (!notice || notice.companyId !== site.companyId || notice.kind !== 'WORKER_FLOOR') problems.push({ path: 'workerNoticeId', message: "Not a worker notice of this site's company." })
    }
    if (body.dpiaId) {
      const dpia = await client.privacyDpia.findUnique({ where: { id: body.dpiaId }, select: { companyId: true } })
      if (!dpia || dpia.companyId !== site.companyId) problems.push({ path: 'dpiaId', message: "Not an impact assessment of this site's company." })
    }
    if (body.schemeId) {
      const scheme = await client.incentiveScheme.findUnique({ where: { id: body.schemeId }, select: { companyId: true, siteId: true } })
      if (!scheme || scheme.companyId !== site.companyId || (scheme.siteId !== null && scheme.siteId !== site.id)) problems.push({ path: 'schemeId', message: "Not a scheme of this site's company (its own or a line's of this site)." })
    }
  })
  refuseProblems(problems, 'Some of what piece pay rests on cannot be named here.')
  const data = {
    ...(body.ccnlName !== undefined ? { ccnlName: text(body.ccnlName) } : {}),
    ...(body.ccnlArticle !== undefined ? { ccnlArticle: text(body.ccnlArticle) } : {}),
    ...(body.workerNoticeId !== undefined ? { workerNoticeId: body.workerNoticeId } : {}),
    ...(body.dpiaId !== undefined ? { dpiaId: body.dpiaId } : {}),
    ...(body.consultantName !== undefined ? { consultantName: text(body.consultantName) } : {}),
    ...(body.consultantAgreedOn !== undefined ? { consultantAgreedOn: body.consultantAgreedOn ? dateOf(body.consultantAgreedOn) : null } : {}),
    ...(body.schemeId !== undefined ? { schemeId: body.schemeId } : {}),
    ...(body.preconditionsNote !== undefined ? { preconditionsNote: text(body.preconditionsNote) } : {}),
  }
  const { result } = await command(
    caller,
    { name: 'people.recordPiecePayPreconditions', idempotencyKey, input: body, ...(current ? { record: { type: 'PiecePaySwitch' as const, id: site.id, expectedVersion: body.version! } } : {}) },
    async (tools) => {
      const before = await tools.tx.piecePaySwitch.findUnique({ where: { id: site.id }, select: SWITCH_SELECT })
      if (!before) {
        const { count } = await tools.tx.piecePaySwitch.createMany({ data: [{ id: site.id, companyId: site.companyId, siteId: site.id, createdById: context.actorId }], skipDuplicates: true })
        if (count !== 1) throw new ConflictError('The switch of this site was just recorded by someone else; reload it.')
      }
      await payGuarded(() => tools.tx.piecePaySwitch.update({ where: { id: site.id }, data, select: { id: true } }))
      const after = (await tools.tx.piecePaySwitch.findUnique({ where: { id: site.id }, select: SWITCH_SELECT }))!
      tools.audit({ action: 'people.recordPiecePayPreconditions', recordType: 'PiecePaySwitch', recordId: site.id, companyId: site.companyId, siteId: site.id, before: switchAudit(before), after: switchAudit(after) })
      emitSwitch(tools, site, after, 'PRECONDITIONS_RECORDED', 'OFFICE')
      return switchViewOf(tools.tx, context, site, tools.now)
    },
  )
  return result
}

/**
 * people.piecerates.switch: "Start piece pay at <site> from <day>" (design pop-up "Start piece pay": a fresh code, then
 * the five preconditions listed as met). Refused in words, before any code is asked, while one is missing; the database
 * checks the legal ones again (…_pay_w2b_guards).
 */
export async function startPiecePay(
  caller: CommandCaller,
  siteId: string,
  body: { readonly version: number; readonly onFrom: string; readonly reason: string },
  options: { readonly stepUp: () => void; readonly idempotencyKey?: string | undefined },
): Promise<SwitchView & { words: string[] }> {
  const { context, site } = await siteOf(caller, siteId, PEOPLE_PIECERATES_SWITCH)
  const now = serverClock.now()
  const today = todayOf(now)
  const row = await caller.withClient((client) => client.piecePaySwitch.findUnique({ where: { id: site.id }, select: SWITCH_SELECT }))
  if (!row) throw new NotFoundError('Nothing is recorded for piece pay at this site yet: record what it rests on first.')
  const judge = async (db: Db, current: SwitchRow) => {
    const facts = await factsFor(db, site, current, body.onFrom, today)
    const problems = startProblems({ facts, window: windowOf(current), reason: body.reason })
    const missing = problems.filter((problem) => problem.path.startsWith('preconditions/'))
    if (problems.some((problem) => problem.path === 'state')) throw new ConflictError(problems.find((problem) => problem.path === 'state')!.message)
    // The day and the reason first (what the person typed), then what is not on record.
    refuseProblems(
      problems.filter((problem) => !problem.path.startsWith('preconditions/')),
      'Piece pay cannot start this way.',
    )
    if (missing.length > 0) {
      throw new DomainError('invalid_state', missing.length === 1 ? `Piece pay cannot start yet: ${missing[0]!.message}` : `Piece pay cannot start yet: ${missing.length} preconditions are not on record.`, missing)
    }
  }
  await caller.withClient((client) => judge(client, row))
  options.stepUp()
  const { result } = await command(
    caller,
    { name: 'people.startPiecePay', idempotencyKey: options.idempotencyKey, input: { siteId: site.id, ...body }, record: { type: 'PiecePaySwitch', id: site.id, expectedVersion: body.version } },
    async (tools) => {
      const before = (await tools.tx.piecePaySwitch.findUnique({ where: { id: site.id }, select: SWITCH_SELECT }))!
      // Read again in the transaction: a precondition that changed since the check is never recorded as met.
      await judge(tools.tx, before)
      await payGuarded(() =>
        tools.tx.piecePaySwitch.update({
          where: { id: site.id },
          data: {
            state: 'ON',
            onFrom: dateOf(body.onFrom),
            switchedOnAt: tools.now,
            switchedOnById: context.actorId,
            offFrom: null,
            switchedOffAt: null,
            switchedOffById: null,
            offReason: null,
            earlierWindows: windowsAfterRestart(earlierOf(before), windowOf(before)),
          },
          select: { id: true },
        }),
      )
      const after = (await tools.tx.piecePaySwitch.findUnique({ where: { id: site.id }, select: SWITCH_SELECT }))!
      tools.audit({ action: 'people.startPiecePay', recordType: 'PiecePaySwitch', recordId: site.id, companyId: site.companyId, siteId: site.id, before: switchAudit(before), after: switchAudit(after), reason: body.reason.trim() })
      emitSwitch(tools, site, after, 'SWITCHED_ON', 'OFFICE')
      return {
        ...(await switchViewOf(tools.tx, context, site, tools.now)),
        words: [`Piece pay counts at ${site.name} from ${body.onFrom}: scans of the rates in force are paid by the piece from that day, made up to the scheme's guaranteed pay.`],
      }
    },
  )
  return result
}

/** Stops piece pay at a site inside the caller's command (a person's stop, or B-W2b-27's PERFORMANCE switch-off). Null when it was not on. */
export async function stopPiecePayInCommand(
  tools: CommandTools,
  site: Pick<SiteRow, 'id' | 'companyId'>,
  options: { readonly actorId: string; readonly reason: string; readonly by: 'OFFICE' | 'GATE_OFF'; readonly bumpVersion: boolean },
): Promise<BusinessDate | null> {
  const before = await tools.tx.piecePaySwitch.findUnique({ where: { id: site.id }, select: SWITCH_SELECT })
  if (!before || before.state !== 'ON') return null
  const offFrom = stopDayOf(day(before.onFrom)!, todayOf(tools.now))
  await payGuarded(() =>
    tools.tx.piecePaySwitch.update({
      where: { id: site.id },
      data: { state: 'OFF', offFrom: dateOf(offFrom), switchedOffAt: tools.now, switchedOffById: options.actorId, offReason: options.reason, ...(options.bumpVersion ? { version: { increment: 1 } } : {}) },
      select: { id: true },
    }),
  )
  const after = (await tools.tx.piecePaySwitch.findUnique({ where: { id: site.id }, select: SWITCH_SELECT }))!
  tools.audit({ action: 'people.stopPiecePay', recordType: 'PiecePaySwitch', recordId: site.id, companyId: site.companyId, siteId: site.id, before: switchAudit(before), after: switchAudit(after), reason: options.reason })
  emitSwitch(tools, site, after, 'SWITCHED_OFF', options.by)
  return offFrom
}

/** people.piecerates.switch: stops piece pay at a site (a reason; never a step-up: narrowing is always allowed). */
export async function stopPiecePay(caller: CommandCaller, siteId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string): Promise<SwitchView & { words: string[] }> {
  const { context, site } = await siteOf(caller, siteId, PEOPLE_PIECERATES_SWITCH)
  refuseProblems(reasonProblems(body.reason), 'Say why piece pay stops.')
  const row = await caller.withClient((client) => client.piecePaySwitch.findUnique({ where: { id: site.id }, select: { state: true } }))
  if (!row || row.state !== 'ON') throw new ConflictError('Piece pay is off at this site already.')
  const { result } = await command(
    caller,
    { name: 'people.stopPiecePay', idempotencyKey, input: { siteId: site.id, ...body }, record: { type: 'PiecePaySwitch', id: site.id, expectedVersion: body.version } },
    async (tools) => {
      const offFrom = await stopPiecePayInCommand(tools, site, { actorId: context.actorId, reason: body.reason.trim(), by: 'OFFICE', bumpVersion: false })
      if (offFrom === null) throw new ConflictError('Piece pay was just stopped at this site; reload it.')
      return {
        ...(await switchViewOf(tools.tx, context, site, tools.now)),
        words: [`Piece pay stops at ${site.name} from ${offFrom}: no piece-pay figure is recorded from that day. Pay earned before stays payable, and an open pay period stays computable.`],
      }
    },
  )
  return result
}
