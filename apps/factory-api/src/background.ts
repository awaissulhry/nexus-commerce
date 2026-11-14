import { fileURLToPath } from 'node:url'
import { openFactoryDatabase, type FactoryDatabase } from '@nexus/factory-db'
import { checkTestDatabaseUrl, readWorktree, worktreeDatabaseNames } from '@nexus/factory-db/test-database'
import { startCrons, type CronJob } from './core/cron'
import { redact } from './core/logger'
import { openQueues, queueConnection, type Log } from './core/queue'
import { loadFactoryEnv } from './env'
import { certificateExpiryCron } from './modules/compliance/certificates/expiry'
// B-W2a-21: the work-order cost ledger after each stock move, scan and rework of a work order.
import { costingHandlers } from './modules/costing/actual/handlers'
import { startOnIssueHandler } from './modules/inventory/issue/start'
import { floorMoveValuationHandler } from './modules/inventory/ledger/valuation'
import { invoiceFilesHandler } from './modules/invoicing/invoice-files'
import { tellBuyerHandler } from './modules/purchasing/confirm/handler'
// B-W2b-305: purchase_order.approved → the order sent with its yes, as the person who asked.
import { approvedSendHandler } from './modules/purchasing/po-approvals/approved-send'
import { afterAcceptanceHandler } from './modules/sales/quotes/after-acceptance'
import { orderHandlers } from './modules/sales/orders/handlers'
import { nightlyPlanCron } from './modules/planning/nightly'
import { sdiArchiveHandler } from './modules/invoicing/sdi/archive'
import { sdiCourtesyCopyHandler } from './modules/invoicing/sdi/copy'
import { sdiPollCron, sdiPollHandler } from './modules/invoicing/sdi/poll'
import { shipDocumentsHandler } from './modules/shipping/documents/handler'
import { trackingPollCron, trackingPollHandler } from './modules/shipping/labels/poll'
import { emailInHandlers } from './platform/email-in/handlers'
import { emailSendHandler } from './platform/email-out/outbound'
import { digestCron } from './platform/email-out/digest/digest'
import { notificationsHandler } from './platform/notifications/fan-out'
// B-W2b-385: the followed saved views, counted as their people every quarter of an hour (their last ids in Redis).
import { redisIdMemory, viewFollowCron } from './platform/notifications/view-follow/evaluate'
import { exportExpiryCron } from './platform/exports/expire'
import { exportHandlers } from './platform/exports/worker'
import { assertNoFakeAccountsInProduction } from './platform/gateway/boot'
import { importHandlers } from './platform/imports/worker'
import { inboundHandler } from './platform/inbound/process'
import { startEventWorkers, type EventHandler } from './platform/outbox/dispatch'
import { outboxLagCron } from './platform/outbox/lag'
import { queuePublisher, startRelay } from './platform/outbox/relay'
import { printDispatchHandler } from './platform/print/handler'
import { rolesSyncCron, syncAllTenants } from './platform/auth/roles/sync'
// B-W2a-18: a new tenant's empty reason lists get the standard reasons.
import { standardReasonsCron, standardReasonsForNewTenants } from './platform/reasons/standard'
// B-W2a-32: the search index, one indexer per record type in platform/search/indexers/ (found by folder).
import { indexNewTenants, searchHandlers } from './platform/search/indexing'
import { loadIndexers } from './platform/search/registry'
// B-W2a-33: the exception rules (evaluated every 5 minutes, and again for one record after its events) and the date timers.
import { alertsEvaluateCron, alertsRecheckHandler } from './platform/alerts/engine'
import { timersFireCron } from './platform/timers/fire'
// B-W2a-38: the daily production report e-mailed to the people subscribed.
import { dailyReportCron } from './modules/production/reports/mail'
// B-W2a-42: uploads held for their virus scan are scanned again; this process's error reports say worker or scheduler.
import { scanSweepCron } from './platform/files/scan/sweep'
import { setReportSource } from './observability/tracker'
// B-W2a-52: the daily purchase order confirmation reminders (sends nothing while a company's switch is off: the default).
import { confirmationRemindersCron } from './modules/purchasing/reminders/daily'
// B-W2b-377: a receipt released by its last yes posted for its receiver; the daily chase reminders (behind the Owner's switch).
import { releasedReceiptHandler } from './modules/inventory/receiving/tolerance-hold'
// B-W2b-386: the system's shipment holds (the balance before shipping, the account on hold, over the credit limit).
import { systemHoldsCron, systemHoldsHandler } from './modules/shipping/holds/system'
// B-W2b-393: the suggested matches of the bank lines, looked at again when payments, invoices or deposit requests change.
import { suggestionHandlers } from './modules/payments/matching/suggest'
import { chaseRemindersCron } from './modules/purchasing/reminders/chase'
// B-W2a-55: the payment reminder ladder (prepares reminders on its timers; a person approves and sends each one).
import { ladderCron, ladderHandlers } from './modules/receivables/ladder'
// B-W2a-61: a customer return's decided credit drafts its credit notes (a person issues them).
import { creditNoteHandlers } from './modules/invoicing/credit-note/handlers'
import { payablesHandlers, sdiPickupCron } from './modules/payables/sdi'
// B-W2a-66: the certificate renewal stages.
import { renewalStagesCron } from './modules/compliance/renewals/stages'
// B-W2b-15
import { releaseOnWorkOrderDoneHandler, reservationCleanupCron } from './modules/inventory/reservations/system-release'
// B-W2b-26: the leaver steps the system settles on its own (badge off after the last day, the case closed when done).
import { leaverStepsCron } from './modules/people/leavers/automatic'
// B-W2b-33: the automatic clock-out at the shift end (MES-227).
import { autoClockOutCron } from './modules/people/clock/auto'
// B-W2b-37: attendance days (the handler computes a person's day after a clock event; the cron as time passes).
import { attendanceDaysCron, attendanceHandlers } from './modules/people/attendance/jobs'
// B-W2b-42: overtime computed from an attendance day (the handler after attendance.day_changed).
import { overtimeHandlers } from './modules/people/overtime/jobs'
// B-W2b-43: earnings (a scan pays or is held; a late clock event releases a held scan).
import { earningsHandlers } from './modules/people/earnings/jobs'
// B-W2b-24: the W2b data catch-ups (two-factor since, lifted blocks, first-load steps from their W2a audit rows).
import { fillTwoFactorSinceAll, twoFactorSinceCron } from './platform/auth/roles/two-factor-since'
import { liftCatchUpCron, moveLiftsAll } from './platform/email-out/delivery/lift-catch-up'
import { firstLoadCatchUpCron, writeStepsAll } from './platform/imports/guided/catch-up'
// B-W2b-22: the cost ledger's nightly catch-up (what waited for a value or a rate).
import { costCatchUpCron } from './modules/costing/actual/catch-up'
// B-W2b-11: the report pack, so the worker can export a report (platform/exports/sources/reports.ts).
import { loadReports } from './modules/insights/reports/registry'
// B-W2b-120: the safety calendar's sources, so the worker can export the calendar (platform/exports/sources/safety-calendar.ts).
import { loadSources as loadCalendarSources } from './modules/safety/calendar/registry'
// B-W2b-41: stuck bundles told once per wait; the scan-pattern checks (only at sites whose checks are ON).
import { scanFindingsCron, stuckBundlesCron } from './modules/production/bundles/jobs'
// B-W2b-40: a clock-out pauses the person's running work (MES-117).
import { pauseAtClockOutHandler } from './modules/production/terminal/clock-out'
// B-W2b-101: inspections opened by rule at goods receipt, a finished operation and a bundle scan (QHS-010, QHS-011).
import { inspectionTriggerHandlers } from './modules/quality/triggers/handler'
// B-W2b-225: a routing step's quality checkpoint opens its check at a bundle's first report (PRD-119).
import { routingCheckpointHandlers } from './modules/product/routing-depth/checkpoints'
// B-W2b-96: machine requests nobody acknowledged escalate by their routing rule.
import { escalationCron } from './modules/plant/requests/escalation'
// B-W2b-108: CAPA actions reminded before their due day and escalated when overdue (tasks).
import { capaRemindersCron } from './modules/quality/capa/reminders'
// B-W2b-124: the reminders of statutory machine checks whose window opened.
import { checkRemindersCron } from './modules/plant/statutory/reminders'
// B-W2b-118: quality alert rules fire at once on a hold, a critical NCR, a safety complaint, and by the cron after a wait or before a date.
import { alertRulesCron, alertRulesHandler } from './modules/quality/rules/firing'
// B-W2b-125: a machine locked as unsafe opens a hazard report in Plant › Incidents when the site asks for one.
import { incidentHandlers } from './modules/safety/incidents/handlers'
import { healthDueListCron, healthHandlers } from './modules/safety/health/jobs'
// B-W2b-159: the dead portal sign-in codes are purged (a day after they expired).
import { portalCodePurgeCron } from './platform/auth/portal/purge'
// B-W2b-163: the drafts of link forms are purged 7 days after their link expired.
import { linkDraftPurgeCron } from './platform/links/drafts'
// B-W2b-160: a picture's stripped copy after its scan (file.available); uploads in parts given up after seven days.
import { stripPicturesHandler } from './platform/files/thumbs/handler'
import { largeUploadExpiryCron } from './platform/files/multipart/expiry'
// B-W2b-162: partner people whose access ends within 7 days are told once (PLT-022).
import { accessEndingCron } from './platform/auth/partners/access-ending'
// B-W2b-167: partner notifications (fan-out + instant mails), the partner summaries, the partner task reminders.
import { partnerNotificationsHandler } from './platform/portal/notifications/fan-out'
// B-W2b-185: paying online (the PAY_INVOICE requests; after a payment ended: TD02, receipt, cancel at the provider).
import { onlinePaymentHandlers } from './modules/payments/online/follow-up'
// B-W2b-170: the tracking page's link mailed when the goods leave.
import { trackingLinkHandler } from './modules/shipping/tracking-link/handler'
// B-W2b-171: the body photos sent with measurements by link (their deletion day once the garment ships; deleted when it passes).
import { measurementPhotosCron } from './modules/sales/measure-link/retention'
// B-W2b-200: "E-mail me" of a partner invited to a record (thread.message_posted → the invited people's mails).
import { sharesNotifyHandler } from './platform/shares/notify'
import { partnerDigestCron } from './platform/portal/notifications/digest'
import { partnerTaskRemindersCron } from './platform/portal/tasks/reminders'
// B-W2b-177: document expiry reminders (30 and 7 days before; the partner asked for a new version).
import { expiryRemindersCron } from './platform/files/expiry/remind'
// B-W2b-184: approval requests to partners expire past their due time (and an answer's settle is caught up); office approvals by e-mail.
import { approvalsSweepCron } from './platform/approvals-out/sweep'
import { officeApprovalsMailCron } from './modules/insights/sources/approvals-mail'
// B-W2b-215: an approved SMV version takes effect on its day (hourly).
import { smvTakeEffectCron } from './modules/product/minutes/take-effect'
// B-W2b-251: technical_file.pack_requested → the evidence pack built (its PDF, ZIP and fingerprint) or failed in words.
import { buildPackHandlers } from './modules/compliance/techfiles/build'
// B-W2b-260: a distributor's reply on its notice's thread is the notice's answer; a bounced or failed mail fails the notice.
import { distributorHandlers } from './modules/compliance/recall/distributors'
// B-W2b-256: supplier declarations (a portal upload answers its request; overdue and reminders hourly) and material profiles evaluated again.
import { declarationHandlers, declarationsCron } from './modules/compliance/declarations-asked/jobs'
import { profilesNightlyCron, reevaluateHandlers } from './modules/compliance/material-profiles/reevaluate'
// B-W2b-263: pre-production gates passed by their events (a sample round approved, the order's leather released).
import { gateHandlers } from './modules/planning/milestones/follow'
// B-W2b-313: the lot lifecycle moved by its stock moves and quality decisions.
import { lotLifecycleHandler } from './modules/inventory/lots-depth/lifecycle'
// B-W2b-304: a payment checks the customer's orders held for credit again.
import { creditHandlers } from './modules/sales/credit/handlers'
// B-W2b-317 (PLN-200): a supplier's date that moves is checked against what it feeds at once (Supply too late).
import { supplyLateHandler } from './modules/planning/exceptions/supply-late'
// B-W2b-264: the claims' evidence check (daily 00:25 Europe/Rome; claim.evidence_expired once per claim and cause).
import { claimEvidenceExpiryCron } from './modules/compliance/claims/expiry'
// B-W2b-292: the warehouse task sources (a receipt, a released lot or hold, a hold that asks quarantine, a pick list; due counts).
import { warehouseTaskCron, warehouseTaskHandlers } from './modules/inventory/tasks/handlers'
// B-W2b-294: a sent quote's validity (EXPIRED after its last day, the customer reminded before it); the schedule of an order
// confirmed by its yes.
import { quoteValidityCron } from './modules/sales/quote-terms/validity'
import { orderScheduleHandler } from './modules/sales/quote-terms/carry'
// B-W2b-360: the rider's reminder of a fitting, a showroom visit or a measuring session (hourly, the day before; FAKE mail locally).
import { fittingRemindersCron } from './modules/sales/fittings/reminders'
// B-W2b-340: an order that waited for a yes takes its quote lines' options once it is CONFIRMED.
import { orderOptionsHandler } from './modules/sales/configurator/copy'
// B-W2b-389: the daily ECB reference rates (16:30 and 18:30 Europe/Rome, Monday to Friday; only where switched on; FAKE locally).
import { ecbDailyCron } from './platform/currency/feed'
// B-W2b-394: mail in depth (the capture address's match and the team inboxes' routing, inquiries from an inquiry address, a
// bounce's task; the team inboxes' follow-ups that came).
import { mailRouteHandler } from './platform/email-in/team-inbox/route'
import { followUpsCron } from './platform/email-in/team-inbox/follow-ups'
import { inquiryFromAddressHandler } from './modules/sales/inquiries/from-mail'
import { bounceTaskHandler } from './platform/email-out/delivery-status/tasks'

/**
 * The factory's background processes (plan A1 §3.1), one codebase with the API, two Railway services:
 *
 *   node dist/background.js worker      the outbox relay (relay.ts), the events dispatcher and the handler runner
 *                                       (dispatch.ts), after syncing every active tenant's system roles with their
 *                                       templates (platform/auth/roles/sync.ts); npm run dev:worker -w @nexus/factory-api
 *   node dist/background.js scheduler   the clustered crons (core/cron.ts): each tick runs on one replica only;
 *                                       npm run dev:scheduler -w @nexus/factory-api
 *
 * Commerce hard rule 2, for the factory: a local worker or scheduler starts every consumer and every cron, so before
 * anything connects it refuses
 *   - a wrong environment (env.ts: local and test only on loopback, staging and production only on Railway);
 *   - with FACTORY_ENV local or test, a database that is not this worktree's own (factory_<branch>, factory_<step>) or a
 *     throwaway factory_test…: never a shared one;
 *   - with FACTORY_ENV local or test, a missing FACTORY_QUEUE_PREFIX (env.ts): the local Redis is shared by every
 *     worktree.
 * Then the database login is audited (openFactoryDatabase) and, with FACTORY_ENV=production, no integration account may be
 * in FAKE mode, as at the API's boot.
 */

const MODES = ['worker', 'scheduler'] as const
type Mode = (typeof MODES)[number]

/** The handlers of published events, one list for the worker. Modules add theirs here (dispatch.ts defineHandler). */
const HANDLERS: readonly EventHandler[] = [inboundHandler(), ...importHandlers(), printDispatchHandler(), emailSendHandler(), ...emailInHandlers(), floorMoveValuationHandler(), startOnIssueHandler(), invoiceFilesHandler(), sdiPollHandler(), sdiArchiveHandler(), sdiCourtesyCopyHandler(), trackingPollHandler(), afterAcceptanceHandler(), shipDocumentsHandler(), ...orderHandlers(), tellBuyerHandler(), ...costingHandlers(), ...exportHandlers()]
// B-W2a-20: the notification centre's fan-out (mentions, followed records, assignments, approvals).
const W2A_20_HANDLERS: readonly EventHandler[] = [notificationsHandler()]
// B-W2a-32: the search index follows the record events its indexers name (platform/search/indexing.ts).
const SEARCH_INDEXERS = await loadIndexers(fileURLToPath(new URL('.', import.meta.url)))
const W2A_32_HANDLERS: readonly EventHandler[] = searchHandlers(SEARCH_INDEXERS)
// B-W2a-33: one record's exception rules again right after an event that changes it.
const W2A_33_HANDLERS: readonly EventHandler[] = [alertsRecheckHandler()]
// B-W2a-55: a ladder timer fired (prepare the customer's due reminders); a customer's money changed (re-plan its timers).
const W2A_55_HANDLERS: readonly EventHandler[] = ladderHandlers()
// B-W2a-61: return.credit_due → the return's credit note drafts.
const W2A_61_HANDLERS: readonly EventHandler[] = creditNoteHandlers()
// B-W2a-62: a company's SDI pickup came due (the supplier invoices SDI delivered); goods arrived for an invoice (match again).
const W2A_62_HANDLERS: readonly EventHandler[] = payablesHandlers()
// B-W2b-15: a work order completed, closed or cancelled → the rest of its reservations released by the system.
const W2B_15_HANDLERS: readonly EventHandler[] = [releaseOnWorkOrderDoneHandler()]
// B-W2b-40: clock.out → the person's running operations paused (MES-117).
const W2B_40_HANDLERS: readonly EventHandler[] = [pauseAtClockOutHandler()]
// B-W2b-37: attendance.clock_event → that person's attendance day computed again.
const W2B_37_HANDLERS: readonly EventHandler[] = attendanceHandlers()
// B-W2b-42: attendance.day_changed → that day's overtime entries in step.
const W2B_42_HANDLERS: readonly EventHandler[] = overtimeHandlers()
// B-W2b-43: production.scan_recorded → the earnings ledger; attendance.day_changed → held scans looked at again.
const W2B_43_HANDLERS: readonly EventHandler[] = earningsHandlers()
// B-W2b-101: a receipt posted, a workshop's goods back, a scan → the company's inspection rules open what they pick.
const W2B_101_HANDLERS: readonly EventHandler[] = inspectionTriggerHandlers()
// B-W2b-118: a hold placed, a critical NCR raised, a safety complaint → the quality alert rules with no wait fire.
const W2B_118_HANDLERS: readonly EventHandler[] = [alertRulesHandler()]
// B-W2b-125: maintenance_request.locked (hazardReport) → a hazard report in Plant › Incidents.
const W2B_125_HANDLERS: readonly EventHandler[] = incidentHandlers()
// B-W2b-135: employee.role_changed → a change-of-task (or before-task) visit; leaver.started/ended → the end-of-employment visit.
const W2B_135_HANDLERS: readonly EventHandler[] = healthHandlers()
const W2B_160_HANDLERS: readonly EventHandler[] = [stripPicturesHandler()]
// B-W2b-167: an event that concerns a partner → its people's notifications (and the mails they get as it happens).
const W2B_167_HANDLERS: readonly EventHandler[] = [partnerNotificationsHandler({ cookieSecret: () => env.FACTORY_COOKIE_SECRET })]
// B-W2b-185: paying online.
const W2B_185_HANDLERS: readonly EventHandler[] = onlinePaymentHandlers()
// B-W2b-170: shipment.status_changed → SHIPPED mails the customer's orders contacts the branded tracking page.
const W2B_170_HANDLERS: readonly EventHandler[] = [trackingLinkHandler()]
// B-W2b-200: a shared message on a record a partner is invited to → that person's mail when they asked for it.
const W2B_200_HANDLERS: readonly EventHandler[] = [sharesNotifyHandler()]
// B-W2b-225: production.scan_recorded REPORT → the step's checkpoint opens its in-process check.
const W2B_225_HANDLERS: readonly EventHandler[] = routingCheckpointHandlers()
// B-W2b-251: an evidence pack asked for → its build job.
const W2B_251_HANDLERS: readonly EventHandler[] = buildPackHandlers()
// B-W2b-260: distributor notices: replies recorded as answers, bounces as failures.
const W2B_260_HANDLERS: readonly EventHandler[] = distributorHandlers()
// B-W2b-256: a supplier's portal upload answers its declaration request; profiles evaluated again on a rule, a substance, a list version, a lab result, a file.
const W2B_256_HANDLERS: readonly EventHandler[] = [...declarationHandlers(), ...reevaluateHandlers()]
// B-W2b-263: sample_round.decided (approved) → the sample gates naming the round pass; lot.released (leather) → the order's leather gate when all its leather is released.
const W2B_263_HANDLERS: readonly EventHandler[] = gateHandlers()
// B-W2b-313: a lot's lifecycle follows its ledger (IN_USE at the first issue, DEPLETED when the last unit leaves, RETURNED).
const W2B_313_HANDLERS: readonly EventHandler[] = [lotLifecycleHandler()]
// B-W2b-292: a receipt posted or reversed, a lot or hold released, a hold asking quarantine, a pick list made or picked → the warehouse tasks they ask.
const W2B_292_HANDLERS: readonly EventHandler[] = warehouseTaskHandlers()
// B-W2b-305: purchase_order.approved → the purchase order sent with its yes (held in words when it cannot go).
const W2B_305_HANDLERS: readonly EventHandler[] = [approvedSendHandler()]
// B-W2b-304
const W2B_304_HANDLERS: readonly EventHandler[] = creditHandlers()
// B-W2b-317
const W2B_317_HANDLERS: readonly EventHandler[] = [supplyLateHandler()]
// B-W2b-294: an order that waited for a yes takes its quote's delivery schedule once it is CONFIRMED.
const W2B_294_HANDLERS: readonly EventHandler[] = [orderScheduleHandler()]
// B-W2b-340
const W2B_340_HANDLERS: readonly EventHandler[] = [orderOptionsHandler()]
// B-W2b-377: a receipt whose lines beyond their tolerance all got their yes, posted for the person who recorded it.
const W2B_377_HANDLERS: readonly EventHandler[] = [releasedReceiptHandler()]
// B-W2b-386: a shipment made, an order's payment schedule changed, an account hold placed or released, a credit check or limit → the system's shipment holds placed or lifted.
const W2B_386_HANDLERS: readonly EventHandler[] = [systemHoldsHandler()]
// B-W2b-393: a payment recorded, placed, taken back or voided, an invoice issued, a deposit request made or waived → the company's bank line suggestions.
const W2B_393_HANDLERS: readonly EventHandler[] = suggestionHandlers()
// B-W2b-394: a sorted mail → the capture address's match and its team inbox; a mail to an inquiry address → its inquiry; a bounce → the sender's task.
const W2B_394_HANDLERS: readonly EventHandler[] = [mailRouteHandler(), inquiryFromAddressHandler(), bounceTaskHandler()]
// B-W2b-11: the reports (one file each in modules/insights/reports/defs/), read by an export of a report.
await loadReports(fileURLToPath(new URL('.', import.meta.url)))
// B-W2b-120: the safety calendar's sources (one file each in modules/safety/calendar/sources/), read by an export of the calendar.
await loadCalendarSources(fileURLToPath(new URL('.', import.meta.url)))

const mode = process.argv[2] as Mode
if (!MODES.includes(mode)) {
  console.error(`usage: background.js <${MODES.join('|')}> (got ${JSON.stringify(process.argv[2] ?? '')})`)
  process.exit(2)
}
setReportSource(mode)

/** JSON lines on standard output, every field redacted like the API's log (core/logger.ts). */
function lineLog(name: Mode): Log {
  const write =
    (level: 'info' | 'warn' | 'error') =>
    (fields: Record<string, unknown>, message: string): void => {
      const line = { level, time: new Date().toISOString(), process: name, msg: message, ...(redact(fields) as Record<string, unknown>) }
      process.stdout.write(`${JSON.stringify(line)}\n`)
    }
  return { info: write('info'), warn: write('warn'), error: write('error') }
}
const log = lineLog(mode)

function refuse(reason: string): never {
  console.error(`factory-${mode}: refused to start: ${reason}`)
  process.exit(1)
}

let env: ReturnType<typeof loadFactoryEnv>
try {
  env = loadFactoryEnv()
} catch (error) {
  refuse((error as Error).message)
}
const prefix = env.FACTORY_QUEUE_PREFIX
if (env.FACTORY_ENV === 'local' || env.FACTORY_ENV === 'test') {
  const own = checkTestDatabaseUrl(env.FACTORY_DATABASE_URL, worktreeDatabaseNames(readWorktree(fileURLToPath(new URL('.', import.meta.url)))))
  if (!own.ok) refuse(`${own.reason}; a local ${mode} runs only against this worktree's own database`)
}

let database: FactoryDatabase
try {
  database = await openFactoryDatabase({ connectionString: env.FACTORY_DATABASE_URL, pool: { max: 8 }, clientCapacity: env.FACTORY_DATABASE_CLIENTS })
} catch (error) {
  refuse(`the database refused the boot: ${(error as Error).message}`)
}
// Plan A1 §4: production never starts while an integration account is FAKE (platform/gateway/boot.ts).
try {
  await assertNoFakeAccountsInProduction(database, env.FACTORY_ENV)
} catch (error) {
  refuse((error as Error).message)
}
const redis = queueConnection(env.FACTORY_REDIS_URL)
redis.on('error', (error) => log.warn({ err: error }, 'redis is unreachable'))
const kit = openQueues({ connection: redis, prefix })

const stops: Array<() => Promise<void>> = []
if (mode === 'worker') {
  // A deploy that changed a role template starts a new worker: the system roles follow it (audited per tenant).
  await syncAllTenants({ database, log }).catch((error) => log.error({ err: error }, 'the system roles could not be synced at start'))
  await standardReasonsForNewTenants({ database, log }).catch((error) => log.error({ err: error }, 'the standard reasons could not be given at start'))
  await indexNewTenants({ database, indexers: SEARCH_INDEXERS, log }).catch((error) => log.error({ err: error }, 'the search index could not be built at start'))
  // B-W2b-24: rows W2a kept in the audit log move to their W2b columns and table at the first start after the deploy.
  await fillTwoFactorSinceAll({ database, log }).catch((error) => log.error({ err: error }, 'the two-factor times could not be filled at start'))
  await moveLiftsAll({ database, log }).catch((error) => log.error({ err: error }, 'the unblocked addresses could not be moved at start'))
  await writeStepsAll({ database, log }).catch((error) => log.error({ err: error }, 'the first-load steps could not be written at start'))
  const relay = startRelay({ database, publish: queuePublisher(kit), log })
  const workers = startEventWorkers({ kit, handlers: [...HANDLERS, ...W2A_20_HANDLERS, ...W2A_32_HANDLERS, ...W2A_33_HANDLERS, ...W2A_55_HANDLERS, ...W2A_61_HANDLERS, ...W2A_62_HANDLERS, ...W2B_15_HANDLERS, ...W2B_40_HANDLERS, ...W2B_37_HANDLERS, ...W2B_42_HANDLERS, ...W2B_43_HANDLERS, ...W2B_101_HANDLERS, ...W2B_118_HANDLERS, ...W2B_125_HANDLERS, ...W2B_135_HANDLERS, ...W2B_160_HANDLERS, ...W2B_167_HANDLERS, ...W2B_185_HANDLERS, ...W2B_170_HANDLERS, ...W2B_200_HANDLERS, ...W2B_225_HANDLERS, ...W2B_251_HANDLERS, ...W2B_260_HANDLERS, ...W2B_256_HANDLERS, ...W2B_263_HANDLERS, ...W2B_313_HANDLERS, ...W2B_292_HANDLERS, ...W2B_305_HANDLERS, ...W2B_304_HANDLERS, ...W2B_317_HANDLERS, ...W2B_294_HANDLERS, ...W2B_340_HANDLERS, ...W2B_377_HANDLERS, ...W2B_386_HANDLERS, ...W2B_393_HANDLERS, ...W2B_394_HANDLERS], database, live: redis, log })
  stops.push(() => relay.stop(), () => workers.close())
} else {
  const crons: CronJob[] = [outboxLagCron({ database, kit, log }), rolesSyncCron({ database, log }), certificateExpiryCron({ database, log }), sdiPollCron({ database, log }), trackingPollCron({ database, log }), nightlyPlanCron({ database, log }), exportExpiryCron({ database, log })]
  crons.push(standardReasonsCron({ database, log }))
  // B-W2a-20: the daily digests people turned on.
  crons.push(digestCron({ database, log }))
  // B-W2a-33: the exception rules' evaluation and the date timers' firing.
  crons.push(alertsEvaluateCron({ database, log }), timersFireCron({ database, log }))
  // B-W2a-38: the daily production report, to the people subscribed (quiet default: none).
  crons.push(dailyReportCron({ database, log }))
  // B-W2a-42: uploads still held for their virus scan (the scanner did not answer at confirm); nothing while scanning is off.
  crons.push(scanSweepCron({ database, log }))
  // B-W2a-52: confirmation reminders to suppliers, only for a company that switched them on (none until a setting exists).
  crons.push(confirmationRemindersCron({ database, log }))
  // B-W2b-377: chase reminders for late lines (mail only for a company whose automatic reminders are on: OFF by default).
  crons.push(chaseRemindersCron({ database, log }))
  // B-W2a-55: the reminder ladder's daily pass (06:00): stale reminders cancelled, the invoices' ladder timers kept in step.
  crons.push(ladderCron({ database, log }))
  // B-W2a-62: every 15 minutes, the supplier invoices SDI delivered (per company whose SDI intermediary is chosen: the FAKE locally).
  crons.push(sdiPickupCron({ database, log }))
  // B-W2a-66: the certificate renewal stages (the 180- and 90-day CERTIFICATE_EXPIRING rules, made once per tenant).
  crons.push(renewalStagesCron({ database, log }))
  // B-W2b-15: the nightly reservation clean-up (SCM-211): reservations whose demand is done, released by the system.
  crons.push(reservationCleanupCron({ database, log }))
  // B-W2b-26: the open leaver cases, hourly: after the last working day the floor sign-in is switched off, due automatic
  // steps tick, a case with nothing open closes (the person LEFT).
  crons.push(leaverStepsCron({ database, log }))
  // B-W2b-33: every five minutes, an open clock-in past its shift end + the company's tolerance is closed (AUTO).
  crons.push(autoClockOutCron({ database, log }))
  // B-W2b-37: attendance days as time passes (missing clock-outs, planned days nobody clocked in).
  crons.push(attendanceDaysCron({ database, log }))
  // B-W2b-24: the W2b data catch-ups again each night (idle passes write nothing).
  crons.push(twoFactorSinceCron({ database, log }), liftCatchUpCron({ database, log }), firstLoadCatchUpCron({ database, log }))
  crons.push(costCatchUpCron({ database, log }))
  // B-W2b-41: every 15 minutes the stuck bundles (MES-168); hourly the scan-pattern checks about bundles (MES-075).
  crons.push(stuckBundlesCron({ database, log }), scanFindingsCron({ database, log }))
  // B-W2b-96: every minute, the routed machine requests nobody acknowledged in time escalate (QHS-179).
  crons.push(escalationCron({ database, log }))
  // B-W2b-108: every 15 minutes, open CAPA actions are reminded (3 days before and on their day) and overdue ones escalate (QHS-096).
  crons.push(capaRemindersCron({ database, log }))
  // B-W2b-124: hourly, the statutory checks whose reminder window opened, once per due date (QHS-205).
  crons.push(checkRemindersCron({ database, log }))
  // B-W2b-118: every 5 minutes, the quality alert rules whose wait was crossed or whose date step was reached fire (QHS-154).
  crons.push(alertRulesCron({ database, log }))
  // B-W2b-135: daily, the periodic health visits from the plans the doctor set and the return visits after > 60 days' absence.
  crons.push(healthDueListCron({ database, log }))
  // B-W2b-159: hourly, the portal sign-in and step-up codes that expired more than a day ago are deleted (PLT-050).
  crons.push(portalCodePurgeCron({ database, log }))
  // B-W2b-163: hourly, the drafts of link forms (measurements, claims, questionnaires) 7 days after their link expired.
  crons.push(linkDraftPurgeCron({ database, log }))
  crons.push(largeUploadExpiryCron({ database, log }))
  // B-W2b-162: daily, the partner people whose end of access is within 7 days are told once per end (PLT-022).
  crons.push(accessEndingCron({ database, log }))
  // B-W2b-167: the partner summaries (every 15 minutes, from 08:00 on working days) and the reminders of partner requests (hourly).
  crons.push(partnerDigestCron({ database, log, cookieSecret: env.FACTORY_COOKIE_SECRET }), partnerTaskRemindersCron({ database, log }))
  // B-W2b-177: document expiry reminders (daily 06:40 Europe/Rome).
  crons.push(expiryRemindersCron({ database, log }))
  // B-W2b-184: approval requests (expiry and settle catch-up, every 10 minutes); Home › Approvals by e-mail (every 5 minutes).
  crons.push(approvalsSweepCron({ database, log }), officeApprovalsMailCron({ database, log, cookieSecret: env.FACTORY_COOKIE_SECRET }))
  // B-W2b-171: hourly, the body photos' deletion day (90 days after the garment ships) and their deletion when it passes.
  crons.push(measurementPhotosCron({ database, log }))
  // B-W2b-215: hourly at minute 7, approved SMV versions whose day came take effect.
  crons.push(smvTakeEffectCron({ database, log }))
  // B-W2b-386: every 30 minutes, the system's shipment holds kept with their causes (credit moves without an event of its own).
  crons.push(systemHoldsCron({ database, log }))
  // B-W2b-256: hourly at minute 35, declaration requests past their due day move overdue and portal requests are reminded by
  // their own cadence; every night at 03:50, every material profile is evaluated again.
  crons.push(declarationsCron({ database, log }), profilesNightlyCron({ database, log }))
  // B-W2b-264: daily at 00:25, every approved claim whose evidence stopped holding is flagged once (claim.evidence_expired).
  crons.push(claimEvidenceExpiryCron({ database, log }))
  // B-W2b-292: hourly at minute 17, the count schedules that fell due get their COUNT task (and stale ones are cancelled).
  crons.push(warehouseTaskCron({ database, log }))
  // B-W2b-294: daily at 06:15, sent quotes past their last day become EXPIRED and those ending soon remind their customer once.
  crons.push(quoteValidityCron({ database, log }))
  // B-W2b-360: hourly at minute 23, a booked appointment starting within a day reminds its rider once (made-to-measure on only).
  crons.push(fittingRemindersCron({ database, log }))
  // B-W2b-385: every 15 minutes, the followed saved views counted as their people; a change tells them (notification.view_changed).
  crons.push(viewFollowCron({ database, log, memory: redisIdMemory(redis, prefix) }))
  // B-W2b-389
  crons.push(ecbDailyCron({ database, log }))
  // B-W2b-394: every 15 minutes, a team-inbox mail whose follow-up came with no answer is open again (email.inbound_worked FOLLOW_UP_DUE).
  crons.push(followUpsCron({ database, log }))
  const scheduler = startCrons(crons, { redis, prefix, log })
  stops.push(() => scheduler.stop())
}
log.info({ prefix, environment: env.FACTORY_ENV }, `factory-${mode} started`)

let closing = false
async function shutdown(signal: string): Promise<void> {
  if (closing) return
  closing = true
  log.info({ signal }, `factory-${mode} shutting down`)
  for (const stop of stops) await stop().catch((error) => log.error({ err: error }, 'a part did not stop cleanly'))
  await kit.close()
  redis.disconnect()
  await database.close()
  process.exit(0)
}
process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))
