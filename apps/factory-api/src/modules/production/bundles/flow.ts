import { bundleFlow, type Flow, type FlowRework } from '@nexus/factory-domain/production/bundles/split'
import { standingScans, type ScanFact, type ScanOperation } from '@nexus/factory-domain/production/scans/rules'
import { readBundleScans } from '../scans/store'
import type { Reader } from './store'

/**
 * The flow of a split bundle (B-W2a-13; MES-071, MES-126): what B-W1-42's scan rules read for a bundle that was split,
 * split off another one, or sent back for rework (factory-domain production/bundles/split.ts `bundleFlow`). The ONE hook
 * the scans module calls (modules/production/scans scans.ts report and correction ask, corrections.ts approval (W2b,
 * B-W2b-10: capped at a split parent's live garments), outside.ts, views.ts card; W2b's WIP reads the same flow in
 * factory-domain production/scans/wip): it hands the bundle's live garments
 * and its standing scans as the cap reads them, and why no scan takes it now (every garment in an open rework).
 *
 * Reads as the caller (the floor at its own site; row-level security keeps it there): the bundle's parent and children,
 * the reworks that name it, and for a child the parent's scans (its flow first: a child of a child goes up the chain).
 * Inside the scan's command it reads under the scan's locks (the work order's issue lock taken shared, the bundle's scan
 * lock), so a split, a rework or a scan of one bundle do not cross: a split takes the issue lock exclusively.
 */

interface FlowBundle {
  readonly id: string
  readonly code: string
  readonly quantity: number
}

async function reworksOf(db: Reader, bundleId: string): Promise<FlowRework[]> {
  return db.reworkOrder.findMany({
    where: { bundleId, status: { not: 'CANCELLED' } },
    select: { id: true, status: true, quantity: true, goodQuantity: true, reasonCode: true, foundAtOperationId: true, reworkAtOperationId: true, sourceScanId: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
}

/** The bundle's flow; `standing` its own standing scans (the caller read them). Depth: a split of a split goes up the chain. */
export async function bundleFlowOf<S extends ScanFact>(db: Reader, bundle: FlowBundle, operations: readonly ScanOperation[], standing: ReadonlyMap<string, S>, depth = 0): Promise<Flow<S>> {
  const row = await db.bundle.findUnique({ where: { id: bundle.id }, select: { parentBundleId: true, createdAt: true } })
  const children = await db.bundle.findMany({ where: { parentBundleId: bundle.id }, select: { quantity: true, status: true } })
  const reworks = await reworksOf(db, bundle.id)
  let parent: { id: string; standing: ReadonlyMap<string, S> } | null = null
  if (row?.parentBundleId && depth < 8) {
    const above = await db.bundle.findUnique({ where: { id: row.parentBundleId }, select: { id: true, code: true, quantity: true } })
    if (above) {
      // The parent's scans with the same columns as the caller's (a synthetic entry is a copy of one of them).
      const scans = (await readBundleScans(db, above.id)) as unknown as S[]
      const flow = await bundleFlowOf(db, above, operations, standingScans(scans), depth + 1)
      parent = { id: above.id, standing: flow.standing }
    }
  }
  if (!row?.parentBundleId && children.length === 0 && reworks.length === 0) return { quantity: bundle.quantity, standing: new Map(standing), refusal: null }
  return bundleFlow({ bundle: { ...bundle, createdAt: row?.createdAt ?? new Date(0) }, operations, standing, children, reworks, parent })
}
