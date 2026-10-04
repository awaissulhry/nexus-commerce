/**
 * AUTO.A0 — the unified actor list: everything that can change this account, in one vocabulary.
 *
 * The Automations page listed 51 rules; rules made 2.95% of the writes. The engines
 * (`ad-rank-defend` alone: 67%) had rows on the Control Room's Levers board and nowhere the
 * operator actually works. This service normalises the engine registry into actor rows the
 * Automations grid can render beside the rules, and — because the registry provably misses
 * actors the log contains (9,598 writes carry a null userId) — the list is **declared ∪
 * observed**: any actor string in the last window that no rule and no engine claims gets a row
 * saying exactly that, instead of vanishing.
 *
 * The RULES half is deliberately NOT here: `GET /advertising/autonomy/rules` already owns it
 * (census, ceilings, scope names, week counts) and a second reader of the same tables would be
 * a fork of this section's most load-bearing read. The client renders rules ∪ engines ∪
 * observed in one grid; this service owns everything that is not a rule.
 */
import { prisma } from '@nexus/database'
import { getEngineLevers, type EngineActivity, type ExposureGroup, type LeverMode } from './ads-control-room.service.js'
import { engineForActor, engineLabel } from './ads-engine-actors.js'

const DAY = 86_400_000

export interface EngineActor {
  kind: 'engine'
  key: string
  name: string
  what: string
  /** The engine's own posture, in the section's four words — read-only here (env/flag-owned). */
  posture: LeverMode
  postureReason: string
  haltBehaviour: 'honours' | 'gated' | 'exempt'
  scope: string | null
  cron: string | null
  schedule: string | null
  lastRunAt: string | null
  lastRunStatus: string | null
  lastRunSummary: string | null
  runs7d: number
  failures7d: number
  warning: string | null
  /** Writes in the window attributed to this engine's actor strings. */
  writes7d: number
  /** 7a — whether it can change Amazon by itself (the breaker and write delivery never do). */
  writesOnOwn: boolean
  /** 7a — what it does now, in plain groups: only `acts` changes Amazon on its own. */
  exposure: { group: ExposureGroup; label: string; start: string | null }
  activity: EngineActivity
  catalogId: string | null
}

export interface ObservedActor {
  kind: 'observed'
  /** The raw `userId` the log carries — or the literal '(no actor recorded)'. */
  actor: string
  label: string
  writes7d: number
  lastWriteAt: string | null
}

export interface ActorsPayload {
  engines: EngineActor[]
  /** Actor strings in the window that no rule and no engine claims. Never hidden. */
  observed: ObservedActor[]
  global: { autonomy: string; halted: boolean; degraded: boolean; envKill: boolean }
  window: { days: number; since: string }
}

export async function getActors(): Promise<ActorsPayload> {
  const days = 7
  const since = new Date(Date.now() - days * DAY)

  const [{ levers, global }, writeGroups, ruleRows] = await Promise.all([
    getEngineLevers(),
    prisma.advertisingActionLog.groupBy({
      by: ['userId'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _max: { createdAt: true },
    }),
    prisma.automationRule.findMany({ where: { domain: 'advertising' }, select: { id: true } }),
  ])
  const ruleIds = new Set(ruleRows.map((r) => r.id))

  // Attribute each observed actor string: engine → its row's writes7d; rule → the rules grid's
  // business; operator → one labelled row; unclaimed → an observed row each.
  const engineWrites = new Map<string, number>()
  const observed: ObservedActor[] = []
  let operatorWrites = 0
  let operatorLast: Date | null = null

  // The engine → actor map lives in ads-engine-actors.ts (one map for this list, the drawer and the breaker).
  const onBoard = new Set(levers.map((l) => l.key))

  for (const g of writeGroups) {
    const id = g.userId
    const n = g._count._all
    const last = g._max.createdAt
    if (id == null) {
      observed.push({ kind: 'observed', actor: '(no actor recorded)', label: 'Writes with no author — the log carries a null userId', writes7d: n, lastWriteAt: last?.toISOString() ?? null })
      continue
    }
    const engine = engineForActor(id)
    if (engine && onBoard.has(engine)) { engineWrites.set(engine, (engineWrites.get(engine) ?? 0) + n); continue }
    if (engine) {
      observed.push({ kind: 'observed', actor: id, label: `Written by ${engineLabel(engine)} (no row of its own on this board)`, writes7d: n, lastWriteAt: last?.toISOString() ?? null })
      continue
    }
    if (id.startsWith('automation:')) {
      const ruleId = id.slice('automation:'.length)
      if (ruleIds.has(ruleId)) continue // a rule's writes — the rules grid already shows them
      observed.push({ kind: 'observed', actor: id, label: 'An automation actor no rule and no engine claims', writes7d: n, lastWriteAt: last?.toISOString() ?? null })
      continue
    }
    if (id.startsWith('user:') || id === 'operator' || id === 'user') {
      operatorWrites += n
      if (last && (!operatorLast || last > operatorLast)) operatorLast = last
      continue
    }
    observed.push({ kind: 'observed', actor: id, label: 'An actor string the registry has never heard of', writes7d: n, lastWriteAt: last?.toISOString() ?? null })
  }
  if (operatorWrites > 0) {
    observed.unshift({ kind: 'observed', actor: 'you', label: 'Operator edits, from any page with a write control', writes7d: operatorWrites, lastWriteAt: operatorLast?.toISOString() ?? null })
  }
  observed.sort((a, b) => (a.actor === 'you' ? -1 : b.actor === 'you' ? 1 : b.writes7d - a.writes7d))

  const engines: EngineActor[] = levers.map((l) => ({
    kind: 'engine',
    key: l.key,
    name: l.name,
    what: l.what,
    posture: l.mode,
    postureReason: l.modeReason,
    haltBehaviour: l.haltBehaviour,
    scope: l.scope,
    cron: l.cron,
    schedule: l.schedule,
    lastRunAt: l.lastRunAt ? l.lastRunAt.toISOString() : null,
    lastRunStatus: l.lastRunStatus,
    lastRunSummary: l.lastRunSummary,
    runs7d: l.runs7d,
    failures7d: l.failures7d,
    warning: l.warning,
    writes7d: engineWrites.get(l.key) ?? 0,
    writesOnOwn: l.writesOnOwn,
    exposure: l.exposure,
    activity: l.activity,
    catalogId: l.catalogId,
  }))

  return { engines, observed, global, window: { days, since: since.toISOString() } }
}
