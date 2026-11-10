import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { AlternateView, BomDepthView } from '@nexus/factory-domain/product/bom-lines/contracts'
import { alternateUse, certificateCheckRequired, kitPlan, type AlternateLine, type AlternateMaterial, type AlternateUse } from '@nexus/factory-domain/product/bom-lines/rules'
import type { MaterialApproval } from '@nexus/factory-domain/product/bom-structure/rules'
import { decimalText, type Uom } from '@nexus/factory-domain/product/units/units'
import type { CommandTools, CommandTx } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { findRevision, STYLE_COLUMNS, type BomStyleRow, type LockedDraft, type RevisionRow } from '../bom/store'
import { readSteps, type StepRecord } from '../routing/read'

/**
 * The rows of BOM lines in depth (B-W2b-228): B-W2b-211's columns of W1's BomLine that no earlier step writes (who sends the
 * material, the workshop's kit mark), the alternates (BomLineAlternate), the revision's output, and what they name (the
 * materials with their approval, PPE mark, tracking and colours; the parties; the routing steps; the certificate that covers
 * a PPE component alternate). Every read names its columns; queries run one after another (a transaction client runs one at
 * a time). No money.
 *
 * Locks (after W1's `lockDraft`: the style row FOR UPDATE, B-W2b-221's edit rule, the revision by compare-and-set): the
 * materials named FOR SHARE (W1's `lockMaterials`, by id), the party named FOR SHARE, then the rows written.
 */

export type Reader = FactoryClient | CommandTx

const text = (value: { toString(): string }): string => decimalText(value.toString())

export const DEPTH_LINE_COLUMNS = {
  id: true,
  seq: true,
  itemId: true,
  placement: true,
  qty: true,
  uom: true,
  supplierId: true,
  customerSuppliedByPartyId: true,
  issueToSubcontract: true,
  routingSeq: true,
  subAssemblyRevisionId: true,
  version: true,
} as const satisfies Prisma.BomLineSelect
type DepthLineRow = Prisma.BomLineGetPayload<{ select: typeof DEPTH_LINE_COLUMNS }>

/** A line as these routes read it (decimals as plain decimal text). */
export interface DepthLine extends Omit<DepthLineRow, 'qty'> {
  readonly qty: string
}

const lineOf = (row: DepthLineRow): DepthLine => ({ ...row, qty: text(row.qty) })

/** The lines of a revision, in BOM order. */
export async function readDepthLines(db: Reader, revisionId: string): Promise<DepthLine[]> {
  return (await db.bomLine.findMany({ where: { revisionId }, select: DEPTH_LINE_COLUMNS, orderBy: { seq: 'asc' } })).map(lineOf)
}

/** A line of this revision (another revision's, or none, is not found). */
export async function lineFor(db: Reader, revisionId: string, lineId: string): Promise<DepthLine> {
  const row = isUuid(lineId) ? await db.bomLine.findFirst({ where: { id: lineId, revisionId }, select: DEPTH_LINE_COLUMNS }) : null
  if (!row) throw new NotFoundError('BOM line not found.')
  return lineOf(row)
}

export const ALTERNATE_COLUMNS = {
  id: true,
  bomLineId: true,
  priority: true,
  itemId: true,
  itemColourId: true,
  qty: true,
  allowedWhen: true,
  certificateCheck: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.BomLineAlternateSelect
type AlternateRow = Prisma.BomLineAlternateGetPayload<{ select: typeof ALTERNATE_COLUMNS }>

export interface AlternateRecord extends Omit<AlternateRow, 'qty' | 'allowedWhen'> {
  readonly qty: string | null
  readonly allowedWhen: AlternateUse
}

const alternateOf = (row: AlternateRow): AlternateRecord => ({ ...row, qty: row.qty === null ? null : text(row.qty) })

/** The alternates of a revision (or of one of its lines), line by line, first choice first. */
export async function readAlternates(db: Reader, revisionId: string, lineId?: string): Promise<AlternateRecord[]> {
  const rows = await db.bomLineAlternate.findMany({
    where: { revisionId, ...(lineId === undefined ? {} : { bomLineId: lineId }) },
    select: ALTERNATE_COLUMNS,
    orderBy: [{ bomLineId: 'asc' }, { priority: 'asc' }],
  })
  return rows.map(alternateOf)
}

const ITEM_COLUMNS = {
  id: true,
  code: true,
  name: true,
  kind: true,
  status: true,
  approval: true,
  approvalNote: true,
  isPpeComponent: true,
  companyId: true,
  tracking: true,
  baseUom: true,
  purchaseUom: true,
  purchaseFactor: true,
  consumptionUom: true,
  consumptionFactor: true,
} as const satisfies Prisma.ItemSelect
type ItemRow = Prisma.ItemGetPayload<{ select: typeof ITEM_COLUMNS }>

/** A material as these routes read it: the alternate rules' facts, its name and tracking, its colours with their names. */
export interface ItemFacts extends AlternateMaterial {
  readonly name: string
  readonly tracking: ItemRow['tracking']
  readonly colours: readonly { readonly id: string; readonly code: string; readonly name: string; readonly status: 'ACTIVE' | 'ARCHIVED' }[]
}

/** The materials named (by id; one not found is left out), with every colour of each. */
export async function readItems(db: Reader, itemIds: readonly string[]): Promise<Map<string, ItemFacts>> {
  const ids = [...new Set(itemIds)]
  if (ids.length === 0) return new Map()
  const rows = await db.item.findMany({ where: { id: { in: ids } }, select: ITEM_COLUMNS })
  const colours = await db.itemColour.findMany({ where: { itemId: { in: ids } }, select: { id: true, itemId: true, code: true, name: true, status: true }, orderBy: { code: 'asc' } })
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        code: row.code,
        name: row.name,
        kind: row.kind,
        status: row.status,
        approval: row.approval as MaterialApproval,
        approvalNote: row.approvalNote,
        isPpeComponent: row.isPpeComponent,
        companyId: row.companyId,
        tracking: row.tracking,
        units: { baseUom: row.baseUom, purchaseUom: row.purchaseUom, purchaseFactor: text(row.purchaseFactor), consumptionUom: row.consumptionUom, consumptionFactor: text(row.consumptionFactor) },
        colours: colours.filter((colour) => colour.itemId === row.id).map((colour) => ({ id: colour.id, code: colour.code, name: colour.name, status: colour.status })),
      },
    ]),
  )
}

/** A party as these routes read it. */
export interface PartyFacts {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly roles: readonly string[]
  readonly status: string
  readonly companyId: string | null
}

/** The parties named (by id; one not found is left out); FOR SHARE when `lock` (not archived or its roles changed under a write). */
export async function readParties(db: Reader, partyIds: readonly (string | null)[], lock = false): Promise<Map<string, PartyFacts>> {
  const ids = [...new Set(partyIds.filter((id): id is string => id !== null && isUuid(id)))].sort()
  if (ids.length === 0) return new Map()
  if (lock) await (db as CommandTx).$queryRaw`SELECT "id" FROM "Party" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR SHARE`
  const rows = await db.party.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, legalName: true, tradeName: true, roles: true, status: true, companyId: true } })
  return new Map(rows.map((row) => [row.id, { id: row.id, code: row.code, name: row.tradeName ?? row.legalName, roles: row.roles, status: row.status, companyId: row.companyId }]))
}

/** A line and its material, as the alternate rules read them. */
export const alternateLineOf = (line: Pick<DepthLine, 'seq' | 'itemId' | 'uom'>, material: Pick<ItemFacts, 'code' | 'isPpeComponent'> | undefined): AlternateLine => ({
  seq: line.seq,
  itemId: line.itemId,
  uom: line.uom as Uom,
  material: { code: material?.code ?? '?', isPpeComponent: material?.isPpeComponent ?? false },
})

// ---- the view -----------------------------------------------------------------------------------------------------------

/** Everything the depth view shows, read with one client. */
export interface LoadedDepth {
  readonly style: BomStyleRow
  readonly ppe: boolean
  readonly revision: RevisionRow
  readonly output: { readonly outputQuantity: number; readonly outputUom: Uom }
  readonly lines: readonly DepthLine[]
  readonly alternates: readonly AlternateRecord[]
  readonly items: ReadonlyMap<string, ItemFacts>
  readonly parties: ReadonlyMap<string, PartyFacts>
  readonly steps: readonly StepRecord[]
  /** The certificate covering each PPE component alternate today, by material. */
  readonly certificates: ReadonlyMap<string, { id: string; number: string; standard: string; validTo: string } | null>
}

export async function loadDepth(db: Reader, style: BomStyleRow, revision: RevisionRow): Promise<LoadedDepth> {
  const lines = await readDepthLines(db, revision.id)
  const alternates = await readAlternates(db, revision.id)
  const items = await readItems(db, [...lines.map((line) => line.itemId), ...alternates.map((alternate) => alternate.itemId)])
  const parties = await readParties(db, lines.flatMap((line) => [line.supplierId, line.customerSuppliedByPartyId]))
  const steps = await readSteps(db, revision.id)
  const facts = await db.styleRevision.findUniqueOrThrow({ where: { id: revision.id }, select: { outputQuantity: true, outputUom: true } })
  const ppe = (await db.style.findUniqueOrThrow({ where: { id: style.id }, select: { ppeCategory: true } })).ppeCategory !== 'NOT_PPE'
  const today = businessDate(serverClock.now())
  const certificates = new Map<string, { id: string; number: string; standard: string; validTo: string } | null>()
  for (const itemId of [...new Set(alternates.map((alternate) => alternate.itemId))].sort()) {
    if (items.get(itemId)?.isPpeComponent) certificates.set(itemId, await coveringCertificate(db, itemId, style.companyId, today))
  }
  return { style, ppe, revision, output: { outputQuantity: facts.outputQuantity, outputUom: facts.outputUom }, lines, alternates, items, parties, steps, certificates }
}

/**
 * The certificate in the register that covers a PPE component today (as quality/lab's `certificateCovering` reads it for a
 * lot): VALID, its validity holding today, an ACTIVE coverage of the item; one a brand or supplier holds (no company), or the
 * style's company's own (a tenant-wide style: only the former). The one valid longest.
 */
async function coveringCertificate(db: Reader, itemId: string, companyId: string | null, today: BusinessDate) {
  const day = new Date(`${today}T00:00:00.000Z`)
  const rows = await db.certificateCoverage.findMany({
    where: { itemId, status: 'ACTIVE', certificate: { status: 'VALID', validFrom: { lte: day }, validTo: { gte: day }, OR: companyId === null ? [{ companyId: null }] : [{ companyId: null }, { companyId }] } },
    select: { certificate: { select: { id: true, number: true, standard: true, validTo: true } } },
  })
  const best = rows.map((row) => row.certificate).sort((a, b) => b.validTo.getTime() - a.validTo.getTime() || (a.id < b.id ? -1 : 1))[0]
  return best ? { id: best.id, number: best.number, standard: best.standard, validTo: best.validTo.toISOString().slice(0, 10) } : null
}

const partyRefOf = (party: PartyFacts | undefined, id: string) => ({ id, code: party?.code ?? '?', name: party?.name ?? '' })

/** The lines of one revision in depth, the output, the kit and what each customer sends. */
export function depthViewOf(loaded: LoadedDepth): BomDepthView {
  const { style, revision, items, parties } = loaded
  const itemRef = (itemId: string) => {
    const item = items.get(itemId)
    return {
      id: itemId,
      code: item?.code ?? '?',
      name: item?.name ?? '',
      kind: (item?.kind ?? 'COMPONENT') as BomDepthView['lines'][number]['item']['kind'],
      status: item?.status ?? 'ARCHIVED',
      approval: item?.approval ?? 'PENDING',
      isPpeComponent: item?.isPpeComponent ?? false,
      tracking: item?.tracking ?? 'NONE',
      baseUom: item?.units.baseUom ?? 'PCS',
    }
  }
  const alternateViewOf = (line: DepthLine, alternate: AlternateRecord): AlternateView => {
    const item = items.get(alternate.itemId)
    const colour = alternate.itemColourId === null ? null : item?.colours.find((entry) => entry.id === alternate.itemColourId)
    const required = item ? certificateCheckRequired(alternateLineOf(line, items.get(line.itemId)), item) : false
    return {
      id: alternate.id,
      priority: alternate.priority,
      item: itemRef(alternate.itemId),
      itemColour: alternate.itemColourId === null ? null : { id: alternate.itemColourId, code: colour?.code ?? '', name: colour?.name ?? '', status: colour?.status ?? 'ARCHIVED' },
      qty: alternate.qty,
      allowedWhen: alternate.allowedWhen,
      certificateCheck: alternate.certificateCheck,
      certificateRequired: required,
      certificate: item?.isPpeComponent ? (loaded.certificates.get(alternate.itemId) ?? null) : null,
      needs: alternateUse({
        priority: alternate.priority,
        code: item?.code ?? '?',
        allowedWhen: alternate.allowedWhen,
        certificateCheck: alternate.certificateCheck,
        ownShort: false,
        approved: false,
        certificateChecked: false,
      }).held,
      note: alternate.note,
      createdAt: toUtcIso(alternate.createdAt),
      updatedAt: toUtcIso(alternate.updatedAt),
    }
  }
  const stepOf = (routingSeq: number | null) => {
    const step = routingSeq === null ? undefined : loaded.steps.find((entry) => entry.seq === routingSeq)
    return step ? { seq: step.seq, code: step.code, name: step.name } : null
  }
  const cut = (line: DepthLine) => items.get(line.itemId)?.tracking === 'HIDE'
  const lines = loaded.lines.map((line) => ({
    id: line.id,
    seq: line.seq,
    item: itemRef(line.itemId),
    placement: line.placement,
    qty: line.qty,
    uom: line.uom,
    supplier: line.supplierId === null ? null : partyRefOf(parties.get(line.supplierId), line.supplierId),
    customerSupplied: line.customerSuppliedByPartyId === null ? null : partyRefOf(parties.get(line.customerSuppliedByPartyId), line.customerSuppliedByPartyId),
    issueToSubcontract: line.issueToSubcontract,
    kit: line.issueToSubcontract ? (cut(line) ? ('CUT' as const) : ('KIT' as const)) : null,
    routingStep: stepOf(line.routingSeq),
    subAssembly: line.subAssemblyRevisionId !== null,
    alternates: loaded.alternates.filter((alternate) => alternate.bomLineId === line.id).map((alternate) => alternateViewOf(line, alternate)),
  }))
  // The kit from this revision for an order that sends every step (a step-bound line goes only with its step).
  const plan = kitPlan(loaded.lines, new Set(loaded.lines.flatMap((line) => (line.routingSeq === null ? [] : [line.routingSeq]))))
  const kitLines = loaded.lines.filter((line) => plan.lineIds.has(line.id))
  const customers = new Map<string, string[]>()
  for (const line of loaded.lines) if (line.customerSuppliedByPartyId) customers.set(line.customerSuppliedByPartyId, [...(customers.get(line.customerSuppliedByPartyId) ?? []), line.id])
  return {
    revision: { id: revision.id, styleId: revision.styleId, revision: revision.revision, status: revision.status, version: revision.version },
    style: { id: style.id, code: style.code, name: style.name, companyId: style.companyId, status: style.status, ppe: loaded.ppe },
    editable: revision.status === 'DRAFT' && style.status !== 'ARCHIVED',
    output: { quantity: loaded.output.outputQuantity, uom: loaded.output.outputUom },
    lines,
    kit: { from: plan.from, lineIds: kitLines.filter((line) => !cut(line)).map((line) => line.id), cutLineIds: kitLines.filter(cut).map((line) => line.id) },
    customers: [...customers].map(([partyId, lineIds]) => ({ party: partyRefOf(parties.get(partyId), partyId), lineIds })).sort((a, b) => a.party.code.localeCompare(b.party.code)),
    counts: {
      lines: lines.length,
      alternates: loaded.alternates.length,
      customerSupplied: loaded.lines.filter((line) => line.customerSuppliedByPartyId !== null).length,
      forWorkshop: loaded.lines.filter((line) => line.issueToSubcontract).length,
    },
  }
}

/** The depth view as the command left it (its answer). */
export async function depthInTx(tools: Pick<CommandTools, 'tx'>, styleId: string, revisionId: string): Promise<BomDepthView> {
  const style = await tools.tx.style.findUniqueOrThrow({ where: { id: styleId }, select: STYLE_COLUMNS })
  return depthViewOf(await loadDepth(tools.tx, style, await findRevision(tools.tx, styleId, revisionId)))
}

// ---- writes ---------------------------------------------------------------------------------------------------------------

/** An audit row on the revision and W1's `style.bom_changed` with the lines changed (B-W2b-228's part of the BOM). */
export function recordChange(tools: CommandTools, draft: LockedDraft, lineIds: readonly string[], change: Record<string, unknown>): void {
  const { style } = draft
  tools.audit({ recordType: 'StyleRevision', recordId: draft.revisionId, companyId: style.companyId, after: { bom: change, version: draft.version } })
  tools.emit({
    type: 'style.bom_changed',
    subject: style.id,
    companyId: style.companyId,
    payload: { styleId: style.id, code: style.code, revisionId: draft.revisionId, revision: draft.revision, lineIds: [...lineIds] },
  })
}

export const invalid = (issues: readonly Issue[], what = 'BOM line'): ValidationError => new ValidationError(`The ${what} is not valid.`, issues)
export const prefixed = (issues: readonly Issue[], at = 'body'): Issue[] => issues.map((issue) => ({ path: `${at}/${issue.path}`, message: issue.message }))

/**
 * A database refusal never reaches a person as a 500: B-W2b-211's guards ("product: …", check_violation; a frozen part,
 * restrict_violation) become a 409 in their words, a unique violation (two alternates of one line at one priority, written
 * at the same time) a 409 too. Every rule is said in words before the write; this is the net under them.
 */
export async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    const known = error as { code?: unknown; meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null
    const cause = known?.meta?.driverAdapterError?.cause
    if ((cause?.originalCode === '23514' || cause?.originalCode === '23001') && typeof cause.originalMessage === 'string' && cause.originalMessage.startsWith('product: ')) {
      const words = cause.originalMessage.slice('product: '.length)
      throw new ConflictError(`${words.charAt(0).toUpperCase()}${words.slice(1)}. Load the BOM again.`)
    }
    if (known?.code === 'P2002' || cause?.originalCode === '23505') throw new ConflictError('Another change to this line was saved at the same time: load the BOM again.')
    throw error
  }
}

// ---- for other modules ----------------------------------------------------------------------------------------------------

/**
 * A customer's material has no cost and is not bought (PRD-084): the lines of a revision without those the customer sends.
 * Costing (costing/store.ts) and planning's demand (planning/store.ts) read the revision's lines through it.
 */
export async function withoutCustomerSupplied<Line extends { readonly id: string }>(db: Reader, revisionId: string, lines: readonly Line[]): Promise<Line[]> {
  const sent = await db.bomLine.findMany({ where: { revisionId, customerSuppliedByPartyId: { not: null } }, select: { id: true } })
  if (sent.length === 0) return [...lines]
  const ids = new Set(sent.map((row) => row.id))
  return lines.filter((line) => !ids.has(line.id))
}
