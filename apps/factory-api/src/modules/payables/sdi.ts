import type { FactoryDatabase } from '@nexus/factory-db'
import { dayWords } from '@nexus/factory-domain/accounting/periods'
import { ConflictError, ForbiddenError, isDomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { FatturaPaReadError, readFatturaPa, sameTaxId, type ReceivedDocument, type ReceivedFatturaPa } from '@nexus/factory-domain/payables/fatturapa'
import { PAYABLES_MANAGE, PAYABLES_VIEW } from '@nexus/factory-domain/payables/permissions'
import { PAYABLES_LIMITS, receivedLineKind, suggestMapping, type OrderLineCandidate, type SubcontractCandidate } from '@nexus/factory-domain/payables/rules'
import { SDI_RECEIVED_OPERATIONS, type SdiReceivedFile, type SdiReceivedItem, type SdiReceivedList, type SdiReceivedListRequest } from '@nexus/factory-domain/payables/sdi-port'
import type { IntegrationMode } from '@nexus/factory-domain/ports/provider'
import { FakeSdi } from '../../adapters/sdi/fake'
import { UNCHOSEN_SDI_PROVIDER, type SdiAdapter } from '../../adapters/sdi/port'
import { callerFor, command, COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandTools } from '../../core/command'
import { defineCron, type CronJob } from '../../core/cron'
import type { Log } from '../../core/queue'
import { serverClock, type Clock } from '../../core/time'
import { honourPeriodLocks, PeriodLockedError } from '../accounting/period-guard'
import { sdiAccountOf } from '../invoicing/sdi/store'
import { processSdi } from '../invoicing/sdi/runtime'
import { putGeneratedFile, recordGeneratedFile, type PreparedGeneratedFile } from '../../platform/files/files'
import { processFiles } from '../../platform/files/service'
import { gatewayAccount, GatewayCallFailed, GatewayRefusal, ProviderError, type Gateway } from '../../platform/gateway/gateway'
import { processGateway } from '../../platform/gateway/service'
import { defineHandler, type EventHandler } from '../../platform/outbox/dispatch'
import { activeTenants, asSystem as systemClient, systemContext } from '../../platform/outbox/system'
import { invoicesBilling, rematchInCommand } from './matching'
import { RefusedError } from './invoices'
import { actorOf } from '../../core/context'
import { asSystem, dayDate, lockInvoiceRow, officeOf, RECORD, type Reader } from './store'

/**
 * Supplier invoices from SDI (B-W2a-62; FIN-136; design finance.payables: the tile "New from SDI", the band's "Last SDI
 * pickup 10:40", live "finance.sdi.inbound → New rows"). The company's SDI account (the one it sends with; FAKE until
 * Owner question Q21, GATE-SPEND) holds what SDI delivered to it; a pickup asks it, outside any transaction (two read-only
 * gateway calls per invoice: sdi.list_received, sdi.get_received), reads each FatturaPA (factory-domain
 * payables/fatturapa) and records it in ONE command of the tenant's SYSTEM context (SDI's delivery is registered by
 * nobody of the office, so whoever approves it is never its registrant): the SupplierInvoice as SDI said it (source
 * SDI, its IdentificativoSdI, received on the day SDI delivered it), its lines with the order each most likely bills
 * (factory-domain payables/rules suggestMapping: the order or delivery note the supplier named, the article code), the
 * XML (and the supplier's PDF, when attached) as fiscal-archive files of the invoice, then the three-way match.
 *
 * An invoice is recorded once per IdentificativoSdI; a delivery that cannot be recorded waits at the intermediary, in
 * words in the pickup's answer and its audit row (the supplier not among the parties, addressed to another company, a
 * batch of several invoices in one file, the same number already typed in, a closed month): a person fixes the cause
 * and picks up again. Pickups run every 15 minutes in the scheduler (`payables.sdiPickup`, per company whose account's
 * intermediary is chosen: the FAKE locally) through the worker, and on a person's "Pick up now".
 */

const now = (): Date => serverClock.now()

// ---- the runtime -----------------------------------------------------------------------------------------------------

export interface PayablesSdi {
  /** The account's intermediary can be asked (FAKE: the fake is here; LIVE, SANDBOX: a provider is chosen, Q21). */
  picksUp(mode: IntegrationMode): boolean
  list(caller: CommandCaller, accountId: string, request: SdiReceivedListRequest): Promise<SdiReceivedList>
  get(caller: CommandCaller, accountId: string, item: SdiReceivedItem): Promise<SdiReceivedFile>
  readonly fake: FakeSdi | null
}

export function createPayablesSdi(options: { readonly gateway: Gateway; readonly fake: FakeSdi | null; readonly remote?: SdiAdapter }): PayablesSdi {
  const remote = options.remote ?? UNCHOSEN_SDI_PROVIDER
  const adapterFor = (account: { provider: string; mode: string }): SdiAdapter => {
    if (account.provider !== 'SDI') throw new ProviderError('This account is not an SDI account.', { retryable: false })
    if (account.mode !== 'FAKE') return remote
    if (!options.fake) throw new ProviderError('A FAKE SDI account needs the fake SDI, which this environment does not have.', { retryable: false })
    return options.fake
  }
  return Object.freeze({
    fake: options.fake,
    picksUp: (mode: IntegrationMode) => (mode === 'FAKE' ? options.fake !== null : remote !== UNCHOSEN_SDI_PROVIDER),
    list: (caller: CommandCaller, accountId: string, request: SdiReceivedListRequest) =>
      options.gateway.call(gatewayAccount(caller, accountId), { ...SDI_RECEIVED_OPERATIONS.list, request: { since: request.since, page: request.cursor !== null } }, (call) => adapterFor(call.account).listReceived(call, request)),
    get: (caller: CommandCaller, accountId: string, item: SdiReceivedItem) =>
      options.gateway.call(gatewayAccount(caller, accountId), { ...SDI_RECEIVED_OPERATIONS.get, idempotencyKey: `received.${item.providerRef}`, request: { fileName: item.fileName } }, (call) => adapterFor(call.account).getReceived(call, item.providerRef)),
  } satisfies PayablesSdi)
}

let configured: PayablesSdi | undefined
let fromProcess: PayablesSdi | undefined

/** Sets the runtime (tests); undefined goes back to the process's (its gateway, and the invoicing SDI runtime's fake). */
export function usePayablesSdi(runtime: PayablesSdi | undefined): void {
  configured = runtime
}

export function processPayablesSdi(): PayablesSdi {
  if (configured) return configured
  if (!fromProcess) fromProcess = createPayablesSdi({ gateway: processGateway(), fake: processSdi().fake })
  return fromProcess
}

// ---- recording one delivery ---------------------------------------------------------------------------------------------

export interface Waiting {
  readonly sdiIdentifier: string
  readonly fileName: string
  readonly receivedAt: string
  readonly problem: string
}

export interface Recorded {
  readonly invoiceId: string
  readonly number: string
  readonly sdiIdentifier: string
  readonly matchStatus: string
}

const SUPPLYING_ROLES = ['SUPPLIER', 'SUBCONTRACTOR'] as const
const ORDER_OPEN_TO_BILL = ['SENT', 'CONFIRMED', 'CHANGES_PROPOSED', 'PARTLY_RECEIVED', 'RECEIVED', 'CLOSED'] as const
const SUBCONTRACT_OPEN_TO_BILL = ['ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED', 'RECEIVED', 'CLOSED'] as const

/** The supplier the XML names: the party whose tax identity has its VAT number (or fiscal code), supplying this company. */
async function supplierOfXml(db: Reader, companyId: string, read: ReceivedFatturaPa): Promise<{ id: string; currency: string } | string> {
  const { vatNumber, vatCode, fiscalCode, name } = read.supplier
  const ids = [vatNumber, vatCode, fiscalCode].filter((value): value is string => value !== null)
  if (ids.length === 0) return 'The XML names no VAT number or fiscal code of the supplier.'
  const identities = await db.partyTaxIdentity.findMany({
    where: { OR: [{ vatNumber: { in: ids } }, { fiscalCode: { in: ids } }, ...(vatCode ? [{ vatNumber: { endsWith: vatCode } }] : [])] },
    select: { partyId: true, vatNumber: true, fiscalCode: true, party: { select: { id: true, companyId: true, roles: true, status: true, currency: true } } },
  })
  const parties = new Map<string, { id: string; currency: string }>()
  for (const identity of identities) {
    const same = sameTaxId(identity.vatNumber, vatNumber) || sameTaxId(identity.vatNumber, vatCode) || sameTaxId(identity.fiscalCode, fiscalCode) || sameTaxId(identity.fiscalCode, vatCode)
    if (!same) continue
    const party = identity.party
    if (party.companyId !== null && party.companyId !== companyId) continue
    if (!party.roles.some((role) => (SUPPLYING_ROLES as readonly string[]).includes(role))) continue
    parties.set(party.id, { id: party.id, currency: party.currency })
  }
  const who = `${name ?? 'the supplier'} (${vatNumber ?? fiscalCode})`
  if (parties.size === 0) return `${who} is not a supplier among the parties: add it (with its VAT number and the SUPPLIER role), then pick up again.`
  if (parties.size > 1) return `${who} is the tax identity of ${parties.size} suppliers: keep one, then pick up again.`
  return [...parties.values()][0]!
}

/** The supplier's open order lines and subcontract orders of the company, for the mapping suggestion. */
async function candidatesOf(db: Reader, companyId: string, partyId: string, currency: string): Promise<{ lines: OrderLineCandidate[]; subcontracts: SubcontractCandidate[] }> {
  const rows = await db.purchaseOrderLine.findMany({
    where: { partyId, cancelledAt: null, purchaseOrder: { companyId, currency, status: { in: [...ORDER_OPEN_TO_BILL] } } },
    select: { id: true, siteId: true, seq: true, supplierArticleCode: true, item: { select: { code: true } }, purchaseOrder: { select: { number: true } }, receiptLines: { where: { receipt: { status: 'POSTED' } }, select: { receipt: { select: { supplierDdtNumber: true } } } } },
    take: 500,
  })
  const subcontracts = await db.subcontractOrder.findMany({ where: { partyId, companyId, currency, status: { in: [...SUBCONTRACT_OPEN_TO_BILL] } }, select: { id: true, siteId: true, number: true }, take: 200 })
  return {
    lines: rows.map((row) => ({
      id: row.id,
      siteId: row.siteId,
      orderNumber: row.purchaseOrder.number,
      seq: row.seq,
      supplierArticleCode: row.supplierArticleCode,
      itemCode: row.item.code,
      ddtNumbers: row.receiptLines.map((line) => line.receipt.supplierDdtNumber).filter((value): value is string => value !== null),
      open: true,
    })),
    subcontracts,
  }
}

/** The invoice a credit note names in DatiFattureCollegate, when it is one of ours of the same supplier and company. */
async function creditedOf(db: Reader, companyId: string, partyId: string, document: ReceivedDocument): Promise<string | null> {
  if (document.kind !== 'CREDIT_NOTE') return null
  for (const related of document.related) {
    if (!related.document) continue
    const found = await db.supplierInvoice.findFirst({ where: { companyId, partyId, kind: 'INVOICE', number: related.document, ...(related.date ? { issueDate: dayDate(related.date) } : {}) }, select: { id: true }, orderBy: { issueDate: 'desc' } })
    if (found) return found.id
  }
  return null
}

/** Why the delivery is not recorded now (a person's work), or the facts to record it. */
async function checkDelivery(db: Reader, companyId: string, item: SdiReceivedFile): Promise<string | { read: ReceivedFatturaPa; document: ReceivedDocument; party: { id: string; currency: string } }> {
  let read: ReceivedFatturaPa
  try {
    read = readFatturaPa(item.xml)
  } catch (error) {
    if (error instanceof FatturaPaReadError) return `The file is not a readable FatturaPA: ${error.message}`
    throw error
  }
  if (read.documents.length > 1) return `The file holds a batch of ${read.documents.length} invoices (a "lotto"): it is not recorded one by one yet; ask the supplier to send them one per file.`
  const document = read.documents[0]!
  const company = await db.company.findUnique({ where: { id: companyId }, select: { vatNumber: true, fiscalCode: true, legalName: true } })
  if (!company) return 'The company of the SDI account is not readable.'
  const buyer = read.buyer
  const ours = sameTaxId(company.vatNumber, buyer.vatNumber) || sameTaxId(company.vatNumber, buyer.vatCode) || sameTaxId(company.fiscalCode, buyer.fiscalCode) || sameTaxId(company.fiscalCode, buyer.vatCode)
  if (!ours) return `The invoice is addressed to ${buyer.name ?? 'another buyer'} (${buyer.vatNumber ?? buyer.fiscalCode ?? 'no tax id'}), not to ${company.legalName}.`
  const party = await supplierOfXml(db, companyId, read)
  if (typeof party === 'string') return party
  if (document.netTotal < 0 || document.vatTotal < 0 || document.grossTotal < 0) return `Invoice ${document.number} adds up to less than zero: it is not recorded as an invoice (ask the supplier for a credit note, TD04).`
  if (document.lines.length > PAYABLES_LIMITS.lines) return `Invoice ${document.number} has ${document.lines.length} lines; a supplier invoice is recorded with at most ${PAYABLES_LIMITS.lines}.`
  const same = await db.supplierInvoice.findFirst({ where: { companyId, partyId: party.id, number: document.number, issueDate: dayDate(document.issueDate) }, select: { source: true, status: true } })
  if (same) return `Invoice ${document.number} of ${dayWords(document.issueDate)} of this supplier is registered already (${same.source === 'SDI' ? 'from SDI' : 'typed in'}, ${same.status.toLowerCase()}): the SDI one cannot be recorded beside it.`
  return { read, document, party }
}

/** The XML and the supplier's own PDF put in the file store, outside any transaction (system caller). */
async function prepareFiles(system: CommandCaller, companyId: string, invoiceId: string, item: SdiReceivedFile, document: ReceivedDocument): Promise<{ xml: PreparedGeneratedFile; pdf: PreparedGeneratedFile | null }> {
  const files = processFiles()
  const xmlName = item.fileName.toLowerCase().endsWith('.xml') ? item.fileName : `${item.fileName.replace(/\.p7m$/i, '')}`
  const xml = await putGeneratedFile(files, system, { companyId, recordType: RECORD, recordId: invoiceId, kind: 'FISCAL_ARCHIVE', originalName: xmlName.endsWith('.xml') ? xmlName : `${xmlName}.xml`, contentType: 'application/xml', body: Buffer.from(item.xml, 'utf8') })
  const attached = document.attachments.find((entry) => entry.format === 'PDF' || entry.name.toLowerCase().endsWith('.pdf'))
  let pdf: PreparedGeneratedFile | null = null
  if (attached) {
    const body = Buffer.from(attached.base64, 'base64')
    if (body.length > 0 && body.subarray(0, 4).toString('latin1') === '%PDF') {
      pdf = await putGeneratedFile(files, system, { companyId, recordType: RECORD, recordId: invoiceId, kind: 'FISCAL_ARCHIVE', originalName: attached.name.toLowerCase().endsWith('.pdf') ? attached.name : `${attached.name}.pdf`, contentType: 'application/pdf', body })
    }
  }
  return { xml, pdf }
}

/** One delivery recorded in ONE system command, matched; or why it waits. Key `sdi-in:<IdentificativoSdI>`. */
export async function recordDelivery(system: CommandCaller, companyId: string, item: SdiReceivedFile): Promise<Recorded | Waiting> {
  const waiting = (problem: string): Waiting => ({ sdiIdentifier: item.sdiIdentifier, fileName: item.fileName, receivedAt: item.receivedAt, problem })
  const checked = await system.withClient((client) => checkDelivery(client, companyId, item))
  if (typeof checked === 'string') return waiting(checked)
  const { document, party } = checked
  const invoiceId = newId()
  const files = await prepareFiles(system, companyId, invoiceId, item, document)
  const candidates = await system.withClient((client) => candidatesOf(client, companyId, party.id, document.currency))
  const receivedOn = businessDate(new Date(item.receivedAt))
  try {
    const { result } = await command(system, { name: 'payables.sdiReceive', idempotencyKey: `sdi-in:${item.sdiIdentifier}`, input: { companyId, sdiIdentifier: item.sdiIdentifier, fileName: item.fileName, sha256: files.xml.sha256 } }, async (tools) => {
      const { tx } = tools
      if (await tx.supplierInvoice.findFirst({ where: { sdiIdentifier: item.sdiIdentifier }, select: { id: true } })) throw new ConflictError('This SDI delivery is recorded already.')
      await honourPeriodLocks(tools, [{ companyId, day: receivedOn, refused: `supplier invoice ${document.number} delivered by SDI on ${dayWords(receivedOn)} is not registered`, path: 'receivedOn', record: { type: RECORD, id: invoiceId } }])
      const creditOfId = await creditedOf(tx, companyId, party.id, document)
      await tx.supplierInvoice.create({
        data: {
          id: invoiceId,
          companyId,
          partyId: party.id,
          source: 'SDI',
          kind: document.kind,
          docType: document.docType,
          number: document.number,
          issueDate: dayDate(document.issueDate),
          receivedOn: dayDate(receivedOn),
          sdiIdentifier: item.sdiIdentifier,
          sdiFileName: item.fileName,
          currency: document.currency,
          netTotal: document.netTotal,
          vatTotal: document.vatTotal,
          grossTotal: document.grossTotal,
          withholdingAmount: document.withholdingAmount,
          stampDutyAmount: document.stampDutyAmount,
          vatSummary: document.vatSummary.map((row) => ({ ...row })),
          paymentTerms: document.paymentTerms ? { condition: document.paymentTerms.condition, installments: document.paymentTerms.installments.map((entry) => ({ ...entry })) } : undefined,
          dueDate: document.dueDate ? dayDate(document.dueDate) : null,
          creditOfId,
          createdById: null,
        },
        select: { id: true },
      })
      let mapped = 0
      for (const line of document.lines) {
        const suggestion = document.kind === 'CREDIT_NOTE' ? null : suggestMapping({ seq: line.seq, itemCode: line.itemCode, codes: line.codes.map((code) => code.value) }, document, candidates.lines, candidates.subcontracts)
        const kind = receivedLineKind(line.lineType, suggestion)
        const onOrder = kind === 'CHARGE' ? null : suggestion
        if (onOrder) mapped++
        await tx.supplierInvoiceLine.create({
          data: {
            id: newId(),
            partyId: party.id,
            invoiceId,
            seq: line.seq,
            kind,
            description: line.description,
            itemCode: line.itemCode,
            quantity: line.quantity,
            uom: line.uom,
            unitPrice: line.unitPrice,
            discountPct: line.discountPct,
            netAmount: line.netAmount,
            vatRatePct: line.vatRatePct,
            vatNature: line.vatNature,
            siteId: onOrder?.siteId ?? null,
            purchaseOrderLineId: onOrder?.kind === 'GOODS' ? onOrder.purchaseOrderLineId : null,
            subcontractOrderId: onOrder?.kind === 'SUBCONTRACT' ? onOrder.subcontractOrderId : null,
          },
          select: { id: true },
        })
      }
      const xml = await recordGeneratedFile(tools, files.xml, { details: { file: 'FatturaPA XML as received', sdiIdentifier: item.sdiIdentifier, number: document.number } })
      const pdf = files.pdf ? await recordGeneratedFile(tools, files.pdf, { details: { file: "the supplier's PDF attached to the XML", sdiIdentifier: item.sdiIdentifier, number: document.number } }) : null
      await tx.supplierInvoice.update({ where: { id: invoiceId }, data: { xmlFileId: xml.id, ...(pdf ? { pdfFileId: pdf.id } : {}) }, select: { id: true } })
      tools.audit({
        action: 'payables.sdiReceive',
        recordType: RECORD,
        recordId: invoiceId,
        companyId,
        after: { source: 'SDI', sdiIdentifier: item.sdiIdentifier, fileName: item.fileName, docType: document.docType, number: document.number, issueDate: document.issueDate, receivedOn, currency: document.currency, totals: markMoney('cost', { netTotal: document.netTotal, vatTotal: document.vatTotal, grossTotal: document.grossTotal }), lines: document.lines.length, mapped, creditOfId },
      })
      const outcome = await rematchInCommand(tools, invoiceId, { bySystem: true })
      tools.emit({ type: 'supplier_invoice.received', subject: invoiceId, companyId, payload: { supplierInvoiceId: invoiceId, partyId: party.id, source: 'SDI', kind: document.kind, status: 'RECEIVED', matchStatus: outcome.matchStatus, lines: document.lines.length, mapped } })
      return { invoiceId, number: document.number, sdiIdentifier: item.sdiIdentifier, matchStatus: outcome.matchStatus }
    })
    return result
  } catch (error) {
    if (error instanceof PeriodLockedError) return waiting(error.message)
    if (isDomainError(error)) return waiting(error.message)
    throw error
  }
}

// ---- a pickup -----------------------------------------------------------------------------------------------------------

export interface PickupResult {
  readonly companyId: string
  readonly accountId: string
  readonly listed: number
  readonly known: number
  readonly recorded: Recorded[]
  readonly waiting: Waiting[]
  readonly at: string
}

export const PICKUP_ACTION = 'payables.sdiPickup'
const MAX_PAGES = 20

/** A pickup for one company, as `caller` (a person: "Pick up now"; the worker: its system context). */
export async function pickUp(caller: CommandCaller, companyId: string, options: { readonly runtime?: PayablesSdi; readonly causationId?: string } = {}): Promise<PickupResult> {
  const runtime = options.runtime ?? processPayablesSdi()
  const system = asSystem(caller)
  const byPerson = caller.factoryContext?.audience === 'office'
  const account = await system.withClient((client) => sdiAccountOf(client, companyId))
  if (!runtime.picksUp(account.mode as IntegrationMode)) throw new RefusedError([{ code: 'NO_INTERMEDIARY', message: 'No SDI intermediary is chosen yet (Owner question Q21): invoices SDI delivers cannot be picked up until it is.' }])
  const at = now()
  const since = new Date(at.getTime() - PAYABLES_LIMITS.pickupDays * 86_400_000).toISOString()
  const items: SdiReceivedItem[] = []
  let cursor: string | null = null
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const answer: SdiReceivedList = await runtime.list(system, account.id, { since, cursor })
      items.push(...answer.items)
      cursor = answer.next
      if (cursor === null) break
    }
  } catch (error) {
    if (error instanceof GatewayRefusal || error instanceof GatewayCallFailed) throw new RefusedError([{ code: 'INTERMEDIARY_UNAVAILABLE', message: `The SDI intermediary could not be asked now (${error.message}); the next pickup tries again.` }])
    throw error
  }
  const known = new Set(
    (await system.withClient((client) => client.supplierInvoice.findMany({ where: { sdiIdentifier: { in: items.map((item) => item.sdiIdentifier) } }, select: { sdiIdentifier: true } }))).map((row) => row.sdiIdentifier!),
  )
  const recorded: Recorded[] = []
  const waiting: Waiting[] = []
  for (const item of items.filter((entry) => !known.has(entry.sdiIdentifier))) {
    let file: SdiReceivedFile
    try {
      file = await runtime.get(system, account.id, item)
    } catch (error) {
      if (error instanceof GatewayRefusal || error instanceof GatewayCallFailed) {
        waiting.push({ sdiIdentifier: item.sdiIdentifier, fileName: item.fileName, receivedAt: item.receivedAt, problem: `The intermediary did not hand the file over (${error.message}); the next pickup tries again.` })
        continue
      }
      throw error
    }
    const outcome = await recordDelivery(system, companyId, file)
    if ('invoiceId' in outcome) recorded.push(outcome)
    else waiting.push(outcome)
  }
  const result: PickupResult = { companyId, accountId: account.id, listed: items.length, known: known.size, recorded, waiting, at: at.toISOString() }
  await command(caller, { name: PICKUP_ACTION, input: { companyId, accountId: account.id, listed: items.length, recorded: recorded.map((row) => row.sdiIdentifier), waiting: waiting.map((row) => row.sdiIdentifier), at: result.at }, ...(options.causationId ? { causationId: options.causationId } : {}) }, async (tools) => {
    tools.audit({
      action: PICKUP_ACTION,
      recordType: 'IntegrationAccount',
      recordId: account.id,
      companyId,
      after: { listed: items.length, known: known.size, recorded: recorded.map((row) => ({ invoiceId: row.invoiceId, number: row.number, sdiIdentifier: row.sdiIdentifier })), waiting, byPerson },
    })
    tools.emit({ type: 'supplier_invoice.sdi_picked_up', subject: account.id, companyId, payload: { companyId, accountId: account.id, listed: items.length, recorded: recorded.length, waiting: waiting.length, byPerson } })
    return { ok: true }
  })
  return result
}

/** payables.manage: "Pick up now" for a company (the manage permission over that company). */
export async function pickUpNow(caller: CommandCaller, input: { readonly companyId: string }): Promise<PickupResult> {
  const context = officeOf(caller)
  if (!can(actorOf(context), PAYABLES_VIEW, { companyId: input.companyId })) throw new NotFoundError('Company not found.')
  if (!can(actorOf(context), PAYABLES_MANAGE, { companyId: input.companyId })) throw new ForbiddenError()
  try {
    return await pickUp(caller, input.companyId)
  } catch (error) {
    if (error instanceof ConflictError && !(error instanceof RefusedError)) throw new RefusedError([{ code: 'NO_SDI_ACCOUNT', message: error.message }])
    throw error
  }
}

/** payables.view: per company the caller reaches, its SDI account and the last pickup (when, what it recorded, what waits). */
export async function sdiStatus(caller: CommandCaller, query: { readonly companyId?: string | undefined }) {
  const context = officeOf(caller)
  const runtime = processPayablesSdi()
  return caller.withClient(async (client) => {
    const companies = await client.company.findMany({ where: query.companyId ? { id: query.companyId } : {}, select: { id: true, code: true, legalName: true }, orderBy: { code: 'asc' } })
    const reached = companies.filter((company) => can(actorOf(context), PAYABLES_VIEW, { companyId: company.id }))
    const out = []
    for (const company of reached) {
      const accounts = await client.integrationAccount.findMany({ where: { provider: 'SDI', companyId: company.id, status: { not: 'DISABLED' } }, select: { id: true, mode: true, status: true }, orderBy: { id: 'asc' } })
      const account = accounts[0] ?? null
      const last = account
        ? await client.auditLog.findFirst({ where: { recordType: 'IntegrationAccount', recordId: account.id, action: PICKUP_ACTION }, select: { at: true, audience: true, after: true }, orderBy: [{ at: 'desc' }, { id: 'desc' }] })
        : null
      const after = (last?.after ?? null) as { listed?: number; recorded?: unknown[]; waiting?: Waiting[] } | null
      out.push({
        company: { id: company.id, code: company.code, name: company.legalName },
        account: account ? { id: account.id, mode: account.mode, status: account.status } : null,
        picksUp: account ? account.status === 'ACTIVE' && runtime.picksUp(account.mode as IntegrationMode) : false,
        lastPickup: last ? { at: last.at.toISOString(), byPerson: last.audience === 'OFFICE', listed: after?.listed ?? 0, recorded: Array.isArray(after?.recorded) ? after!.recorded!.length : 0, waiting: Array.isArray(after?.waiting) ? after!.waiting! : [] } : null,
      })
    }
    return { companies: out }
  })
}

// ---- the scheduler and the worker -----------------------------------------------------------------------------------------

export const PICKUP_DUE_COMMAND = 'payables.sdiPickupDue'
const PICKUP_STEP_MS = 15 * 60_000

/** One tick: per active tenant, one event per company whose SDI intermediary can be asked. */
export async function runPickupTick(options: { readonly database: FactoryDatabase; readonly log: Log; readonly clock?: Clock; readonly runtime?: PayablesSdi }): Promise<{ tenants: number; due: number; failed: number }> {
  const clock = options.clock ?? serverClock
  const runtime = options.runtime ?? processPayablesSdi()
  const step = Math.floor(clock.now().getTime() / PICKUP_STEP_MS)
  const requestId = `sdi-pickup-${newId()}`
  let due = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    try {
      const accounts = (
        await systemClient(options.database, tenantId, requestId, (client) =>
          client.integrationAccount.findMany({ where: { provider: 'SDI', status: 'ACTIVE', companyId: { not: null } }, select: { id: true, companyId: true, mode: true }, orderBy: { id: 'asc' } }),
        )
      ).filter((account) => runtime.picksUp(account.mode as IntegrationMode))
      if (accounts.length === 0) continue
      await runCommand(
        callerFor(options.database, systemContext(tenantId, requestId)),
        { name: PICKUP_DUE_COMMAND, idempotencyKey: `sdi-pickup-due:${step}`, input: { step, accounts: accounts.map((account) => account.id) } },
        async ({ audit, emit }) => {
          for (const account of accounts) {
            audit({ recordType: 'IntegrationAccount', recordId: account.id, companyId: account.companyId, after: { step, due: true } })
            emit({ type: 'supplier_invoice.sdi_pickup_due', subject: account.id, companyId: account.companyId, payload: { companyId: account.companyId!, accountId: account.id, step } })
          }
          return { due: accounts.length }
        },
        { ...COMMAND_SETTINGS, clock },
      )
      due += accounts.length
    } catch (error) {
      failed++
      options.log.error({ err: error, tenantId }, 'the SDI pickups of a tenant could not be planned')
    }
  }
  if (due > 0 || failed > 0) options.log.info({ tenants: tenants.length, due, failed }, 'SDI pickups planned')
  return { tenants: tenants.length, due, failed }
}

/** The scheduler's cron, every 15 minutes. */
export function sdiPickupCron(options: { readonly database: FactoryDatabase; readonly log: Log }): CronJob {
  return defineCron({ name: 'payables.sdiPickup', schedule: '*/15 * * * *', run: async () => void (await runPickupTick(options)) })
}

/** The worker: a pickup due (the scheduler's event), and the match again once goods arrived or went back. */
export function payablesHandlers(runtime: () => PayablesSdi = processPayablesSdi): EventHandler[] {
  return [
    defineHandler({
      name: 'payables.sdiPickup',
      events: ['supplier_invoice.sdi_pickup_due'],
      attempts: 3,
      async handle(event, { caller }) {
        const { companyId } = event.payload as { companyId: string }
        try {
          await pickUp(caller, companyId, { runtime: runtime(), causationId: event.eventId })
        } catch (error) {
          // The intermediary down or not set up: the next tick tries again; nothing to retry now.
          if (error instanceof RefusedError) return
          throw error
        }
      },
    }),
    defineHandler({
      name: 'payables.rematch',
      events: ['inventory.receipt_posted', 'inventory.receipt_reversed', 'subcontract_order.received'],
      attempts: 5,
      async handle(event, { caller }) {
        const payload = event.payload as { receiptId?: string; subcontractOrderId?: string }
        const invoiceIds = await caller.withClient(async (client) => {
          if (event.type === 'subcontract_order.received') return payload.subcontractOrderId ? invoicesBilling(client, { subcontractOrderIds: [payload.subcontractOrderId] }) : []
          const lines = payload.receiptId ? await client.goodsReceiptLine.findMany({ where: { receiptId: payload.receiptId, purchaseOrderLineId: { not: null } }, select: { purchaseOrderLineId: true } }) : []
          return invoicesBilling(client, { purchaseOrderLineIds: lines.map((line) => line.purchaseOrderLineId!) })
        })
        for (const invoiceId of invoiceIds) {
          await command(caller, { name: 'payables.rematchAfterGoods', idempotencyKey: `rematch:${event.eventId}:${invoiceId}`, input: { invoiceId, event: event.type }, causationId: event.eventId }, async (tools: CommandTools) => {
            await lockInvoiceRow(tools.tx, invoiceId)
            const outcome = await rematchInCommand(tools, invoiceId, { bySystem: true })
            if (!outcome.changed) tools.audit({ action: 'payables.rematchAfterGoods', recordType: RECORD, recordId: invoiceId, after: { matchStatus: outcome.matchStatus, unchanged: true } })
            return { matchStatus: outcome.matchStatus }
          })
        }
      },
    }),
  ]
}
