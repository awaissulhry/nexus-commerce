import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PRIVACY_VIEW } from '@nexus/factory-domain/privacy/permissions'
import { PRIVACY_RETENTION_MANAGE } from '@nexus/factory-domain/privacy/retention/permissions'
import {
  DATED_PURGES,
  isShortening,
  KEPT_FOR_GOOD,
  PERIODS_UNVERIFIED,
  periodWords,
  RULE_HELD_WORDS,
  ruleKey,
  ruleProblems,
  SWEEP_FAILURE_WORDS,
  SWEEP_FAILURES,
  SWEEP_HELD_WORDS,
  UNVERIFIED_WORDS,
  APPEND_ONLY_LEDGERS,
  LEDGER_KEPT_WORDS,
  LEDGER_WORDS,
  type RetentionAction,
  type RuleHeld,
  type SweepFailure,
  type SweepHeld,
} from '@nexus/factory-domain/privacy/retention/retention'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { holdsEverywhere } from '../../audit/reads/everywhere'
import { assertMay, dayOf, mayOn, officeOf, refuse } from '../access'
import { RETENTION_TYPES, retentionTypeOf } from './rules'
import { SWEEP_SCHEDULE, SWEEP_SCHEDULE_WORDS, sweepRule } from './sweep'

/**
 * Retention rules per record type (B-W2b-405; PLT-204; GDPR art. 5(1)(e); c.c. art. 2220; design admin.privacy "Retention rules":
 * record type, keep for, then, legal reason, last sweep; "Shortening needs the Owner (fresh code)"):
 *
 *   GET  /privacy/retention?companyId=                    the rules the caller sees (privacy.view) with their last sweep, the
 *                                                         record types a rule may name, the append-only ledgers (kept for
 *                                                         good, never purged: the Owner's decision of 15 Nov 2026), the
 *                                                         purges that run on their own dates
 *   GET  /privacy/retention/rules/:ruleId/sweeps          a rule's sweeps, newest first (privacy.view)
 *   POST /privacy/retention/rules                         a rule (privacy.retention.manage): born on, reporting only
 *   PATCH /privacy/retention/rules/:ruleId                keep for, then, legal reason (version); shortening the period, or
 *                                                         another action while the rule applies, asks a fresh code
 *   POST /privacy/retention/rules/:ruleId/active          switched off (it neither reports nor applies) or on again
 *   POST /privacy/retention/rules/:ruleId/apply           GATE-PRIVACY: switched on to apply (a fresh code) or back to reporting
 *   POST /privacy/retention/rules/:ruleId/sweep           swept now (reports, or applies when switched on)
 *
 * A company's rule needs the permission over that company (404 without privacy.view, 403 without the route's); a rule of the
 * whole group needs it over every company. A rule names a record type of rules/index.ts (others are refused: the sweep would know
 * nothing of them; the append-only ledgers never).
 */

const RULE_SELECT = {
  id: true,
  key: true,
  companyId: true,
  recordType: true,
  keepMonths: true,
  thenAction: true,
  legalReason: true,
  active: true,
  applyOn: true,
  applyOnAt: true,
  applyOnById: true,
  version: true,
  company: { select: { id: true, code: true, legalName: true, tradeName: true } },
} as const satisfies Prisma.RetentionRuleSelect
type RuleRow = Prisma.RetentionRuleGetPayload<{ select: typeof RULE_SELECT }>

const SWEEP_SELECT = {
  id: true,
  ruleId: true,
  mode: true,
  keepMonths: true,
  thenAction: true,
  cutoffOn: true,
  status: true,
  startedAt: true,
  finishedAt: true,
  dueCount: true,
  appliedCount: true,
  heldCount: true,
  failedCount: true,
  failures: true,
  requestedById: true,
} as const satisfies Prisma.RetentionSweepSelect
type SweepRow = Prisma.RetentionSweepGetPayload<{ select: typeof SWEEP_SELECT }>

type Client = Parameters<Parameters<CommandCaller['withClient']>[0]>[0]

async function namesOf(client: Client, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))]
  if (wanted.length === 0) return new Map()
  const users = await client.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })
  return new Map(users.map((user) => [user.id, user.displayName]))
}

const coded = <Code extends string>(code: Code | null, words: Readonly<Record<Code, string>>) => (code === null ? null : { code, words: words[code] })

function sweepViewOf(row: SweepRow, recordType: string, names: ReadonlyMap<string, string>) {
  const type = retentionTypeOf(recordType)
  const failures = (Array.isArray(row.failures) ? row.failures : []) as Array<{ code?: unknown; recordId?: unknown }>
  return {
    id: row.id,
    ruleId: row.ruleId,
    mode: row.mode,
    keepMonths: row.keepMonths,
    thenAction: row.thenAction,
    cutoffOn: dayOf(row.cutoffOn)!,
    status: row.status,
    startedAt: toUtcIso(row.startedAt),
    finishedAt: row.finishedAt ? toUtcIso(row.finishedAt) : null,
    due: row.dueCount,
    applied: row.appliedCount,
    held: row.heldCount,
    failed: row.failedCount,
    heldWhy: coded<SweepHeld>(type?.holdsAll ?? null, SWEEP_HELD_WORDS),
    failures: failures
      .filter((entry): entry is { code: SweepFailure; recordId?: unknown } => (SWEEP_FAILURES as readonly unknown[]).includes(entry.code))
      .map((entry) => ({ code: entry.code, words: SWEEP_FAILURE_WORDS[entry.code], recordId: typeof entry.recordId === 'string' ? entry.recordId : null })),
    requestedBy: row.requestedById ? { id: row.requestedById, name: names.get(row.requestedById) ?? '' } : null,
  }
}

function assertManage(context: OfficeContext, rule: { readonly companyId: string | null }): void {
  if (rule.companyId === null) {
    if (!holdsEverywhere(context.grants, PRIVACY_RETENTION_MANAGE)) throw new ForbiddenError('A rule of the whole group is changed only with the permission over every company.')
    return
  }
  assertMay(context, PRIVACY_RETENTION_MANAGE, rule.companyId, 'Retention rule not found.')
}

const may = (held: RuleHeld | null) => ({ allowed: held === null, held: coded(held, RULE_HELD_WORDS) })

function ruleViewOf(row: RuleRow, lastSweep: SweepRow | null, names: ReadonlyMap<string, string>) {
  const type = retentionTypeOf(row.recordType)
  const off: RuleHeld | null = row.active ? null : 'SWITCHED_OFF'
  return {
    id: row.id,
    key: row.key,
    company: row.company ? { id: row.company.id, code: row.company.code, name: row.company.tradeName ?? row.company.legalName } : null,
    recordType: row.recordType,
    known: type !== null,
    keepMonths: row.keepMonths,
    period: periodWords(row.keepMonths),
    thenAction: row.thenAction,
    legalReason: row.legalReason,
    active: row.active,
    applyOn: row.applyOn,
    applyOnAt: row.applyOnAt ? toUtcIso(row.applyOnAt) : null,
    applyOnBy: row.applyOnById ? { id: row.applyOnById, name: names.get(row.applyOnById) ?? '' } : null,
    unverified: PERIODS_UNVERIFIED,
    unverifiedWords: PERIODS_UNVERIFIED ? UNVERIFIED_WORDS : null,
    countsFrom: type?.countsFrom ?? null,
    does: type?.does[row.thenAction as RetentionAction] ?? null,
    holdsAll: coded<SweepHeld>(type?.holdsAll ?? null, SWEEP_HELD_WORDS),
    version: row.version,
    lastSweep: lastSweep ? sweepViewOf(lastSweep, row.recordType, names) : null,
    actions: {
      change: may(type === null ? 'UNKNOWN_TYPE' : type.actions.length === 0 ? 'NO_ACTION' : null),
      switchOff: may(off),
      switchOn: may(row.active ? 'ACTIVE' : null),
      applyOn: may(off ?? (type === null ? 'UNKNOWN_TYPE' : row.applyOn ? 'APPLYING' : null)),
      applyOff: may(off ?? (row.applyOn ? null : 'NOT_APPLYING')),
      sweepNow: may(off),
    },
  }
}
export type RuleView = ReturnType<typeof ruleViewOf>

async function ruleAnswer(caller: CommandCaller, ruleId: string): Promise<RuleView> {
  return caller.withClient(async (client) => {
    const row = await client.retentionRule.findUniqueOrThrow({ where: { id: ruleId }, select: RULE_SELECT })
    const last = await client.retentionSweep.findFirst({ where: { ruleId }, select: SWEEP_SELECT, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }] })
    return ruleViewOf(row, last, await namesOf(client, [row.applyOnById, last?.requestedById ?? null]))
  })
}

/** The rule, when the caller may know it (404 otherwise: a company's without privacy.view on it). */
async function readRule(caller: CommandCaller, ruleId: string): Promise<{ context: OfficeContext; rule: RuleRow }> {
  const context = officeOf(caller)
  const rule = isUuid(ruleId) ? await caller.withClient((client) => client.retentionRule.findUnique({ where: { id: ruleId }, select: RULE_SELECT })) : null
  if (!rule || (rule.companyId !== null && !mayOn(context, PRIVACY_VIEW, rule.companyId))) throw new NotFoundError('Retention rule not found.')
  return { context, rule }
}

/** GET /privacy/retention */
export async function listRetention(caller: CommandCaller, query: { readonly companyId?: string | undefined }) {
  const context = officeOf(caller)
  const visible = scopeWhere(actorOf(context), PRIVACY_VIEW, { company: 'companyId' }) as Prisma.RetentionRuleWhereInput
  // Prisma drops an empty filter inside OR: every company's rules are a plain `{}`.
  const everyCompany = Object.keys(visible).length === 0
  const where: Prisma.RetentionRuleWhereInput = query.companyId ? { OR: [{ companyId: null }, { AND: [visible, { companyId: query.companyId }] }] } : everyCompany ? {} : { OR: [{ companyId: null }, visible] }
  const rules = await caller.withClient(async (client) => {
    const rows = await client.retentionRule.findMany({ where, select: RULE_SELECT, orderBy: [{ recordType: 'asc' }, { companyId: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }] })
    const lasts = new Map<string, SweepRow>()
    for (const row of rows) {
      const last = await client.retentionSweep.findFirst({ where: { ruleId: row.id }, select: SWEEP_SELECT, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }] })
      if (last) lasts.set(row.id, last)
    }
    const names = await namesOf(client, [...rows.map((row) => row.applyOnById), ...[...lasts.values()].map((sweep) => sweep.requestedById)])
    return rows.map((row) => ruleViewOf(row, lasts.get(row.id) ?? null, names))
  })
  return {
    rules,
    types: RETENTION_TYPES.map((type) => ({
      recordType: type.recordType,
      companyScoped: type.companyScoped,
      actions: [...type.actions],
      countsFrom: type.countsFrom,
      does: Object.entries(type.does).map(([action, words]) => ({ action: action as RetentionAction, words: words! })),
      holdsAll: coded<SweepHeld>(type.holdsAll, SWEEP_HELD_WORDS),
    })),
    ledgers: APPEND_ONLY_LEDGERS.map((recordType) => ({ recordType, what: LEDGER_WORDS[recordType], words: LEDGER_KEPT_WORDS })),
    datedPurges: DATED_PURGES.map((purge) => ({ ...purge })),
    keptForGood: [...KEPT_FOR_GOOD],
    sweep: { schedule: SWEEP_SCHEDULE, words: SWEEP_SCHEDULE_WORDS },
  }
}

/** GET /privacy/retention/rules/:ruleId/sweeps */
export async function listSweeps(caller: CommandCaller, ruleId: string) {
  const { rule } = await readRule(caller, ruleId)
  return caller.withClient(async (client) => {
    const rows = await client.retentionSweep.findMany({ where: { ruleId }, select: SWEEP_SELECT, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: 100 })
    const names = await namesOf(client, rows.map((row) => row.requestedById))
    return { sweeps: rows.map((row) => sweepViewOf(row, rule.recordType, names)) }
  })
}

interface Writes {
  readonly stepUp: () => void
  readonly idempotencyKey?: string | undefined
}

export interface CreateRuleBody {
  readonly companyId: string | null
  readonly recordType: string
  readonly keepMonths: number
  readonly thenAction: RetentionAction
  readonly legalReason: string
}

const changeOf = (rule: RuleRow, change: 'ADDED' | 'CHANGED' | 'SWITCHED_OFF' | 'APPLY_ON' | 'APPLY_OFF', values: Partial<Pick<RuleRow, 'keepMonths' | 'thenAction'>> = {}) => ({
  type: 'privacy.retention_rule_changed',
  subject: rule.id,
  companyId: rule.companyId,
  payload: { ruleId: rule.id, companyId: rule.companyId, recordType: rule.recordType, keepMonths: values.keepMonths ?? rule.keepMonths, thenAction: values.thenAction ?? rule.thenAction, change },
})

/** POST /privacy/retention/rules */
export async function createRule(caller: CommandCaller, body: CreateRuleBody, idempotencyKey?: string): Promise<{ rule: RuleView }> {
  const context = officeOf(caller)
  if (body.companyId !== null) {
    const company = isUuid(body.companyId) ? await caller.withClient((client) => client.company.findUnique({ where: { id: body.companyId! }, select: { id: true } })) : null
    if (!company) throw new NotFoundError('Company not found.')
  }
  assertManage(context, body)
  const type = retentionTypeOf(body.recordType)
  if (!type) {
    const words = (APPEND_ONLY_LEDGERS as readonly string[]).includes(body.recordType) ? LEDGER_KEPT_WORDS : `The sweep knows nothing of "${body.recordType}": pick a record type it knows.`
    refuse([{ path: 'recordType', message: words }], words)
  }
  if (body.companyId !== null && !type!.companyScoped) refuse([{ path: 'companyId', message: `${body.recordType} belongs to the whole group: its rule is one for every company.` }], 'This rule is one for the whole group.')
  refuse(ruleProblems(body, type!.actions), 'The rule is not valid.')
  const key = ruleKey(body.recordType, body.companyId)
  const { result } = await command(caller, { name: 'privacy.retentionAdd', idempotencyKey, input: body }, async (tools) => {
    if (await tools.tx.retentionRule.findFirst({ where: { key }, select: { id: true } })) throw new ConflictError(`A rule for ${body.recordType} ${body.companyId === null ? 'of the whole group' : 'of this company'} exists already: change it instead.`)
    const id = newId()
    const row = await tools.tx.retentionRule.create({
      data: { id, companyId: body.companyId, key, recordType: body.recordType, keepMonths: body.keepMonths, thenAction: body.thenAction, legalReason: body.legalReason.trim(), active: true, applyOn: false, createdById: context.actorId },
      select: RULE_SELECT,
    })
    tools.audit({ recordType: 'RetentionRule', recordId: id, companyId: body.companyId, after: { key, recordType: body.recordType, keepMonths: body.keepMonths, thenAction: body.thenAction, legalReason: row.legalReason, applyOn: false } })
    tools.emit(changeOf(row, 'ADDED'))
    return id
  })
  return { rule: await ruleAnswer(caller, result) }
}

export interface ChangeRuleBody {
  readonly version: number
  readonly keepMonths?: number | undefined
  readonly thenAction?: RetentionAction | undefined
  readonly legalReason?: string | undefined
}

/** PATCH /privacy/retention/rules/:ruleId */
export async function changeRule(caller: CommandCaller, ruleId: string, body: ChangeRuleBody, writes: Writes): Promise<{ rule: RuleView }> {
  const { context, rule } = await readRule(caller, ruleId)
  assertManage(context, rule)
  const type = retentionTypeOf(rule.recordType)
  if (!type) throw new InvalidStateError(RULE_HELD_WORDS.UNKNOWN_TYPE)
  const next = { keepMonths: body.keepMonths ?? rule.keepMonths, thenAction: body.thenAction ?? (rule.thenAction as RetentionAction), legalReason: body.legalReason ?? rule.legalReason }
  refuse(ruleProblems(next, type.actions), 'The rule is not valid.')
  // "Shortening needs the Owner (fresh code)"; another action while the rule applies changes what the sweep does to records.
  if (isShortening(rule.keepMonths, next.keepMonths) || (rule.applyOn && next.thenAction !== rule.thenAction)) writes.stepUp()
  await command(caller, { name: 'privacy.retentionChange', idempotencyKey: writes.idempotencyKey, input: { ruleId, ...body }, record: { type: 'RetentionRule', id: ruleId, expectedVersion: body.version } }, async (tools) => {
    await tools.tx.retentionRule.update({ where: { id: ruleId }, data: { keepMonths: next.keepMonths, thenAction: next.thenAction, legalReason: next.legalReason.trim(), updatedAt: tools.now }, select: { id: true } })
    tools.audit({ recordType: 'RetentionRule', recordId: ruleId, companyId: rule.companyId, before: { keepMonths: rule.keepMonths, thenAction: rule.thenAction, legalReason: rule.legalReason }, after: { keepMonths: next.keepMonths, thenAction: next.thenAction, legalReason: next.legalReason.trim() } })
    tools.emit(changeOf(rule, 'CHANGED', next))
    return null
  })
  return { rule: await ruleAnswer(caller, ruleId) }
}

/** POST /privacy/retention/rules/:ruleId/active: off (neither reports nor applies; applying stops too) or on again (reporting). */
export async function setRuleActive(caller: CommandCaller, ruleId: string, body: { readonly version: number; readonly active: boolean }, idempotencyKey?: string): Promise<{ rule: RuleView }> {
  const { context, rule } = await readRule(caller, ruleId)
  assertManage(context, rule)
  if (rule.active === body.active) throw new InvalidStateError(body.active ? RULE_HELD_WORDS.ACTIVE : RULE_HELD_WORDS.SWITCHED_OFF)
  await command(caller, { name: 'privacy.retentionActive', idempotencyKey, input: { ruleId, ...body }, record: { type: 'RetentionRule', id: ruleId, expectedVersion: body.version } }, async (tools) => {
    const data = body.active ? { active: true } : { active: false, applyOn: false, applyOnAt: null, applyOnById: null }
    await tools.tx.retentionRule.update({ where: { id: ruleId }, data: { ...data, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ recordType: 'RetentionRule', recordId: ruleId, companyId: rule.companyId, before: { active: rule.active, applyOn: rule.applyOn }, after: { active: body.active, applyOn: body.active ? rule.applyOn : false } })
    if (!body.active) tools.emit(changeOf(rule, 'SWITCHED_OFF'))
    else tools.emit(changeOf(rule, 'CHANGED'))
    return null
  })
  return { rule: await ruleAnswer(caller, ruleId) }
}

/** POST /privacy/retention/rules/:ruleId/apply: GATE-PRIVACY's switch (on asks a fresh code; off never does). */
export async function setRuleApply(caller: CommandCaller, ruleId: string, body: { readonly version: number; readonly on: boolean }, writes: Writes): Promise<{ rule: RuleView }> {
  const { context, rule } = await readRule(caller, ruleId)
  assertManage(context, rule)
  if (!rule.active) throw new InvalidStateError(RULE_HELD_WORDS.SWITCHED_OFF)
  if (body.on && !retentionTypeOf(rule.recordType)) throw new InvalidStateError(RULE_HELD_WORDS.UNKNOWN_TYPE)
  if (rule.applyOn === body.on) throw new InvalidStateError(body.on ? RULE_HELD_WORDS.APPLYING : RULE_HELD_WORDS.NOT_APPLYING)
  if (body.on) writes.stepUp()
  await command(caller, { name: 'privacy.retentionApply', idempotencyKey: writes.idempotencyKey, input: { ruleId, ...body }, record: { type: 'RetentionRule', id: ruleId, expectedVersion: body.version } }, async (tools) => {
    const data = body.on ? { applyOn: true, applyOnAt: tools.now, applyOnById: context.actorId } : { applyOn: false, applyOnAt: null, applyOnById: null }
    await tools.tx.retentionRule.update({ where: { id: ruleId }, data: { ...data, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ recordType: 'RetentionRule', recordId: ruleId, companyId: rule.companyId, before: { applyOn: rule.applyOn }, after: { applyOn: body.on } })
    tools.emit(changeOf(rule, body.on ? 'APPLY_ON' : 'APPLY_OFF'))
    return null
  })
  return { rule: await ruleAnswer(caller, ruleId) }
}

/** POST /privacy/retention/rules/:ruleId/sweep: one sweep now (reports, or applies when switched on); a refusal is a FAILED sweep. */
export async function sweepNow(caller: CommandCaller, ruleId: string) {
  const { context, rule } = await readRule(caller, ruleId)
  assertManage(context, rule)
  const sweepId = await sweepRule(caller, ruleId, { requestedById: context.actorId })
  const answer = await ruleAnswer(caller, ruleId)
  const sweep = await caller.withClient(async (client) => {
    const row = await client.retentionSweep.findUniqueOrThrow({ where: { id: sweepId }, select: SWEEP_SELECT })
    return sweepViewOf(row, rule.recordType, await namesOf(client, [row.requestedById]))
  })
  return { rule: answer, sweep }
}
