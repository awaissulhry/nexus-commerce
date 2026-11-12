import { DomainError, InvalidStateError } from '@nexus/factory-domain/core/errors'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addressLine, legalFooter, legalLines, legalName } from '@nexus/factory-domain/documents/legal'
import type { DocumentLanguage, PostalAddress } from '@nexus/factory-domain/documents/model'
import { rmaPapers } from '@nexus/factory-domain/sales/returns-depth/papers'
import { scanCodeCandidates, scanCodeOf } from '@nexus/factory-domain/sales/returns-depth/rules'
import { SALES_RETURNS_MANAGE, SALES_RETURNS_VIEW } from '@nexus/factory-domain/sales/returns/permissions'
import type { FreightPayer, ReturnStatus } from '@nexus/factory-domain/sales/returns/rules'
import { command, type CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { companyLegalOf } from '../../../platform/documents/documents'
import { officeReturn } from '../returns/access'
import { policyOf } from '../returns/policy'
import { lockReturn, touchReturn } from '../returns/rma'
import { dayOrNull, readLines, RETURN_RECORD } from '../returns/store'
import { renderRmaPapers } from './sheet-pdf'

/**
 * The scan code on the RMA papers (B-W2b-341; SAL-346 "Scannable code on RMA papers"; design floor.returnsin "The RMA sheet
 * or box label opens the right return"): the code printed as a Code 128 barcode on the RMA sheet and its box label, set
 * once (the guard: never changed), from the RMA's number (capitals, digits and dashes; with the company's code before it
 * when another RMA of the tenant holds that). The dock's "Scan the return" (GET /sales/returns/dock?code=, B-W2a-43's)
 * finds the return by its number or this code (`scanCodeWhere`).
 *
 *   POST /sales/returns/:returnId/scan-code  (sales.returns.manage) the code, made when the papers are printed the first
 *                                            time (AUTHORISED, RECEIVED or INSPECTED); a second call answers the same code
 *   GET  /sales/returns/:returnId/papers     (sales.returns.view) the RMA sheet with its box label (PDF), in the customer's
 *                                            language or the one asked; once the code is set
 */

/** The dock's find: a scanned or typed code that may be a scan code (capitals), as a where clause; none otherwise. */
export const scanCodeWhere = (value: string): { scanCode: string }[] => {
  const code = scanCodeOf(value)
  return code ? [{ scanCode: code }] : []
}

const PRINTABLE: readonly ReturnStatus[] = Object.freeze(['AUTHORISED', 'RECEIVED', 'INSPECTED'])

/** POST /sales/returns/:returnId/scan-code */
export async function setScanCode(caller: CommandCaller, returnId: string, body: { readonly version: number }, idempotencyKey?: string): Promise<{ scanCode: string; created: boolean }> {
  const { rma: seen } = await officeReturn(caller, returnId, SALES_RETURNS_MANAGE)
  if (seen.scanCode) return { scanCode: seen.scanCode, created: false }
  const { result } = await command(caller, { name: 'returnsDepth.setScanCode', idempotencyKey, input: { returnId, ...body } }, async (tools) => {
    const { tx } = tools
    const rma = await lockReturn(tools, seen.id, body.version, PRINTABLE, 'its papers are printed')
    if (rma.scanCode) return { scanCode: rma.scanCode, created: false }
    const company = await tx.company.findUnique({ where: { id: rma.companyId }, select: { code: true } })
    const candidates = scanCodeCandidates(rma.number, company?.code ?? '')
    const taken = new Set((await tx.returnAuthorisation.findMany({ where: { scanCode: { in: candidates } }, select: { scanCode: true } })).map((row) => row.scanCode))
    const code = candidates.find((candidate) => !taken.has(candidate))
    if (!code) throw new DomainError('conflict', `No free scan code for return ${rma.number}: every code made from its number is taken.`)
    await touchReturn(tools, rma, { scanCode: code })
    tools.audit({ action: 'returnsDepth.setScanCode', recordType: RETURN_RECORD, recordId: rma.id, companyId: rma.companyId, siteId: rma.siteId, before: { scanCode: null }, after: { scanCode: code } })
    tools.emit({ type: 'return.scan_code_set', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, scanCode: code } })
    return { scanCode: code, created: true }
  })
  return result
}

const asAddress = (value: unknown): PostalAddress | null => {
  if (value === null || typeof value !== 'object') return null
  const entry = value as Record<string, unknown>
  return typeof entry.line1 === 'string' && typeof entry.postalCode === 'string' && typeof entry.city === 'string' && typeof entry.country === 'string'
    ? { line1: entry.line1, line2: typeof entry.line2 === 'string' ? entry.line2 : null, postalCode: entry.postalCode, city: entry.city, province: typeof entry.province === 'string' ? entry.province : null, country: entry.country }
    : null
}

/** GET /sales/returns/:returnId/papers */
export async function rmaPapersPdf(caller: CommandCaller, returnId: string, query: { readonly language?: DocumentLanguage | undefined }): Promise<{ pdf: Buffer; fileName: string }> {
  const { rma } = await officeReturn(caller, returnId, SALES_RETURNS_VIEW)
  if (!rma.scanCode) throw new InvalidStateError(`Return ${rma.number} has no scan code yet: print its papers from the return (it is given one then).`)
  const company = await companyLegalOf(caller, rma.companyId)
  const facts = await caller.withClient(async (client) => ({
    site: await client.site.findUnique({ where: { id: rma.siteId }, select: { name: true, address: true } }),
    party: await client.party.findUnique({ where: { id: rma.partyId }, select: { legalName: true, language: true } }),
    lines: await readLines(client, rma.id),
    policy: rma.policyId ? await client.returnPolicy.findUnique({ where: { id: rma.policyId }, select: { name: true, conditions: true, freightPaidBy: true, withdrawalWords: true } }) : null,
    fallback: rma.policyId ? null : await policyOf(client, rma.companyId),
  }))
  const language: DocumentLanguage = query.language ?? (facts.party?.language === 'en' ? 'en' : 'it')
  const address = asAddress(facts.site?.address)
  const papers = rmaPapers({
    language,
    date: businessDate(serverClock.now()),
    company: { name: legalName(company, language), lines: legalLines(company, language), legal: legalFooter(company, language) },
    number: rma.number,
    scanCode: rma.scanCode,
    customer: { name: facts.party?.legalName ?? '', reference: rma.customerRef },
    sendTo: { name: facts.site?.name ?? legalName(company, language), address: address ? addressLine(address, language) : null },
    authorisedOn: rma.authorisedAt ? businessDate(rma.authorisedAt) : null,
    goodsDueBy: dayOrNull(rma.goodsDueBy),
    freightPaidBy: (facts.policy?.freightPaidBy ?? facts.fallback?.freightPaidBy ?? null) as FreightPayer | null,
    lines: facts.lines.map((line) => ({ seq: line.seq, description: line.description, size: line.size, quantity: line.quantity, serial: line.garmentSerial ?? line.serial, lot: line.garmentBatch ?? line.batchNumber })),
    policyName: facts.policy?.name ?? null,
    conditions: facts.policy ? facts.policy.conditions : (facts.fallback?.conditions ?? null),
    withdrawal: rma.withdrawal ? { words: facts.policy?.withdrawalWords ?? null } : null,
  })
  return { pdf: await renderRmaPapers(papers), fileName: papers.fileName }
}
