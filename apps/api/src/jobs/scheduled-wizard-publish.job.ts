/**
 * SP.3 (list-wizard) — scheduled wizard publish cron.
 *
 * Picks PENDING ScheduledWizardPublish rows where scheduledFor <= now
 * and fires the same orchestration the /listing-wizard/:id/submit
 * route runs. v1 keeps the firing logic narrow (compose → dispatch
 * → update wizard.status → write the schedule row's fireResult);
 * the cross-tab event emit + wizard.submitted telemetry the route
 * does are skipped here. Operators viewing the wizard see the new
 * status next time they refresh the wizard page.
 *
 * Tick cadence: every 60 seconds. PENDING rows with scheduledFor
 * within (now - tick, now] always fire on the next tick within ~60s.
 *
 * Default-OFF: opt in via NEXUS_ENABLE_SCHEDULED_WIZARD_PUBLISH=1.
 * Reasoning: scheduled publishes call real channel adapters; a
 * misconfigured cron firing in dev would publish real listings.
 * Operator's first run should be deliberate.
 *
 * Failure mode: per-schedule errors are caught and recorded on the
 * schedule row (status='FAILED', fireError); the cron loop carries
 * on through other rows.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { SubmissionService } from '../services/listing-wizard/submission.service.js'
import {
  ChannelPublishService,
  type SubmissionEntry,
} from '../services/listing-wizard/channel-publish.service.js'
import { normalizeChannels } from '../services/listing-wizard/channels.js'

const submissionService = new SubmissionService(prisma as any)
const channelPublishService = new ChannelPublishService()

const TICK_INTERVAL_MS = 60 * 1000
const FIRE_RESULT_MAX_BYTES = 4 * 1024

let cronTimer: NodeJS.Timeout | null = null

/**
 * One-shot tick. Exported so a scripts/ runner can call it ad-hoc.
 * Returns a summary string for logging.
 */
export async function runScheduledWizardPublishOnce(): Promise<string> {
  const now = new Date()
  const due = await prisma.scheduledWizardPublish.findMany({
    where: { status: 'PENDING', scheduledFor: { lte: now } },
    orderBy: [{ scheduledFor: 'asc' }],
    take: 25, // cap one tick at 25 rows so a backlog doesn't pin the worker
  })

  if (due.length === 0) {
    return 'no PENDING schedules due'
  }

  let fired = 0
  let failed = 0
  for (const row of due) {
    const result = await fireOneSchedule(row.id)
    if (result === 'fired') fired += 1
    else if (result === 'failed') failed += 1
  }

  return `due=${due.length} fired=${fired} failed=${failed}`
}

/**
 * Fire a single PENDING schedule. Loads the wizard, composes
 * payloads, dispatches via channelPublishService, updates wizard
 * status, writes the schedule row's fireResult / status.
 *
 * Returns 'fired' when the orchestration ran (regardless of whether
 * individual adapters returned LIVE / FAILED / NOT_IMPLEMENTED) and
 * 'failed' when the orchestration itself threw before completion.
 */
async function fireOneSchedule(
  scheduleId: string,
): Promise<'fired' | 'failed'> {
  try {
    const schedule = await prisma.scheduledWizardPublish.findUnique({
      where: { id: scheduleId },
    })
    if (!schedule || schedule.status !== 'PENDING') {
      // Raced with another tick or cancellation; skip silently.
      return 'fired'
    }

    const wizard = await prisma.listingWizard.findUnique({
      where: { id: schedule.wizardId },
      select: {
        id: true,
        productId: true,
        channels: true,
        status: true,
        state: true,
        channelStates: true,
        completedAt: true,
        product: { select: { sku: true } },
      },
    })
    if (!wizard) {
      await markFailed(scheduleId, 'Wizard not found.')
      return 'failed'
    }
    if (wizard.status !== 'DRAFT') {
      await markFailed(
        scheduleId,
        `Wizard already ${wizard.status} — cannot re-fire a non-DRAFT.`,
      )
      return 'failed'
    }

    const channels = normalizeChannels(wizard.channels)
    if (channels.length === 0) {
      await markFailed(scheduleId, 'Wizard has no channels selected.')
      return 'failed'
    }

    const payloads = await submissionService.composeMultiChannelPayloads({
      id: wizard.id,
      productId: wizard.productId,
      channels,
      state: (wizard.state as Record<string, unknown>) ?? {},
      channelStates:
        (wizard.channelStates as Record<string, Record<string, unknown>>) ??
        {},
      product: wizard.product ?? undefined,
    })

    const submissions: SubmissionEntry[] = await Promise.all(
      payloads.map((p) =>
        channelPublishService.publishToChannel({
          channelKey: p.channelKey,
          platform: p.platform,
          marketplace: p.marketplace,
          payload: p.payload as Record<string, unknown> | undefined,
          unsupported: p.unsupported,
          reason: p.reason,
          productId: wizard.productId,
        }),
      ),
    )

    const overall = computeOverallStatus(submissions)
    await prisma.listingWizard.update({
      where: { id: wizard.id },
      data: {
        status: overall,
        completedAt:
          overall === 'LIVE' ? new Date() : wizard.completedAt,
        submissions: submissions as unknown as object,
      },
    })

    // Cap the fireResult JSON to keep the schedule row narrow.
    // Truncated payloads still record the wizard.status outcome so
    // operators see the headline; details live on /poll afterwards.
    const fireResult = {
      wizardStatus: overall,
      submissions,
    }
    const json = JSON.stringify(fireResult)
    const trimmed =
      json.length > FIRE_RESULT_MAX_BYTES
        ? { wizardStatus: overall, truncated: true }
        : fireResult

    await prisma.scheduledWizardPublish.update({
      where: { id: scheduleId },
      data: {
        status: 'FIRED',
        firedAt: new Date(),
        fireResult: trimmed as unknown as object,
      },
    })

    // SP.7 — write an in-app notification so the operator sees the
    // outcome from the bell icon. Best-effort; a failed write here
    // doesn't roll back the schedule row update.
    await emitScheduleNotification({
      userId: schedule.createdBy ?? 'default-user',
      wizardId: wizard.id,
      productId: wizard.productId,
      productSku: wizard.product?.sku ?? null,
      overall,
      submissionCount: submissions.length,
      fireError: null,
    })

    return 'fired'
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message.slice(0, 500)
        : String(err).slice(0, 500)
    await markFailed(scheduleId, message)
    // SP.7 — surface orchestration failure as a danger notification
    // so the operator notices without having to refresh the wizard.
    try {
      const schedule = await prisma.scheduledWizardPublish.findUnique({
        where: { id: scheduleId },
        select: {
          wizardId: true,
          createdBy: true,
          wizard: { select: { productId: true } },
        },
      })
      if (schedule) {
        await emitScheduleNotification({
          userId: schedule.createdBy ?? 'default-user',
          wizardId: schedule.wizardId,
          productId: schedule.wizard?.productId ?? '',
          productSku: null,
          overall: 'FAILED',
          submissionCount: 0,
          fireError: message,
        })
      }
    } catch {
      // Best-effort; don't recurse on errors.
    }
    return 'failed'
  }
}

interface ScheduleNotificationInput {
  userId: string
  wizardId: string
  /** Used to build the click-through href; the wizard page path is
   *  /products/[productId]/list-wizard, the page resolves the active
   *  wizard internally. Empty string skips href (keeps the row
   *  informational rather than linking to a 404). */
  productId: string
  productSku: string | null
  overall: 'DRAFT' | 'SUBMITTED' | 'LIVE' | 'FAILED'
  submissionCount: number
  fireError: string | null
}
async function emitScheduleNotification(
  input: ScheduleNotificationInput,
): Promise<void> {
  try {
    const skuTag = input.productSku ? ` for ${input.productSku}` : ''
    const titleByOutcome: Record<typeof input.overall, string> = {
      LIVE: `Scheduled publish LIVE${skuTag}`,
      SUBMITTED: `Scheduled publish queued${skuTag}`,
      FAILED: `Scheduled publish failed${skuTag}`,
      DRAFT: `Scheduled publish skipped${skuTag}`,
    }
    const severity =
      input.overall === 'LIVE'
        ? 'success'
        : input.overall === 'FAILED'
          ? 'danger'
          : 'warn'
    const body = input.fireError
      ? input.fireError.slice(0, 300)
      : `${input.submissionCount} channel${
          input.submissionCount === 1 ? '' : 's'
        } dispatched.`
    await prisma.notification.create({
      data: {
        userId: input.userId,
        type: 'wizard-schedule-fired',
        severity,
        title: titleByOutcome[input.overall],
        body,
        entityType: 'ListingWizard',
        entityId: input.wizardId,
        href: input.productId
          ? `/products/${input.productId}/list-wizard`
          : null,
        meta: {
          wizardStatus: input.overall,
          submissionCount: input.submissionCount,
        } as unknown as object,
      },
    })
  } catch (err) {
    logger.warn(
      'scheduled-wizard-publish: notification write failed',
      { err: err instanceof Error ? err.message : String(err) },
    )
  }
}

async function markFailed(scheduleId: string, message: string): Promise<void> {
  try {
    await prisma.scheduledWizardPublish.update({
      where: { id: scheduleId },
      data: {
        status: 'FAILED',
        firedAt: new Date(),
        fireError: message,
      },
    })
  } catch {
    // Suppress — best-effort write; cron carries on.
  }
}

function computeOverallStatus(
  submissions: SubmissionEntry[],
): 'DRAFT' | 'SUBMITTED' | 'LIVE' | 'FAILED' {
  if (submissions.length === 0) return 'DRAFT'
  const allLive = submissions.every((s) => s.status === 'LIVE')
  if (allLive) return 'LIVE'
  const anyFailed = submissions.some((s) => s.status === 'FAILED')
  if (anyFailed) return 'FAILED'
  return 'SUBMITTED'
}

/**
 * Start the cron. Idempotent — calling twice is a no-op. Defaults
 * off; opt in via NEXUS_ENABLE_SCHEDULED_WIZARD_PUBLISH=1.
 */
export function startScheduledWizardPublishCron(): void {
  if (cronTimer) return
  if (process.env.NEXUS_ENABLE_SCHEDULED_WIZARD_PUBLISH !== '1') {
    logger.info(
      'scheduled-wizard-publish: disabled (set NEXUS_ENABLE_SCHEDULED_WIZARD_PUBLISH=1 to enable)',
    )
    return
  }
  // First tick fires after one interval — gives the API time to
  // boot before the cron starts touching the DB.
  cronTimer = setInterval(() => {
    void (async () => {
      try {
        const summary = await runScheduledWizardPublishOnce()
        if (summary !== 'no PENDING schedules due') {
          logger.info(
            `scheduled-wizard-publish: tick — ${summary}`,
          )
        }
      } catch (err) {
        logger.warn(
          'scheduled-wizard-publish: tick failed',
          { err: err instanceof Error ? err.message : String(err) },
        )
      }
    })()
  }, TICK_INTERVAL_MS)
  logger.info(
    `scheduled-wizard-publish: cron started (interval ${TICK_INTERVAL_MS}ms)`,
  )
}

export function stopScheduledWizardPublishCron(): void {
  if (cronTimer) {
    clearInterval(cronTimer)
    cronTimer = null
  }
}
