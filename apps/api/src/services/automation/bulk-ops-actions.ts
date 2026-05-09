/**
 * W7.1 — Bulk-ops action handlers for the AutomationRule engine.
 *
 * Extends the replenishment-domain handler registry with action types
 * the bulk-operations surface uses. Loaded once at module init via
 * `registerBulkOpsActions()`; handlers mutate ACTION_HANDLERS in
 * place so the existing evaluator dispatch keeps working.
 *
 * Action types added:
 *
 *   apply_bulk_template
 *     Fires a saved BulkActionTemplate with operator-supplied params.
 *     The template's actionPayload gets parameters substituted in,
 *     then handed to BulkActionService.createJob → processJob.
 *     Respects dryRun: in dry mode, computes the substituted payload
 *     and returns it as `output.preview` without writing anything.
 *
 *   create_bulk_job
 *     Inline bulk-job creation when the action carries actionType +
 *     actionPayload + filters directly. Used by rules that don't
 *     route through the template library (e.g. "any time stock < 5
 *     on a HELMET, run an INVENTORY_UPDATE +50 reorder buffer").
 *
 *   pause_schedules_matching
 *     Bulk-pauses ScheduledBulkAction rows whose actionType matches.
 *     Used by safety-net rules: "if more than 50 jobs failed in the
 *     last hour, pause all scheduled bulk-actions until investigated".
 *
 * Triggers — string constants only, since trigger emission lives
 * elsewhere (W7.2 wires BulkActionService events to the engine):
 *
 *   bulk_job_completed     emitted from BulkActionService.processJob
 *                          on terminal status (COMPLETED / FAILED /
 *                          PARTIALLY_COMPLETED / CANCELLED)
 *   bulk_job_failed_burst  emitted by a detector cron when failure
 *                          rate exceeds a threshold
 *   schedule_fired         emitted by the schedule worker on each
 *                          successful schedule fire
 *   bulk_cron_tick         15-min recurring tick (mirrors
 *                          replenishment 'cron_tick'), context
 *                          carries domain='bulk-operations'
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import {
  ACTION_HANDLERS,
  getFieldPath,
  type ActionHandler,
} from '../automation-rule.service.js'
import { BulkActionService } from '../bulk-action.service.js'
import { BulkActionTemplateService } from '../bulk-action-template.service.js'

const bulkActionService = new BulkActionService(prisma)
const templateService = new BulkActionTemplateService(prisma)

export const BULK_OPS_TRIGGERS = [
  'bulk_job_completed',
  'bulk_job_failed_burst',
  'schedule_fired',
  'bulk_cron_tick',
] as const

export type BulkOpsTrigger = (typeof BULK_OPS_TRIGGERS)[number]

export const BULK_OPS_ACTION_TYPES = [
  'apply_bulk_template',
  'create_bulk_job',
  'pause_schedules_matching',
] as const

const apply_bulk_template: ActionHandler = async (action, context, meta) => {
  const templateId =
    (action.templateId as string | undefined) ??
    (getFieldPath(context, 'template.id') as string | undefined)
  if (!templateId) {
    return {
      type: action.type,
      ok: false,
      error: 'apply_bulk_template requires action.templateId',
    }
  }
  const params = (action.params ?? {}) as Record<string, unknown>
  const filterOverride =
    action.filters !== undefined
      ? (action.filters as Record<string, unknown> | null)
      : undefined
  const template = await templateService.getTemplate(templateId)
  if (!template) {
    return {
      type: action.type,
      ok: false,
      error: `Template not found: ${templateId}`,
    }
  }
  let substituted
  try {
    substituted = templateService.applyParameters(
      template,
      params,
      filterOverride,
    )
  } catch (err) {
    return {
      type: action.type,
      ok: false,
      error:
        err instanceof Error ? err.message : `applyParameters failed: ${err}`,
    }
  }
  if (meta.dryRun) {
    return {
      type: action.type,
      ok: true,
      output: {
        dryRun: true,
        templateId,
        templateName: template.name,
        actionType: template.actionType,
        substitutedPayload: substituted.actionPayload,
        filters: substituted.filters,
      },
    }
  }
  try {
    const job = await bulkActionService.createJob({
      jobName: `[automation:${meta.ruleId}] ${template.name}`,
      actionType: template.actionType as never,
      channel: template.channel ?? undefined,
      actionPayload: substituted.actionPayload,
      filters: substituted.filters ?? undefined,
      createdBy: `automation:${meta.ruleId}`,
    } as never)
    void bulkActionService.processJob(job.id).catch((err) => {
      logger.warn(
        `[automation:${meta.ruleId}] processJob ${job.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
    void templateService.recordUsage(templateId)
    return {
      type: action.type,
      ok: true,
      output: {
        jobId: job.id,
        templateId,
        templateName: template.name,
      },
    }
  } catch (err) {
    return {
      type: action.type,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

const create_bulk_job: ActionHandler = async (action, context, meta) => {
  const actionType =
    (action.actionType as string | undefined) ??
    (getFieldPath(context, 'bulk.actionType') as string | undefined)
  if (!actionType) {
    return {
      type: action.type,
      ok: false,
      error: 'create_bulk_job requires action.actionType',
    }
  }
  const actionPayload = (action.actionPayload ?? {}) as Record<string, unknown>
  const filters =
    (action.filters as Record<string, unknown> | null | undefined) ?? null
  const targetProductIds = Array.isArray(action.targetProductIds)
    ? (action.targetProductIds as string[])
    : undefined
  const channel = (action.channel as string | undefined) ?? undefined
  const jobName =
    (action.jobName as string | undefined) ??
    `[automation:${meta.ruleId}] ${actionType}`

  if (meta.dryRun) {
    return {
      type: action.type,
      ok: true,
      output: {
        dryRun: true,
        actionType,
        actionPayload,
        filters,
        channel,
        targetCount: targetProductIds?.length ?? null,
      },
    }
  }
  try {
    const job = await bulkActionService.createJob({
      jobName,
      actionType: actionType as never,
      channel,
      actionPayload,
      filters: filters ?? undefined,
      targetProductIds,
      createdBy: `automation:${meta.ruleId}`,
    } as never)
    void bulkActionService.processJob(job.id).catch((err) => {
      logger.warn(
        `[automation:${meta.ruleId}] processJob ${job.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
    return {
      type: action.type,
      ok: true,
      output: { jobId: job.id, actionType },
    }
  } catch (err) {
    return {
      type: action.type,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

const pause_schedules_matching: ActionHandler = async (action, _context, meta) => {
  const actionType = action.actionType as string | undefined
  // Without a filter the action would pause every schedule — refuse
  // unless the operator explicitly opted in via `confirmAll: true`.
  if (!actionType && action.confirmAll !== true) {
    return {
      type: action.type,
      ok: false,
      error:
        'pause_schedules_matching requires either actionType filter or confirmAll=true',
    }
  }
  const where: { enabled: boolean; actionType?: string } = { enabled: true }
  if (actionType) where.actionType = actionType
  if (meta.dryRun) {
    const count = await prisma.scheduledBulkAction.count({ where })
    return {
      type: action.type,
      ok: true,
      output: { dryRun: true, wouldPause: count, where },
    }
  }
  const result = await prisma.scheduledBulkAction.updateMany({
    where,
    data: { enabled: false, nextRunAt: null },
  })
  return {
    type: action.type,
    ok: true,
    output: { paused: result.count, where },
  }
}

let registered = false

/**
 * Idempotent registration. Called once at API boot from index.ts so
 * the bulk-ops handlers are available to evaluateRule before any
 * trigger fires.
 */
export function registerBulkOpsActions(): void {
  if (registered) return
  registered = true
  ACTION_HANDLERS['apply_bulk_template'] = apply_bulk_template
  ACTION_HANDLERS['create_bulk_job'] = create_bulk_job
  ACTION_HANDLERS['pause_schedules_matching'] = pause_schedules_matching
  logger.info(
    `[automation] registered bulk-ops actions (${BULK_OPS_ACTION_TYPES.length}) and trigger constants (${BULK_OPS_TRIGGERS.length})`,
  )
}
