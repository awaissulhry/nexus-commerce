import { DomainError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { SALES_SAFETY_VIEW } from '@nexus/factory-domain/sales/safety-reports/permissions'
import { heldWords, type HeldCode } from '@nexus/factory-domain/sales/safety-reports/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { officeOf } from '../returns/access'
import { readReport, type ReportRow } from './store'

/**
 * Who works on product-safety reports in the office (B-W2b-351): over the companies its grants reach and, when a report names a
 * customer, over that customer (a report from the public DoC page names none: whoever reaches its company). A report the
 * caller may not see is not found; one it sees but may not act on is forbidden, in words.
 */

export { officeOf }

export interface ReportScope {
  readonly companyId: string
  readonly partyId: string | null
}

export const scopeOfReport = (row: ReportScope): { companyId: string; partyId?: string } => ({ companyId: row.companyId, ...(row.partyId ? { partyId: row.partyId } : {}) })

export const mayOn = (context: OfficeContext, permission: Permission, row: ReportScope): boolean => can(actorOf(context), permission, scopeOfReport(row))

/** The report the office caller sees (sales.safety.view, else not found) and acts on with `permission` (else forbidden). */
export async function officeReport(caller: CommandCaller, reportId: string, permission: Permission = SALES_SAFETY_VIEW, words?: string): Promise<{ context: OfficeContext; row: ReportRow }> {
  const context = officeOf(caller)
  const row = isUuid(reportId) ? await caller.withClient((client) => readReport(client, reportId)) : null
  if (!row || !mayOn(context, SALES_SAFETY_VIEW, row)) throw new NotFoundError('Safety report not found.')
  if (!mayOn(context, permission, row)) throw new ForbiddenError(words)
  return { context, row }
}

/** A step the report's state holds: 409 invalid_state, the code in `held/<CODE>`, the words here. */
export function held(code: HeldCode, number: string): DomainError {
  const words = `Safety report ${number} ${heldWords(code)}.`
  return new DomainError('invalid_state', words, [{ path: `held/${code}`, message: words }])
}

export const INJURY_WORDS = 'Whether someone was hurt, and in what words, is read only by the product-safety role (sales.safety.injury), each opening recorded.'
export const LOG_WORDS = 'The accident log is kept by the product-safety role (sales.safety.log).'
