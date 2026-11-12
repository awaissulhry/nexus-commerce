import { dayWords } from '@nexus/factory-domain/accounting/periods'
import { businessDate } from '@nexus/factory-domain/core/time'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { postingDateProblem, postingWindow } from '@nexus/factory-domain/inventory/posting/rules'
import type { CommandCaller } from '../../../core/command'
import { periodLockPreview } from '../../accounting/period-guard'
import { officeContextOf, siteFor } from '../ledger/access'
import { rulesOf } from './store'

/**
 * GET /inventory/posting/check?siteId&day (B-W2b-314; SCM-196): the posting date a person is about to send, checked as the
 * post will check it — the site's company's back-dating limit (the warehouse rules) and the month lock over the day
 * (Finance's: HARD refuses, SOFT asks the override's reason) — so the Adjust dialog's date field says it before Post.
 * Office, inventory.stock.view at the site. Reads only.
 */
export async function checkPostingDate(caller: CommandCaller, query: { readonly siteId: string; readonly day: string }, now: Date = new Date()) {
  const context = officeContextOf(caller)
  const site = await siteFor(caller, query.siteId, INVENTORY_STOCK_VIEW, 'siteId')
  const today = businessDate(now)
  return caller.withClient(async (db) => {
    const { inForce } = await rulesOf(db, context.tenantId, site.companyId)
    const days = inForce.backDatingDays.value
    const limit = postingDateProblem({ day: query.day, today, backDatingDays: days })
    const lock = limit ? null : await periodLockPreview(db, { companyId: site.companyId, day: query.day, refused: `a stock move dated ${dayWords(query.day)} is not posted` })
    const problem = limit ?? (lock?.level === 'HARD' ? lock.words : null)
    return {
      day: query.day,
      today,
      earliest: postingWindow(today, days).earliest,
      backDatingDays: { days, source: inForce.backDatingDays.source },
      allowed: problem === null,
      problem,
      periodLock: lock,
    }
  })
}
