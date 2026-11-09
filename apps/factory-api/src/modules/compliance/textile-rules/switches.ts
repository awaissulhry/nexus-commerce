import type { FastifyRequest } from 'fastify'
import { TEXTILE_RULES_MANAGE } from '@nexus/factory-domain/compliance/textile-rules/permissions'
import { CHECK_WORDS, DEFAULT_SWITCHES, isSwitchableRule, SWITCH_WORDS, SWITCHABLE_RULES, type Switches, type SwitchableRule } from '@nexus/factory-domain/compliance/textile-rules/rules'
import { ForbiddenError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { COMMAND_SETTINGS, runCommand, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock, type Clock } from '../../../core/time'
import { mayWrite } from '../../product/materials/store'
import { officeOf } from '../labels/store'
import type { Reader } from './facts'

/**
 * The switches of the checks (B-W2b-208): the 80 % textile threshold, the care label and "Made in Italy", each OFF until a
 * person switches it on for the whole factory (Owner 2026-11-09: rules for lines and claims still open in OWNER-QUESTIONS
 * are built switched off). No table holds them yet (no schema in this step): a switch is the newest audit row
 * `compliance.textileRules.switch` of the Tenant record, `after` { rule, on }, with the person's reason. The compliance
 * rules schema of W2b-4 (B-W2b-216: market profiles and requirements) is where they move, per market.
 *
 * Switching takes the tenant's advisory lock `factory.textile-rules`, reads the switch under it (a switch to the state it is
 * already in is a 409 in words), writes the audit row and emits `textile_rule.switched`. It needs
 * compliance.textileRules.manage over every company (the switch is the factory's, not one company's).
 */

export const SWITCH_ACTION = 'compliance.textileRules.switch'
const RECORD_TYPE = 'Tenant'

let clock: Clock = serverClock
/** Test only: the module's clock (the switches' time and the checks' `asOf`). */
export function useTextileRulesClock(next: Clock | undefined): void {
  clock = next ?? serverClock
}
export const textileRulesClock = (): Clock => clock

export interface SwitchState {
  readonly on: boolean
  readonly changedAt: string | null
  readonly reason: string | null
}

/** Every switch as the newest audit row says it, else its default (OFF). */
export async function readSwitchStates(db: Reader, tenantId: string): Promise<Record<SwitchableRule, SwitchState>> {
  const rows = await db.auditLog.findMany({
    where: { recordType: RECORD_TYPE, recordId: tenantId, action: SWITCH_ACTION },
    select: { at: true, after: true, reason: true },
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
    take: 200,
  })
  const states = Object.fromEntries(SWITCHABLE_RULES.map((rule) => [rule, { on: DEFAULT_SWITCHES[rule], changedAt: null, reason: null }])) as Record<SwitchableRule, SwitchState>
  const seen = new Set<string>()
  for (const row of rows) {
    const after = row.after as { rule?: unknown; on?: unknown } | null
    if (!after || typeof after.rule !== 'string' || typeof after.on !== 'boolean' || !isSwitchableRule(after.rule) || seen.has(after.rule)) continue
    seen.add(after.rule)
    states[after.rule] = { on: after.on, changedAt: toUtcIso(row.at), reason: row.reason }
  }
  return states
}

export const switchesOf = (states: Record<SwitchableRule, SwitchState>): Switches =>
  Object.fromEntries(SWITCHABLE_RULES.map((rule) => [rule, states[rule].on])) as unknown as Switches

const viewOf = (rule: SwitchableRule, state: SwitchState) => ({
  rule,
  title: CHECK_WORDS[rule].title,
  on: state.on,
  words: { on: SWITCH_WORDS[rule].on, off: SWITCH_WORDS[rule].off },
  law: [...CHECK_WORDS[rule].law],
  changedAt: state.changedAt,
  reason: state.reason,
})
export type SwitchView = ReturnType<typeof viewOf>

/** GET /compliance/textile-rules/switches */
export async function listSwitches(request: FastifyRequest) {
  const context = officeOf(request)
  const states = await request.withClient((db) => readSwitchStates(db, context.tenantId))
  return { switches: SWITCHABLE_RULES.map((rule) => viewOf(rule, states[rule])), asOf: toUtcIso(clock.now()) }
}

/** PUT /compliance/textile-rules/switches/:rule { on, reason } */
export async function switchRule(caller: CommandCaller, rule: string, body: { readonly on: boolean; readonly reason: string }, key: string | null | undefined) {
  const context = officeOf(caller)
  if (!isSwitchableRule(rule)) throw new NotFoundError('There is no such check to switch.')
  if (!mayWrite(actorOf(context), TEXTILE_RULES_MANAGE, null)) throw new ForbiddenError('A check is switched for the whole factory: it needs a role over every company.')
  const { result } = await runCommand(
    caller,
    { name: SWITCH_ACTION, idempotencyKey: key, input: { rule, on: body.on, reason: body.reason } },
    async ({ tx, now, audit, emit }) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.textile-rules', ${context.tenantId}::uuid), 0))`
      const states = await readSwitchStates(tx, context.tenantId)
      if (states[rule].on === body.on) {
        throw new InvalidStateError(`The check "${CHECK_WORDS[rule].title}" is already ${body.on ? 'on' : 'off'}.`)
      }
      audit({ recordType: RECORD_TYPE, recordId: context.tenantId, companyId: null, before: { rule, on: states[rule].on }, after: { rule, on: body.on }, reason: body.reason })
      emit({ type: 'textile_rule.switched', subject: context.tenantId, companyId: null, payload: { rule, on: body.on } })
      return { switch: viewOf(rule, { on: body.on, changedAt: toUtcIso(now), reason: body.reason }) }
    },
    { ...COMMAND_SETTINGS, clock },
  )
  return result
}
