import type { FactoryClient } from '@nexus/factory-db'
import { ConflictError, type Issue } from '@nexus/factory-domain/core/errors'
import { PAY_BY_LINK_REFUSAL, PAYROLL_EXPORT, payByLinkProblem } from '@nexus/factory-domain/links/pay'
import { carriesPay, parseValues } from '@nexus/factory-domain/people/payroll/values'
import type { CommandTx } from '../../core/command'

/**
 * Pay figures never go by link (Owner, 11-02; factory-domain links/pay): the one check every link maker calls before it
 * makes a link — POST /links, a set of files (files.ts), a renewal (renew.ts) and B-W2b-54's payroll Send
 * (modules/people/payroll/send.ts). It reads what the rule needs: a stored file's own record, a payroll export's values
 * (its amounts). The database refuses the pay record types again for every login (…_links_depth_w2b_guards); this check
 * says it first, in words, and also judges the payroll file, which only its values tell.
 */

/** A refusal in words: 409, issue `refusal/<CODE>` (the people module's shape). */
export class LinkRefusedError extends ConflictError {
  override name = 'LinkRefusedError'
  override readonly issues: readonly Issue[]
  constructor(
    readonly refusal: string,
    message: string,
    more: readonly Issue[] = [],
  ) {
    super(message)
    this.issues = [{ path: `refusal/${refusal}`, message }, ...more]
  }
}

type PayClient = Pick<FactoryClient | CommandTx, 'storedFile' | 'payrollExport'>

/** One of the export's values has an amount (people/payroll/values carriesPay). A missing export carries nothing. */
export async function payrollCarriesPay(client: PayClient, exportId: string): Promise<boolean> {
  const row = await client.payrollExport.findUnique({ where: { id: exportId }, select: { values: true } })
  return row ? carriesPay(parseValues(row.values)) : false
}

/**
 * Why the record a link would open (or a stored file it would share) may not go by link, in words; null when it may. A
 * StoredFile is judged by the record it belongs to (a file of a pay period is a pay record's). A record this client
 * cannot see is judged by its type alone.
 */
export async function payProblemOf(client: PayClient, subject: { readonly recordType: string; readonly recordId: string }): Promise<string | null> {
  if (subject.recordType === 'StoredFile') {
    const file = await client.storedFile.findUnique({ where: { id: subject.recordId }, select: { recordType: true, recordId: true, originalName: true } })
    if (!file) return null
    const own = file.recordType === PAYROLL_EXPORT ? await payrollCarriesPay(client, file.recordId) : false
    return payByLinkProblem({ recordType: file.recordType, payrollCarriesPay: own, fileName: file.originalName })
  }
  const own = subject.recordType === PAYROLL_EXPORT ? await payrollCarriesPay(client, subject.recordId) : false
  return payByLinkProblem({ recordType: subject.recordType, payrollCarriesPay: own })
}

/** Refuses (409 `refusal/PAY_FIGURES`, in words) a link to a record or file that carries pay figures. */
export async function assertNoPayByLink(client: PayClient, subject: { readonly recordType: string; readonly recordId: string }): Promise<void> {
  const problem = await payProblemOf(client, subject)
  if (problem) throw new LinkRefusedError(PAY_BY_LINK_REFUSAL, problem)
}
