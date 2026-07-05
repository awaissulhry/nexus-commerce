/**
 * FF1.11 — ExportWizardService workbook integration (TDD — written before implementation).
 *
 * Tests that ExportWizardService.create() with format='workbook' / targetEntity='catalog':
 *   1. Completes (status=COMPLETED) and stamps snapshotId=job.id.
 *   2. download() returns a .xlsx file whose worksheets include 'Products' and 'Amazon'.
 *
 * Uses a STATEFUL mock Prisma (one job stored in a local variable) so that create →
 * run → download all observe the same in-memory job without touching the real DB.
 */
import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { ExportWizardService } from '../../export-wizard.service'

// ── Stateful mock Prisma factory ───────────────────────────────────────────────
//
// buildWorkbookModel → discoverMarkets uses:
//   channelListing.findMany({ distinct: [...], ... }) → [{ marketplace: 'IT' }]
//   marketplace.findMany(...)                         → []
//
// fetchCatalog uses:
//   product.findMany(...)                                              → [{ sku: 'A', parent: null }]
//   channelListing.findMany({ where: { ... }, include: { ... }, ... }) → listing rows (no distinct)
//
// We distinguish the two channelListing.findMany calls by the presence of the `distinct` key.

function makeMockPrisma() {
  let job: Record<string, unknown> | null = null

  return {
    exportJob: {
      create: async (args: { data: Record<string, unknown> }) => {
        job = {
          id: 'job1',
          createdAt: new Date('2026-07-05T00:00:00Z'),
          status: 'PENDING',
          ...args.data,
        }
        return job
      },
      findUnique: async (_args: { where: { id: string } }) => job,
      update: async (args: { data: Record<string, unknown> }) => {
        job = { ...job, ...args.data }
        return job
      },
    },
    product: {
      findMany: async () => [{ sku: 'A', parent: null }],
    },
    channelListing: {
      findMany: async (args: Record<string, unknown>) => {
        if (args?.distinct) {
          // discoverMarkets call — return a single-market list for AMAZON IT
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
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('ExportWizardService — workbook format integration', () => {
  it('create() with format=workbook completes inline: status=COMPLETED and snapshotId=job.id', async () => {
    const mockPrisma = makeMockPrisma()
    const svc = new ExportWizardService(mockPrisma as any)

    const job = await svc.create({
      jobName: 'catalog',
      format: 'workbook' as any,
      targetEntity: 'catalog' as any,
      columns: [],
      filters: { channels: ['AMAZON'] },
    })

    expect(job.status).toBe('COMPLETED')
    expect(job.snapshotId).toBe(job.id)
  })

  it('download() returns filename ending .xlsx with Products and Amazon worksheets', async () => {
    const mockPrisma = makeMockPrisma()
    const svc = new ExportWizardService(mockPrisma as any)

    const job = await svc.create({
      jobName: 'catalog',
      format: 'workbook' as any,
      targetEntity: 'catalog' as any,
      columns: [],
      filters: { channels: ['AMAZON'] },
    })

    const dl = await svc.download(job.id as string)

    expect(dl).not.toBeNull()
    expect(dl!.filename).toMatch(/\.xlsx$/)

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(dl!.bytes)

    const sheetNames = wb.worksheets.map((w) => w.name)
    expect(sheetNames).toContain('Products')
    expect(sheetNames).toContain('Amazon')
  })
})
