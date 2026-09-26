/**
 * Publish circuit breakers across the API, worker and scheduler.
 *
 * Each process keeps its own circuits in memory (amazon/ebay/shopify-publish-gate.service.ts): the API's for
 * publishes it runs inline, the worker's for the outbound queue. The dashboard used to read only the API's
 * map, so a circuit the worker had opened showed as "closed", and "reset" closed nothing in the worker.
 *
 * Now every process publishes its circuits in its runtime snapshot (lib/runtime-status) and the API
 * aggregates them. A reset is a generation counter in Redis per channel: the API increments it, every process
 * compares it with the generation it last applied on each publish tick, resets its own circuits when it moved,
 * and publishes the generation it applied. The API waits a few seconds for those acknowledgements and reports
 * exactly which processes applied the reset and which did not.
 */
import { logger } from '../../utils/logger.js'
import { getAllAmazonCircuitStates, resetAllAmazonCircuits } from '../amazon-publish-gate.service.js'
import { getAllEbayCircuitStates, resetAllEbayCircuits } from '../ebay-publish-gate.service.js'
import { getAllShopifyCircuitStates, resetAllShopifyCircuits } from '../shopify-publish-gate.service.js'
import {
  PROCESS_ROLES, bounded, currentProcessRole, localInstanceId, publishLocalSnapshot, readLiveProcesses,
  registerStatusSection, statusKey, statusRedis, unknownFor, type LiveProcesses, type ProcessRole, type ProcessSnapshot, type UnknownValue,
} from '../../lib/runtime-status/process-snapshot.js'

export const CIRCUIT_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY'] as const
export type CircuitChannel = (typeof CIRCUIT_CHANNELS)[number]
type KnownState = 'closed' | 'open' | 'half-open'
type CircuitEntry = { state: KnownState; failureCount: number; openedAt: string | null; lastError?: string | null }

const LOCAL: Record<CircuitChannel, { read: () => Record<string, CircuitEntry>; reset: () => void }> = {
  AMAZON: { read: getAllAmazonCircuitStates, reset: resetAllAmazonCircuits },
  EBAY: { read: getAllEbayCircuitStates, reset: resetAllEbayCircuits },
  SHOPIFY: { read: getAllShopifyCircuitStates, reset: resetAllShopifyCircuits },
}

export const circuitResetKey = (channel: CircuitChannel) => statusKey(`circuit-reset:${channel}`)

export function isCircuitChannel(value: string): value is CircuitChannel {
  return (CIRCUIT_CHANNELS as readonly string[]).includes(value)
}

/** The reset generation this process has applied per channel; null until it first reached Redis. */
let appliedGenerations: Record<CircuitChannel, number> | null = null

/** Puts this process's circuits in its runtime snapshot. Idempotent; readers call it too, so the API always reports its own. */
export function registerCircuitSection(): void {
  registerStatusSection('circuits', circuitSection)
}

/** This process's circuits, for its runtime snapshot. */
export function circuitSection(): { channels: Record<CircuitChannel, Record<string, CircuitEntry>>; resetApplied: Record<CircuitChannel, number> | null } {
  return {
    channels: Object.fromEntries(CIRCUIT_CHANNELS.map(channel => [channel, LOCAL[channel].read()])) as Record<CircuitChannel, Record<string, CircuitEntry>>,
    resetApplied: appliedGenerations ? { ...appliedGenerations } : null,
  }
}

/**
 * Apply every reset requested since this process last looked. Runs on each publish tick in every process.
 * The first successful read only records the current generations: a process that just started holds no
 * circuits from before them.
 */
export async function applyRequestedCircuitResets(): Promise<CircuitChannel[]> {
  const redis = await statusRedis()
  if (!redis.client) return []
  const values = await bounded(redis.client.mget(...CIRCUIT_CHANNELS.map(circuitResetKey)))
  const generations = Object.fromEntries(CIRCUIT_CHANNELS.map((channel, i) => [channel, Number(values[i] ?? 0) || 0])) as Record<CircuitChannel, number>
  if (!appliedGenerations) {
    appliedGenerations = generations
    return []
  }
  const applied: CircuitChannel[] = []
  for (const channel of CIRCUIT_CHANNELS) {
    if (generations[channel] > appliedGenerations[channel]) {
      LOCAL[channel].reset()
      appliedGenerations[channel] = generations[channel]
      applied.push(channel)
    }
  }
  if (applied.length) logger.info('publish circuits reset on operator request', { channels: applied, role: currentProcessRole() })
  return applied
}

const RANK: Record<KnownState, number> = { closed: 0, 'half-open': 1, open: 2 }

export interface ChannelCircuitView {
  /** The worst state any reporting process holds; 'unknown' when all reported closed but a process did not report. */
  state: KnownState | 'unknown'
  failureCount: number
  openedAt: string | null
  lastError: string | null
  keyCount: number
  /** True when every process role reported its circuits. */
  complete: boolean
  reporting: Array<{ role: ProcessRole; instanceId: string; publishedAt: string; state: KnownState; keyCount: number }>
  unknown: UnknownValue[]
}

function channelsOf(snapshot: ProcessSnapshot): Record<string, Record<string, CircuitEntry>> | null {
  const section = snapshot.sections.circuits as { channels?: Record<string, Record<string, CircuitEntry>> } | undefined
  return section?.channels && typeof section.channels === 'object' ? section.channels : null
}

export function aggregateCircuits(live: LiveProcesses): Record<CircuitChannel, ChannelCircuitView> {
  const reportingSnapshots = live.snapshots.filter(snapshot => channelsOf(snapshot))
  const missingRoles = PROCESS_ROLES.filter(role => !reportingSnapshots.some(snapshot => snapshot.role === role))
  return Object.fromEntries(CIRCUIT_CHANNELS.map(channel => {
    const entries: CircuitEntry[] = []
    const reporting: ChannelCircuitView['reporting'] = []
    for (const snapshot of reportingSnapshots) {
      const own = Object.values(channelsOf(snapshot)![channel] ?? {})
      entries.push(...own)
      const worstOwn = own.reduce<KnownState>((worst, entry) => (RANK[entry.state] > RANK[worst] ? entry.state : worst), 'closed')
      reporting.push({ role: snapshot.role, instanceId: snapshot.instanceId, publishedAt: snapshot.publishedAt, state: worstOwn, keyCount: own.length })
    }
    const worst = entries.reduce<CircuitEntry | null>((a, b) => {
      if (!a) return b
      if (RANK[b.state] !== RANK[a.state]) return RANK[b.state] > RANK[a.state] ? b : a
      return b.failureCount > a.failureCount ? b : a
    }, null)
    const unknown = missingRoles.map(role => unknownFor(live, role, `${channel}.circuits`))
    const knownState: KnownState = worst?.state ?? 'closed'
    const view: ChannelCircuitView = {
      state: knownState === 'closed' && unknown.length ? 'unknown' : knownState,
      failureCount: worst?.failureCount ?? 0,
      openedAt: worst?.openedAt ?? null,
      lastError: worst?.lastError ?? null,
      keyCount: entries.length,
      complete: unknown.length === 0,
      reporting,
      unknown,
    }
    return [channel, view]
  })) as Record<CircuitChannel, ChannelCircuitView>
}

export async function readCircuitBreakers(): Promise<Record<CircuitChannel, ChannelCircuitView>> {
  registerCircuitSection()
  return aggregateCircuits(await readLiveProcesses())
}

export interface CircuitResetOutcome {
  /** The request reached Redis, so every process that publishes will apply it. */
  recorded: boolean
  generation: number | null
  acknowledgedBy: Array<{ role: ProcessRole; instanceId: string }>
  /** Live processes that had not applied the reset when the wait ended. */
  pending: Array<{ role: ProcessRole; instanceId: string }>
  /** Every role reported, and every live process applied the reset. */
  complete: boolean
  circuits: ChannelCircuitView
  reason?: string
}

const ackOf = (snapshot: ProcessSnapshot, channel: CircuitChannel): number => {
  const applied = (snapshot.sections.circuits as { resetApplied?: Record<string, number> | null } | undefined)?.resetApplied
  return Number(applied?.[channel] ?? -1)
}

export async function requestCircuitReset(
  channel: CircuitChannel,
  options: { waitMs?: number; pollMs?: number } = {},
): Promise<CircuitResetOutcome> {
  // Long enough for every process's next publish tick (PUBLISH_INTERVAL_MS) to apply and acknowledge it.
  const waitMs = options.waitMs ?? (Number(process.env.NEXUS_CIRCUIT_RESET_WAIT_MS) || 7_000)
  const pollMs = options.pollMs ?? 250
  registerCircuitSection()
  // This process first: the operator asked for it, and it needs no round trip.
  LOCAL[channel].reset()
  const self = { role: currentProcessRole(), instanceId: localInstanceId() }
  const redis = await statusRedis()
  let generation: number
  try {
    if (!redis.client) throw new Error(redis.reason)
    // Establish (or catch up on) this process's generations first, so recording ours cannot make the next
    // tick mistake another channel's old generation for a new request.
    await applyRequestedCircuitResets()
    generation = await bounded(redis.client.incr(circuitResetKey(channel)))
  } catch (error) {
    const live = await readLiveProcesses()
    return {
      recorded: false,
      generation: null,
      acknowledgedBy: [self],
      pending: [],
      complete: false,
      circuits: aggregateCircuits(live)[channel],
      reason: `the reset could not be recorded in Redis (${error instanceof Error ? error.message : String(error)}); only this ${self.role} process was reset`,
    }
  }
  appliedGenerations ??= Object.fromEntries(CIRCUIT_CHANNELS.map(c => [c, 0])) as Record<CircuitChannel, number>
  appliedGenerations[channel] = Math.max(appliedGenerations[channel], generation)
  await publishLocalSnapshot(redis).catch(() => false)

  const deadline = Date.now() + waitMs
  let live: LiveProcesses
  for (;;) {
    live = await readLiveProcesses()
    const others = live.snapshots.filter(snapshot => snapshot.instanceId !== self.instanceId || snapshot.role !== self.role)
    if (others.every(snapshot => ackOf(snapshot, channel) >= generation) || Date.now() >= deadline) break
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
  const circuits = aggregateCircuits(live)[channel]
  const acknowledgedBy = live.snapshots.filter(s => ackOf(s, channel) >= generation).map(s => ({ role: s.role, instanceId: s.instanceId }))
  const pending = live.snapshots.filter(s => ackOf(s, channel) < generation).map(s => ({ role: s.role, instanceId: s.instanceId }))
  return { recorded: true, generation, acknowledgedBy, pending, complete: pending.length === 0 && circuits.complete, circuits }
}

/** Test seam: forget the applied generations, as a freshly started process would. */
export function __resetCircuitGenerationsForTests(): void {
  appliedGenerations = null
}
