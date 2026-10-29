import type { Grain } from '@nexus/factory-domain/auth/grains/grains'
import { certificateGate } from '@nexus/factory-domain/compliance/cert-gate/gate'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import {
  isPriced,
  priceBasisOf,
  priceVersion,
  quoteIssues,
  sendBlockers,
  submitBlockers,
  type ApprovalReason,
  type PricedVersion,
  type QuoteIssue,
} from '@nexus/factory-domain/sales/quotes/quotes'
import { taxable, type VatTreatment } from '@nexus/factory-domain/tax/vat-treatment'
import { gateRequestFor } from '../../compliance/certificates/gate'
import { snapshotMissing } from './pricing'
import { quoteRulesFor } from './rules'
import {
  APPROVAL_COLUMNS,
  dateTimeText,
  day,
  decimal,
  moneyLineOf,
  quotePartyOf,
  readCurrentVersion,
  readLineRecords,
  treatmentFor,
  treatmentOfStored,
  type ApprovalRow,
  type LineRecord,
  type QuoteRow,
  type Reader,
  type VersionRow,
} from './store'

/**
 * The quote record as the office reads it (A2 SCR-034): the header, the current version with its totals, VAT breakdown,
 * cost and margin against the floor, the lines with their size grids (each size's certificate coverage, QHS-051), the
 * approval rules checked live and the requests, and the issues in words. Money is marked; the margin AMOUNT is left out
 * for a caller without the cost grain (net − margin is the cost), so the margin grain alone shows a percentage against
 * the floor, never a cost (design question S2, answer a).
 */

interface CertificateAnswer {
  readonly outcome: 'covered' | 'not_required' | 'refused'
  readonly certificateNumber: string | null
  readonly reasons: string[]
}
const CERTIFICATE_NOT_REQUIRED: CertificateAnswer = { outcome: 'not_required', certificateNumber: null, reasons: [] }

/** Each size's certificate answer for one line (the gate of B-W1-12, asked once per line, then per size). */
async function certificatesOf(db: Reader, line: LineRecord, date: BusinessDate): Promise<Map<string, CertificateAnswer>> {
  const answers = new Map<string, CertificateAnswer>()
  if (line.sizes.length === 0) return answers
  const { request } = await gateRequestFor(db, { styleId: line.styleId, colourwayId: line.colourwayId, size: line.sizes[0]!.size }, date)
  for (const row of line.sizes) {
    const result = certificateGate({ ...request, size: row.size } as typeof request)
    if (result.outcome === 'covered') answers.set(row.size, { outcome: 'covered', certificateNumber: result.certificate.number, reasons: [] })
    else if (result.outcome === 'not_required') answers.set(row.size, CERTIFICATE_NOT_REQUIRED)
    else answers.set(row.size, { outcome: 'refused', certificateNumber: null, reasons: result.reasons.map((reason) => reason.message) })
  }
  return answers
}

export const approvalViewOf = (row: ApprovalRow) => ({
  id: row.id,
  status: row.status,
  reasons: row.reasons as ApprovalReason[],
  requestNote: row.requestNote,
  details: asMoney('margin', (row.details ?? null) as Record<string, unknown> | null),
  createdById: row.createdById,
  createdAt: toUtcIso(row.createdAt),
  decidedById: row.decidedById,
  decidedAt: dateTimeText(row.decidedAt),
  decisionNote: row.decisionNote,
})

export interface ReadFacts {
  readonly version: VersionRow
  readonly lines: readonly LineRecord[]
  readonly priced: PricedVersion
  readonly issues: QuoteIssue[]
}

/**
 * The money computed again from the stored lines (the same function the writes store it with: deterministic), the
 * issues, and what the record needs to show them. `certificates: false` skips the gate (an approval request needs only
 * the issues that block it).
 */
export async function readFacts(db: Reader, quote: QuoteRow, now: Date, options: { certificates: boolean } = { certificates: true }) {
  const today = businessDate(now)
  const version = await readCurrentVersion(db, quote)
  const lines = await readLineRecords(db, version.id)
  const party = await quotePartyOf(db, quote.partyId, today, now)
  const rules = await quoteRulesFor(db, quote.companyId)
  const styles = new Map((await db.style.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.styleId))] } }, select: { id: true, code: true, name: true, status: true, sizes: true } })).map((row) => [row.id, row]))
  const colourways = new Map((await db.colourway.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.colourwayId))] } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const revisionIds = [...new Set(lines.flatMap((line) => (line.styleRevisionId ? [line.styleRevisionId] : [])))]
  const revisions = new Map((await db.styleRevision.findMany({ where: { id: { in: revisionIds } }, select: { id: true, revision: true, status: true } })).map((row) => [row.id, row]))
  const contact = quote.contactId ? await db.partyContact.findUnique({ where: { id: quote.contactId }, select: { name: true, email: true } }) : null
  // The lines' sizes in the style's range order.
  const ordered = lines.map((line) => {
    const range = styles.get(line.styleId)?.sizes ?? []
    return { ...line, sizes: [...line.sizes].sort((a, b) => range.indexOf(a.size) - range.indexOf(b.size)) }
  })
  const fallback: VatTreatment = party?.profile ? (() => {
    const decided = treatmentFor(party.profile!)
    return 'problem' in decided ? taxable(22) : decided
  })() : taxable(22)
  const priced = priceVersion({
    basis: priceBasisOf(version.taxMode),
    currency: version.currency,
    treatment: ordered[0] ? treatmentOfStored(ordered[0]) : fallback,
    lines: ordered.map(moneyLineOf),
    depositPct: decimal(version.depositPct),
    rules,
  })
  const gateDay = version.promiseDate ? day(version.promiseDate)! : today
  const certificates = new Map<string, Map<string, CertificateAnswer>>()
  if (options.certificates) for (const line of ordered) certificates.set(line.id, await certificatesOf(db, line, gateDay))
  const labelOf = (line: LineRecord) => `${styles.get(line.styleId)?.code ?? 'style'} ${colourways.get(line.colourwayId)?.name ?? ''}`.trim()
  const issues = quoteIssues({
    today,
    party: {
      status: party?.row.status ?? 'ARCHIVED',
      legalName: party?.row.legalName ?? 'The customer',
      taxMode: party?.identity?.taxMode ?? null,
      viesValid: party?.viesValid ?? false,
      viesMessage: party?.viesMessage ?? null,
    },
    version: { validUntil: day(version.validUntil), billToAddressId: version.billToAddressId, shipToAddressId: version.shipToAddressId, promiseDate: day(version.promiseDate), contactEmail: contact?.email ?? null },
    lines: ordered.map((line) => ({
      id: line.id,
      seq: line.seq,
      label: labelOf(line),
      priced: isPriced(moneyLineOf(line)),
      costMissing: snapshotMissing(line.costSnapshot).map((entry) => entry.message),
      costRevision: line.styleRevisionId ? ((revisions.get(line.styleRevisionId)?.status ?? null) as 'RELEASED' | 'DRAFT' | 'OBSOLETE' | null) : null,
      certificates: [...(certificates.get(line.id)?.entries() ?? [])].map(([size, answer]) => ({ size, reasons: answer.reasons })),
    })),
    rules: priced.rules,
  })
  return { today, version, lines: ordered, party, rules, priced, issues, styles, colourways, revisions, contact, certificates }
}

/**
 * The quote record (quotes.view), the same for every caller (a command's answer is kept for its replays): the grain
 * filter drops the marked fields a caller does not see, and `forCaller` the margin amounts of a caller without the cost
 * grain.
 */
export async function quoteDetail(db: Reader, quote: QuoteRow, now: Date) {
  const facts = await readFacts(db, quote, now)
  const { version, lines, priced, issues, party } = facts
  const approvals = await db.quoteApproval.findMany({ where: { versionId: version.id }, select: APPROVAL_COLUMNS, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  const marginAmount = (value: number | null) => asMoney('margin', value)
  const pricedBySeq = new Map(priced.lines.map((line) => [line.seq, line]))
  return {
    id: quote.id,
    number: quote.number,
    companyId: quote.companyId,
    partyId: quote.partyId,
    party: { code: party?.row.code ?? '', legalName: party?.row.legalName ?? '', status: party?.row.status ?? 'ARCHIVED' },
    contactId: quote.contactId,
    contact: facts.contact ? { name: facts.contact.name, email: facts.contact.email } : null,
    customerRef: quote.customerRef,
    status: quote.status,
    currentRevision: quote.currentRevision,
    internalNote: quote.internalNote,
    version: quote.version,
    createdById: quote.createdById,
    createdAt: toUtcIso(quote.createdAt),
    updatedAt: toUtcIso(quote.updatedAt),
    current: {
      id: version.id,
      revision: version.revision,
      status: version.status,
      currency: version.currency,
      language: version.language,
      taxMode: version.taxMode,
      priceBasis: priceBasisOf(version.taxMode),
      taxIdentityId: version.taxIdentityId,
      billToAddressId: version.billToAddressId,
      shipToAddressId: version.shipToAddressId,
      validUntil: day(version.validUntil),
      firmOffer: version.firmOffer,
      promiseDate: day(version.promiseDate),
      paymentTerms: version.paymentTerms,
      termsText: version.termsText,
      termsVersion: version.termsVersion,
      depositPct: decimal(version.depositPct),
      depositKind: version.depositKind,
      depositAmount: asMoney('price', version.depositAmount),
      noWithdrawal: version.noWithdrawal,
      netAmount: asMoney('price', version.netAmount),
      vatAmount: asMoney('price', version.vatAmount),
      grossAmount: asMoney('price', version.grossAmount),
      vat: asMoney('price', priced.vat.map((entry) => ({ ...entry }))),
      costAmount: asMoney('cost', version.costAmount),
      costComplete: priced.costComplete,
      marginAmount: marginAmount(version.marginAmount),
      marginPct: asMoney('margin', decimal(version.marginPct)),
      marginFloorPct: asMoney('margin', decimal(version.marginFloorPct)),
      marginFloorBreached: asMoney('margin', version.marginFloorBreached),
      changeNote: version.changeNote,
      version: version.version,
      createdAt: toUtcIso(version.createdAt),
      updatedAt: toUtcIso(version.updatedAt),
    },
    lines: lines.map((line) => {
      const style = facts.styles.get(line.styleId)
      const colourway = facts.colourways.get(line.colourwayId)
      const revision = line.styleRevisionId ? facts.revisions.get(line.styleRevisionId) : undefined
      const certificates = facts.certificates.get(line.id)
      const money = pricedBySeq.get(line.seq)
      return {
        id: line.id,
        seq: line.seq,
        kind: line.kind,
        styleId: line.styleId,
        style: { code: style?.code ?? '', name: style?.name ?? '', status: style?.status ?? 'ARCHIVED' },
        styleRevisionId: line.styleRevisionId,
        styleRevision: revision ? { revision: revision.revision, status: revision.status } : null,
        colourwayId: line.colourwayId,
        colourway: { code: colourway?.code ?? '', name: colourway?.name ?? '' },
        description: line.description,
        note: line.note,
        quantity: line.quantity,
        listUnitPrice: asMoney('price', decimal(line.listUnitPrice)),
        unitPrice: asMoney('price', decimal(line.unitPrice)!),
        discountPct: money?.discountPct ?? null,
        netAmount: asMoney('price', line.netAmount),
        vatRatePct: line.vatRatePct.toFixed(2),
        vatNature: line.vatNature,
        vatAmount: asMoney('price', line.vatAmount),
        unitCost: asMoney('cost', decimal(line.unitCost)),
        costAmount: asMoney('cost', line.costAmount),
        costComplete: line.costAmount !== null,
        costMissing: line.styleRevisionId === null ? [{ code: 'NO_REVISION', message: 'The style has no revision to cost it from.' }] : snapshotMissing(line.costSnapshot),
        costSnapshot: asMoney('cost', (line.costSnapshot ?? null) as Record<string, unknown> | null),
        marginAmount: marginAmount(line.marginAmount),
        marginPct: asMoney('margin', decimal(line.marginPct)),
        belowFloor: asMoney('margin', money?.belowFloor ?? false),
        sizes: line.sizes.map((row) => ({
          size: row.size,
          quantity: row.quantity,
          unitPrice: asMoney('price', row.unitPrice),
          certificate: { ...(certificates?.get(row.size) ?? CERTIFICATE_NOT_REQUIRED) },
        })),
        version: line.version,
      }
    }),
    approval: {
      needed: priced.approvalNeeded,
      marginFloorPct: asMoney('margin', priced.marginFloorPct),
      discountLimitPct: priced.discountLimitPct,
      rules: priced.rules.map((rule) => ({ ...rule, lines: [...rule.lines] })),
      requests: approvals.map(approvalViewOf),
    },
    issues,
    canAskApproval: version.status === 'DRAFT' && priced.approvalNeeded && submitBlockers(issues).length === 0,
    sendBlockers: sendBlockers(issues, version.status, priced.approvalNeeded),
  }
}

export type QuoteDetail = Awaited<ReturnType<typeof quoteDetail>>

/**
 * The record as this caller may read it: without the cost grain, no margin AMOUNT (net − margin is the cost), so the
 * margin grain alone shows percentages against the floor, never a cost (design question S2, answer a).
 */
export function forCaller<Answer extends { quote: QuoteDetail }>(answer: Answer, grains: ReadonlySet<Grain>): Answer {
  if (grains.has('cost')) return answer
  const { marginAmount: _version, ...current } = answer.quote.current
  const lines = answer.quote.lines.map(({ marginAmount: _line, ...line }) => line)
  return { ...answer, quote: { ...answer.quote, current, lines } as unknown as QuoteDetail }
}
