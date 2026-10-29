import { composeLabel } from '@nexus/factory-domain/labels/model'
import { labelZpl } from '@nexus/factory-domain/labels/zpl'
import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import type { Prisma } from '../src/generated/prisma/client'
import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * The print module's synthetic seed, per tenant of seed/_core.ts: on each plant a label printer (203 dpi, 100 × 50 mm
 * stock) behind the FAKE relay (it records jobs and sends nothing), and on plant A1 an A4 printer too; then a few jobs:
 * on A1 a hide label still queued, a lot label sent to the relay and a PDF printed (the files seed's office document),
 * on B1 a bundle ticket that failed; A1's cutting table (station CUT-01) prints its tickets on A1's label printer
 * (MES-184). The ZPL is the real layout of factory-domain/labels for made-up scannable ids.
 * Written in the tenant's office scope. Made up and harmless; a second run adds nothing (INSERT … ON CONFLICT DO NOTHING).
 */

const AT = new Date('2026-10-28T08:00:00.000Z')
const LATER = new Date('2026-10-28T08:00:05.000Z')
const STOCK = { widthMm: 100, heightMm: 50, dpi: 203 } as const

export async function seed({ db, namespace }: SeedContext): Promise<void> {
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const actorId = id('actor')
  const tag = tenantTag(tenantId)
  const plants = [
    { site: id('site:A1'), company: id('company:A'), key: 'A1' },
    { site: id('site:B1'), company: id('company:B'), key: 'B1' },
  ] as const
  const [a1, b1] = plants

  const printers: Prisma.PrinterCreateManyInput[] = [
    ...plants.map(
      (plant): Prisma.PrinterCreateManyInput => ({
        id: id(`print:printer:${plant.key}:LBL`),
        companyId: plant.company,
        siteId: plant.site,
        code: 'LBL-01',
        name: `Seed label printer ${plant.key}`,
        kind: 'LABEL_ZPL',
        relay: 'FAKE',
        relayTarget: 'seed-label-printer:9100',
        dpi: STOCK.dpi,
        labelWidthMm: STOCK.widthMm,
        labelHeightMm: STOCK.heightMm,
        createdAt: AT,
        updatedAt: AT,
        createdById: actorId,
      }),
    ),
    {
      id: id('print:printer:A1:A4'),
      companyId: a1.company,
      siteId: a1.site,
      code: 'A4-01',
      name: 'Seed office printer A1',
      kind: 'A4_PDF',
      relay: 'FAKE',
      relayTarget: 'seed-office-printer',
      createdAt: AT,
      updatedAt: AT,
      createdById: actorId,
    },
  ]

  const label = (key: string, kind: 'HIDE' | 'LOT' | 'BUNDLE', ref: number, title: string) => {
    const scanId = formatScanId({ type: kind, tenantTag: tag, ref })
    const zpl = labelZpl(composeLabel({ kind, language: 'it', scanId, maker: 'Seed', title }), STOCK)
    return { recordType: kind === 'HIDE' ? 'Hide' : kind === 'LOT' ? 'Lot' : 'Bundle', recordId: id(`print:record:${key}`), payloadKind: 'ZPL' as const, labelKind: kind, scanId, zpl }
  }
  const job = (key: string, plant: (typeof plants)[number], printer: string) => ({
    id: id(`print:job:${key}`),
    companyId: plant.company,
    siteId: plant.site,
    printerId: id(printer),
    requestedById: actorId,
    createdAt: AT,
    createdById: actorId,
  })
  const jobs: Prisma.PrintJobCreateManyInput[] = [
    { ...job('A1:queued', a1, 'print:printer:A1:LBL'), ...label('A1:queued', 'HIDE', 1, 'Seed hide'), updatedAt: AT },
    { ...job('A1:sent', a1, 'print:printer:A1:LBL'), ...label('A1:sent', 'LOT', 2, 'Seed lot'), copies: 2, status: 'SENT', attempts: 1, relayJobId: 'fake-seed-1', sentAt: LATER, updatedAt: LATER },
    {
      ...job('A1:printed', a1, 'print:printer:A1:A4'),
      recordType: 'Company',
      recordId: a1.company,
      payloadKind: 'PDF',
      fileId: id('files:office'),
      status: 'PRINTED',
      attempts: 1,
      relayJobId: 'fake-seed-2',
      sentAt: LATER,
      printedAt: LATER,
      updatedAt: LATER,
    },
    {
      ...job('B1:failed', b1, 'print:printer:B1:LBL'),
      ...label('B1:failed', 'BUNDLE', 3, 'Seed bundle'),
      status: 'FAILED',
      attempts: 5,
      lastError: 'The seed relay did not answer.',
      failedAt: LATER,
      updatedAt: LATER,
    },
  ]

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      await tx.printer.createMany({ data: printers, skipDuplicates: true })
      await tx.printJob.createMany({ data: jobs, skipDuplicates: true })
      // MES-184: A1's cutting table prints its bundle tickets on A1's label printer (a station not yet paired only).
      await tx.station.updateMany({ where: { id: id('site:A1:station:CUT-01'), labelPrinterId: null }, data: { labelPrinterId: id('print:printer:A1:LBL') } })
    }),
  )
}
