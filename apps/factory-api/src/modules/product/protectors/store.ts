import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { MaterialApproval } from '@nexus/factory-domain/product/bom-structure/rules'
import { editRefusal as ruleRefusal } from '@nexus/factory-domain/product/lifecycle/rules'
import type { PlacementView, ProtectorPlacementView } from '@nexus/factory-domain/product/protectors/contracts'
import {
  placementEditRefusal,
  placementFindings,
  placementWords,
  type BomProtectorLine,
  type CertificateFacts,
  type PlacementFacts,
  type ProtectorFacts,
  type ProtectorLevel,
  type ProtectorPocket,
} from '@nexus/factory-domain/product/protectors/rules'
import type { CommandTools, CommandTx } from '../../../core/command'
import { findRevision, lockStyleRow, revisionViewOf, STYLE_COLUMNS, type BomStyleRow, type LockedStyle, type RevisionRow } from '../bom/store'
import { editRuleOf, requireEditRule } from '../lifecycle/edit-rule'

/**
 * Protector placement's rows (factory-db `ProtectorPlacement`, B-W2b-210) and what they are checked against (`Item` PROTECTOR
 * materials and their properties, the revision's `BomLine`s and `BomLineSize`s, `Certificate` + `CertificateCoverage` of the
 * protector and of the style): the columns every read names (no relation selects: inside a transaction Prisma sends them at
 * once on its one connection), the section's view with its findings, and the lock every write takes.
 *
 * Lock order of a write (the BOM's, B-W1-13; the spec's, B-W2b-224): the style row FOR UPDATE, the revision checked a DRAFT
 * of this style and the style not archived (409 in words), the edit rule of the style's state (B-W2b-221, kind DRAFT),
 * then the placement rows. W1's part rule (…_product_guards) takes the revision FOR SHARE meanwhile and refuses any write to
 * a released revision whatever reaches it.
 */

export const PLACEMENT_COLUMNS = {
  id: true,
  styleId: true,
  revisionId: true,
  seq: true,
  pocket: true,
  protectorItemId: true,
  standard: true,
  level: true,
  sizes: true,
  positionNote: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.ProtectorPlacementSelect
export type PlacementRow = Prisma.ProtectorPlacementGetPayload<{ select: typeof PLACEMENT_COLUMNS }>

const ITEM_COLUMNS = { id: true, code: true, name: true, kind: true, approval: true, properties: true, companyId: true, status: true } as const satisfies Prisma.ItemSelect
type ItemRow = Prisma.ItemGetPayload<{ select: typeof ITEM_COLUMNS }>

type Client = FactoryClient | CommandTx

/** A material's protector properties (B-W2b-206: { standard, type, level, size }), read loosely: a text or nothing. */
function propertyOf(properties: Prisma.JsonValue | null, key: 'standard' | 'level'): string | null {
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null
  const value = (properties as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export const protectorFactsOf = (row: ItemRow): ProtectorFacts => ({
  id: row.id,
  code: row.code,
  name: row.name,
  kind: String(row.kind),
  approval: row.approval as MaterialApproval,
  standard: propertyOf(row.properties, 'standard'),
  level: propertyOf(row.properties, 'level'),
})

export async function readItems(client: Client, ids: readonly string[]): Promise<Map<string, ItemRow>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = await client.item.findMany({ where: { id: { in: unique } }, select: ITEM_COLUMNS })
  return new Map(rows.map((row) => [row.id, row]))
}

/** A material a pocket may take now: a PROTECTOR of the style's company or every company, active, not blocked. */
export const mayChoose = (row: ItemRow, companyId: string | null): boolean =>
  String(row.kind) === 'PROTECTOR' && row.status === 'ACTIVE' && row.approval !== 'BLOCKED' && (row.companyId === null || row.companyId === companyId)

export const readPlacements = (client: Client, revisionId: string): Promise<PlacementRow[]> =>
  client.protectorPlacement.findMany({ where: { revisionId }, select: PLACEMENT_COLUMNS, orderBy: { seq: 'asc' } })

export const placementFactsOf = (row: PlacementRow): PlacementFacts => ({
  id: row.id,
  seq: row.seq,
  pocket: row.pocket as ProtectorPocket,
  protectorItemId: row.protectorItemId,
  standard: row.standard,
  level: row.level,
  sizes: [...row.sizes],
})

/** The PROTECTOR lines of the revision's BOM, with their quantities per size. */
async function bomProtectorLines(client: Client, revisionId: string): Promise<{ lines: BomProtectorLine[]; itemIds: string[] }> {
  const lines = await client.bomLine.findMany({ where: { revisionId }, select: { id: true, seq: true, itemId: true, sizeDependent: true, qty: true }, orderBy: { seq: 'asc' } })
  const items = await readItems(
    client,
    lines.map((line) => line.itemId),
  )
  const protectorLines = lines.filter((line) => String(items.get(line.itemId)?.kind) === 'PROTECTOR')
  const sizes = protectorLines.some((line) => line.sizeDependent)
    ? await client.bomLineSize.findMany({ where: { revisionId, bomLineId: { in: protectorLines.map((line) => line.id) } }, select: { bomLineId: true, size: true, qty: true } })
    : []
  return {
    lines: protectorLines.map((line) => ({
      seq: line.seq,
      itemId: line.itemId,
      sizeDependent: line.sizeDependent,
      qty: line.qty.toString(),
      sizes: sizes.filter((entry) => entry.bomLineId === line.id).map((entry) => ({ size: entry.size, qty: entry.qty.toString() })),
    })),
    itemIds: [...new Set(protectorLines.map((line) => line.itemId))],
  }
}

const levelsOf = (value: Prisma.JsonValue | null): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null)

/** The VALID certificates whose ACTIVE coverage names these materials (by material) and this style. */
async function certificatesOf(client: Client, styleId: string, itemIds: readonly string[]): Promise<{ items: Map<string, CertificateFacts[]>; style: CertificateFacts[] }> {
  const coverage = await client.certificateCoverage.findMany({
    where: { status: 'ACTIVE', OR: [{ styleId }, ...(itemIds.length > 0 ? [{ itemId: { in: [...itemIds] } }] : [])] },
    select: { certificateId: true, styleId: true, itemId: true, sizes: true },
  })
  const certificateIds = [...new Set(coverage.map((row) => row.certificateId))]
  const certificates =
    certificateIds.length === 0
      ? []
      : await client.certificate.findMany({ where: { id: { in: certificateIds }, status: 'VALID' }, select: { id: true, number: true, standard: true, ppeClass: true, performanceLevels: true }, orderBy: { number: 'asc' } })
  const byId = new Map(certificates.map((row) => [row.id, row]))
  const items = new Map<string, CertificateFacts[]>()
  const style: CertificateFacts[] = []
  for (const row of coverage) {
    const certificate = byId.get(row.certificateId)
    if (!certificate) continue
    const facts: CertificateFacts = { number: certificate.number, standard: certificate.standard, ppeClass: certificate.ppeClass, performanceLevels: levelsOf(certificate.performanceLevels), sizes: row.itemId ? [] : [...row.sizes] }
    if (row.itemId) items.set(row.itemId, [...(items.get(row.itemId) ?? []), facts])
    else style.push(facts)
  }
  return { items, style }
}

export function placementViewOf(row: PlacementRow, item: ItemRow | undefined): PlacementView {
  const facts = item ? protectorFactsOf(item) : null
  return {
    id: row.id,
    seq: row.seq,
    pocket: row.pocket as ProtectorPocket,
    protector: { id: row.protectorItemId, code: facts?.code ?? '', name: facts?.name ?? '', approval: facts?.approval ?? 'PENDING', standard: facts?.standard ?? null, level: facts?.level ?? null },
    standard: row.standard,
    level: row.level as ProtectorLevel,
    sizes: [...row.sizes],
    positionNote: row.positionNote,
    version: row.version,
    updatedAt: toUtcIso(row.updatedAt),
  }
}

/** Why the list cannot change now, in words: the revision or the style (W1's words), then the style's edit rule (B-W2b-221). */
export async function refusalOf(client: Client, style: Pick<BomStyleRow, 'id' | 'status'>, revision: RevisionRow): Promise<string | null> {
  const own = placementEditRefusal(revision, style.status)
  if (own) return own
  const { rule, facts } = await editRuleOf(client, style.id)
  return ruleRefusal(rule, 'DRAFT', facts)?.message ?? null
}

/** The section: the placements in order, what to look at, the protectors a pocket may take, whether it can change now. */
export async function placementView(client: Client, style: BomStyleRow, revision: RevisionRow): Promise<ProtectorPlacementView> {
  const rows = await readPlacements(client, revision.id)
  const bom = await bomProtectorLines(client, revision.id)
  const candidates = await client.item.findMany({ where: { kind: 'PROTECTOR', status: 'ACTIVE', approval: { not: 'BLOCKED' }, OR: [{ companyId: null }, ...(style.companyId ? [{ companyId: style.companyId }] : [])] }, select: ITEM_COLUMNS, orderBy: { code: 'asc' }, take: 200 })
  const named = await readItems(client, [...rows.map((row) => row.protectorItemId), ...bom.itemIds])
  for (const row of candidates) named.set(row.id, row)
  const certificates = await certificatesOf(client, style.id, [...new Set([...rows.map((row) => row.protectorItemId), ...bom.itemIds])])
  const protectors = new Map([...named.values()].map((row) => [row.id, protectorFactsOf(row)]))
  const placements = rows.map(placementFactsOf)
  const findings = placementFindings({ range: style.sizes, placements, protectors, bomLines: bom.lines, itemCertificates: certificates.items, styleCertificates: certificates.style })
  const refusal = await refusalOf(client, style, revision)
  const inBom = new Set(bom.itemIds)
  return {
    revision: revisionViewOf(revision),
    style: { id: style.id, code: style.code, name: style.name, companyId: style.companyId, status: style.status, sizes: [...style.sizes] },
    placements: rows.map((row) => placementViewOf(row, named.get(row.protectorItemId))),
    findings: findings.map((finding) => ({ ...finding, sizes: [...finding.sizes], params: { ...finding.params } })),
    choices: candidates.map((row) => {
      const facts = protectorFactsOf(row)
      return { id: facts.id, code: facts.code, name: facts.name, approval: facts.approval, standard: facts.standard, level: facts.level, inBom: inBom.has(row.id) }
    }),
    editable: refusal === null,
    refusal,
    words: placementWords(placements, findings),
  }
}

/** The section as the command left it (its answer). */
export async function placementViewInTx(tx: CommandTx, styleId: string, revisionId: string): Promise<ProtectorPlacementView> {
  const style = await tx.style.findUnique({ where: { id: styleId }, select: STYLE_COLUMNS })
  if (!style) throw new NotFoundError('Style not found.')
  return placementView(tx, style, await findRevision(tx, styleId, revisionId))
}

export interface LockedPlacements {
  readonly style: LockedStyle & { readonly sizes: readonly string[] }
  readonly revision: RevisionRow
}

/** The first step of every write: the style row locked, the revision a DRAFT of this style, the edit rule asked (DRAFT). */
export async function lockPlacements(tools: CommandTools, styleId: string, revisionId: string): Promise<LockedPlacements> {
  const { tx } = tools
  const locked = await lockStyleRow(tx, styleId)
  const revision = await findRevision(tx, styleId, revisionId)
  const refusal = placementEditRefusal(revision, locked.status)
  if (refusal) throw new InvalidStateError(refusal)
  await requireEditRule(tx, styleId, 'DRAFT')
  const style = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: { sizes: true } })
  return { style: { ...locked, sizes: style.sizes }, revision }
}

export const prefixed = (issues: readonly Issue[], at = 'body'): Issue[] => issues.map((issue) => ({ path: `${at}/${issue.path}`, message: issue.message }))
export const invalid = (issues: readonly Issue[]): ValidationError => new ValidationError(issues.length === 1 ? issues[0]!.message : 'The protector placement is not valid.', issues)

/**
 * The last net (the lead: "a database refusal never reaches a person as a 500"): a refusal of the …_sizes_measures_w2b_guards
 * or W1 part triggers (check_violation 'product: …') that the checks before did not foresee (a race), or the place taken
 * meanwhile, is a 409 in words. Anything else is thrown as it is.
 */
export async function placementsGuarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    const known = error as { code?: unknown; meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null
    const cause = known?.meta?.driverAdapterError?.cause
    if ((cause?.originalCode === '23514' || cause?.originalCode === 'P0001') && typeof cause.originalMessage === 'string' && cause.originalMessage.startsWith('product: ')) {
      const words = cause.originalMessage.slice('product: '.length)
      throw new ConflictError(`${words.charAt(0).toUpperCase()}${words.slice(1)}. Load the protector placement again.`)
    }
    if (known?.code === 'P2002' || cause?.originalCode === '23505') throw new ConflictError('Someone changed this protector placement at the same time: load it again.')
    throw error
  }
}
