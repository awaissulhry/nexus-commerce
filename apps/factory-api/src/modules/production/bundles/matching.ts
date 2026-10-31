import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { PRODUCTION_BUNDLES } from '@nexus/factory-domain/production/bundles/permissions'
import { cellSets, pairRefusal, shadeOf, type SetBundle } from '@nexus/factory-domain/production/bundles/sets'
import type { CommandCaller } from '../../../core/command'
import { bundleWorkOrder, countsOf, mayBundle, workerOf } from './bundles'
import { BUNDLE_COLUMNS, readBundles, readCellLabels, readHeader, type BundleRow, type Reader } from './store'

/**
 * Pair and set matching by shade (B-W2b-41; MES-078; design floor.operation "Checks before it counts"): a work order's
 * bundles matched per cell and shade (complete garments, the parts left over, bundles cut from two shades), and the
 * check the operation screen asks before bundles are joined (sleeves to a body, a suit's parts): one cell, no mixed
 * bundle, one known shade at most (factory-domain production/bundles/sets.ts). Reads as the caller: the floor at its own
 * site (production.bundles), the office with production.bundles. A bundle's shade comes from the hides of its cut log
 * entries (the hide's shade, else its lot's shade, else the lot's dye batch).
 *
 * Hook for a scan-time refusal: `setRefusalFor(db, bundleIds)` (null when they match); B-W2b-46's checks before a scan
 * counts (or B-W2b-69's operation screen) call it when an operation joins bundles: no scan names the bundles it is
 * joined with today, so the scan itself cannot know the pair (named in the notes).
 */

/** The known shades of each bundle's hides, distinct and sorted (an empty list: no shade recorded). */
export async function shadesOf(db: Reader, bundles: readonly Pick<BundleRow, 'id' | 'cutLogIds'>[]): Promise<Map<string, string[]>> {
  const entryIds = [...new Set(bundles.flatMap((bundle) => bundle.cutLogIds))]
  const entries = entryIds.length ? await db.cutLog.findMany({ where: { id: { in: entryIds } }, select: { id: true, hideId: true, lotId: true } }) : []
  const hides = entries.length ? new Map((await db.hide.findMany({ where: { id: { in: [...new Set(entries.map((entry) => entry.hideId))] } }, select: { id: true, shade: true } })).map((hide) => [hide.id, hide.shade])) : new Map<string, string | null>()
  const lots = entries.length ? new Map((await db.lot.findMany({ where: { id: { in: [...new Set(entries.map((entry) => entry.lotId))] } }, select: { id: true, shade: true, dyeBatch: true } })).map((lot) => [lot.id, lot])) : new Map<string, { shade: string | null; dyeBatch: string | null }>()
  const shadeOfEntry = new Map(entries.map((entry) => [entry.id, shadeOf({ hideShade: hides.get(entry.hideId) ?? null, lotShade: lots.get(entry.lotId)?.shade ?? null, dyeBatch: lots.get(entry.lotId)?.dyeBatch ?? null })]))
  return new Map(bundles.map((bundle) => [bundle.id, [...new Set(bundle.cutLogIds.flatMap((id) => (shadeOfEntry.get(id) ? [shadeOfEntry.get(id)!] : [])))].sort()]))
}

async function setBundlesOf(db: Reader, bundles: readonly BundleRow[]): Promise<SetBundle[]> {
  const shades = await shadesOf(db, bundles)
  return bundles.map((bundle) => ({ id: bundle.id, code: bundle.code, workOrderSizeId: bundle.workOrderSizeId, part: bundle.part, quantity: bundle.quantity, shades: shades.get(bundle.id) ?? [] }))
}

/** The scan-time hook: null when these bundles may be joined into garments, else the refusal in words. */
export async function setRefusalFor(db: Reader, bundleIds: readonly string[]) {
  const bundles = await db.bundle.findMany({ where: { id: { in: [...bundleIds] } }, select: BUNDLE_COLUMNS })
  return pairRefusal(await setBundlesOf(db, bundles))
}

/** GET /production/bundles/work-orders/:workOrderId/sets: per cell, the complete garments per shade and what is left over. */
export async function workOrderSets(caller: CommandCaller, workOrderId: string) {
  const workOrder = await bundleWorkOrder(caller, workOrderId, PRODUCTION_BUNDLES)
  return caller.withClient(async (db) => {
    const labels = await readCellLabels(db, workOrder.id)
    const active = (await readBundles(db, workOrder.id)).filter((bundle) => bundle.status === 'ACTIVE')
    const bundles = await setBundlesOf(db, active)
    const { cells } = await countsOf(db, workOrder)
    return {
      workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status, siteId: workOrder.siteId },
      cells: cells
        .filter((cell) => bundles.some((bundle) => bundle.workOrderSizeId === cell.cellId))
        .map((cell) => {
          const label = labels.get(cell.cellId)
          const own = bundles.filter((bundle) => bundle.workOrderSizeId === cell.cellId)
          const matched = cellSets(cell.parts.map((part) => part.part), own)
          return {
            workOrderSizeId: cell.cellId,
            colourwayCode: label?.colourwayCode ?? '',
            size: label?.size ?? '',
            parts: cell.parts.map((part) => part.part),
            sets: matched.sets.map((set) => ({ ...set, bundles: [...set.bundles], unmatched: set.unmatched.map((left) => ({ ...left, waitsFor: [...left.waitsFor] })) })),
            mixed: matched.mixed.map((row) => ({ ...row, shades: [...row.shades] })),
          }
        }),
    }
  })
}

/** GET /production/bundles/sets/check?bundleIds=…: may these bundles be joined into garments (MES-078)? */
export async function checkSet(caller: CommandCaller, query: { readonly bundleIds: readonly string[] }) {
  const context = workerOf(caller)
  const ids = [...new Set(query.bundleIds)]
  if (ids.length < 2) throw new ValidationError('Name at least two bundles to pair.', [{ path: 'querystring/bundleIds', message: 'At least two bundle ids.' }])
  return caller.withClient(async (db) => {
    const rows = ids.every(isUuid) ? await db.bundle.findMany({ where: { id: { in: ids } }, select: BUNDLE_COLUMNS }) : []
    const headers = await Promise.all([...new Set(rows.map((row) => row.workOrderId))].map((id) => readHeader(db, id)))
    const reachable = rows.length === ids.length && headers.every((header) => header && mayBundle(context, PRODUCTION_BUNDLES, header))
    if (!reachable) throw new NotFoundError('Not bundles of this site: scan the bundles’ tickets.')
    const bundles = await setBundlesOf(db, rows)
    const refusal = pairRefusal(bundles)
    const shades = [...new Set(bundles.flatMap((bundle) => bundle.shades))].sort()
    return {
      ok: refusal === null,
      refusal,
      /** The one shade they share; null: none recorded (unknown shades match anything) or a refusal. */
      shade: refusal === null && shades.length === 1 ? shades[0]! : null,
      /** Bundles with no shade on record: the check could not judge them. */
      unknown: bundles.filter((bundle) => bundle.shades.length === 0).map((bundle) => bundle.code),
      bundles: bundles.map((bundle) => ({ id: bundle.id, code: bundle.code, part: bundle.part, quantity: bundle.quantity, shades: [...bundle.shades] })),
    }
  })
}
