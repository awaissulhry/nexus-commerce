import { z } from 'zod'
import { output } from '@nexus/factory-domain/core/contracts'
import type { CommandTools } from '../../../../core/command'
import { scrapWaitsAt } from '../../scrap/over-limit'

/**
 * B-W2b-53 hook of the scans' report (modules/production/scrap/over-limit.ts; MES-128): what scans.ts and contract.ts
 * call, each in a named line of their own. The report counts at once (Owner answer F3); when its scrap is above the
 * site's limit, the answer tells the tablet that the scrap waits for the team leader's approval before it posts (the
 * replacement, the scrap of stock, the cost). Nothing is written: the waiting is derived from the limit in force.
 *
 *   contract   the scan answer's optional `scrapWaits` (null: the scrap needs no approval).
 *   answer     after the scan row, inside the report's command: the site's limit (a count, never money) and the words.
 */

/** The scan answer's field (scans/contract.ts `scan`). */
export const scrapWaitsField = {
  scrapWaits: output({ limit: z.number().int(), words: z.string() }).nullable().optional(),
}

export interface ScrapWaits {
  readonly limit: number
  readonly words: string
}

export async function scrapWaitsInCommand(tools: CommandTools, siteId: string, scrapQuantity: number): Promise<ScrapWaits | null> {
  if (scrapQuantity < 2) return null
  const waits = await scrapWaitsAt(tools.tx, siteId, scrapQuantity)
  return waits.waits && waits.limit !== null && waits.words ? { limit: waits.limit, words: waits.words } : null
}
