import { z } from 'zod'
import { output } from '@nexus/factory-domain/core/contracts'
import type { CommandTools } from '../../../../core/command'
import { askApprovalInCommand } from '../../scrap/over-limit'

/**
 * B-W2b-53 hook of the scans' report (modules/production/scrap/over-limit.ts; MES-128): what scans.ts and contract.ts
 * call, each in a named line of their own. The report counts at once (Owner answer F3); when its scrap is above the
 * site's limit, the answer tells the tablet that the scrap waits for the team leader's approval before it posts (the
 * replacement, the scrap of stock, the cost). B-W2b-81: the decision has its ledger, so the waiting is written here.
 *
 *   contract   the scan answer's optional `scrapWaits` (null: the scrap needs no approval).
 *   answer     after the scan row, inside the report's command: the ScrapApproval row WAITING with the limit in force (a
 *              count, never money), and the words.
 */

/** The scan answer's field (scans/contract.ts `scan`). */
export const scrapWaitsField = {
  scrapWaits: output({ limit: z.number().int(), words: z.string() }).nullable().optional(),
}

export interface ScrapWaits {
  readonly limit: number
  readonly words: string
}

export async function scrapWaitsInCommand(tools: CommandTools, scan: { readonly id: string; readonly siteId: string; readonly scrapQuantity: number; readonly createdById: string | null }): Promise<ScrapWaits | null> {
  if (scan.scrapQuantity < 2) return null
  return askApprovalInCommand(tools, scan)
}
