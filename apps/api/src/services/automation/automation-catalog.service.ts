/**
 * R5 (MCP full control, part 06) — every automation in one list: the 39 of the plan's inventory (§1), each with its
 * level, what the server allows, what this business set, its scope, schedule, caps and last run.
 *
 * The effective level is env AND business: the LOWER of what the server's env lets it reach and what this business's
 * own rows say. An automation the env switches off reads OFF, with the flag's name in the reason — a rule set to AUTO
 * on a server whose cron is off does nothing, and a list that showed AUTO there would be the most misleading thing it
 * could say (the Control Room learnt this; see ads-control-room.service.ts).
 *
 * Read-only: one CronRun read for every last run, and each adapter's own reads (automation-adapters.ts). Every read
 * runs in the caller's business. Claude's `list-automations` and `automation-detail` tools (R6) read this.
 */
import prisma from '../../db.js'
import { AUTOMATION_ADAPTERS } from './automation-adapters.js'
import { ENGINES, readEngineSwitch, type EngineKey, type EngineSwitchRow } from './engine-switch.service.js'
import {
  AUTOMATION_IDS, lowest,
  type AutomationAdapter, type AutomationArea, type AutomationId, type AutomationLevel, type AutomationRow,
  type BusinessState, type ClaudeReach, type EnvFlag, type LastRun, type PreviewKind, type WritesTo,
} from './automation-levels.js'

export interface AutomationEntry {
  id: AutomationId
  key: string
  name: string
  what: string
  area: AutomationArea
  writesTo: readonly WritesTo[]
  /**
   * How far it may go now: the lower of `env.ceiling` and `business.level`. Null for settings and brakes (harvest
   * policy, protected terms, guardrails, the suggestions queue …), which never act on their own: `state` says what is
   * in force.
   */
  level: AutomationLevel | null
  /** Why it is at that level, in a sentence: the env flag that holds it down, or what this business set. */
  levelReason: string
  /** What the server's env allows (never a value: only whether each flag lets it act). */
  env: { ceiling: AutomationLevel; flags: EnvFlag[] }
  /** What this business's rows say, before the env cap. */
  business: { level: AutomationLevel | null; reason: string }
  state: string | null
  scope: string | null
  schedule: string | null
  caps: Record<string, unknown> | null
  rows: BusinessState['rows'] | null
  sample: BusinessState['sample'] | null
  lastRun: LastRun | null
  claude: ClaudeReach
  preview: PreviewKind
  previewNote: string
  /**
   * R16 — an engine the env switches: this business's own switch under the env (null = not set: the env alone decides).
   * Absent for automations that have none.
   */
  switch?: { key: string; set: EngineSwitchRow | null }
}

/** The adapter of an automation by its inventory id (A1, N6 …) or key (ads-rules …), case-insensitive. */
export function automationAdapter(idOrKey: string): AutomationAdapter | undefined {
  const wanted = idOrKey.trim().toLowerCase()
  return AUTOMATION_ADAPTERS.find((a) => a.id.toLowerCase() === wanted || a.key === wanted)
}

export function listAdapters(): readonly AutomationAdapter[] {
  return AUTOMATION_ADAPTERS
}

/** The latest CronRun of each job name, in one read. */
async function lastRuns(jobNames: string[]): Promise<Map<string, LastRun & { startedAt: Date }>> {
  if (!jobNames.length) return new Map()
  const rows = await prisma.cronRun.findMany({
    where: { jobName: { in: jobNames } },
    orderBy: { startedAt: 'desc' },
    distinct: ['jobName'],
    select: { jobName: true, startedAt: true, status: true, outputSummary: true, errorMessage: true },
  })
  const clip = (text: string | null) => (text && text.length > 240 ? `${text.slice(0, 239)}…` : text)
  return new Map(rows.map((r) => [r.jobName, { at: r.startedAt.toISOString(), startedAt: r.startedAt, status: r.status, summary: clip(r.outputSummary ?? r.errorMessage ?? null) }]))
}

function lastRunOf(adapter: AutomationAdapter, runs: Map<string, LastRun & { startedAt: Date }>): LastRun | null {
  let latest: (LastRun & { startedAt: Date }) | null = null
  for (const name of adapter.crons) {
    const run = runs.get(name)
    if (run && (!latest || run.startedAt > latest.startedAt)) latest = run
  }
  return latest ? { at: latest.at, status: latest.status, summary: latest.summary } : null
}

/** One adapter's entry: env AND business, and the reason for the level it ends at. */
export function entryOf(adapter: AutomationAdapter, business: BusinessState, lastRun: LastRun | null): AutomationEntry {
  const env = adapter.env()
  let level: AutomationLevel | null = null
  let levelReason = business.reason
  if (business.level != null) {
    level = lowest(env.ceiling, business.level)
    // Env says off (or lower) and wins: say the flag. Otherwise the business's own reason stands.
    if (env.reason && (env.ceiling === 'OFF' || (level === env.ceiling && env.ceiling !== business.level))) levelReason = env.reason
  } else if (env.reason) {
    levelReason = `${business.reason} ${env.reason}`
  }
  return {
    id: adapter.id,
    key: adapter.key,
    name: adapter.name,
    what: adapter.what,
    area: adapter.area,
    writesTo: adapter.writesTo,
    level,
    levelReason,
    env: { ceiling: env.ceiling, flags: env.flags },
    business: { level: business.level, reason: business.reason },
    state: business.state ?? null,
    scope: business.scope ?? null,
    schedule: adapter.schedule,
    caps: business.caps ?? null,
    rows: business.rows ?? null,
    sample: business.sample ?? null,
    lastRun: business.lastRun !== undefined ? business.lastRun : lastRun,
    claude: adapter.claude,
    preview: adapter.preview,
    previewNote: adapter.previewNote,
  }
}

/** A business state that could not be read: said, never guessed. */
function unreadable(error: unknown): BusinessState {
  return { level: null, reason: `Could not read this automation's settings: ${error instanceof Error ? error.message : String(error)}` }
}

/**
 * R16 — an engine's business state under its own switch: a switch set lower than its rows say lowers the business
 * level, and says who set it. No switch row: unchanged.
 */
function underSwitch(business: BusinessState, set: EngineSwitchRow | null, name: string): BusinessState {
  if (!set) return business
  const level = business.level == null ? set.mode : lowest(business.level, set.mode)
  return { ...business, level, reason: `This business switched ${name} to ${set.mode} (${set.setBy}, ${set.setAt.slice(0, 10)}). ${business.reason}` }
}

/** Every automation, or those the filter keeps, in inventory order. */
export async function getAutomationCatalog(keep: (adapter: AutomationAdapter) => boolean = () => true): Promise<AutomationEntry[]> {
  const adapters = AUTOMATION_ADAPTERS.filter(keep)
  const runs = await lastRuns([...new Set(adapters.flatMap((a) => a.crons))])
  const states = await Promise.all(adapters.map((a) => a.state().catch(unreadable)))
  const engineOf = (a: AutomationAdapter) => (a.engine && a.engine in ENGINES ? (a.engine as EngineKey) : null)
  const switches = await Promise.all(adapters.map((a) => { const key = engineOf(a); return key ? readEngineSwitch(key) : Promise.resolve(null) }))
  return adapters.map((adapter, i) => {
    const key = engineOf(adapter)
    if (!key) return entryOf(adapter, states[i], lastRunOf(adapter, runs))
    return { ...entryOf(adapter, underSwitch(states[i], switches[i], ENGINES[key].name), lastRunOf(adapter, runs)), switch: { key, set: switches[i] } }
  })
}

/** One automation's entry and its rows. */
export async function getAutomationDetail(adapter: AutomationAdapter): Promise<{ entry: AutomationEntry; rows: AutomationRow[] | null }> {
  const [entry] = await getAutomationCatalog((a) => a === adapter)
  const rows = adapter.rows ? await adapter.rows() : null
  return { entry, rows }
}

export { AUTOMATION_IDS }
