/**
 * 7a (review 8.1, 8.2) — what each ads engine does now, in plain groups, and what "Writing to Amazon" counts. Pure: the
 * Automations page and the Control Room render these with the design system's Pill, and the tests drive them directly.
 *
 * "Writing to Amazon: 6" counted every engine on Auto: the anomaly breaker and write delivery, which never change
 * Amazon by themselves, and engines with no plan or schedule to act on. The API now puts every engine in one group
 * (ads-control-room.service.ts `engineExposure`, which reads the automation catalog); only the first counts as writing.
 * Every engine stays listed — a group changes the label, never the list.
 */
import type { Tone } from '@/design-system/primitives'

export type ExposureGroup = 'acts' | 'ready' | 'server-off' | 'held' | 'never' | 'unknown'

export interface EngineExposure {
  group: ExposureGroup
  /** The group in words, as the API says it ("Changes Amazon on its own", "Ready — nothing set up" …). */
  label: string
  /** What would start it, when it is ready with nothing to act on. */
  start: string | null
}

/** What 7a adds to an engine row. Optional: an older API omits them, and an engine is then never counted as writing. */
export interface ExposureFields {
  writesOnOwn?: boolean
  exposure?: EngineExposure
  activity?: 'never-ran' | 'idle' | 'acted'
  writes7d?: number
}

/** The order the groups are said in: what changes Amazon first. */
export const GROUP_ORDER: readonly ExposureGroup[] = ['acts', 'ready', 'held', 'server-off', 'never', 'unknown']

export const GROUP_TONE: Record<ExposureGroup, Tone> = {
  acts: 'warning',
  ready: 'info',
  held: 'neutral',
  'server-off': 'neutral',
  never: 'neutral',
  unknown: 'danger',
}

const COUNTED: Record<ExposureGroup, (n: number) => string> = {
  acts: (n) => `${n} ${n === 1 ? 'changes Amazon on its own' : 'change Amazon on their own'}`,
  ready: (n) => `${n} ready — nothing set up`,
  held: (n) => `${n} held back in Nexus`,
  'server-off': (n) => `${n} off by a server switch`,
  never: (n) => `${n} ${n === 1 ? 'never changes Amazon by itself' : 'never change Amazon by themselves'}`,
  unknown: (n) => `${n} could not be read`,
}

/** Only an engine the API places in "acts" changes Amazon on its own. */
export const actsOnItsOwn = (e: ExposureFields): boolean => e.exposure?.group === 'acts'

export function groupCounts(engines: readonly ExposureFields[]): Record<ExposureGroup, number> {
  const out = Object.fromEntries(GROUP_ORDER.map((g) => [g, 0])) as Record<ExposureGroup, number>
  for (const e of engines) if (e.exposure) out[e.exposure.group] += 1
  return out
}

/** Every group that has an engine, in words: "2 change Amazon on their own · 5 ready — nothing set up · …". */
export function groupSummary(engines: readonly ExposureFields[]): string {
  const counts = groupCounts(engines)
  return GROUP_ORDER.filter((g) => counts[g] > 0).map((g) => COUNTED[g](counts[g])).join(' · ')
}

/**
 * Whether an engine row stays under one of the Automations band tiles: "writing" and "unscoped" keep the engines that
 * act (engines are unscoped by construction), "off" keeps those whose posture is off.
 */
export function engineInTile(e: ExposureFields & { posture: string }, tile: 'writing' | 'unscoped' | 'off'): boolean {
  return tile === 'off' ? e.posture === 'OFF' : actsOnItsOwn(e)
}
