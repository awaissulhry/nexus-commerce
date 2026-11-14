import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { businessDate } from '@nexus/factory-domain/core/time'
import { intentTreatment, leavesIntent, takesIntent, INTENT_LEGAL_REF } from '@nexus/factory-domain/invoicing/intent/intent'
import { INVOICES_MANAGE } from '@nexus/factory-domain/invoicing/permissions'
import { SWITCH_WORDS } from '@nexus/factory-domain/invoicing/tax-codes/switches'
import { codeForTreatment, codesInForce } from '@nexus/factory-domain/invoicing/tax-codes/tax-codes'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { decidedVat, onDraft, refreshDraft, storedPrepared, type PreparedLine } from '../drafts'
import { partyFacts } from '../facts'
import { invoiceDetail, officeInvoice, readInvoice } from '../store'
import { storedSourceOf } from '../terms'
import { codeFactsOf, lockSwitches, readCodes, refused, refusingInWords } from '../tax-codes/store'
import { readDeclaration } from './declarations'

/**
 * Naming a declaration of intent on a draft invoice (B-W2b-392; FIN-100): ONE command on the DRAFT (its version guards it).
 * Named: only while the company's declarations switch is on (GATE-ACCOUNTANT), a declaration of the same company and
 * customer, not revoked; the draft's taxable goods, services and charges become N3.5 with the law of the company's N3.5
 * tax code (the tax-codes switch on) or art. 8 c.1 lett. c) DPR 633/1972, and the totals, the stamp duty line and the terms
 * follow (drafts.ts refreshDraft). Let go: its N3.5 lines take the buyer's VAT again. Whether it is checked, of the year
 * and has enough left is the issue's check (INTENT_*), so the office sees each problem before the number is taken.
 */

const NAMING_TYPES = new Set(['TD01', 'TD02', 'TD24', 'TD05'])

/** invoices.manage: names (or lets go) the declaration a draft rests on. */
export async function nameDeclaration(caller: CommandCaller, invoiceId: string, body: { version?: number | undefined; declarationOfIntentId: string | null }, idempotencyKey?: string) {
  const invoice = await officeInvoice(caller, invoiceId, INVOICES_MANAGE)
  return refusingInWords(() =>
    onDraft(caller, invoice, { name: 'invoices.nameDeclarationOfIntent', idempotencyKey, input: { invoiceId, ...body }, version: body.version }, async (tools, current) => {
      const before = (await tools.tx.invoice.findUnique({ where: { id: current.id }, select: { declarationOfIntentId: true } }))!.declarationOfIntentId
      const day = businessDate(tools.now)
      const stored = await storedPrepared(tools.tx, current.id)
      let lines: PreparedLine[]
      if (body.declarationOfIntentId !== null) {
        if (!NAMING_TYPES.has(current.docType)) throw refused('DECLARATION', `A ${current.docType} rests on no declaration of intent: a credit note gives back what the invoice it credits used.`)
        const switches = await lockSwitches(tools.tx, current.companyId)
        if (!switches.declarationsOfIntentOn) throw refused('SWITCH_OFF', `${SWITCH_WORDS.declarationsOfIntentOn.off} Switch it on in the company's tax set-up when the accountant confirms.`)
        const declaration = await readDeclaration(tools.tx, body.declarationOfIntentId)
        if (!declaration || declaration.companyId !== current.companyId || declaration.partyId !== current.buyerPartyId) throw new NotFoundError("Not a declaration of intent of this customer to this company.")
        if (declaration.revokedAt) throw refused('REVOKED', `Declaration of intent ${declaration.protocolNumber} was revoked: no invoice rests on it.`)
        const law = switches.taxCodesOn ? (codeForTreatment(codesInForce((await readCodes(tools.tx, current.companyId)).map(codeFactsOf), day), intentTreatment(null))?.legalRef ?? INTENT_LEGAL_REF) : INTENT_LEGAL_REF
        lines = stored.map((line) => (takesIntent({ kind: line.core.kind, chargeKind: line.chargeKind ?? null, vat: line.core.vat }) ? { ...line, core: { ...line.core, vat: intentTreatment(law) } } : line))
      } else {
        lines = await withBuyersVat(tools, current.buyerPartyId, stored, day)
      }
      await refreshDraft(tools, current, lines, current.priceBasis, storedSourceOf(current.paymentTerms))
      await tools.tx.invoice.update({ where: { id: current.id }, data: { declarationOfIntentId: body.declarationOfIntentId }, select: { id: true } })
      tools.audit({ recordType: 'Invoice', recordId: current.id, companyId: current.companyId, before: { declarationOfIntentId: before }, after: { declarationOfIntentId: body.declarationOfIntentId } })
      tools.emit({ type: 'invoice.draft_saved', subject: current.id, companyId: current.companyId, payload: { invoiceId: current.id, docType: current.docType, created: false } })
      return { invoice: await invoiceDetail(tools.tx, (await readInvoice(tools.tx, current.id))!), declarationOfIntentId: body.declarationOfIntentId }
    }),
  )
}

/** The lines a declaration made N3.5, with the VAT the rules decide for the buyer again (FIN-098). */
async function withBuyersVat(tools: CommandTools, buyerPartyId: string, lines: readonly PreparedLine[], day: string): Promise<PreparedLine[]> {
  const profile = (await partyFacts(tools.tx, buyerPartyId, day, tools.now))?.profile ?? null
  return lines.map((line, index) => {
    if (!leavesIntent({ kind: line.core.kind, vat: line.core.vat })) return line
    const vat = decidedVat(profile, line.core.kind === 'SERVICE' ? 'SERVICE' : line.core.kind === 'CHARGE' ? 'CHARGE' : 'GOODS', `lines/${index}/vatRatePct`)
    if ('path' in vat) throw new ValidationError(vat.message, [vat])
    return { ...line, core: { ...line.core, vat } }
  })
}
