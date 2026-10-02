/**
 * R10 (MCP full control, part 06) — a dayparting / rank schedule's patch, moved unchanged out of
 * `PATCH /advertising/schedules/:id` (advertising.routes.ts) so turn-down-automation switches a schedule off through the
 * same code, with the same resume (RC2.T3). The route answers byte for byte as before
 * (automation-schedule-route-parity.vitest.test.ts).
 */
import type { AdSchedule } from '@prisma/client'
import prisma from '../../db.js'
import { done, refused, type ServiceOutcome } from '../automation/service-outcome.js'

export async function patchAdSchedule(id: string, b: Record<string, unknown>): Promise<ServiceOutcome<AdSchedule>> {
  const data: Record<string, unknown> = {}
  for (const k of ['name', 'windows', 'timezone', 'enabled', 'defaultTargetKey', 'targetOverrides']) if (b[k] !== undefined) data[k] = b[k]
  const before = await prisma.adSchedule.findUnique({ where: { id }, select: { campaignId: true, lastApplied: true } })
  if (!before) return refused(404, { error: 'not found' })
  // RC2.T3 reactivation safety: disabling a schedule that currently has the
  // campaign PAUSED must resume it — the cron only resumes ENABLED schedules,
  // so a disable-while-paused would otherwise strand the campaign paused.
  if (data.enabled === false && before.lastApplied === 'PAUSED') {
    try {
      const { updateCampaignWithSync } = await import('./ads-mutation.service.js')
      await updateCampaignWithSync({ campaignId: before.campaignId, patch: { status: 'ENABLED' }, actor: 'automation:dayparting-disable', reason: 'dayparting schedule disabled — resume', applyImmediately: true } as never)
      data.lastApplied = 'ENABLED'
    } catch { /* best-effort resume */ }
  }
  try { return done(await prisma.adSchedule.update({ where: { id }, data })) } catch { return refused(404, { error: 'not found' }) }
}
