import { z } from 'zod'
import { CUT_WARNING_KINDS, type CutOverrideReasonCode, type CutWarningKind } from '@nexus/factory-domain/production/cutting/checks'
import type { ApiClient } from '../../../lib/api/client'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { presignedSchema } from '../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../record-panels/store'
import { floorRead, floorWrite, seg, taskProblemOf, type TaskOutcome, type TaskProblem } from '../shared/task-api'

/**
 * SCR-094's calls (apps/factory-api modules/production/cutting, B-W1-40; inventory/locations for where a remnant goes),
 * each answer checked against the part of its shape the screen reads. Areas are decimal strings in the hide's
 * material's base unit; no field carries money. The cut itself is NOT here: it is saved in the tablet's queue first
 * (`production.cut.log`, floor-sync) and sent when the network is there. The undo of a recorded cut is online only.
 *
 * B-W2b-110 (on B-W2b-103's API): the hide check of each work order (`checks`: the warnings, what stands, what a lead
 * passed, the card's facts), "Cut anyway" (online only: the lead's badge or name and PIN go with ONE cut, under the cut's
 * client event id; the queue never carries them), the photo of the hide on the table (announced, PUT to the store,
 * confirmed: online; the cut then names the file) and a remnant's RM tag looked up to its hide (B-W2b-100).
 */

const decimal = z.union([z.string(), z.number()]).transform(String)
const style = z.object({ id: z.string(), code: z.string(), name: z.string() })

// ---- B-W2b-110: the hide check of a work order (B-W2b-103 `checks`) ----------------------------------------------------------
const warningKind = z.enum(CUT_WARNING_KINDS)
const shadeLot = z.object({ lotCode: z.string(), shadeLabel: z.string().nullable() })
const hideShadeLot = shadeLot.extend({ outOfShade: z.boolean() })
const thicknessSource = z.enum(['TABLE', 'HIDE'])

export const checkWarning = z.object({
  kind: warningKind,
  code: z.string(),
  shade: z.object({ rule: z.string(), cutFrom: z.array(shadeLot), hide: hideShadeLot, cell: z.string().nullable() }).optional(),
  wrongHide: z
    .object({
      reservedHides: z.array(z.object({ code: z.string(), lotCode: z.string(), grade: z.string().nullable() })),
      reservedLots: z.array(z.string()),
      differs: z.array(z.string()),
      hide: z.object({ lotCode: z.string(), grade: z.string().nullable() }),
    })
    .optional(),
  thickness: z.object({ valueMm: z.string(), source: thicknessSource, minMm: z.string().nullable(), maxMm: z.string().nullable() }).optional(),
  grade: z.object({ hideGrade: z.string().nullable(), pieces: z.array(z.object({ name: z.string(), minGrade: z.string() })) }).optional(),
})

export const hideChecks = z.object({
  warnings: z.array(checkWarning),
  standing: z.array(warningKind),
  passed: z.array(warningKind),
  shade: z.object({ rule: z.string(), cutFrom: z.array(shadeLot), hide: hideShadeLot, same: z.boolean().nullable() }),
  thickness: z.object({ verdict: z.enum(['OK', 'THIN', 'THICK', 'UNKNOWN', 'NO_SPEC']), valueMm: z.string().nullable(), source: thicknessSource.nullable(), minMm: z.string().nullable(), maxMm: z.string().nullable() }),
  grade: z.object({ hide: z.string().nullable(), byText: z.boolean(), pieces: z.array(z.object({ name: z.string(), minGrade: z.string().nullable(), verdict: z.enum(['OK', 'BELOW', 'UNKNOWN']) })) }),
  reserved: z.object({ forIt: z.boolean(), hides: z.array(z.string()), lots: z.array(z.string()) }),
  photo: z.object({ required: z.boolean() }),
})

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
      // B-W2b-110: the hide check against this work order (null: it may not be cut for it; absent from an older API).
      checks: hideChecks.nullish().transform((value) => value ?? null),
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

// ---- B-W2b-110: "Cut anyway", the photo of the hide, a remnant's tag ---------------------------------------------------------

/** One cut as the tablet sends it (the queue's `production.cut.log` payload less the work order, plus its client event id). */
export interface CutBody {
  readonly hideId: string
  readonly lines: readonly { readonly workOrderSizeId: string; readonly sets: number }[]
  readonly done?: { readonly remnant: { readonly area: string; readonly uom: string; readonly toLocationId: string } | null }
  readonly photoFileId?: string
  readonly measuredThicknessMm?: string
  readonly clientEventId: string
  readonly occurredAt?: string
}

/** The lead's signature: their badge read or their name picked, their PIN (sent once, never kept), the tile, the kinds signed for. */
export interface AnywaySignature {
  readonly lead: { readonly badgeCode: string } | { readonly workerId: string }
  readonly pin: string
  readonly reasonCode: CutOverrideReasonCode
  readonly note?: string
  readonly warnings: readonly CutWarningKind[]
}

const anywayAnswer = z
  .object({
    cut: z.object({ id: z.string() }).passthrough().nullable(),
    hide: z.object({ id: z.string(), code: z.string(), state: z.string(), left: decimal, closed: z.boolean() }).passthrough(),
    replayed: z.boolean(),
    override: z.object({ overrides: z.array(warningKind), reasonCode: z.string() }).nullable(),
  })
  .passthrough()
export type AnywayAnswer = z.infer<typeof anywayAnswer>

/** "Cut anyway" refused: the problem, and the warning kinds the office names (`warnings/<KIND>/<CODE>`; a new one since the card). */
export type AnywayOutcome = { readonly ok: true; readonly value: AnywayAnswer } | { readonly ok: false; readonly problem: TaskProblem; readonly warnings: readonly CutWarningKind[] }

const WARNING_PATH = /^warnings\/([A-Z_]+)\//

/** The warning kinds of a CUT_WARNING refusal's issues, in their order, once each. Exported for the tests. */
export function warningKindsOf(paths: readonly string[]): CutWarningKind[] {
  const kinds: CutWarningKind[] = []
  for (const path of paths) {
    const kind = WARNING_PATH.exec(path)?.[1]
    if (kind && (CUT_WARNING_KINDS as readonly string[]).includes(kind) && !kinds.includes(kind as CutWarningKind)) kinds.push(kind as CutWarningKind)
  }
  return kinds
}

/**
 * POST …/work-orders/:id/cuts/anyway — the cut with a lead's signature (B-W2b-103). Online only, never queued: its
 * Idempotency-Key is the cut's client event id, so a lead who signs again after a lost answer gets the entry recorded the
 * first time. The PIN is in this one request and nowhere else.
 */
export async function cutAnyway(api: ApiClient, workOrderId: string, cut: CutBody, sign: AnywaySignature): Promise<AnywayOutcome> {
  try {
    await api.get('/auth/csrf')
    const body = { cut, lead: { ...sign.lead, pin: sign.pin }, reasonCode: sign.reasonCode, ...(sign.note ? { note: sign.note } : {}), warnings: sign.warnings }
    const value = await api.request('POST', `/production/cutting/work-orders/${seg(workOrderId)}/cuts/anyway`, { body, schema: anywayAnswer, idempotencyKey: cut.clientEventId })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, problem: taskProblemOf(error), warnings: isApiError(error) ? warningKindsOf(error.issues.map((issue) => issuePath(issue))) : [] }
  }
}

const announced = z.object({ file: z.object({ id: z.string() }), upload: presignedSchema })

/**
 * The photo of the hide on the table (MES-060; B-W2b-103 POST …/hides/:hideId/photos): announced with its size and SHA-256,
 * its bytes PUT straight to the store, then confirmed. Online only; the cut then names the file (`photoFileId`), the queue
 * carries the id alone.
 */
export async function uploadHidePhoto(api: ApiClient, hideId: string, photo: Blob, name: string): Promise<TaskOutcome<{ fileId: string }>> {
  const base = `/production/cutting/hides/${seg(hideId)}/photos`
  const bytes = await photo.arrayBuffer()
  const first = await floorWrite(api, 'POST', base, { body: { originalName: name, contentType: photo.type || 'image/jpeg', sizeBytes: bytes.byteLength, sha256: await sha256Hex(bytes) }, schema: announced })
  if (!first.ok) return first
  try {
    await putToStore(first.value.upload, bytes)
  } catch {
    return { ok: false, problem: { kind: 'unavailable' } }
  }
  const done = await floorWrite(api, 'POST', `${base}/${seg(first.value.file.id)}/complete`, { schema: z.object({ file: z.object({ id: z.string() }) }) })
  return done.ok ? { ok: true, value: { fileId: done.value.file.id } } : done
}

const remnantAnswer = z.object({ remnant: z.object({ code: z.string(), state: z.string(), hide: z.object({ id: z.string(), code: z.string(), state: z.string() }) }) })
export type RemnantTag = z.infer<typeof remnantAnswer>['remnant']

/** GET /inventory/remnants/lookup — a remnant's RM tag (B-W2b-100), for the hide it is a piece of (the floor's own site). */
export function lookupRemnant(api: ApiClient, code: string): Promise<TaskOutcome<RemnantTag>> {
  return floorRead(api, '/inventory/remnants/lookup', { query: { code }, schema: remnantAnswer }).then((result) => (result.ok ? { ok: true, value: result.value.remnant } : result))
}
