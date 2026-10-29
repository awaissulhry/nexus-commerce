import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { floorRead, floorWrite, seg, type TaskOutcome } from '../shared/task-api'

/**
 * SCR-094's calls (apps/factory-api modules/production/cutting, B-W1-40; inventory/locations for where a remnant goes),
 * each answer checked against the part of its shape the screen reads. Areas are decimal strings in the hide's
 * material's base unit; no field carries money. The cut itself is NOT here: it is saved in the tablet's queue first
 * (`production.cut.log`, floor-sync) and sent when the network is there. The undo of a recorded cut is online only.
 */

const decimal = z.union([z.string(), z.number()]).transform(String)
const style = z.object({ id: z.string(), code: z.string(), name: z.string() })

export const workOrderRow = z.object({
  id: z.string(),
  number: z.string(),
  batchNumber: z.string().nullable(),
  status: z.string(),
  dueDate: z.string().nullable(),
  style,
  colourways: z.array(z.string()),
  pieces: z.number(),
  toCut: z.number(),
  sizesLeft: z.array(z.string()),
})
export type CutWorkOrderRow = z.infer<typeof workOrderRow>
const workOrdersAnswer = z.object({ workOrders: z.array(workOrderRow) })

export const cutViewAnswer = z.object({
  workOrder: z.object({ id: z.string(), number: z.string(), batchNumber: z.string().nullable(), status: z.string(), siteId: z.string(), cuttable: z.boolean(), style: style.nullable() }),
  cells: z.array(z.object({ id: z.string(), colourwayCode: z.string(), size: z.string(), quantity: z.number(), cut: z.number().nullable(), toCut: z.number().nullable() })),
  hides: z.array(z.object({ hideId: z.string(), code: z.string(), lotCode: z.string(), dyeBatch: z.string().nullable(), grade: z.string().nullable(), state: z.string(), atWorkOrder: decimal, cut: decimal, left: decimal })),
  undo: z.object({ id: z.string(), hideId: z.string() }).nullable(),
})
export type CutViewAnswer = z.infer<typeof cutViewAnswer>

const refusal = z.object({ code: z.string(), message: z.string() })

export const hideAnswer = z.object({
  hide: z.object({
    id: z.string(),
    code: z.string(),
    itemCode: z.string(),
    itemName: z.string(),
    colourCode: z.string().nullable(),
    area: decimal,
    areaUom: z.string(),
    baseArea: decimal,
    baseUom: z.string(),
    grade: z.string().nullable(),
    shade: z.string().nullable(),
    thicknessMm: z.string().nullable(),
    defects: z.string().nullable(),
    state: z.string(),
    lot: z.object({ id: z.string(), code: z.string(), dyeBatch: z.string().nullable(), shade: z.string().nullable(), qualityStatus: z.string(), crViStatus: z.string(), usable: z.boolean(), words: z.string().nullable() }),
  }),
  onHand: z.array(z.object({ locationId: z.string(), locationCode: z.string(), onHand: decimal })),
  lastCut: z.object({ at: z.string(), workOrderNumber: z.string(), station: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable() }).nullable(),
  workOrders: z.array(
    z.object({
      id: z.string(),
      number: z.string(),
      status: z.string(),
      holdsHide: z.boolean(),
      left: decimal,
      cuttable: z.boolean(),
      refusal: refusal.nullable(),
      cells: z.array(z.object({ id: z.string(), colourwayCode: z.string(), size: z.string(), quantity: z.number(), cut: z.number(), toCut: z.number() })),
    }),
  ),
})
export type HideAnswer = z.infer<typeof hideAnswer>

const locationsAnswer = z.object({
  sites: z.array(z.object({ id: z.string(), locations: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string(), status: z.string(), path: z.array(z.string()) })) })),
})
export type RemnantPlace = { readonly id: string; readonly code: string; readonly name: string }

/** Released and in-progress work orders to cut at this site; `number`: the traveller scanned (exact). */
export function fetchCutWorkOrders(api: ApiClient, number?: string): Promise<TaskOutcome<CutWorkOrderRow[]>> {
  return floorRead(api, '/production/cutting/work-orders', { query: number ? { number, limit: 1 } : { limit: 30 }, schema: workOrdersAnswer }).then((result) => (result.ok ? { ok: true, value: result.value.workOrders } : result))
}

/** The work order at the table: its cells, the hides it holds, the cutter's own last entry. */
export function fetchCutView(api: ApiClient, workOrderId: string): Promise<TaskOutcome<CutViewAnswer>> {
  return floorRead(api, `/production/cutting/work-orders/${seg(workOrderId)}`, { schema: cutViewAnswer })
}

/** A scanned hide tag, for the work order at the table (or every one that can cut it). */
export function fetchHide(api: ApiClient, code: string, workOrderId?: string | null): Promise<TaskOutcome<HideAnswer>> {
  return floorRead(api, '/production/cutting/hides', { query: { code, ...(workOrderId ? { workOrderId } : {}) }, schema: hideAnswer })
}

/** Where a remnant may go: the site's active storage places (warehouse, zone, bin). */
export async function fetchRemnantPlaces(api: ApiClient, siteId: string): Promise<TaskOutcome<RemnantPlace[]>> {
  const result = await floorRead(api, '/inventory/locations', { query: { siteId }, schema: locationsAnswer })
  if (!result.ok) return result
  const places = result.value.sites
    .flatMap((site) => site.locations)
    .filter((location) => location.status === 'ACTIVE' && (location.kind === 'BIN' || location.kind === 'ZONE' || location.kind === 'WAREHOUSE'))
    .map((location) => ({ id: location.id, code: location.code, name: location.name }))
  return { ok: true, value: places }
}

/** Undo of the cutter's own last cut on this tablet (online only: before the next one). */
export function undoCut(api: ApiClient, cutLogId: string): Promise<TaskOutcome<unknown>> {
  return floorWrite(api, 'POST', `/production/cutting/cuts/${seg(cutLogId)}/undo`, { schema: z.object({ reversedId: z.string() }).passthrough() })
}
