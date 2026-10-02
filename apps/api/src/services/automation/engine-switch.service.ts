/**
 * R16 (MCP full control, part 06 §4, decision D-R2) — a per-business switch for each engine that only the server env
 * switched before. One row per business per engine (`AutomationSwitch`); the env stays the outer limit and is never
 * written here.
 *
 *   effective = lowest(what the env lets the engine do, this business's switch)
 *
 * No row = the env alone decides, exactly as before the table existed. Down is instant (turn-down-automation, inside
 * its limits unless the engine is a brake); up goes only as far as the env allows, and a person clicks it
 * (turn-up-automation never runs an engine up without one). Each engine reads its switch at the top of its own tick
 * (`engineMode`), in the business the tick runs for.
 */
import { workspaceKey } from '@nexus/database/workspace-context'
import { FEATURES } from '@nexus/shared/permissions'
import prisma from '../../db.js'
import type { ToolPermission } from '../agents/tool-types.js'
import { LEVELS, lowest, type AutomationLevel, type LevelSwitch, type SwitchRow } from './automation-levels.js'

export const ENGINE_KEYS = ['rank-defend', 'budget-enforce', 'auto-bid', 'tos-defense', 'coverage-engine', 'fleet-analysts', 'repricer'] as const
export type EngineKey = (typeof ENGINE_KEYS)[number]

export interface EngineDef {
  key: EngineKey
  name: string
  /** Its automation in the catalog (automation-catalog.service.ts): whose `env()` is the outer limit. */
  automation: string
  /** The levels its switch can be at, lowest first; the last is "as far as the env allows" (no row). */
  levels: readonly AutomationLevel[]
  /** Who may move it. */
  manage: ToolPermission
  /** Switched down, can it raise spend (part 06 §3, brakes are not down)? Why, or null. */
  brake: string | null
}

export const ENGINES: Record<EngineKey, EngineDef> = {
  'rank-defend': {
    key: 'rank-defend', name: 'Rank-defend', automation: 'A10', levels: ['OFF', 'AUTO'], manage: FEATURES.adsAutomationManage,
    brake: 'it suppresses bids outside its windows and moves placements: switched off, whatever it last set stays — its boosts included',
  },
  'budget-enforce': {
    key: 'budget-enforce', name: 'Budget enforcement', automation: 'A8', levels: ['OFF', 'OBSERVE', 'AUTO'], manage: FEATURES.adsAutomationManage,
    brake: 'it holds over-spending campaigns down: switched off or to observe, nothing catches the next over-spend',
  },
  'auto-bid': { key: 'auto-bid', name: 'Auto-bid', automation: 'A4', levels: ['OFF', 'AUTO'], manage: FEATURES.adsAutomationManage, brake: null },
  'tos-defense': { key: 'tos-defense', name: 'Top-of-search defense', automation: 'A11', levels: ['OFF', 'AUTO'], manage: FEATURES.adsAutomationManage, brake: null },
  'coverage-engine': { key: 'coverage-engine', name: 'Coverage engine', automation: 'A12', levels: ['OFF', 'OBSERVE', 'AUTO'], manage: FEATURES.adsAutomationManage, brake: null },
  'fleet-analysts': { key: 'fleet-analysts', name: 'Analyst fleet sweep', automation: 'F1', levels: ['OFF', 'OBSERVE'], manage: FEATURES.aiRun, brake: null },
  repricer: { key: 'repricer', name: 'Snapshot repricer', automation: 'N2', levels: ['OFF', 'OBSERVE', 'AUTO'], manage: FEATURES.pricingRulesManage, brake: null },
}

const top = (def: EngineDef) => def.levels[def.levels.length - 1]
const rank = (level: AutomationLevel) => LEVELS.indexOf(level)

export interface EngineSwitchRow {
  mode: AutomationLevel
  reason: string | null
  setBy: string
  setAt: string
}

/** This business's switch of an engine; null = no row (the env alone decides). */
export async function readEngineSwitch(key: EngineKey): Promise<EngineSwitchRow | null> {
  const row = await prisma.automationSwitch.findUnique({ where: { workspace_key: workspaceKey({ key }) } })
  if (!row) return null
  return { mode: row.mode as AutomationLevel, reason: row.reason, setBy: row.setBy, setAt: row.setAt.toISOString() }
}

/**
 * What the engine may do in this business now: the lower of what its env gives it (`envMode`, read by the job as it
 * always has) and this business's switch. A read failure is not "no row": it fails the tick (recorded as a failed
 * run), never runs an engine this business switched off.
 */
export async function engineMode(key: EngineKey, envMode: AutomationLevel): Promise<{ mode: AutomationLevel; switched: EngineSwitchRow | null; note: string | null }> {
  const switched = await readEngineSwitch(key)
  if (!switched) return { mode: envMode, switched: null, note: null }
  const mode = lowest(envMode, switched.mode)
  return { mode, switched, note: rank(switched.mode) < rank(envMode) ? `switched to ${switched.mode} for this business by ${switched.setBy}` : null }
}

/** The engines the Control Room lists with a switch (the snapshot repricer is a pricing engine, switched by Claude's tools). */
export const CONTROL_ROOM_ENGINES: readonly EngineKey[] = ['rank-defend', 'budget-enforce', 'auto-bid', 'tos-defense', 'coverage-engine', 'fleet-analysts']

export type EngineSwitchAnswer =
  | { ok: true; key: EngineKey; name: string; from: AutomationLevel; mode: AutomationLevel; env: { ceiling: AutomationLevel; reason: string | null } }
  | { ok: false; status: number; error: string }

/** What the env lets the engine reach: its catalog adapter's own reading of the flags. */
export async function engineEnv(key: EngineKey): Promise<{ ceiling: AutomationLevel; reason: string | null }> {
  const { automationAdapter } = await import('./automation-catalog.service.js')
  const adapter = automationAdapter(ENGINES[key].automation)
  if (!adapter) return { ceiling: 'OFF', reason: 'its automation is not in the catalog' }
  const e = adapter.env()
  return { ceiling: e.ceiling, reason: e.reason }
}

/**
 * A person moves an engine's switch (the Control Room lever drawer). Down is instant. Up never goes past the env, and
 * only with `confirmUp` — the page's confirm, held here too, so no request turns an engine up by accident. Both write
 * the same audit row as Claude's approved moves.
 */
export async function changeEngineSwitch(key: string, mode: string, actorUserId: string | null, opts: { reason?: string | null; confirmUp?: boolean } = {}): Promise<EngineSwitchAnswer> {
  if (!(ENGINE_KEYS as readonly string[]).includes(key)) return { ok: false, status: 404, error: `There is no engine switch "${key}".` }
  const def = ENGINES[key as EngineKey]
  if (!(def.levels as readonly string[]).includes(mode)) return { ok: false, status: 400, error: `${def.name} can be ${def.levels.join(', ')} — not ${mode}.` }
  const to = mode as AutomationLevel
  const from = (await readEngineSwitch(def.key))?.mode ?? top(def)
  if (to === from) return { ok: false, status: 409, error: `${def.name} is already ${to} for this business.` }
  const env = await engineEnv(def.key)
  if (rank(to) > rank(from)) {
    if (rank(to) > rank(env.ceiling)) return { ok: false, status: 409, error: `The server env lets ${def.name} go no higher than ${env.ceiling}${env.reason ? ` (${env.reason})` : ''}. The env is the Owner's server setting and is never changed here.` }
    if (!opts.confirmUp) return { ok: false, status: 400, error: `Turning ${def.name} up needs a confirmation (confirm: true).` }
  }
  await recordEngineSwitch(def.key, from, to, actorUserId, opts.reason?.trim() || null)
  return { ok: true, key: def.key, name: def.name, from, mode: to, env }
}

/** Write the switch and its audit row: one path for a person's move and Claude's approved one. */
async function recordEngineSwitch(key: EngineKey, from: AutomationLevel, to: AutomationLevel, actorUserId: string | null, reason: string | null): Promise<void> {
  await setEngineSwitch(key, to, `user:${actorUserId ?? 'anonymous'}`, reason)
  const { auditLogService } = await import('../audit-log.service.js')
  await auditLogService.write({ userId: actorUserId, entityType: 'AutomationSwitch', entityId: key, action: 'set_engine_switch', before: { mode: from }, after: { mode: to, reason } }).catch(() => undefined)
}

/** Set this business's switch. The engine's top level removes the row: back to "the env alone decides". */
export async function setEngineSwitch(key: EngineKey, mode: AutomationLevel, setBy: string, reason: string | null = null): Promise<void> {
  const def = ENGINES[key]
  if (!def.levels.includes(mode)) throw new Error(`${def.name} can be ${def.levels.join(', ')} — not ${mode}`)
  if (mode === top(def)) {
    await prisma.automationSwitch.deleteMany({ where: { key } })
    return
  }
  await prisma.automationSwitch.upsert({
    where: { workspace_key: workspaceKey({ key }) },
    create: { key, mode, reason, setBy },
    update: { mode, reason, setBy, setAt: new Date() },
  })
}

/**
 * turn-up / turn-down-automation's view of an engine switch. `envCeiling` is the engine's adapter `env()` (the
 * catalog's own reading of the flags): up never goes past it.
 */
export function engineLevelSwitch(key: EngineKey, env: () => { ceiling: AutomationLevel; reason: string | null }): LevelSwitch {
  const def = ENGINES[key]
  return {
    levels: def.levels,
    needsRow: false,
    manage: def.manage,
    async read(): Promise<SwitchRow> {
      const row = await readEngineSwitch(key)
      return { id: key, name: `${def.name} (this business's switch)`, level: row?.mode ?? top(def), basis: row?.setAt ?? null, brake: def.brake }
    },
    async refusal(_row, level) {
      const e = env()
      if (rank(level) > rank(e.ceiling)) return `the server env lets it go no higher than ${e.ceiling}${e.reason ? ` (${e.reason})` : ''} — the env is the Owner's and is never changed here`
      return null
    },
    async write(row, level, actorUserId) {
      await recordEngineSwitch(key, row.level, level, actorUserId, `turned ${rank(level) < rank(row.level) ? 'down' : 'up'} from ${row.level} (Claude, approved)`)
      return null
    },
  }
}
