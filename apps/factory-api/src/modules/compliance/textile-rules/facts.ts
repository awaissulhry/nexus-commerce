import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { careOf, compositionOf, layoutOf } from '@nexus/factory-domain/compliance/labels/rules'
import type { LineFacts, MaterialFacts } from '@nexus/factory-domain/compliance/textile-rules/composition'
import type { LeatherMaterial } from '@nexus/factory-domain/compliance/textile-rules/leather'
import type { PlaceFacts, StepFacts } from '@nexus/factory-domain/compliance/textile-rules/origin'
import type { ColourwayLines, LabelFacts } from '@nexus/factory-domain/compliance/textile-rules/rules'
import type { Uom } from '@nexus/factory-domain/product/units/units'
import type { CommandTx } from '../../../core/command'

/**
 * The facts the textile, leather and origin checks read (B-W2b-208), from W1 data only: a style revision's BOM lines in
 * one size with their materials, per colourway; the label the revision names; the routing steps with their workshops; the
 * plants of the style's company. One query after another (one connection runs one query at a time). Shared by the office's
 * checks (./read.ts) and the customer's catalogue (modules/sales/portal-ordering/composition.ts).
 */

export type Reader = FactoryClient | CommandTx

const ITEM_SELECT = {
  id: true,
  code: true,
  name: true,
  nameI18n: true,
  kind: true,
  composition: true,
  animalOrigin: true,
  attributes: true,
  finish: true,
  baseUom: true,
  purchaseUom: true,
  purchaseFactor: true,
  consumptionUom: true,
  consumptionFactor: true,
} as const satisfies Prisma.ItemSelect
type ItemRow = Prisma.ItemGetPayload<{ select: typeof ITEM_SELECT }>

const textRecord = (value: unknown): Record<string, string> | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  return Object.fromEntries(entries)
}

const materialOf = (row: ItemRow): MaterialFacts => ({
  id: row.id,
  code: row.code,
  name: row.name,
  kind: row.kind,
  composition: row.composition,
  animalOrigin: row.animalOrigin,
  attributes: textRecord(row.attributes),
  units: {
    baseUom: row.baseUom as Uom,
    purchaseUom: row.purchaseUom as Uom,
    purchaseFactor: row.purchaseFactor.toFixed(),
    consumptionUom: row.consumptionUom as Uom,
    consumptionFactor: row.consumptionFactor.toFixed(),
  },
})

const leatherOf = (row: ItemRow): LeatherMaterial => ({ code: row.code, name: row.name, nameI18n: textRecord(row.nameI18n), kind: row.kind, animalOrigin: row.animalOrigin, finish: row.finish })

export interface RevisionLines {
  /** The lines per colourway (one set without colourways when the style has none active). */
  readonly colourways: readonly ColourwayLines[]
  /** Every material of the revision's BOM, for the leather names. */
  readonly materials: readonly LeatherMaterial[]
}

/**
 * The revision's BOM in one size (`size` null: every line's own quantity), per ACTIVE colourway of the style (`only`:
 * those colourways; a line of another colourway is left out of each). The quantity is per garment, without wastage.
 */
export async function revisionLines(db: Reader, input: { readonly styleId: string; readonly revisionId: string; readonly size: string | null; readonly only?: readonly string[] }): Promise<RevisionLines> {
  const lines = await db.bomLine.findMany({
    where: { revisionId: input.revisionId },
    select: { id: true, seq: true, placement: true, qty: true, uom: true, sizeDependent: true, colourwayId: true, itemId: true },
    orderBy: { seq: 'asc' },
  })
  const sized = input.size === null || !lines.some((line) => line.sizeDependent)
    ? []
    : await db.bomLineSize.findMany({ where: { revisionId: input.revisionId, size: input.size, bomLineId: { in: lines.filter((line) => line.sizeDependent).map((line) => line.id) } }, select: { bomLineId: true, qty: true } })
  const items = lines.length === 0 ? [] : await db.item.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.itemId))] } }, select: ITEM_SELECT })
  const byId = new Map(items.map((item) => [item.id, item]))
  const colourways = await db.colourway.findMany({
    where: { styleId: input.styleId, status: 'ACTIVE', ...(input.only ? { id: { in: [...input.only] } } : {}) },
    select: { id: true, code: true },
    orderBy: { code: 'asc' },
  })
  const factsOf = (line: (typeof lines)[number]): LineFacts => {
    const sizeRow = sized.find((row) => row.bomLineId === line.id)
    const qty = !line.sizeDependent || input.size === null ? line.qty.toFixed() : sizeRow ? sizeRow.qty.toFixed() : null
    return { seq: line.seq, placement: line.placement, qty, uom: line.uom as Uom, material: materialOf(byId.get(line.itemId)!) }
  }
  const sets: ColourwayLines[] =
    colourways.length === 0
      ? [{ colourway: null, lines: lines.filter((line) => line.colourwayId === null).map(factsOf) }]
      : colourways.map((colourway) => ({ colourway: colourway.code, lines: lines.filter((line) => line.colourwayId === null || line.colourwayId === colourway.id).map(factsOf) }))
  return { colourways: sets, materials: items.sort((a, b) => a.code.localeCompare(b.code)).map(leatherOf) }
}

const LABEL_SELECT = { id: true, code: true, revision: true, status: true, languages: true, composition: true, animalOriginPhrase: true, care: true, layout: true } as const satisfies Prisma.LabelTemplateSelect

export interface LabelOf {
  readonly id: string
  readonly facts: LabelFacts
}

/** The label template a revision names, as the checks read it; null when it names none. */
export async function labelOf(db: Reader, labelTemplateId: string | null): Promise<LabelOf | null> {
  if (labelTemplateId === null) return null
  const row = await db.labelTemplate.findUnique({ where: { id: labelTemplateId }, select: LABEL_SELECT })
  if (!row) return null
  return {
    id: row.id,
    facts: {
      code: row.code,
      revision: row.revision,
      status: row.status,
      languages: row.languages,
      composition: compositionOf(row.composition).composition,
      animalOriginPhrase: row.animalOriginPhrase,
      care: careOf(row.care).care,
      layout: layoutOf(row.layout).layout,
    },
  }
}

const countryOf = (address: unknown): string | null => {
  const country = textRecord(address)?.country
  return typeof country === 'string' && /^[A-Z]{2}$/.test(country.trim().toUpperCase()) ? country.trim().toUpperCase() : null
}

/** The routing steps of a revision with the workshop of each subcontracted one (where it receives the pieces). */
export async function routingSteps(db: Reader, revisionId: string): Promise<StepFacts[]> {
  const steps = await db.routingOperation.findMany({ where: { revisionId }, select: { seq: true, code: true, name: true, workCentreKind: true, supplierId: true }, orderBy: { seq: 'asc' } })
  const workshopIds = [...new Set(steps.flatMap((step) => (step.supplierId ? [step.supplierId] : [])))]
  const parties = workshopIds.length === 0 ? [] : await db.party.findMany({ where: { id: { in: workshopIds } }, select: { id: true, code: true, legalName: true, tradeName: true, country: true } })
  const addresses = workshopIds.length === 0 ? [] : await db.partyAddress.findMany({ where: { partyId: { in: workshopIds }, isDefaultShipTo: true, status: 'ACTIVE' }, select: { partyId: true, country: true } })
  const places = new Map<string, PlaceFacts>(
    parties.map((party) => [party.id, { code: party.code, name: party.tradeName ?? party.legalName, country: addresses.find((address) => address.partyId === party.id)?.country ?? party.country }]),
  )
  return steps.map((step) => ({
    seq: step.seq,
    code: step.code,
    name: step.name,
    workCentreKind: step.workCentreKind,
    workshop: step.supplierId ? (places.get(step.supplierId) ?? { code: '?', name: 'an unknown workshop', country: null }) : null,
  }))
}

/** The ACTIVE plants of the company (null: of every company), or the one site asked; with their country. */
export async function plantsOf(db: Reader, companyId: string | null, siteId: string | null): Promise<PlaceFacts[]> {
  const sites = await db.site.findMany({
    where: siteId === null ? { kind: 'PLANT', status: 'ACTIVE', ...(companyId === null ? {} : { companyId }) } : { id: siteId },
    select: { code: true, name: true, address: true },
    orderBy: { code: 'asc' },
  })
  return sites.map((site) => ({ code: site.code, name: site.name, country: countryOf(site.address) }))
}
