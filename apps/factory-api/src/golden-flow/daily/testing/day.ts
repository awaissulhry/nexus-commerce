import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import { creditNoteHandlers } from '../../../modules/invoicing/credit-note/handlers'
import { payablesHandlers } from '../../../modules/payables/sdi'
// B-W2b-15: a done work order's reservations released by the system.
import { releaseOnWorkOrderDoneHandler } from '../../../modules/inventory/reservations/system-release'
// B-W2b-40: a clock-out pauses the person's running work.
import { pauseAtClockOutHandler } from '../../../modules/production/terminal/clock-out'
// B-W2b-37: attendance.clock_event → that person's attendance day computed again.
import { attendanceHandlers } from '../../../modules/people/attendance/jobs'
import { overtimeHandlers } from '../../../modules/people/overtime/jobs'
import { earningsHandlers } from '../../../modules/people/earnings/jobs'
import { inspectionTriggerHandlers } from '../../../modules/quality/triggers/handler'
// B-W2b-118: a hold placed, a critical NCR, a safety complaint → the quality alert rules with no wait fire.
import { alertRulesHandler } from '../../../modules/quality/rules/firing'
// B-W2b-125
import { incidentHandlers } from '../../../modules/safety/incidents/handlers'
import { healthHandlers } from '../../../modules/safety/health/jobs'
// B-W2b-160: a picture's stripped copy after file.available.
import { stripPicturesHandler } from '../../../platform/files/thumbs/handler'
// B-W2b-167: partner notifications (no reader while every seeded portal is off: nothing is made).
import { partnerNotificationsHandler } from '../../../platform/portal/notifications/fan-out'
import { onlinePaymentHandlers } from '../../../modules/payments/online/follow-up'
// B-W2b-170
import { trackingLinkHandler } from '../../../modules/shipping/tracking-link/handler'
// B-W2b-200
import { sharesNotifyHandler } from '../../../platform/shares/notify'
// B-W2b-225: a routing step's checkpoint opens its check.
import { routingCheckpointHandlers } from '../../../modules/product/routing-depth/checkpoints'
// B-W2b-251: an evidence pack asked for is built.
import { buildPackHandlers } from '../../../modules/compliance/techfiles/build'
// B-W2b-260: a distributor's reply or bounce moves its notice.
import { distributorHandlers } from '../../../modules/compliance/recall/distributors'
// B-W2b-256: a portal upload answers its declaration request; material profiles evaluated again.
import { declarationHandlers } from '../../../modules/compliance/declarations-asked/jobs'
import { reevaluateHandlers } from '../../../modules/compliance/material-profiles/reevaluate'
import { gateHandlers } from '../../../modules/planning/milestones/follow'
import { LOCAL_COOKIE_SECRET } from '../../../env'
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
  ['W2B_37_HANDLERS', ['attendanceHandlers']],
  ['W2B_42_HANDLERS', ['overtimeHandlers']],
  ['W2B_43_HANDLERS', ['earningsHandlers']],
  ['W2B_101_HANDLERS', ['inspectionTriggerHandlers']],
  ['W2B_118_HANDLERS', ['alertRulesHandler']],
  ['W2B_125_HANDLERS', ['incidentHandlers']],
  ['W2B_135_HANDLERS', ['healthHandlers']],
  ['W2B_160_HANDLERS', ['stripPicturesHandler']],
  ['W2B_167_HANDLERS', ['partnerNotificationsHandler']],
  ['W2B_185_HANDLERS', ['onlinePaymentHandlers']],
  // B-W2b-170: the tracking page's link mailed when the goods leave.
  ['W2B_170_HANDLERS', ['trackingLinkHandler']],
  // B-W2b-200: the "E-mail me" mails of a shared record's new messages.
  ['W2B_200_HANDLERS', ['sharesNotifyHandler']],
  // B-W2b-225: the routing checkpoints.
  ['W2B_225_HANDLERS', ['routingCheckpointHandlers']],
  // B-W2b-251: the evidence pack's build.
  ['W2B_251_HANDLERS', ['buildPackHandlers']],
  // B-W2b-260: the distributor notices' reply and bounce.
  ['W2B_260_HANDLERS', ['distributorHandlers']],
  // B-W2b-256: declarations and the material profiles' re-evaluation.
  ['W2B_256_HANDLERS', ['declarationHandlers', 'reevaluateHandlers']],
  // B-W2b-263: pre-production gates passed by a sample round's approval or the order's leather released.
  ['W2B_263_HANDLERS', ['gateHandlers']],
]

/** The search indexers the worker loads from the registry folder (background.ts SEARCH_INDEXERS). */
export async function searchIndexers(): Promise<readonly SearchIndexer[]> {
  return loadIndexers(SRC)
}

/** Every handler the worker runs: W1's HANDLERS, then the W2a lists, as background.ts hands them to startEventWorkers. */
export function everyHandler(indexers: readonly SearchIndexer[]): readonly EventHandler[] {
  return [...workerHandlers(), notificationsHandler(), ...searchHandlers(indexers), alertsRecheckHandler(), ...ladderHandlers(), ...creditNoteHandlers(), ...payablesHandlers(), releaseOnWorkOrderDoneHandler(), pauseAtClockOutHandler(), ...attendanceHandlers(), ...overtimeHandlers(), ...earningsHandlers(), ...inspectionTriggerHandlers(), alertRulesHandler(), ...incidentHandlers(), ...healthHandlers(), stripPicturesHandler(), partnerNotificationsHandler({ cookieSecret: () => LOCAL_COOKIE_SECRET }), ...onlinePaymentHandlers(), trackingLinkHandler(), sharesNotifyHandler(), ...routingCheckpointHandlers(), ...buildPackHandlers(), ...distributorHandlers(), ...declarationHandlers(), ...reevaluateHandlers(), ...gateHandlers()]
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
