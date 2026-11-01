import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import { creditNoteHandlers } from '../../../modules/invoicing/credit-note/handlers'
import { payablesHandlers } from '../../../modules/payables/sdi'
// B-W2b-15: a done work order's reservations released by the system.
import { releaseOnWorkOrderDoneHandler } from '../../../modules/inventory/reservations/system-release'
// B-W2b-40: a clock-out pauses the person's running work.
import { pauseAtClockOutHandler } from '../../../modules/production/terminal/clock-out'
import { ladderHandlers } from '../../../modules/receivables/ladder'
import { alertsRecheckHandler } from '../../../platform/alerts/engine'
import { notificationsHandler } from '../../../platform/notifications/fan-out'
import type { EventHandler } from '../../../platform/outbox/dispatch'
import { searchHandlers } from '../../../platform/search/indexing'
import { loadIndexers } from '../../../platform/search/registry'
import type { SearchIndexer } from '../../../platform/search/indexer'
import { assertWorkerHandlers, drain, workerHandlers, type World } from '../../testing/world'

/**
 * The W2a day's worker (B-W2a-82): every handler list of background.ts, not only W1's HANDLERS. The W1 world
 * (../../testing/world.ts) runs W1's list; the day runs that list plus each `W2A_<step>_HANDLERS` list the worker starts,
 * built from the same factories, so a handler a W2a step added (notifications, search, alert rechecks, the reminder ladder,
 * credit-note drafts, supplier-invoice pickup and rematch) follows the day's events as the real worker would.
 */

const BACKGROUND = fileURLToPath(new URL('../../../background.ts', import.meta.url))
const SRC = fileURLToPath(new URL('../../../', import.meta.url))

/** The W2a lists of background.ts, in its order, each with the factories that build it. */
const W2A_LISTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['W2A_20_HANDLERS', ['notificationsHandler']],
  ['W2A_32_HANDLERS', ['searchHandlers']],
  ['W2A_33_HANDLERS', ['alertsRecheckHandler']],
  ['W2A_55_HANDLERS', ['ladderHandlers']],
  ['W2A_61_HANDLERS', ['creditNoteHandlers']],
  ['W2A_62_HANDLERS', ['payablesHandlers']],
  ['W2B_15_HANDLERS', ['releaseOnWorkOrderDoneHandler']],
  ['W2B_40_HANDLERS', ['pauseAtClockOutHandler']],
]

/** The search indexers the worker loads from the registry folder (background.ts SEARCH_INDEXERS). */
export async function searchIndexers(): Promise<readonly SearchIndexer[]> {
  return loadIndexers(SRC)
}

/** Every handler the worker runs: W1's HANDLERS, then the W2a lists, as background.ts hands them to startEventWorkers. */
export function everyHandler(indexers: readonly SearchIndexer[]): readonly EventHandler[] {
  return [...workerHandlers(), notificationsHandler(), ...searchHandlers(indexers), alertsRecheckHandler(), ...ladderHandlers(), ...creditNoteHandlers(), ...payablesHandlers(), releaseOnWorkOrderDoneHandler(), pauseAtClockOutHandler()]
}

/** background.ts starts exactly W1's HANDLERS and the W2a lists above: a list or factory a step adds fails the day until it runs here too. */
export function assertEveryHandler(): void {
  assertWorkerHandlers()
  const source = readFileSync(BACKGROUND, 'utf8')
  const lists = [...source.matchAll(/^const (W2[AB]_\w+_HANDLERS): readonly EventHandler\[\] = (.+)$/gm)].map((match) => [match[1], [...match[2]!.matchAll(/(\w+)\(/g)].map((call) => call[1])] as const)
  expect(lists).toEqual(W2A_LISTS.map(([name, factories]) => [name, [...factories]]))
  const started = /startEventWorkers\(\{ kit, handlers: \[([^\]]*)\]/.exec(source)?.[1] ?? ''
  expect([...started.matchAll(/\.\.\.(\w+)/g)].map((match) => match[1])).toEqual(['HANDLERS', ...W2A_LISTS.map(([name]) => name)])
}

/** The worker's job after a step: the real relay hands every pending event to every handler (../../testing/world.ts drain). */
export function settler(world: World, handlers: readonly EventHandler[]): () => Promise<string[]> {
  return () => drain(world, handlers)
}
