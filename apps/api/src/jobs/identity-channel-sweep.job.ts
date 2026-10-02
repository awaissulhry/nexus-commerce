/**
 * MCP full control I6 — the daily identity sweep: per business, per active channel account, read what the account holds
 * (services/identity/channel-held.service.ts, through the channel gateway) and record it, so the identity audit can
 * say which listing ids an account does not hold (#3), which held items no listing carries (#4) and which seller SKUs
 * differ (#12).
 *
 * OFF by default: it runs only with NEXUS_IDENTITY_SWEEP=1 (the manual trigger too). Scheduled only through
 * lib/cron/clustered.ts, which takes the per-business lease (lib/cron/workspace-lease.ts) when business profiles are on;
 * off-peak by default (NEXUS_IDENTITY_SWEEP_SCHEDULE moves it). A read that stops early never marks an id missing.
 */
import cron from '../lib/cron/clustered.js'
import prisma from '../db.js'
import { visitActiveWorkspaces } from '../lib/workspace-sweep.js'
import { workspaceIdForQuery } from '../lib/workspace-context.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import type { HeldReader } from '../services/identity/channel-held.service.js'

const JOB_NAME = 'identity-channel-sweep'
let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export const identitySweepEnabled = () => process.env.NEXUS_IDENTITY_SWEEP === '1'

/** The adapter per channel: eBay, Amazon, Shopify and Etsy (I7). */
export async function defaultHeldReaders(): Promise<Partial<Record<string, HeldReader>>> {
  const { ebayHeldReader } = await import('../services/identity/channel-held.service.js')
  const { channelHeldReaders } = await import('../services/identity/channel-held-readers.js')
  return { EBAY: ebayHeldReader(), ...channelHeldReaders() }
}

export async function runIdentityChannelSweepOnce(readers?: Partial<Record<string, HeldReader>>): Promise<{ summary: string }> {
  return recordCronRun(JOB_NAME, async () => {
    if (!identitySweepEnabled()) return { summary: 'off: NEXUS_IDENTITY_SWEEP is not 1 — nothing was read' }
    const { sweepAccount } = await import('../services/identity/channel-held.service.js')
    const byChannel = readers ?? await defaultHeldReaders()
    const totals = { accounts: 0, complete: 0, incomplete: 0, seen: 0, ended: 0, failed: 0 }
    await visitActiveWorkspaces(async () => {
      const accounts = await prisma.channelConnection.findMany({
        where: { workspaceId: workspaceIdForQuery(), isActive: true },
        select: { id: true, channelType: true },
        orderBy: { id: 'asc' },
      })
      for (const account of accounts) {
        const reader = byChannel[account.channelType.toUpperCase()]
        if (!reader) continue
        totals.accounts++
        try {
          const report = await sweepAccount(account.id, reader)
          totals.seen += report.seen
          totals.ended += report.ended
          if (report.complete) totals.complete++
          else totals.incomplete++
        } catch (error) {
          totals.failed++
          logger.warn(`${JOB_NAME}: an account could not be swept`, { connectionId: account.id, error: error instanceof Error ? error.message : String(error) })
        }
      }
    })
    return {
      summary: `accounts ${totals.accounts} · complete ${totals.complete} · incomplete ${totals.incomplete} (nothing marked missing) · `
        + `ids seen ${totals.seen} · no longer held ${totals.ended} · failed ${totals.failed}`,
    }
  })
}

export function startIdentityChannelSweepCron(): void {
  if (!identitySweepEnabled()) {
    logger.info(`${JOB_NAME}: cron disabled (NEXUS_IDENTITY_SWEEP is not 1)`)
    return
  }
  const schedule = process.env.NEXUS_IDENTITY_SWEEP_SCHEDULE || '17 3 * * *'
  scheduledTask = cron.schedule(schedule, async () => {
    await runIdentityChannelSweepOnce().catch((error) =>
      logger.error(`${JOB_NAME}: run failed`, { error: error instanceof Error ? error.message : String(error) }))
  })
  logger.info(`${JOB_NAME}: scheduled (${schedule})`)
}

export function stopIdentityChannelSweepCron(): void {
  scheduledTask?.stop()
  scheduledTask = null
}
