import { createHash } from 'node:crypto'
import type { Prisma } from '@nexus/factory-db'
import { DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { costingCurrency } from '@nexus/factory-domain/costing/inputs'
import { cellView, exactCell, missingView, prepareSheet, type PreparedSheet } from '@nexus/factory-domain/costing/sheet'
import { lineCostOf, priceBasisOf, priceVersion, versionTaxModeOf, type LineCost, type PricedVersion, type SizeRow } from '@nexus/factory-domain/sales/quotes/quotes'
import type { VatTreatment } from '@nexus/factory-domain/tax/vat-treatment'
import type { CommandTools, CommandTx } from '../../../core/command'
import { loadCostFacts, STYLE_COLUMNS as COSTING_STYLE_COLUMNS, type CostingCompany } from '../../costing/store'
import { findRevision, type RevisionRow } from '../../product/bom/store'
import { quoteRulesFor } from './rules'
import { decimal, moneyLineOf, quotePartyOf, readLineRecords, storedVat, treatmentFor, VERSION_COLUMNS, type LineRecord, type QuoteParty, type QuoteRow, type Reader, type VersionRow } from './store'

/**
 * A quote version's money, written (B-W1-21): the cost of a line from its style's cost sheet (costing, B-W1-16: the
 * revision's BOM and routing priced with today's inputs, exact to the end, one rounding per figure), and the refresh of a
 * DRAFT version after any change: the party's VAT treatment decided again (its identity in force today, the VIES proof),
 * every line's net and VAT, the version's totals, deposit, cost, margin and the floor it was checked against. All inside
 * the caller's command (its transaction, its time). A line keeps the cost it was priced with until it is costed again
 * (its own change, or a recompute): the design's "cost changed since priced".
 */

/** What one line is costed from. */
export interface CostTarget {
  readonly styleId: string
  readonly styleRevisionId: string | null
  readonly colourwayId: string
  readonly sizes: readonly SizeRow[]
}

export interface CostedLine {
  readonly cost: LineCost
  /** QuoteLine.costSnapshot (a cost-grain column): the cells as priced; null without a revision to cost from. */
  readonly snapshot: Prisma.InputJsonValue | null
}

/** The sheets of one refresh, per style revision (several colourways of a style share one). */
export type SheetCache = Map<string, Promise<{ sheet: PreparedSheet; revision: RevisionRow }>>

async function sheetOf(tx: CommandTx | Reader, cache: SheetCache, target: CostTarget, company: CostingCompany, now: Date) {
  const key = `${target.styleId}:${target.styleRevisionId}`
  let entry = cache.get(key)
  if (!entry) {
    entry = (async () => {
      const style = await tx.style.findUnique({ where: { id: target.styleId }, select: COSTING_STYLE_COLUMNS })
      if (!style) throw new NotFoundError('Style not found.')
      const revision = await findRevision(tx, style.id, target.styleRevisionId!)
      const { facts } = await loadCostFacts(tx, style, revision, company, now)
      return { sheet: prepareSheet(facts), revision }
    })()
    cache.set(key, entry)
  }
  return entry
}

/** A line's cost now: every size's cell of its colourway, × its pieces. */
export async function costLine(tx: CommandTx | Reader, cache: SheetCache, target: CostTarget, company: CostingCompany, now: Date): Promise<CostedLine> {
  if (target.styleRevisionId === null) return { cost: { complete: false, unitCost: null, amount: null }, snapshot: null }
  const { sheet, revision } = await sheetOf(tx, cache, target, company, now)
  const cells = target.sizes.map((row) => exactCell(sheet, target.colourwayId, row.size))
  const cost = lineCostOf(
    cells.map((cell, index) => ({ quantity: target.sizes[index]!.quantity, complete: cell.missing.length === 0, knownTotal: cell.knownTotal })),
    company.currency,
  )
  const snapshot = {
    revisionId: revision.id,
    revision: revision.revision,
    revisionStatus: revision.status,
    on: sheet.facts.on,
    computedAt: toUtcIso(now),
    currency: company.currency,
    companyId: company.id,
    complete: cost.complete,
    cells: cells.map((cell, index) => ({ quantity: target.sizes[index]!.quantity, ...cellView(cell) })),
    missing: missingView(sheet, cells),
  }
  return { cost, snapshot: snapshot as unknown as Prisma.InputJsonValue }
}

/** The cost sheet's missing inputs a line's snapshot names, in words (no figure). */
export function snapshotMissing(snapshot: unknown): { code: string; message: string }[] {
  const missing = (snapshot as { missing?: unknown } | null)?.missing
  if (!Array.isArray(missing)) return []
  return missing.filter((entry): entry is { code: string; message: string } => typeof entry?.code === 'string' && typeof entry?.message === 'string').map((entry) => ({ code: entry.code, message: entry.message }))
}

/** The company a quote is costed for: the quote's own, in its currency. */
export async function costingCompanyOf(db: Reader, companyId: string): Promise<CostingCompany> {
  const row = await db.company.findUnique({ where: { id: companyId }, select: { id: true, currency: true } })
  if (!row) throw new NotFoundError('Company not found.')
  return { id: row.id, currency: costingCurrency(row.currency) }
}

/** The party's treatment now, or a 409 that says what is missing. */
export function decideTreatment(party: QuoteParty): VatTreatment {
  if (!party.profile) throw new DomainError('conflict', `${party.row.legalName} has no tax identity in force: add it to the customer before quoting (the VAT of every line depends on it).`, [{ path: 'party/taxIdentity', message: 'No tax identity in force.' }])
  const treatment = treatmentFor(party.profile)
  if ('problem' in treatment) throw new DomainError('conflict', treatment.problem, [{ path: 'party/taxIdentity', message: treatment.problem }])
  return treatment
}

export interface Refreshed {
  readonly priced: PricedVersion
  readonly lines: readonly LineRecord[]
  readonly party: QuoteParty
}

const sameDecimal = (stored: Prisma.Decimal | null, value: string | null): boolean => (stored === null ? value === null : value !== null && stored.equals(value))

/**
 * Inside a command on a DRAFT version: the party's VAT decided again, the lines in `recost` costed again from today's
 * sheets ('all' for a recompute), then every line's money and the version's totals written. Returns what was computed.
 */
export async function refreshVersion(tools: CommandTools, quote: QuoteRow, version: VersionRow, recost: ReadonlySet<string> | 'all'): Promise<Refreshed> {
  const { tx, now } = tools
  const party = await quotePartyOf(tx, quote.partyId, businessDate(now), now)
  if (!party) throw new NotFoundError('Customer not found.')
  const treatment = decideTreatment(party)
  const taxMode = versionTaxModeOf(party.identity!.taxMode, party.viesValid)
  const company = await costingCompanyOf(tx, quote.companyId)
  const cache: SheetCache = new Map()

  let lines = await readLineRecords(tx, version.id)
  const costed = new Map<string, CostedLine>()
  for (const line of lines) {
    if (recost !== 'all' && !recost.has(line.id)) continue
    const result = await costLine(tx, cache, line, company, now)
    costed.set(line.id, result)
    await tx.quoteLine.update({
      where: { id: line.id },
      data: { unitCost: result.cost.unitCost, costAmount: result.cost.amount, ...(result.snapshot === null ? {} : { costSnapshot: result.snapshot }), version: { increment: 1 } },
      select: { id: true },
    })
    // factory-db exports Prisma's types, not its runtime DbNull: a JSON column is cleared in SQL.
    if (result.snapshot === null && line.costSnapshot !== null) await tx.$executeRaw`UPDATE "QuoteLine" SET "costSnapshot" = NULL WHERE "id" = ${line.id}::uuid`
  }
  if (costed.size > 0) lines = lines.map((line) => (costed.has(line.id) ? { ...line, costAmount: costed.get(line.id)!.cost.amount } : line))

  const rules = await quoteRulesFor(tx, quote.companyId)
  const priced = priceVersion({
    basis: priceBasisOf(taxMode),
    currency: version.currency,
    treatment,
    lines: lines.map(moneyLineOf),
    depositPct: decimal(version.depositPct),
    rules,
  })
  const vat = storedVat(treatment)
  for (const [index, line] of lines.entries()) {
    const money = priced.lines[index]!
    const unchanged =
      line.quantity === money.quantity &&
      line.netAmount === money.netAmount &&
      line.vatAmount === money.vatAmount &&
      line.vatNature === vat.vatNature &&
      line.vatRatePct.equals(vat.vatRatePct) &&
      line.marginAmount === money.marginAmount &&
      sameDecimal(line.marginPct, money.marginPct)
    if (unchanged) continue
    await tx.quoteLine.update({
      where: { id: line.id },
      data: { quantity: money.quantity, netAmount: money.netAmount, vatAmount: money.vatAmount, vatRatePct: vat.vatRatePct, vatNature: vat.vatNature, marginAmount: money.marginAmount, marginPct: money.marginPct, version: { increment: 1 } },
      select: { id: true },
    })
  }
  await tx.quoteVersion.update({
    where: { id: version.id },
    data: {
      taxMode,
      taxIdentityId: party.identityId,
      netAmount: priced.netAmount,
      vatAmount: priced.vatAmount,
      grossAmount: priced.grossAmount,
      depositAmount: priced.depositAmount,
      costAmount: priced.costAmount,
      marginAmount: priced.marginAmount,
      marginPct: priced.marginPct,
      marginFloorPct: priced.marginFloorPct,
      marginFloorBreached: priced.marginFloorBreached,
      version: { increment: 1 },
    },
    select: { id: true },
  })
  return { priced, lines: await readLineRecords(tx, version.id), party }
}

/** The version as it is now (inside the command). */
export const versionNow = (tx: CommandTx, versionId: string): Promise<VersionRow> => tx.quoteVersion.findUniqueOrThrow({ where: { id: versionId }, select: VERSION_COLUMNS })

/**
 * SHA-256 of a version's priced content: what an approver approves (lines, sizes, prices, costs, VAT treatment, totals,
 * deposit). The approval is decided only while the version still hashes the same.
 */
export function fingerprintOf(version: Pick<VersionRow, 'currency' | 'taxMode' | 'depositPct' | 'netAmount' | 'vatAmount' | 'grossAmount' | 'costAmount'>, lines: readonly LineRecord[]): string {
  const content = {
    currency: version.currency,
    taxMode: version.taxMode,
    depositPct: decimal(version.depositPct),
    netAmount: version.netAmount,
    vatAmount: version.vatAmount,
    grossAmount: version.grossAmount,
    costAmount: version.costAmount,
    lines: lines.map((line) => [line.seq, line.styleId, line.styleRevisionId, line.colourwayId, decimal(line.unitPrice), decimal(line.listUnitPrice), line.costAmount, line.vatRatePct.toFixed(2), line.vatNature, line.sizes.map((row) => [row.size, row.quantity, row.unitPrice])]),
  }
  return createHash('sha256').update(JSON.stringify(content)).digest('hex')
}
