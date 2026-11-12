import type { FactoryClient, Prisma } from '@nexus/factory-db'
import type { PartCoverage } from '@nexus/factory-domain/compliance/certificates-depth/bought-in'
import type { CertificateStatus } from '@nexus/factory-domain/compliance/certificates/rules'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { DocumentLanguage } from '@nexus/factory-domain/documents/model'
import type { Uom } from '@nexus/factory-domain/product/units/units'
import { defaultCertificateOf, isPpeLine, lineCertificateCheck, type LineCertificateCheck, type NamedCertificate } from '@nexus/factory-domain/purchasing/line-kinds/certificates'
import { lineKindChecks, lineKindWords, type KindCheckLine } from '@nexus/factory-domain/purchasing/line-kinds/checks'
import type { LineKindCheck } from '@nexus/factory-domain/purchasing/line-kinds/codes'
import { materialWidthOf, rollsOf, type Rolls } from '@nexus/factory-domain/purchasing/line-kinds/rolls'
import { lineVariantProblem } from '@nexus/factory-domain/purchasing/line-kinds/variants'
import type { CommandTx } from '../../../core/command'

/**
 * The facts of purchase order lines by kind (B-W2b-328; SCM-076, SCM-077, SCM-186): each line's rolls, certificate and
 * variant (factory-db supply.prisma PurchaseOrderLine), its material's kind, PPE mark, tracking and width, the PPE
 * register's coverages of its protectors (compliance.prisma CertificateCoverage, the bought-in rule of B-W2b-255) and the
 * material's variants (buying-depth.prisma ItemVariant). Read in the caller's scope: the office's client or a command's
 * transaction (a goods-in tablet reads them too: its grants allow every table named here).
 */

export type Reader = FactoryClient | CommandTx

export const KIND_COLUMNS = { id: true, rolls: true, rollLengthM: true, rollWidthCm: true, certificateId: true, variantCode: true } as const satisfies Prisma.PurchaseOrderLineSelect
export type KindRow = Prisma.PurchaseOrderLineGetPayload<{ select: typeof KIND_COLUMNS }>

const KIND_ITEM_COLUMNS = { id: true, code: true, kind: true, isPpeComponent: true, tracking: true, properties: true } as const satisfies Prisma.ItemSelect
export type KindItem = Prisma.ItemGetPayload<{ select: typeof KIND_ITEM_COLUMNS }>

export const VARIANT_COLUMNS = { id: true, itemId: true, itemColourId: true, size: true, code: true, supplierCode: true, status: true, version: true, createdAt: true } as const satisfies Prisma.ItemVariantSelect
export type VariantRow = Prisma.ItemVariantGetPayload<{ select: typeof VARIANT_COLUMNS }>

const CERTIFICATE_COLUMNS = { id: true, companyId: true, number: true, standard: true, ppeClass: true, status: true, validFrom: true, validTo: true } as const satisfies Prisma.CertificateSelect
type CertificateRow = Prisma.CertificateGetPayload<{ select: typeof CERTIFICATE_COLUMNS }>

const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)

export const namedOf = (row: CertificateRow): NamedCertificate => ({ id: row.id, number: row.number, standard: row.standard, status: row.status as CertificateStatus, validFrom: dayOf(row.validFrom), validTo: dayOf(row.validTo) })

/** Every line's kind facts of one order, with what the checks and the choices need. */
export interface LineKindFacts {
  readonly kinds: ReadonlyMap<string, KindRow>
  readonly items: ReadonlyMap<string, KindItem>
  /** The order buys for development (kind SAMPLE, B-W2b-285). */
  readonly sample: boolean
  /** Per PPE material: its coverages by certificates of the order's company or of every company (any status). */
  readonly coverages: ReadonlyMap<string, readonly PartCoverage[]>
  /** The certificates a line names or a coverage holds, by id. */
  readonly certificates: ReadonlyMap<string, NamedCertificate>
  /** Every variant of the lines' materials, by material. */
  readonly variants: ReadonlyMap<string, readonly VariantRow[]>
}

/** The coverages of these materials' certificates, as B-W2b-255's bought-in rule reads them. */
export async function coveragesOf(db: Reader, companyId: string, itemIds: readonly string[]): Promise<{ coverages: Map<string, PartCoverage[]>; certificates: Map<string, NamedCertificate> }> {
  const coverages = new Map<string, PartCoverage[]>()
  const certificates = new Map<string, NamedCertificate>()
  if (itemIds.length === 0) return { coverages, certificates }
  const rows = await db.certificateCoverage.findMany({
    where: { itemId: { in: [...new Set(itemIds)] }, certificate: { OR: [{ companyId: null }, { companyId }] } },
    select: { id: true, itemId: true, supplierPartyId: true, supplierArticleCode: true, status: true, certificate: { select: CERTIFICATE_COLUMNS } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  for (const row of rows) {
    const named = namedOf(row.certificate)
    certificates.set(named.id, named)
    const coverage: PartCoverage = {
      coverageId: row.id,
      supplierPartyId: row.supplierPartyId,
      supplierArticleCode: row.supplierArticleCode,
      status: row.status as PartCoverage['status'],
      certificate: { ...named, ppeClass: row.certificate.ppeClass },
    }
    coverages.set(row.itemId!, [...(coverages.get(row.itemId!) ?? []), coverage])
  }
  return { coverages, certificates }
}

/** The facts of the order's lines (`lines`: its lines as W1 reads them; only their ids and materials are used). */
export async function readKindFacts(db: Reader, order: { readonly id: string; readonly companyId: string }, lines: readonly { readonly id: string; readonly itemId: string }[]): Promise<LineKindFacts> {
  const ids = lines.map((line) => line.id)
  const itemIds = [...new Set(lines.map((line) => line.itemId))]
  const kinds = ids.length === 0 ? [] : await db.purchaseOrderLine.findMany({ where: { id: { in: ids } }, select: KIND_COLUMNS })
  const items = itemIds.length === 0 ? [] : await db.item.findMany({ where: { id: { in: itemIds } }, select: KIND_ITEM_COLUMNS })
  const head = await db.purchaseOrder.findUnique({ where: { id: order.id }, select: { kind: true } })
  const ppe = items.filter((item) => isPpeLine(item)).map((item) => item.id)
  const { coverages, certificates } = await coveragesOf(db, order.companyId, ppe)
  const named = [...new Set(kinds.flatMap((row) => (row.certificateId && !certificates.has(row.certificateId) ? [row.certificateId] : [])))]
  if (named.length > 0) for (const row of await db.certificate.findMany({ where: { id: { in: named } }, select: CERTIFICATE_COLUMNS })) certificates.set(row.id, namedOf(row))
  const variantRows = itemIds.length === 0 ? [] : await db.itemVariant.findMany({ where: { itemId: { in: itemIds } }, select: VARIANT_COLUMNS, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  const variants = new Map<string, VariantRow[]>()
  for (const row of variantRows) variants.set(row.itemId, [...(variants.get(row.itemId) ?? []), row])
  return { kinds: new Map(kinds.map((row) => [row.id, row])), items: new Map(items.map((item) => [item.id, item])), sample: head?.kind === 'SAMPLE', coverages, certificates, variants }
}

export interface KindLine {
  readonly id: string
  readonly seq: number
  readonly itemId: string
  readonly itemColourId: string | null
  readonly quantity: { toString(): string }
  readonly uom: string
  readonly needDate: Date
}

/** The named certificate's check today for this supplier, or null when the line names none. */
export function certificateCheckOf(facts: LineKindFacts, line: Pick<KindLine, 'itemId'>, certificateId: string | null, supplierPartyId: string, day: BusinessDate): { check: LineCertificateCheck; facts: NamedCertificate | null } | null {
  if (!certificateId) return null
  return { check: lineCertificateCheck(facts.coverages.get(line.itemId) ?? [], certificateId, supplierPartyId, day), facts: facts.certificates.get(certificateId) ?? null }
}

/** The variant a line names, and why it may no longer (null: it may). */
export function variantOf(facts: LineKindFacts, line: Pick<KindLine, 'itemId' | 'itemColourId'>, code: string | null): { row: VariantRow | null; problem: string | null } | null {
  if (!code) return null
  const row = (facts.variants.get(line.itemId) ?? []).find((variant) => variant.code === code) ?? null
  return { row, problem: lineVariantProblem(row, code, facts.items.get(line.itemId)?.code ?? 'The material', line.itemColourId) }
}

/** What a line of these facts is for the send's checks. */
export function checkLineOf(facts: LineKindFacts, line: KindLine, supplierPartyId: string, day: BusinessDate): KindCheckLine {
  const kind = facts.kinds.get(line.id)
  const item = facts.items.get(line.itemId)
  const coverages = facts.coverages.get(line.itemId) ?? []
  const variant = variantOf(facts, line, kind?.variantCode ?? null)
  return {
    seq: line.seq,
    itemCode: item?.code ?? '',
    quantity: line.quantity.toString(),
    uom: line.uom as Uom,
    needDate: dayOf(line.needDate),
    rolls: kind ? rollsOf(kind) : null,
    ppe: item ? isPpeLine(item) : false,
    certificateId: kind?.certificateId ?? null,
    certificate: certificateCheckOf(facts, line, kind?.certificateId ?? null, supplierPartyId, day),
    coverable: defaultCertificateOf(coverages, supplierPartyId, day) !== null,
    registered: coverages.some((coverage) => coverage.status === 'ACTIVE'),
    variant: variant && kind?.variantCode ? { code: kind.variantCode, problem: variant.problem } : null,
  }
}

/** The send's checks of the lines by kind (`lines`: the lines sent, not cancelled). */
export function kindChecks(facts: LineKindFacts, lines: readonly KindLine[], supplierPartyId: string, today: BusinessDate): LineKindCheck[] {
  return lineKindChecks(
    lines.map((line) => checkLineOf(facts, line, supplierPartyId, today)),
    facts.sample,
  )
}

/** What the supplier reads of a line's kind on the PDF (empty: a plain line). */
export function kindWordsOf(facts: LineKindFacts | undefined, line: Pick<KindLine, 'id' | 'itemId'>, language: DocumentLanguage): string[] {
  const kind = facts?.kinds.get(line.id)
  if (!facts || !kind) return []
  const variant = kind.variantCode ? ((facts.variants.get(line.itemId) ?? []).find((row) => row.code === kind.variantCode) ?? null) : null
  const certificate = kind.certificateId ? (facts.certificates.get(kind.certificateId) ?? null) : null
  return lineKindWords(
    {
      rolls: rollsOf(kind) as Rolls | null,
      variant: kind.variantCode ? { code: kind.variantCode, size: variant?.size ?? null, supplierCode: variant?.supplierCode ?? null } : null,
      certificate: certificate ? { number: certificate.number, standard: certificate.standard } : null,
    },
    language,
  )
}

/** The material's width in cm (its properties), or null. */
export const widthOfItem = (item: KindItem | undefined): string | null => (item ? materialWidthOf(item.properties) : null)
