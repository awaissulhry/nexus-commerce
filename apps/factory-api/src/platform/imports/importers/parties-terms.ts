import type { Prisma } from '@nexus/factory-db'
import type { Issue } from '@nexus/factory-domain/core/errors'
import { can, grantsFor, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { CellValue } from '@nexus/factory-domain/imports/cells'
import type { RowIssue, RowValues } from '@nexus/factory-domain/imports/importer'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { termsOfRow, TERMS_COLUMNS, type ImportedTerms } from '@nexus/factory-domain/parties/importer'
import type { PartyRole } from '@nexus/factory-domain/parties/rules'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { assignmentPlan } from '@nexus/factory-domain/sales/pricelists/pricelists'
import { PRICE_LISTS_MANAGE, PRICE_LISTS_VIEW } from '@nexus/factory-domain/sales/pricelists/permissions'
import { PAYMENT_TERMS_VIEW } from '@nexus/factory-domain/sales/terms/permissions'
import type { InvoiceTiming } from '@nexus/factory-domain/sales/terms/terms'
import type { CommandTools, CommandTx } from '../../../core/command'
import { ApiError } from '../../../core/errors'
import { serverClock } from '../../../core/time'
import { givePriceListInCommand } from '../../../modules/sales/pricelists/assignments'
import { listCodesOf, listProblemFor } from '../../../modules/sales/pricelists/lists'
import { dayText } from '../../../modules/sales/pricelists/store'
// Types only: the registry lists the parties adapter, which uses this file.
import type { CheckRow, ImportScope } from '../registry'

/**
 * The commercial terms columns of the customers and suppliers import (B-W2b-25; the B-W2a-49 gap; design sales.customers
 * Tax & terms › "Commercial terms"): the parts of modules/parties importer.ts's adapter that read and write a customer's
 * terms. factory-domain parties/importer `termsOfRow` decides the plain fields in the dry run; this
 *
 *   loads    each party's terms with the codes of its library terms and price list (`termsOf`),
 *   checks   the codes a row names (`checkTerms`): payment terms the person may see (paymentterms.view), ACTIVE, of the
 *            party's company or every company; a price list the person may see AND give (pricelists.view and
 *            pricelists.manage), ACTIVE, of the party's company or every company, in the party's currency (also when the
 *            row only changes the currency and the party keeps its list),
 *   writes   the terms of one planned row inside the batch's command (`writeTermsInCommand`), after the party itself: the
 *            library terms and the list held FOR SHARE (an archive waits, then counts this customer), the Party's terms
 *            columns, one audit row `parties.setCommercialTerms` in the shape of the terms card's (`listId`, the minimum
 *            order marked price) and `party.updated` with the fields that changed.
 *
 * A price list given here moves the customer's dated list history exactly as the terms card does (B-W2b-16,
 * modules/sales/pricelists/assignments.ts `givePriceListInCommand`, in the same command as Party.priceListId): the open
 * row ends yesterday and the new one starts today; a customer's list changes at most once a day, so the check refuses a
 * second change on the same day in the dry run, in the history's own words (factory-domain `assignmentPlan`), and the
 * write refuses it again (the batch stops with the words) should one slip in between.
 */

const AUDIT_ACTION = 'parties.setCommercialTerms'

/** Stops the batch: the terms the row names changed since the dry run. */
class TermsRefused extends ApiError {
  constructor(code: string, detail: string) {
    super('conflict', `The import row for ${code} no longer fits its commercial terms: ${detail}. Run the dry run again.`)
  }
}

const TERMS_PARTY = {
  id: true,
  code: true,
  createdAt: true,
  companyId: true,
  roles: true,
  currency: true,
  paymentTermsId: true,
  priceListId: true,
  defaultDepositPct: true,
  invoiceTiming: true,
  incoterm: true,
  preferredCarrierCode: true,
  minimumOrderAmount: true,
} as const satisfies Prisma.PartySelect
type TermsParty = Prisma.PartyGetPayload<{ select: typeof TERMS_PARTY }>

const LIST = { id: true, code: true, status: true, companyId: true, currency: true } as const satisfies Prisma.PriceListSelect
const TERMS = { id: true, code: true, status: true, companyId: true } as const satisfies Prisma.PaymentTermsSelect

const scoped = (companyId: string | null) => (companyId === null ? {} : { companyId })
const fits = (rowCompany: string | null, partyCompany: string | null): boolean => rowCompany === null || partyCompany === null || rowCompany === partyCompany

// ---- load -------------------------------------------------------------------------------------------------------------

/** The parties' commercial terms as the import sees them, by party id (the codes of the terms and list they name). */
export async function termsOf(client: CommandTx, partyIds: readonly string[]): Promise<Map<string, ImportedTerms>> {
  const out = new Map<string, ImportedTerms>()
  if (partyIds.length === 0) return out
  const parties = await client.party.findMany({ where: { id: { in: [...partyIds] } }, select: TERMS_PARTY })
  const ids = (pick: (party: TermsParty) => string | null) => [...new Set(parties.map(pick).filter((id): id is string => id !== null))]
  const terms = new Map((await client.paymentTerms.findMany({ where: { id: { in: ids((party) => party.paymentTermsId) } }, select: TERMS })).map((row) => [row.id, row.code]))
  const lists = new Map((await client.priceList.findMany({ where: { id: { in: ids((party) => party.priceListId) } }, select: LIST })).map((row) => [row.id, row.code]))
  for (const party of parties) {
    out.set(party.id, {
      paymentTermsCode: party.paymentTermsId === null ? null : (terms.get(party.paymentTermsId) ?? null),
      priceList: party.priceListId === null ? null : (lists.get(party.priceListId) ?? null),
      defaultDepositPct: party.defaultDepositPct === null ? null : decimalText(party.defaultDepositPct.toString()),
      invoiceTiming: party.invoiceTiming as InvoiceTiming,
      incoterm: party.incoterm,
      preferredCarrierCode: party.preferredCarrierCode,
      minimumOrderAmount: party.minimumOrderAmount,
    })
  }
  return out
}

// ---- who may import them ----------------------------------------------------------------------------------------------

/** Refusals of a job that maps a terms column the person may not set (the engine asks at the start, dry run and apply). */
export function authorizeTerms(actor: Actor, job: ImportScope, columns: readonly string[]): Issue[] {
  const reaches = (permission: string) =>
    grantsFor(actor, permission as never).some((grant) => grant.companies === 'all' || (job.companyId !== null && grant.companies.includes(job.companyId)))
  const issues: Issue[] = []
  if (columns.includes('paymentTermsCode') && !reaches(PAYMENT_TERMS_VIEW)) {
    issues.push({ path: 'columns/paymentTermsCode', message: 'Naming payment terms needs paymentterms.view (the payment terms library).' })
  }
  if (columns.includes('list') && !reaches(PRICE_LISTS_MANAGE)) {
    issues.push({ path: 'columns/list', message: 'Giving customers a price list needs pricelists.manage (the right to keep price lists): leave the Price list column out.' })
  }
  return issues
}

// ---- check ------------------------------------------------------------------------------------------------------------

/** The codes each row names, against the library terms and the price lists (one list of issues per row, in order). */
export async function checkTerms(client: CommandTx, rows: readonly CheckRow[], scope: ImportScope, actor: Actor): Promise<RowIssue[][]> {
  const text = (value: CellValue | undefined): string | null => (value === undefined ? null : String(value))
  const codes = rows.map((row) => String(row.key.code))
  const parties = new Map((await client.party.findMany({ where: { code: { in: codes } }, select: TERMS_PARTY })).map((party) => [party.code, party]))
  const termCodes = [...new Set(rows.map((row) => text(row.values.paymentTermsCode)).filter((code): code is string => code !== null))]
  const terms = new Map((termCodes.length === 0 ? [] : await client.paymentTerms.findMany({ where: { code: { in: termCodes } }, select: TERMS })).map((row) => [row.code, row]))
  const listIds = [...parties.values()].map((party) => party.priceListId).filter((id): id is string => id !== null)
  const listCodes = [...new Set(rows.map((row) => text(row.values.list)).filter((code): code is string => code !== null))]
  const lists = await client.priceList.findMany({ where: { OR: [{ code: { in: listCodes } }, { id: { in: listIds } }] }, select: LIST })
  const listByCode = new Map(lists.map((row) => [row.code, row]))
  const listById = new Map(lists.map((row) => [row.id, row]))

  // The dated list history (B-W2b-16) of the customers whose list a row changes: at most one change per customer per day.
  const changing = rows.flatMap((row) => {
    const party = parties.get(String(row.key.code))
    const list = text(row.values.list) === null ? undefined : listByCode.get(text(row.values.list)!)
    return party && list && list.id !== party.priceListId ? [party.id] : []
  })
  const history = changing.length === 0 ? [] : await client.partyPriceListAssignment.findMany({ where: { partyId: { in: changing } }, select: { id: true, partyId: true, priceListId: true, validFrom: true, validTo: true } })
  const historyCodes = await listCodesOf(client, [...new Set(history.map((entry) => entry.priceListId))])
  const today = businessDate(serverClock.now())

  return rows.map((row) => {
    const issues: RowIssue[] = []
    const party = parties.get(String(row.key.code))
    const currency = text(row.values.currency) ?? party?.currency ?? 'EUR'
    const subject = { companyId: scope.companyId, currency, code: String(row.key.code) }
    const termsCode = text(row.values.paymentTermsCode)
    if (termsCode !== null) {
      const found = terms.get(termsCode)
      if (!found || !can(actor, PAYMENT_TERMS_VIEW, scoped(found.companyId))) issues.push({ column: 'paymentTermsCode', message: `No payment terms ${termsCode} in the library you may see.` })
      else if (found.status !== 'ACTIVE') issues.push({ column: 'paymentTermsCode', message: `${found.code} is archived: give the customer active terms.` })
      else if (!fits(found.companyId, scope.companyId)) issues.push({ column: 'paymentTermsCode', message: `${found.code} belongs to another company.` })
    }
    const listCode = text(row.values.list)
    if (listCode !== null) {
      const list = listByCode.get(listCode)
      if (!list || !can(actor, PRICE_LISTS_VIEW, scoped(list.companyId))) issues.push({ column: 'list', message: `No price list ${listCode} you may see.` })
      else if (!can(actor, PRICE_LISTS_MANAGE, scoped(list.companyId))) issues.push({ column: 'list', message: `You may not give customers ${list.code}: that needs the right to keep price lists.` })
      else {
        const problem = listProblemFor(list, subject)
        if (problem) issues.push({ column: 'list', message: problem })
        else if (party && list.id !== party.priceListId) {
          const rowsOfParty = history.filter((entry) => entry.partyId === party.id).map((entry) => ({ id: entry.id, priceListId: entry.priceListId, validFrom: dayText(entry.validFrom)!, validTo: dayText(entry.validTo) }))
          const plan = assignmentPlan(rowsOfParty, list.id, today, today, { party: party.code, listCode: (id) => historyCodes.get(id) ?? listById.get(id)?.code ?? id })
          if (plan.kind === 'REFUSED') issues.push({ column: 'list', message: plan.message })
        }
      }
    } else if (row.values.currency !== undefined && party?.priceListId) {
      // The row moves the currency and the customer keeps its list: the list must be in the new currency (as the terms card).
      const list = listById.get(party.priceListId)
      if (list && list.currency !== currency) issues.push({ column: 'currency', message: `${party.code} is priced from ${list.code} (${list.currency}): give it a list in ${currency} with its new currency (the Price list column).` })
    }
    return issues
  })
}

// ---- write ------------------------------------------------------------------------------------------------------------

const fieldsOf = (row: TermsParty) => ({
  paymentTermsId: row.paymentTermsId,
  priceListId: row.priceListId,
  defaultDepositPct: row.defaultDepositPct === null ? null : decimalText(row.defaultDepositPct.toString()),
  invoiceTiming: row.invoiceTiming as InvoiceTiming,
  incoterm: row.incoterm,
  preferredCarrierCode: row.preferredCarrierCode,
  minimumOrderAmount: row.minimumOrderAmount,
})
type Fields = ReturnType<typeof fieldsOf>
const FIELDS = ['paymentTermsId', 'priceListId', 'defaultDepositPct', 'invoiceTiming', 'incoterm', 'preferredCarrierCode', 'minimumOrderAmount'] as const

/** The audit values, in the shape of the terms card's (`listId`; the minimum order with its grain). */
const auditOf = (fields: Fields) => ({
  paymentTermsId: fields.paymentTermsId,
  listId: fields.priceListId,
  defaultDepositPct: fields.defaultDepositPct,
  invoiceTiming: fields.invoiceTiming,
  incoterm: fields.incoterm,
  preferredCarrierCode: fields.preferredCarrierCode,
  minimumOrderAmount: markMoney('price', fields.minimumOrderAmount),
})

/**
 * Inside the batch's command, after the row's party was written (`created`: by this row): the terms it gives. A row with
 * no terms column only has its new currency checked against the list the customer keeps.
 */
export async function writeTermsInCommand(tools: CommandTools, partyId: string, values: RowValues, created: boolean): Promise<void> {
  const given = TERMS_COLUMNS.some((column) => values[column] !== undefined)
  if (!given && values.currency === undefined) return
  const { tx, now } = tools
  const row = await tx.party.findUniqueOrThrow({ where: { id: partyId }, select: TERMS_PARTY })
  const before = fieldsOf(row)
  const terms = termsOfRow(values, { roles: row.roles as PartyRole[], currency: row.currency })
  if (terms && !terms.ok) throw new TermsRefused(row.code, terms.issues.map((issue) => issue.message).join(' '))
  const patch = terms?.ok ? terms.patch : {}
  // Who may name these terms and give this list was checked with the person who applies, in this same batch (`checkTerms`):
  // the write runs in the worker's system context, so it checks only what the rows are now.
  const next: Fields = { ...before }

  if (patch.paymentTermsCode !== undefined) {
    const found = await tx.paymentTerms.findFirst({ where: { code: patch.paymentTermsCode }, select: TERMS })
    if (found) await tx.$queryRaw`SELECT id FROM "PaymentTerms" WHERE id = ${found.id}::uuid FOR SHARE`
    if (!found || found.status !== 'ACTIVE' || !fits(found.companyId, row.companyId)) throw new TermsRefused(row.code, `payment terms ${patch.paymentTermsCode} are not active terms of its company`)
    next.paymentTermsId = found.id
  }
  const listId = patch.listCode !== undefined ? ((await tx.priceList.findFirst({ where: { code: patch.listCode }, select: { id: true } }))?.id ?? null) : before.priceListId
  if (patch.listCode !== undefined && listId === null) throw new TermsRefused(row.code, `price list ${patch.listCode} is gone`)
  if (listId !== null && (patch.listCode !== undefined || values.currency !== undefined)) {
    await tx.$queryRaw`SELECT id FROM "PriceList" WHERE id = ${listId}::uuid FOR SHARE`
    const list = await tx.priceList.findUniqueOrThrow({ where: { id: listId }, select: LIST })
    const problem = patch.listCode !== undefined ? listProblemFor(list, { companyId: row.companyId, currency: row.currency, code: row.code }) : list.currency === row.currency ? null : `it is priced from ${list.code} (${list.currency}), not in ${row.currency}`
    if (problem) throw new TermsRefused(row.code, problem)
    next.priceListId = list.id
  }
  if (patch.defaultDepositPct !== undefined) next.defaultDepositPct = patch.defaultDepositPct
  if (patch.invoiceTiming !== undefined) next.invoiceTiming = patch.invoiceTiming
  if (patch.incoterm !== undefined) next.incoterm = patch.incoterm
  if (patch.preferredCarrierCode !== undefined) next.preferredCarrierCode = patch.preferredCarrierCode
  if (patch.minimumOrderAmount !== undefined) next.minimumOrderAmount = patch.minimumOrderAmount

  const changed = FIELDS.filter((field) => String(next[field]) !== String(before[field]))
  if (changed.length === 0) return
  // B-W2b-16: the customer's dated list history follows its list in the same command (from today; one change per day).
  if (changed.includes('priceListId')) {
    const codes = await listCodesOf(tx, [before.priceListId, next.priceListId].filter((id): id is string => id !== null))
    await givePriceListInCommand(tools, { id: row.id, code: row.code, priceListId: before.priceListId, createdAt: row.createdAt }, next.priceListId, (id) => codes.get(id) ?? id)
  }
  // command() bumps only the record it guards (the import job): the party's version moves here (not for a party this row made).
  await tx.party.update({
    where: { id: partyId },
    data: { ...next, updatedAt: now, ...(created ? {} : { version: { increment: 1 } }) },
    select: { id: true },
  })
  tools.audit({ action: AUDIT_ACTION, recordType: 'Party', recordId: partyId, companyId: row.companyId, before: auditOf(before), after: auditOf(next) })
  tools.emit({ type: 'party.updated', subject: partyId, companyId: row.companyId, payload: { partyId, code: row.code, fields: [...changed] } })
}
