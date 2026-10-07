/**
 * R10 (MCP full control, part 06 §3–§4) — one level service for every automation Claude may switch: up or down the
 * OFF · OBSERVE · PROPOSE · AUTO ladder, through each kind's own switch (its adapter's `levelSwitch`), with its audit.
 *
 *   · AUTO through the graduation gate (D-R1): a person's click is held by the kind's own `refusal` (Amazon ads rules:
 *     the level dial's ceiling, contested lane and gate — shared with the Control Room dial; other rules: 14 days, 10
 *     real runs, 1 match). A kind with no such refusal (the ads dial: only a halt; autopilot plans, budget pools,
 *     dayparting and budget schedules, coverage sets, repricing rules) does not hold his click. AA-W2-11 (D-W2-4 = A) —
 *     a move to AUTO also carries the row's gate evidence (`gate`, LevelSwitch.gateEvidence): Claude's rule may take an
 *     automation to AUTO only for automations the business lists and only once that gate is open; a kind with no
 *     evidence (the ads dial, an env engine, a repricing rule) is AUTO by a person's click only.
 *   · brakes are not "down" (§3): turning a brake down — a bid-lowering or negating rule, a dayparting schedule, a budget
 *     schedule — can raise spend, so the plan says `brake` and turn-down-automation puts it outside its limits (a person
 *     decides it, always).
 *   · env is never touched. R16: an engine the env switched gets a per-business switch under it (no rowId), which
 *     goes up only as far as the env allows and — when it goes up — always needs a person.
 *
 * `planSwitch` is the dry run (a pure read); `applySwitch` writes through the kind's switch.
 */
import { LEVELS, type AutomationAdapter, type AutomationLevel, type GateEvidence, type LevelSwitch, type SwitchRow } from './automation-levels.js'
import { ENGINES, engineLevelSwitch, type EngineKey } from './engine-switch.service.js'

export type Direction = 'up' | 'down'

export interface SwitchPlan {
  action: 'turn-up-automation' | 'turn-down-automation'
  automation: { id: string; key: string; name: string }
  row: { id: string; name: string }
  from: AutomationLevel
  to: AutomationLevel
  /** The level, and (W4-12b) any field the move changes with it (LevelSwitch.alsoChanges: an ads builder rule's `control`). */
  changes: { level: { from: AutomationLevel; to: AutomationLevel }; [field: string]: { from: string; to: string } }
  /** Why turning this down can raise spend; null when it cannot. */
  brake: string | null
  basis: string | null
  effect: string
  /** R16 — an engine's per-business switch: what the env allows it. Null for a row's switch. */
  env: { ceiling: AutomationLevel; reason: string | null } | null
  /** AA-W2-11 — a move up to AUTO: the row's graduation gate (null: no gate Nexus can check). Absent below AUTO. */
  gate?: GateEvidence | null
}

const rank = (level: AutomationLevel) => LEVELS.indexOf(level)

export type SwitchAnswer = { ok: true; plan: SwitchPlan; row: SwitchRow } | { ok: false; error: string }

/** The switch a move names: the engine's own (R16) when no row is named and it has one, else its rows' switch. */
function switchOf(adapter: AutomationAdapter, rowId: string | undefined): { sw: LevelSwitch; engine: EngineKey | null } | null {
  if (!rowId && adapter.engine && adapter.engine in ENGINES) {
    const key = adapter.engine as EngineKey
    return { sw: engineLevelSwitch(key, () => adapter.env()), engine: key }
  }
  return adapter.levelSwitch ? { sw: adapter.levelSwitch, engine: null } : null
}

/** Who may move it: the kind's own manage permission (an engine's switch: the engine's). Checked by the tools first. */
export function switchPermission(adapter: AutomationAdapter, rowId?: string) {
  if (!rowId && adapter.engine && adapter.engine in ENGINES) return ENGINES[adapter.engine as EngineKey].manage
  return adapter.levelSwitch?.manage ?? null
}

/** A switch's row as it is now (undo compares it with what a move wrote); null when there is none. */
export async function readSwitchRow(adapter: AutomationAdapter, rowId: string | undefined): Promise<SwitchRow | null> {
  const chosen = switchOf(adapter, rowId)
  return chosen ? chosen.sw.read(chosen.sw.needsRow ? rowId : undefined) : null
}

export async function planSwitch(adapter: AutomationAdapter, rowId: string | undefined, to: AutomationLevel, direction: Direction): Promise<SwitchAnswer> {
  const chosen = switchOf(adapter, rowId)
  if (!chosen) {
    if (rowId && adapter.engine) return { ok: false, error: `${adapter.name} switches as a whole: leave rowId out (${adapter.noSwitch ?? 'its rows are set in Nexus'}).` }
    return { ok: false, error: `${adapter.name} has no switch Claude can move: ${adapter.noSwitch ?? 'it is set in Nexus'}.` }
  }
  const { sw, engine } = chosen
  if (sw.needsRow && !rowId) return { ok: false, error: `Name the ${adapter.name} row to switch (rowId), from list-automations or automation-detail.` }
  const row = await sw.read(sw.needsRow ? rowId : undefined)
  if (!row) return { ok: false, error: `${adapter.name} has no row ${rowId} in this business (not found).` }
  if (!sw.levels.includes(to)) return { ok: false, error: `${row.name}: ${adapter.name} can be ${sw.levels.join(', ')} — not ${to}.` }
  if (to === row.level) return { ok: false, error: `${row.name} is already ${to}.` }
  if (direction === 'up' && rank(to) < rank(row.level)) return { ok: false, error: `${row.name} is ${row.level}: ${to} is down — use turn-down-automation.` }
  if (direction === 'down' && rank(to) > rank(row.level)) return { ok: false, error: `${row.name} is ${row.level}: ${to} is up — use turn-up-automation.` }
  if (direction === 'up' && sw.refusal) {
    const why = await sw.refusal(row, to)
    if (why) return { ok: false, error: `${row.name}: ${why}` }
  }
  const brake = direction === 'down' ? row.brake : null
  const env = engine ? adapter.env() : null
  // AA-W2-11 — the gate's evidence, for the limits Claude's rule is judged on (a person's click is held by `refusal` above).
  const gate = direction === 'up' && to === 'AUTO' ? (!engine && sw.gateEvidence ? await sw.gateEvidence(row) : null) : undefined
  // W4-12b — what else the move changes with the level (the kind's write changes it too).
  const also = !engine && sw.alsoChanges ? await sw.alsoChanges(row, to) : null
  const effect = (direction === 'up'
    ? `${row.name} goes from ${row.level} to ${to}.${to === 'AUTO' ? ' At AUTO it acts by itself, inside its caps and every guardrail.' : ''}`
    : `${row.name} goes from ${row.level} down to ${to}.${brake ? ` A brake: ${brake}.` : ''}`)
    + (also ? ` ${also.words}` : '')
    + (env ? ` The server env allows it ${env.ceiling}; it acts at the lower of the two from its next tick, in this business only.` : '')
  return {
    ok: true,
    row,
    plan: {
      action: direction === 'up' ? 'turn-up-automation' : 'turn-down-automation',
      automation: { id: adapter.id, key: adapter.key, name: adapter.name },
      row: { id: row.id, name: row.name },
      from: row.level, to,
      changes: { level: { from: row.level, to }, ...(also ? { [also.field]: { from: also.from, to: also.to } } : {}) },
      brake, basis: row.basis, effect,
      env: env ? { ceiling: env.ceiling, reason: env.reason } : null,
      ...(gate !== undefined ? { gate } : {}),
    },
  }
}

export async function applySwitch(adapter: AutomationAdapter, rowId: string | undefined, to: AutomationLevel, direction: Direction, actorUserId: string | null): Promise<{ ok: true; plan: SwitchPlan; level: AutomationLevel; note: string | null } | { ok: false; error: string }> {
  const planned = await planSwitch(adapter, rowId, to, direction)
  if ('error' in planned) return planned
  const { sw } = switchOf(adapter, rowId)!
  const written = await sw.write(planned.row, to, actorUserId)
  if (typeof written === 'string') return { ok: false, error: `${planned.row.name}: not switched — ${written}` }
  const now = await sw.read(sw.needsRow ? planned.row.id : undefined)
  return { ok: true, plan: planned.plan, level: now?.level ?? to, note: written?.note ?? null }
}
