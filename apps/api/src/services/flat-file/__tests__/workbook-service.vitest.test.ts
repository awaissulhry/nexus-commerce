/**
 * FF1.10 — Orchestrator tests (TDD — written before implementation).
 *
 * Tests buildCatalogWorkbook:
 *   1. Full build — Products + Amazon sheets present; marketList.AMAZON includes 'IT';
 *      Products sheet has at least one data row (sku 'A').
 *   2. Blank template — Products sheet has zero data rows; product.findMany NOT called.
 */
import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { buildCatalogWorkbook } from '../workbook.service'

// ── Mock Prisma ───────────────────────────────────────────────────────────────
//
// buildWorkbookModel → discoverMarkets needs:
//   channelListing.findMany({ distinct: ['marketplace'], ... }) → [{ marketplace: 'IT' }]
//   marketplace.findMany(...)                                   → []
//
// fetchCatalog needs:
//   product.findMany(...)                                       → [{ sku: 'A', parent: null }]
//   channelListing.findMany({ include: { product: ... }, ... }) → listing rows
//
// We distinguish the two channelListing.findMany calls by the presence of `distinct`.

const mockPrisma = {
  product: {
    findMany: async () => [{ sku: 'A', parent: null }],
  },
  channelListing: {
    findMany: async (args: any) => {
      if (args?.distinct) {
        // discoverMarkets call — return a single-market list
        return [{ marketplace: 'IT' }]
      }
      // fetchCatalog call — return one listing row for product 'A'
      return [{ channel: 'AMAZON', marketplace: 'IT', product: { sku: 'A' } }]
    },
  },
  marketplace: {
    findMany: async () => [],
  },
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('buildCatalogWorkbook', () => {
  it('full build: Products and Amazon sheets present; marketList.AMAZON includes IT; Products has a data row', async () => {
    const { bytes, marketList } = await buildCatalogWorkbook(mockPrisma, {
      channels: ['AMAZON'],
      snapshotId: 's',
      exportedAt: '2026-07-05',
    })

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(Buffer.from(bytes))

    const sheetNames = wb.worksheets.map(w => w.name)
    expect(sheetNames).toContain('Products')
    expect(sheetNames).toContain('Amazon')

    expect(marketList.AMAZON).toContain('IT')

    // Products sheet must have at least one data row (row 2+)
    const products = wb.getWorksheet('Products')!
    let dataRowCount = 0
    products.eachRow((_row, rowNo) => { if (rowNo > 1) dataRowCount++ })
    expect(dataRowCount).toBeGreaterThan(0)
  })

  it('blank template: Products sheet has no data rows; product.findMany is NOT called', async () => {
    // If product.findMany is called the promise rejects — test fails automatically
    const blankPrisma = {
      ...mockPrisma,
      product: {
        findMany: async () => {
          throw new Error('product.findMany must NOT be called for blank template')
        },
      },
    }

    const { bytes } = await buildCatalogWorkbook(blankPrisma, {
      channels: ['AMAZON'],
      snapshotId: 's',
      exportedAt: '2026-07-05',
      blankTemplate: true,
    })

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(Buffer.from(bytes))

    const products = wb.getWorksheet('Products')!
    let dataRowCount = 0
    products.eachRow((_row, rowNo) => { if (rowNo > 1) dataRowCount++ })
    expect(dataRowCount).toBe(0)
  })
})
