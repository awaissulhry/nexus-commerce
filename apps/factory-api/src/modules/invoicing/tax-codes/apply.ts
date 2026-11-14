import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { IssueProblem } from '@nexus/factory-domain/invoicing/checks'
import { declarationStateOf, intentAmountOf, intentIssueProblems } from '@nexus/factory-domain/invoicing/intent/intent'
import { treatmentOf, type CoreLine } from '@nexus/factory-domain/invoicing/invoices'
import { decideStampDuty, quarterStartOf, STAMP_DUTY_LEGAL_REF, STAMP_DUTY_NATURA, stampDutyIssueProblems, stampDutyLine, stampDutyWords, type StampDutyDecision } from '@nexus/factory-domain/invoicing/stamp-duty/stamp-duty'
import { SWITCH_WORDS, TAX_SWITCHES } from '@nexus/factory-domain/invoicing/tax-codes/switches'
import { codeForTreatment, codesInForce, lineCodeProblems, type TaxCodeFacts } from '@nexus/factory-domain/invoicing/tax-codes/tax-codes'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { PriceBasis } from '@nexus/factory-domain/tax/vat-summary'
import { nonTaxable } from '@nexus/factory-domain/tax/vat-treatment'
import type { CommandCaller, CommandTools, CommandTx } from '../../../core/command'
import { serverClock } from '../../../core/time'
import type { PreparedLine } from '../drafts'
import { officeInvoice, readLines, type InvoiceRow, type LineRow, type Reader } from '../store'
import { declarationFactsOf, readDeclaration } from '../intent/declarations'
import { useDeclarationAtIssue } from '../intent/use'
import { recountInCommand } from '../stamp-duty/quarters'
import { codeFactsOf, dayOf, issueRefusal, lockSwitches, readCodes, readSwitches, type SwitchesRow } from './store'

/**
 * Where tax rules as data meet the invoice core (B-W2b-392; FIN-100, FIN-101, FIN-107), each called from ONE line of the
 * core (marked B-W2b-392 there), GATE-ACCOUNTANT switch by switch (all OFF: every path behaves as W1):
 *
 *   taxedLines         every draft write (drafts.ts insertDraft, refreshDraft): any STAMP_DUTY line is decided again from
 *                      the other lines (Owner 11-13: charged to the customer as a line, one per invoice); with the tax-codes
 *                      switch on a line without VAT prints the law of the company's code in force for its Natura;
 *   taxRuleProblems    the checks before issue of a DRAFT (facts.ts reviewIssue): TAX_CODE, STAMP_DUTY, INTENT_*;
 *   taxDutiesAtIssue   inside the issue command (issue.ts, before the number): the switches held FOR SHARE, the checks again
 *                      under them, the declaration of intent used (or given back by a credit note), the quarter recounted;
 *   invoiceTax         GET /invoicing/invoices/:invoiceId/tax: what the three say of an invoice, for the pre-check panel.
 */

const isStampLine = (line: { readonly chargeKind?: string | null }): boolean => line.chargeKind === 'STAMP_DUTY'

/** A stored line as the core computes it (facts.ts coreLineOf's rule), or null when its VAT is not one the core builds. */
function coreOf(line: LineRow): CoreLine | null {
  const vat = treatmentOf({ vatRatePct: line.vatRatePct.toFixed(2), vatNature: line.vatNature, vatLegalRef: line.vatLegalRef })
  if (vat === null) return null
  return {
    kind: line.kind,
    description: line.description,
    itemCode: line.itemCode,
    quantity: line.quantity.toFixed(4),
    uom: line.uom,
    unitPrice: line.unitPrice.toFixed(6),
    discountPct: line.discountPct === null ? null : line.discountPct.toFixed(4),
    vat,
    deduction: line.kind === 'DEPOSIT_DEDUCTION' ? { netAmount: line.netAmount, grossAmount: line.grossAmount ?? line.netAmount } : null,
  }
}

async function inForceOf(db: Reader, companyId: string, day: BusinessDate): Promise<TaxCodeFacts[]> {
  return codesInForce((await readCodes(db, companyId)).map(codeFactsOf), day)
}

/** The law of the company's code for the stamp duty's N1 (its STAMP_DUTY rule's), or null for the built-in one. */
const stampDutyLaw = (inForce: readonly TaxCodeFacts[]): string | null => codeForTreatment(inForce, nonTaxable(STAMP_DUTY_NATURA, STAMP_DUTY_LEGAL_REF), 'STAMP_DUTY')?.legalRef ?? null

/** Inside a draft's command: its lines with the company's tax rules applied (see the module comment). */
export async function taxedLines(tx: CommandTx, draft: { readonly companyId: string; readonly docType: string; readonly currency: string }, lines: readonly PreparedLine[], basis: PriceBasis, day: BusinessDate): Promise<PreparedLine[]> {
  const kept = lines.filter((line) => !isStampLine(line))
  const switches = await lockSwitches(tx, draft.companyId)
  if (!switches.taxCodesOn && !switches.stampDutyOn) return kept
  const inForce = switches.taxCodesOn ? await inForceOf(tx, draft.companyId, day) : []
  const worded = kept.map((line) => {
    const vat = line.core.vat
    if (!switches.taxCodesOn || line.core.kind === 'DEPOSIT_DEDUCTION' || vat.kind !== 'NON_TAXABLE') return line
    const code = codeForTreatment(inForce, vat)
    return code?.legalRef && code.legalRef !== vat.legalReference ? { ...line, core: { ...line.core, vat: nonTaxable(vat.natura, code.legalRef) } } : line
  })
  if (!switches.stampDutyOn) return worded
  const decision = decideStampDuty({ docType: draft.docType, currency: draft.currency, basis, lines: worded.map((line) => line.core), switchOn: true })
  if (!decision.charge || decision.amount === null) return worded
  return [...worded, { core: stampDutyLine(decision.amount, switches.taxCodesOn ? stampDutyLaw(inForce) : null), salesOrderLineId: null, size: null, ddtId: null, chargeKind: 'STAMP_DUTY' }]
}

/** The stamp duty decided for an invoice now, from its lines without the charge (null: a line the core cannot compute). */
function stampDecisionOf(invoice: Pick<InvoiceRow, 'docType' | 'currency' | 'priceBasis'>, lines: readonly LineRow[], switches: SwitchesRow): StampDutyDecision | null {
  const cores = lines.filter((line) => !isStampLine(line)).map(coreOf)
  if (cores.some((line) => line === null)) return null
  return decideStampDuty({ docType: invoice.docType, currency: invoice.currency, basis: invoice.priceBasis, lines: cores as CoreLine[], switchOn: switches.stampDutyOn })
}

const chargedOf = (lines: readonly LineRow[]): number | null => lines.find(isStampLine)?.netAmount ?? null

/** The tax codes' and the stamp duty's checks (the declaration's are its own: they read its row). */
async function codeAndStampProblems(db: Reader, invoice: InvoiceRow, lines: readonly LineRow[], date: BusinessDate, switches: SwitchesRow): Promise<IssueProblem[]> {
  const problems: IssueProblem[] = []
  if (switches.taxCodesOn) {
    const checked = lines.map((line) => ({ seq: line.seq, kind: line.kind, vat: isStampLine(line) ? null : (coreOf(line)?.vat ?? null) }))
    problems.push(...lineCodeProblems(checked, await inForceOf(db, invoice.companyId, date), date))
  }
  const decision = stampDecisionOf(invoice, lines, switches)
  if (decision) problems.push(...stampDutyIssueProblems(decision, chargedOf(lines)))
  return problems
}

const intentLines = (lines: readonly LineRow[]) => lines.map((line) => ({ kind: line.kind, vatNature: line.vatNature, netAmount: line.netAmount }))

/** The checks before issue of a DRAFT (TAX_CODE, STAMP_DUTY, INTENT_*); none for an issued invoice (an SDI correction). */
export async function taxRuleProblems(db: Reader, invoice: InvoiceRow, lines: readonly LineRow[], date: BusinessDate): Promise<IssueProblem[]> {
  if (invoice.status !== 'DRAFT') return []
  const switches = await readSwitches(db, invoice.companyId)
  const named = (await db.invoice.findUnique({ where: { id: invoice.id }, select: { declarationOfIntentId: true } }))?.declarationOfIntentId ?? null
  const declaration = named ? await readDeclaration(db, named) : null
  return [
    ...(await codeAndStampProblems(db, invoice, lines, date, switches)),
    ...intentIssueProblems({ switchOn: switches.declarationsOfIntentOn, docType: invoice.docType, declaration: declaration ? declarationFactsOf(declaration) : null, lines: intentLines(lines), issueDate: date }),
  ]
}

/** Inside the issue command, before the number is taken (see the module comment). */
export async function taxDutiesAtIssue(tools: CommandTools, invoice: InvoiceRow, lines: readonly LineRow[], date: BusinessDate): Promise<void> {
  const switches = await lockSwitches(tools.tx, invoice.companyId)
  const problems = await codeAndStampProblems(tools.tx, invoice, lines, date, switches)
  if (problems.length > 0) throw issueRefusal(problems)
  await useDeclarationAtIssue(tools, invoice, intentLines(lines), date, switches)
  if (switches.stampDutyOn && invoice.stampDutyAmount !== null) await recountInCommand(tools, invoice.companyId, quarterStartOf(date), { invoiceId: invoice.id, amount: invoice.stampDutyAmount })
}

/** invoices.view: what the company's tax rules say of an invoice (its stamp duty, its declaration, the checks). */
export async function invoiceTax(caller: CommandCaller, invoiceId: string) {
  const invoice = await officeInvoice(caller, invoiceId)
  const today = businessDate(serverClock.now())
  return caller.withClient(async (client) => {
    const lines = await readLines(client, invoice.id)
    const switches = await readSwitches(client, invoice.companyId)
    const decision = stampDecisionOf(invoice, lines, switches) ?? { amount: invoice.stampDutyAmount, charge: false, reason: invoice.stampDutyAmount === null ? ('NOT_DUE' as const) : ('SWITCH_OFF' as const) }
    const named = (await client.invoice.findUnique({ where: { id: invoice.id }, select: { declarationOfIntentId: true } }))?.declarationOfIntentId ?? null
    const declaration = named ? await readDeclaration(client, named) : null
    const candidates = await client.declarationOfIntent.findMany({ where: { companyId: invoice.companyId, partyId: invoice.buyerPartyId, revokedAt: null }, select: { id: true, protocolNumber: true, protocolDate: true, year: true, amount: true, usedAmount: true, checkedAt: true, revokedAt: true }, orderBy: [{ protocolDate: 'desc' }, { id: 'desc' }] })
    return {
      invoiceId: invoice.id,
      status: invoice.status,
      switches: { taxCodesOn: switches.taxCodesOn, stampDutyOn: switches.stampDutyOn, declarationsOfIntentOn: switches.declarationsOfIntentOn },
      stampDuty: { amount: asMoney('price', decision.amount), charge: decision.charge, reason: decision.reason, chargedAmount: asMoney('price', chargedOf(lines)), words: stampDutyWords(decision) },
      declarationOfIntent: declaration
        ? {
            id: declaration.id,
            protocolNumber: declaration.protocolNumber,
            protocolDate: dayOf(declaration.protocolDate),
            year: declaration.year,
            state: declarationStateOf(declarationFactsOf(declaration)),
            amount: asMoney('price', declaration.amount),
            usedAmount: asMoney('price', declaration.usedAmount),
            thisAmount: asMoney('price', intentAmountOf(intentLines(lines))),
          }
        : null,
      declarationCandidates: candidates.map((row) => ({ id: row.id, protocolNumber: row.protocolNumber, year: row.year, state: declarationStateOf({ ...row, protocolDate: dayOf(row.protocolDate), checkedAt: row.checkedAt ? row.checkedAt.toISOString() : null, revokedAt: null }) })),
      problems: await taxRuleProblems(client, invoice, lines, today),
      waits: TAX_SWITCHES.filter((name) => !switches[name]).map((name) => SWITCH_WORDS[name].off),
    }
  })
}
