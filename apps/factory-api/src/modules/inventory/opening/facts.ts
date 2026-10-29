import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { RowValues } from '@nexus/factory-domain/imports/importer'
import type { ItemTracking } from '@nexus/factory-domain/inventory/ledger/moves'
import { OPENING_REPORTS_RECORD, openingLinePrefix, openingMoveKey, type OpeningFacts, type OpeningLot } from '@nexus/factory-domain/inventory/opening/rules'
import type { CrViEvidence } from '@nexus/factory-domain/quality/lab/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { cleanFileName } from '../../../platform/files/rules'
import { ruleFor } from '../../quality/lab/read'
import { processLabResults } from '../../quality/lab/results-store'
import { decimalOrNull, type Reader } from '../../quality/lab/store'

/**
 * What opening-stock rows name, read for the domain's judgement (factory-domain inventory/opening/rules): the import's
 * company's site of each row's code (and whether the person reaches it), its location, the material with its units and
 * colours, the supplier, the report file among the company's opening-stock reports (CERTIFICATE files of the
 * `OpeningStock` record, AVAILABLE), whether a named PPE certificate of the register is VALID today and covers the
 * material, the Cr VI evidence rule in force (Q14) and the opening lot (no receipt line) of the same site, material,
 * colour and lot code. Reads only, a few queries per batch whatever its size; the dry run's check and the apply's
 * write use the same reads.
 */

export interface FactsOptions {
  readonly tenantId: string
  readonly companyId: string
  readonly today: BusinessDate
  /** The person reaches this site for opening stock (the dry run's starter, the apply's applier). */
  readonly reaches: (site: { readonly companyId: string; readonly id: string }) => boolean
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
const codes = (rows: readonly RowValues[], column: string): string[] => [...new Set(rows.flatMap((row) => (text(row[column]) === null ? [] : [text(row[column])!])))]
const decimalText = (value: { toString(): string } | null): string | null => (value === null ? null : new Dec(value.toString()).toFixed())

export async function readOpeningFacts(client: Reader, rows: readonly RowValues[], options: FactsOptions): Promise<OpeningFacts[]> {
  const { companyId, today } = options
  const day = new Date(`${today}T00:00:00.000Z`)
  const sites = await client.site.findMany({ where: { companyId, code: { in: codes(rows, 'site') }, status: 'ACTIVE' }, select: { id: true, code: true, companyId: true } })
  const locations = await client.location.findMany({ where: { siteId: { in: sites.map((site) => site.id) }, code: { in: codes(rows, 'location') } }, select: { id: true, siteId: true, code: true, status: true } })
  const items = await client.item.findMany({
    where: { code: { in: codes(rows, 'item') } },
    select: {
      id: true,
      code: true,
      companyId: true,
      status: true,
      tracking: true,
      baseUom: true,
      purchaseUom: true,
      purchaseFactor: true,
      consumptionUom: true,
      consumptionFactor: true,
      requiresCrViTest: true,
      crViLimitMgKg: true,
      isPpeComponent: true,
      standardCost: true,
      colours: { select: { id: true, code: true, status: true } },
    },
  })
  const parties = await client.party.findMany({ where: { code: { in: codes(rows, 'supplier') }, OR: [{ companyId: null }, { companyId }] }, select: { id: true, code: true, roles: true, status: true } })
  const names = [...new Set(codes(rows, 'reportFile').map((name) => cleanFileName(name) ?? name))]
  const reports = await client.storedFile.findMany({
    where: { recordType: OPENING_REPORTS_RECORD, recordId: companyId, companyId, kind: 'CERTIFICATE', status: 'AVAILABLE', originalName: { in: names } },
    select: { id: true, originalName: true, sha256: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const covering = await client.certificateCoverage.findMany({
    where: {
      itemId: { in: items.map((item) => item.id) },
      status: 'ACTIVE',
      certificate: { number: { in: codes(rows, 'certificate') }, status: 'VALID', validFrom: { lte: day }, validTo: { gte: day }, OR: [{ companyId: null }, { companyId }] },
    },
    select: { itemId: true, certificate: { select: { number: true } } },
  })
  const covers = new Set(covering.map((row) => `${row.certificate.number}|${row.itemId}`))
  const { rule } = await ruleFor(client, options.tenantId, companyId)

  const siteOf = new Map(sites.map((site) => [site.code, site]))
  const itemOf = new Map(items.map((item) => [item.code, item]))
  const lotRows = await client.lot.findMany({
    where: { receiptLineId: null, siteId: { in: sites.map((site) => site.id) }, itemId: { in: items.map((item) => item.id) }, supplierLotRef: { in: codes(rows, 'lot') } },
    select: {
      id: true,
      code: true,
      siteId: true,
      itemId: true,
      itemColourId: true,
      supplierId: true,
      supplierLotRef: true,
      dyeBatch: true,
      shade: true,
      receivedAt: true,
      qualityStatus: true,
      requiresCrViTest: true,
      crViStatus: true,
      crViLimitMgKg: true,
      hides: { select: { supplierCode: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const lots = new Map<string, OpeningLot>()
  for (const row of lotRows) {
    const key = `${row.siteId}|${row.itemId}|${row.itemColourId ?? '-'}|${row.supplierLotRef}`
    if (lots.has(key)) continue
    const [result] = await processLabResults().list(client, row.id)
    lots.set(key, {
      id: row.id,
      code: row.code,
      supplierId: row.supplierId,
      dyeBatch: row.dyeBatch,
      shade: row.shade,
      receivedDay: row.receivedAt ? businessDate(row.receivedAt) : null,
      qualityStatus: row.qualityStatus,
      requiresCrViTest: row.requiresCrViTest,
      crViStatus: row.crViStatus,
      crViLimitMgKg: decimalOrNull(row.crViLimitMgKg),
      result: result
        ? {
            method: result.method,
            valueMgKg: result.valueMgKg,
            belowDetectionLimit: result.belowDetectionLimit,
            detectionLimitMgKg: result.detectionLimitMgKg,
            lab: result.lab,
            reportNumber: result.reportNumber,
            testedOn: result.testedOn,
            evidence: result.evidence as CrViEvidence,
            article: result.article,
            periodFrom: result.periodFrom,
            periodTo: result.periodTo,
            fileId: result.fileId,
          }
        : null,
      hideNumbers: row.hides.flatMap((hide) => (hide.supplierCode ? [hide.supplierCode] : [])),
    })
  }

  return rows.map((values): OpeningFacts => {
    const site = siteOf.get(text(values.site) ?? '') ?? null
    const location = site ? (locations.find((entry) => entry.siteId === site.id && entry.code === text(values.location)) ?? null) : null
    const item = itemOf.get(text(values.item) ?? '') ?? null
    const colour = item && text(values.colour) ? (item.colours.find((entry) => entry.code === text(values.colour)) ?? null) : null
    const supplier = parties.find((party) => party.code === text(values.supplier)) ?? null
    const reportName = text(values.reportFile)
    const named = reportName === null ? [] : reports.filter((file) => file.originalName === (cleanFileName(reportName) ?? reportName))
    const certificate = text(values.certificate)
    const lotCode = text(values.lot)
    return {
      site: site ? { id: site.id, code: site.code, reachable: options.reaches(site) } : null,
      location: location ? { id: location.id, code: location.code, active: location.status === 'ACTIVE' } : null,
      item: item
        ? {
            id: item.id,
            code: item.code,
            active: item.status === 'ACTIVE',
            foreign: item.companyId !== null && item.companyId !== companyId,
            tracking: item.tracking as ItemTracking,
            units: { baseUom: item.baseUom, purchaseUom: item.purchaseUom, purchaseFactor: item.purchaseFactor.toString(), consumptionUom: item.consumptionUom, consumptionFactor: item.consumptionFactor.toString() },
            requiresCrViTest: item.requiresCrViTest,
            crViLimitMgKg: decimalOrNull(item.crViLimitMgKg),
            isPpeComponent: item.isPpeComponent,
            standardCost: decimalText(item.standardCost),
            colours: item.colours.map((entry) => ({ id: entry.id, code: entry.code, active: entry.status === 'ACTIVE' })),
          }
        : null,
      supplier: supplier ? { id: supplier.id, code: supplier.code, isSupplier: supplier.roles.includes('SUPPLIER'), active: supplier.status === 'ACTIVE' } : null,
      // Two uploads of the same name and content are one report; of the same name and different content, several.
      report: reportName === null ? null : named.length === 0 ? 'NONE' : new Set(named.map((file) => file.sha256)).size > 1 ? 'SEVERAL' : { id: named[0]!.id },
      certificateCovers: certificate === null ? null : item !== null && covers.has(`${certificate}|${item.id}`),
      lot: site && item && lotCode !== null ? (lots.get(`${site.id}|${item.id}|${colour?.id ?? '-'}|${lotCode}`) ?? null) : null,
      rule,
      today,
    }
  })
}

// ---- lines imported before ------------------------------------------------------------------------------------------------

export interface ImportedMove {
  readonly id: string
  readonly n: number
  readonly lotId: string | null
  readonly quantity: string
}

export interface ImportedLineRow {
  readonly line: string
  readonly site: string
  readonly location: string
  readonly item: string
  readonly colour: string | null
  readonly lot: string | null
  readonly lotCode: string | null
  readonly unit: string
  readonly moves: readonly ImportedMove[]
}

/**
 * The lines of the company's opening stock already posted, by their moves' idempotency keys (the first move of a line is
 * `inventory.opening:<company>:<line>:1`): never posted again, whatever import brings them.
 */
export async function importedLines(client: Reader, companyId: string, lines: readonly string[]): Promise<Map<string, ImportedLineRow>> {
  const found = new Map<string, ImportedLineRow>()
  if (lines.length === 0) return found
  const firsts = await client.stockMove.findMany({ where: { idempotencyKey: { in: lines.map((line) => openingMoveKey(companyId, line, 1)) } }, select: { idempotencyKey: true } })
  const posted = lines.filter((line) => firsts.some((move) => move.idempotencyKey === openingMoveKey(companyId, line, 1)))
  if (posted.length === 0) return found
  const moves = await client.stockMove.findMany({
    where: { OR: posted.map((line) => ({ idempotencyKey: { startsWith: openingLinePrefix(companyId, line) } })) },
    select: {
      id: true,
      idempotencyKey: true,
      lotId: true,
      quantity: true,
      uom: true,
      site: { select: { code: true } },
      toLocation: { select: { code: true } },
      item: { select: { code: true } },
      itemColour: { select: { code: true } },
      lot: { select: { code: true, supplierLotRef: true } },
    },
  })
  for (const line of posted) {
    const prefix = openingLinePrefix(companyId, line)
    const own = moves
      .filter((move) => move.idempotencyKey.startsWith(prefix) && /^\d+$/.test(move.idempotencyKey.slice(prefix.length)))
      .map((move) => ({ move, n: Number.parseInt(move.idempotencyKey.slice(prefix.length), 10) }))
      .sort((a, b) => a.n - b.n)
    const first = own[0]?.move
    if (!first) continue
    found.set(line, {
      line,
      site: first.site.code,
      location: first.toLocation?.code ?? '',
      item: first.item.code,
      colour: first.itemColour?.code ?? null,
      lot: first.lot?.supplierLotRef ?? null,
      lotCode: first.lot?.code ?? null,
      unit: first.uom,
      moves: own.map(({ move, n }) => ({ id: move.id, n, lotId: move.lotId, quantity: new Dec(move.quantity.toString()).toFixed(4) })),
    })
  }
  return found
}
