import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { intentAmountOf, intentIssueProblems, type IntentLine } from '@nexus/factory-domain/invoicing/intent/intent'
import { markMoney } from '@nexus/factory-domain/money/marked'
import type { CommandTools } from '../../../core/command'
import { issueRefusal, type SwitchesRow } from '../tax-codes/store'
import { declarationFactsOf, DECLARATION_COLUMNS, type DeclarationRow } from './declarations'

/**
 * What an issue does to a declaration of intent (B-W2b-392; FIN-100), inside the issue command (issue.ts, before the
 * number is taken; the money locks are held, the company's switches FOR SHARE):
 *
 *   - an invoice that names a declaration: the declaration's row is locked FOR UPDATE, the checks run again under it
 *     (switched on, not revoked, checked, of the invoice's year, enough left: 409 in words, no number taken), then what
 *     the invoice uses (the net of its N3.5 lines) is added to it;
 *   - a credit note (TD04) of an invoice that named one gives back what it credits of N3.5 (never below 0; a revoked
 *     declaration keeps what it had).
 * Each with an audit row and `declaration_of_intent.changed`.
 */

async function lockDeclaration(tools: CommandTools, declarationId: string): Promise<DeclarationRow | null> {
  const rows = await tools.tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "DeclarationOfIntent" WHERE "id" = ${declarationId}::uuid FOR UPDATE`
  return rows.length === 0 ? null : tools.tx.declarationOfIntent.findUnique({ where: { id: declarationId }, select: DECLARATION_COLUMNS })
}

export async function useDeclarationAtIssue(
  tools: CommandTools,
  invoice: { readonly id: string; readonly companyId: string; readonly docType: string; readonly creditOfId: string | null },
  lines: readonly IntentLine[],
  date: BusinessDate,
  switches: SwitchesRow,
): Promise<void> {
  const named = (await tools.tx.invoice.findUnique({ where: { id: invoice.id }, select: { declarationOfIntentId: true } }))?.declarationOfIntentId ?? null
  if (named !== null) {
    const declaration = await lockDeclaration(tools, named)
    const problems = intentIssueProblems({ switchOn: switches.declarationsOfIntentOn, docType: invoice.docType, declaration: declaration ? declarationFactsOf(declaration) : null, lines, issueDate: date })
    if (problems.length > 0) throw issueRefusal(problems)
    const used = intentAmountOf(lines)
    await tools.tx.declarationOfIntent.update({ where: { id: named }, data: { usedAmount: { increment: used }, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'invoices.useDeclarationOfIntent', recordType: 'DeclarationOfIntent', recordId: named, companyId: invoice.companyId, before: { usedAmount: markMoney('price', declaration!.usedAmount) }, after: { usedAmount: markMoney('price', declaration!.usedAmount + used), invoiceId: invoice.id } })
    tools.emit({ type: 'declaration_of_intent.changed', subject: named, companyId: invoice.companyId, payload: { declarationId: named, partyId: declaration!.partyId, action: 'USED', invoiceId: invoice.id } })
    return
  }
  if (invoice.docType !== 'TD04' || invoice.creditOfId === null) return
  const credited = (await tools.tx.invoice.findUnique({ where: { id: invoice.creditOfId }, select: { declarationOfIntentId: true } }))?.declarationOfIntentId ?? null
  if (credited === null) return
  const declaration = await lockDeclaration(tools, credited)
  const back = Math.min(intentAmountOf(lines), declaration?.usedAmount ?? 0)
  if (!declaration || declaration.revokedAt !== null || back <= 0) return
  await tools.tx.declarationOfIntent.update({ where: { id: credited }, data: { usedAmount: { decrement: back }, version: { increment: 1 } }, select: { id: true } })
  tools.audit({ action: 'invoices.returnDeclarationOfIntent', recordType: 'DeclarationOfIntent', recordId: credited, companyId: invoice.companyId, before: { usedAmount: markMoney('price', declaration.usedAmount) }, after: { usedAmount: markMoney('price', declaration.usedAmount - back), invoiceId: invoice.id } })
  tools.emit({ type: 'declaration_of_intent.changed', subject: credited, companyId: invoice.companyId, payload: { declarationId: credited, partyId: declaration.partyId, action: 'RETURNED', invoiceId: invoice.id } })
}
