/**
 * Reviews › Insights › Fixes › Size guide — the re-check behind the pure review-size-guide.ts: reads fit by size for the
 * whole business over SIZE_GUIDE_PERIOD (review-fit.service.ts `fitFindingsFor`, the Themes fit table's own reads and
 * rule), reads the size-guide fixes there are, and writes what `planSizeGuideRecheck` says: a new open fix, the open
 * one refreshed, a duplicate or an evidence-less open fix closed, a decided fix marked "evidence gone".
 *
 * It runs when the Fixes list is read (`listFixes`), at most once per SIZE_GUIDE_RECHECK_MS per business on this API
 * process. Nothing here reaches a channel, a buyer or an AI: it writes ReviewActionItem rows only, guarded by their
 * status (a fix a person moved meanwhile is left as it is).
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { workspaceContext } from '../../lib/workspace-context.js'
import { PRIMARY_CONTENT_LOCALE } from '../pim/content-locale.js'
import { fitFindingsFor } from './review-fit.service.js'
import { insightBounds } from './review-insights-math.js'
import {
  SIZE_GUIDE_CREATED_BY, SIZE_GUIDE_PERIOD, SIZE_GUIDE_SOURCE, SIZE_GUIDE_THEME, planSizeGuideRecheck,
} from './review-size-guide.js'

/** How often the Fixes list re-checks fit by size (per business, per API process). */
export const SIZE_GUIDE_RECHECK_MS = 5 * 60_000

export interface SizeGuideRecheck {
  created: number
  refreshed: number
  closed: number
  gone: number
}

const json = (v: unknown) => v as Prisma.InputJsonValue

/** The re-check, now: one open fix per family and direction, closed when its evidence is gone. */
export async function recheckSizeGuideFixes(now = new Date()): Promise<SizeGuideRecheck> {
  const bounds = insightBounds(SIZE_GUIDE_PERIOD, now)
  const [findings, rows] = await Promise.all([
    fitFindingsFor({ scope: { channel: null, market: null }, from: bounds.from, now }),
    prisma.reviewActionItem.findMany({
      where: { type: 'SIZE_GUIDE' },
      select: { id: true, productId: true, status: true, title: true, detail: true, payload: true, createdAt: true },
    }),
  ])
  const out: SizeGuideRecheck = { created: 0, refreshed: 0, closed: 0, gone: 0 }
  for (const step of planSizeGuideRecheck(rows, findings, PRIMARY_CONTENT_LOCALE, now)) {
    if (step.op === 'create') {
      await prisma.reviewActionItem.create({
        data: {
          type: 'SIZE_GUIDE', productId: step.productId, marketplace: null, category: SIZE_GUIDE_THEME, spikeId: null,
          title: step.title, detail: step.detail, payload: json(step.payload), source: SIZE_GUIDE_SOURCE, createdBy: SIZE_GUIDE_CREATED_BY,
        },
      })
      out.created += 1
    } else if (step.op === 'refresh') {
      const done = await prisma.reviewActionItem.updateMany({ where: { id: step.id, status: 'OPEN' }, data: { title: step.title, detail: step.detail, payload: json(step.payload) } })
      out.refreshed += done.count
    } else if (step.op === 'close') {
      const done = await prisma.reviewActionItem.updateMany({ where: { id: step.id, status: 'OPEN' }, data: { status: 'DISMISSED', payload: json(step.payload) } })
      out.closed += done.count
    } else {
      const done = await prisma.reviewActionItem.updateMany({ where: { id: step.id, status: { in: ['APPLIED', 'DISMISSED'] } }, data: { payload: json(step.payload) } })
      out.gone += done.count
    }
  }
  return out
}

const lastRun = new Map<string, number>()

/**
 * The re-check when it is due for this business (null = it ran less than SIZE_GUIDE_RECHECK_MS ago). The slot is taken
 * before it runs, so two reads at once run it once; a failure frees it for the next read.
 */
export async function recheckSizeGuideIfDue(now = new Date()): Promise<SizeGuideRecheck | null> {
  const key = workspaceContext()?.workspaceId ?? 'none'
  const last = lastRun.get(key)
  if (last !== undefined && now.getTime() >= last && now.getTime() - last < SIZE_GUIDE_RECHECK_MS) return null
  lastRun.set(key, now.getTime())
  try {
    return await recheckSizeGuideFixes(now)
  } catch (error) {
    lastRun.delete(key)
    throw error
  }
}
