import type { FactoryClient } from '@nexus/factory-db'
import { FILES_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import type { GateCover, PpeCategory, SizeGateRequest } from '@nexus/factory-domain/compliance/cert-gate/gate'
import { can, holds, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { costingCurrency } from '@nexus/factory-domain/costing/inputs'
import { COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { exactCell, prepareSheet, shownCost } from '@nexus/factory-domain/costing/sheet'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { checkedCells, coverageCell, coverageCounts, type CoverageCell } from '@nexus/factory-domain/product/compliance/rules'
import { STYLE_COMPLIANCE_VIEW } from '@nexus/factory-domain/product/compliance/permissions'
import type { RowCost, RowCoverage, StyleRow } from '@nexus/factory-domain/product/styles/contracts'
import type { CommandTx } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { dayOf } from '../../compliance/certificates/certificates'
import { loadCostFacts, type CostingCompany } from '../../costing/store'
import { REVISION_COLUMNS as COST_REVISION_COLUMNS, type RevisionRow } from '../bom/store'
import { todayOf } from '../compliance/read'
import type { StyleRowData } from './store'

/**
 * What a style list row shows beside the style (B-W2b-25; design products.styles `styles.grid` columns Thumbnail,
 * Certificate coverage, Cost per garment, and the phone card "thumbnail, coverage mark, cost"; the B-W2a-37 gap): read
 * for one page of rows, each part only for a caller who may see it over the style's company.
 *
 *   thumbnail  the style's first picture: its oldest AVAILABLE image file (StoredFile of the Style, kind PHOTO or
 *              ATTACHMENT, content type image/*), with files.read over the file's company; the gallery (W2b-4) will name
 *              a main picture.
 *   coverage   the certificate coverage as the style's Compliance tab counts it (factory-domain product/compliance
 *              `coverageCell`, `checkedCells`, `coverageCounts`: the same gate on the same rows, today in Europe/Rome),
 *              with compliance.certificates.view.
 *   cost       what one garment costs on the cost sheet (modules/costing `loadCostFacts`, factory-domain costing/sheet):
 *              the RELEASED revision, else the newest DRAFT (an estimate); the base size, else the range's first; the
 *              lowest and highest of the active colourways whose garment has every input. Only with costing.view AND the
 *              cost grain (the grain filter drops the field for everyone else; it is not even computed for them). A
 *              tenant-wide style is costed for the list's company filter, else for none (the default currency), as the
 *              cost sheet does without a company.
 *
 * Reads only, with the request's client: one query per kind for the page (coverage, pictures), and the cost sheet's
 * reads per costed row.
 */

type Reader = FactoryClient | CommandTx

export interface RowExtras {
  readonly thumbnail: StyleRow['thumbnail']
  readonly coverage: RowCoverage | null
  readonly cost: StyleRow['cost']
}

const NONE: RowExtras = { thumbnail: null, coverage: null, cost: asMoney('cost', null) }

// ---- thumbnails ---------------------------------------------------------------------------------------------------------

async function thumbnails(client: Reader, actor: Actor, styleIds: readonly string[]): Promise<Map<string, NonNullable<StyleRow['thumbnail']>>> {
  const out = new Map<string, NonNullable<StyleRow['thumbnail']>>()
  if (styleIds.length === 0 || !holds(actor, FILES_READ)) return out
  const rows = await client.storedFile.findMany({
    where: {
      AND: [
        scopeWhere(actor, FILES_READ, { company: { field: 'companyId', nullable: true } }) as object,
        { recordType: 'Style', recordId: { in: [...styleIds] }, status: 'AVAILABLE', kind: { in: ['PHOTO', 'ATTACHMENT'] }, contentType: { startsWith: 'image/' } },
      ],
    },
    select: { id: true, recordId: true, originalName: true, contentType: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  for (const row of rows) if (!out.has(row.recordId)) out.set(row.recordId, { fileId: row.id, name: row.originalName, contentType: row.contentType })
  return out
}

// ---- certificate coverage -----------------------------------------------------------------------------------------------

/** The counts of a style's checked cells (the Compliance tab's legend), and the sizes with a gap. */
export function coverageOf(style: { readonly ppeCategory: string; readonly sizes: readonly string[] }, cells: readonly CoverageCell[]): RowCoverage {
  const checked = checkedCells(cells)
  const counts = coverageCounts(checked.map((cell) => ({ ...cell, offered: true })))
  const notCovered = checked.filter((cell) => cell.status === 'NOT_COVERED' || cell.status === 'EXPIRED' || cell.status === 'SUSPENDED')
  const gapSizes = new Set(notCovered.map((cell) => cell.size))
  const required = style.ppeCategory !== 'NOT_PPE'
  return {
    state: !required ? 'NOT_REQUIRED' : checked.length === 0 ? 'NO_CELLS' : notCovered.length === 0 ? 'ALL_COVERED' : 'GAPS',
    cells: checked.length,
    covered: counts.covered,
    notCovered: notCovered.length,
    expiringSoon: counts.expiringSoon,
    sizesNotCovered: style.sizes.filter((size) => gapSizes.has(size)),
  }
}

async function coverages(client: Reader, rows: readonly StyleRowData[], date: BusinessDate): Promise<Map<string, RowCoverage>> {
  const out = new Map<string, RowCoverage>()
  if (rows.length === 0) return out
  const ids = rows.map((row) => row.id)
  // One query per kind for the page, one after another (a transaction runs one query at a time).
  const colourways = await client.colourway.findMany({ where: { styleId: { in: ids } }, select: { id: true, styleId: true, code: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  const variants = await client.variant.findMany({ where: { styleId: { in: ids }, status: 'ACTIVE' }, select: { styleId: true, colourwayId: true, size: true } })
  const covers = await client.certificateCoverage.findMany({
    where: { styleId: { in: ids }, status: 'ACTIVE' },
    select: {
      id: true,
      styleId: true,
      colourwayIds: true,
      sizes: true,
      allowsMadeToMeasure: true,
      certificate: { select: { id: true, number: true, standard: true, ppeClass: true, notifiedBodyName: true, notifiedBodyNumber: true, validFrom: true, validTo: true, status: true } },
    },
    orderBy: { id: 'asc' },
  })
  const offered = new Set(variants.map((variant) => `${variant.colourwayId}|${variant.size}`))
  for (const row of rows) {
    const styleCovers: GateCover[] = covers
      .filter((cover) => cover.styleId === row.id)
      .map((cover) => ({
        coverageId: cover.id,
        colourwayIds: cover.colourwayIds,
        sizes: cover.sizes,
        allowsMadeToMeasure: cover.allowsMadeToMeasure,
        certificate: { ...cover.certificate, validFrom: dayOf(cover.certificate.validFrom), validTo: dayOf(cover.certificate.validTo) },
      }))
    const own = colourways.filter((colourway) => colourway.styleId === row.id)
    const base = (colourwayId: string, size: string): SizeGateRequest => ({
      style: { id: row.id, code: row.code, ppeCategory: row.ppeCategory as PpeCategory, sizes: row.sizes, mtmAllowed: row.mtmAllowed },
      colourwayId,
      size,
      date,
      covers: styleCovers,
    })
    // Rows = every colourway (archived ones too, as the Compliance tab), columns = the range.
    const cells = own.flatMap((colourway) =>
      row.sizes.map((size) => coverageCell(base(colourway.id, size), { colourwayId: colourway.id, colourwayCode: colourway.code, size, offered: offered.has(`${colourway.id}|${size}`) })),
    )
    out.set(row.id, coverageOf(row, cells))
  }
  return out
}

// ---- cost per garment ---------------------------------------------------------------------------------------------------

async function companiesOf(client: Reader, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await client.company.findMany({ where: { id: { in: [...ids] } }, select: { id: true, currency: true } })
  return new Map(rows.map((row) => [row.id, row.currency]))
}

async function costOf(client: Reader, row: StyleRowData, revision: RevisionRow, company: CostingCompany, now: Date): Promise<RowCost | null> {
  const size = row.baseSize ?? row.sizes[0]
  if (size === undefined) return null
  const { facts, colourways } = await loadCostFacts(client, { id: row.id, code: row.code, name: row.name, companyId: row.companyId, status: row.status, sizes: row.sizes, baseSize: row.baseSize }, revision, company, now)
  if (colourways.length === 0) return null
  const sheet = prepareSheet(facts)
  const cells = colourways.map((colourway) => exactCell(sheet, colourway.id, size))
  const known = cells.filter((cell) => cell.missing.length === 0).map((cell) => cell.knownTotal)
  const sorted = [...known].sort((a, b) => a.comparedTo(b))
  return {
    revision: revision.revision,
    estimate: revision.status !== 'RELEASED',
    size,
    currency: company.currency,
    lowest: sorted.length > 0 ? shownCost(sorted[0]!) : null,
    highest: sorted.length > 0 ? shownCost(sorted.at(-1)!) : null,
    complete: known.length === cells.length,
  }
}

async function costs(client: Reader, actor: Actor, rows: readonly StyleRowData[], listCompanyId: string | null): Promise<Map<string, RowCost | null>> {
  const out = new Map<string, RowCost | null>()
  if (!holds(actor, 'money.cost')) return out
  const costed = rows.filter((row) => can(actor, COSTING_VIEW, { companyId: row.companyId }))
  if (costed.length === 0) return out
  const revisions = await client.styleRevision.findMany({ where: { styleId: { in: costed.map((row) => row.id) }, status: { in: ['RELEASED', 'DRAFT'] } }, select: COST_REVISION_COLUMNS, orderBy: { revision: 'desc' } })
  const currencies = await companiesOf(client, [...new Set(costed.map((row) => row.companyId ?? listCompanyId).filter((id): id is string => id !== null))])
  const now = serverClock.now()
  for (const row of costed) {
    const own = revisions.filter((revision) => revision.styleId === row.id)
    const revision = own.find((entry) => entry.status === 'RELEASED') ?? own[0]
    if (!revision) {
      out.set(row.id, null)
      continue
    }
    const companyId = row.companyId ?? listCompanyId
    const company: CostingCompany = { id: companyId, currency: costingCurrency(companyId === null ? null : (currencies.get(companyId) ?? null)) }
    out.set(row.id, await costOf(client, row, revision, company, now))
  }
  return out
}

// ---- the page -----------------------------------------------------------------------------------------------------------

/** The extras of one page of rows, by style id (a row the caller may see none of gets nulls). */
export async function rowExtras(client: Reader, actor: Actor, rows: readonly StyleRowData[], listCompanyId: string | null): Promise<Map<string, RowExtras>> {
  const pictures = await thumbnails(client, actor, rows.map((row) => row.id))
  const certified = await coverages(
    client,
    rows.filter((row) => can(actor, STYLE_COMPLIANCE_VIEW, { companyId: row.companyId })),
    todayOf(),
  )
  const costed = await costs(client, actor, rows, listCompanyId)
  return new Map(
    rows.map((row) => [
      row.id,
      {
        thumbnail: pictures.get(row.id) ?? NONE.thumbnail,
        coverage: certified.get(row.id) ?? NONE.coverage,
        cost: asMoney('cost', costed.get(row.id) ?? null),
      },
    ]),
  )
}
