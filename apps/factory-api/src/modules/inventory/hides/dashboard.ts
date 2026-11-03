import { z } from 'zod'
import type { Prisma } from '@nexus/factory-db'
import { FILES_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { addArea, AREA_UOMS, noArea, twoNumbersWords, type AreaUom, type TwoNumbers } from '@nexus/factory-domain/inventory/hides/area'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { notMoney } from '@nexus/factory-domain/money/marked'
import { ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeContextOf } from '../ledger/access'
import { fixed, locatedBy, PARTY_SELECT, partyName, SCOPE } from '../stock/read-kit'
import { areaUom } from './facts'

/**
 * The leather dashboard's own reads (B-W2b-131; SCM-285 "Leather dashboard", design warehouse.hides sec hd-dashboard and
 * pop-up hd-photo). Office, inventory.stock.view, over the hides of the companies and sites the caller's grants reach (the
 * lot's company and site, as every hides read). The other panels read routes that exist already: area on hand and its value
 * (GET /costing/valuation/leather, B-W2a-29), the grade mix per lot and the remnants (GET /inventory/leather/grade-mix,
 * B-W2b-94), the yield of the last 30 days per style and supplier lot (GET /production/yield, B-W2a-13). No money, no person.
 *
 *   GET /inventory/leather/dashboard   the leather the factory does not hold in its own places or may not use now: what lies
 *                                      at a subcontractor's place (a SUBCONTRACTOR location, per workshop, article and colour)
 *                                      and what is on hold (in stock, its lot not released — quarantine, blocked, rejected —
 *                                      or an ACTIVE quality hold on the hide or its lot), hides beside area, per unit.
 *   GET /inventory/leather/photos      the photos of up to 100 hides (Hide files of kind PHOTO, AVAILABLE), newest first, each
 *                                      with where it was taken when a record says so: at the cutting table (a cut log entry
 *                                      names it, with its work order) or at incoming inspection (a hide mark names it). Without
 *                                      files.read over a hide's company its photos are left out and `canRead` says so.
 */

const areaUomEnum = z.enum(AREA_UOMS)
const named = output({ id: id(), code: z.string(), name: z.string() })
const words = output({ it: z.string(), en: z.string() })
const figure = output({ hides: z.number().int(), area: z.string() })

export const dashboardContract = defineContract({
  querystring: input({ siteId: id().optional() }),
  response: {
    200: output({
      asOf: instant(),
      atSubcontractors: output({
        rows: z.array(
          output({
            location: named,
            /** The workshop the place belongs to. */
            party: output({ id: id(), name: z.string() }).nullable(),
            item: named,
            colour: named.nullable(),
            uom: areaUomEnum,
            ...figure.shape,
            words,
          }),
        ),
        /** Per unit, every row together (hides and areas, not money). */
        sums: notMoney(z.array(output({ uom: areaUomEnum, ...figure.shape, words }))),
      }),
      onHold: output({
        rows: z.array(
          output({
            item: named,
            colour: named.nullable(),
            uom: areaUomEnum,
            /** Its lot is not released (QUARANTINE, BLOCKED, REJECTED). */
            lotNotReleased: figure,
            /** Its lot is released and an ACTIVE quality hold names the hide or its lot. */
            qualityHold: figure,
            words,
          }),
        ),
        sums: notMoney(z.array(output({ uom: areaUomEnum, lotNotReleased: figure, qualityHold: figure, words }))),
      }),
    }),
  },
})

export const photosContract = defineContract({
  querystring: input({
    /** A comma list of 1–100 hide ids. */
    hideIds: z
      .string()
      .max(3_800)
      .transform((value) => [...new Set(value.split(',').map((part) => part.trim()).filter((part) => part !== ''))])
      .pipe(z.array(id()).min(1).max(100)),
  }),
  response: {
    200: output({
      /** files.read over every company of these hides: false → some photos are left out (the screen says why). */
      canRead: z.boolean(),
      hides: z.array(
        output({
          hideId: id(),
          photos: z.array(
            output({
              fileId: id(),
              originalName: z.string(),
              contentType: z.string(),
              createdAt: instant(),
              /** Where it was taken when a record says so; null: not recorded (added in the office, or on a tablet). */
              place: z.enum(['CUTTING_TABLE', 'INSPECTION']).nullable(),
              /** Shared with the floor: taken on a tablet. */
              floor: z.boolean(),
              /** The work order of the cut that names it. */
              workOrder: output({ id: id(), number: z.string() }).nullable(),
            }),
          ),
        }),
      ),
    }),
  },
})

const IN_STOCK = ['FULL', 'PARTLY_CUT', 'REMNANT'] as const

const HIDE_SELECT = {
  id: true,
  lotId: true,
  lot: {
    select: {
      id: true,
      companyId: true,
      siteId: true,
      qualityStatus: true,
      itemColourId: true,
      item: { select: { id: true, code: true, name: true, baseUom: true } },
      itemColour: { select: { id: true, code: true, name: true } },
    },
  },
} as const satisfies Prisma.HideSelect
type HideData = Prisma.HideGetPayload<{ select: typeof HIDE_SELECT }>

const wordsOf = (two: TwoNumbers) => ({ it: twoNumbersWords(two, 'it'), en: twoNumbersWords(two, 'en') })
const keyOf = (lot: HideData['lot']) => `${lot.item.id}|${lot.itemColourId ?? ''}`
const byArticle = (a: { item: { code: string }; colour: { code: string } | null }, b: { item: { code: string }; colour: { code: string } | null }) =>
  `${a.item.code}|${a.colour?.code ?? ''}`.localeCompare(`${b.item.code}|${b.colour?.code ?? ''}`)

/** GET /inventory/leather/dashboard. */
export async function readLeatherDashboard(caller: CommandCaller, query: { readonly siteId?: string | undefined }) {
  const context = officeContextOf(caller)
  const lotScope = scopeWhere(actorOf(context), INVENTORY_STOCK_VIEW, SCOPE) as Prisma.LotWhereInput
  const lotFilter: Prisma.LotWhereInput = { AND: [lotScope, query.siteId ? { siteId: query.siteId } : {}, { item: { tracking: 'HIDE' } }] }
  return caller.withClient(async (client) => {
    const hides = await client.hide.findMany({ where: { AND: [{ lot: lotFilter }, { state: { in: [...IN_STOCK] } }] }, select: HIDE_SELECT, orderBy: { id: 'asc' } })
    const ids = hides.map((hide) => hide.id)
    const located = ids.length > 0 ? await locatedBy(client, 'hideId', { hideId: { in: ids } }) : new Map<string, { onHand: Decimal; at: ReadonlyMap<string, Decimal> }>()

    // ---- at subcontractors: the hides' stock at a SUBCONTRACTOR place, per place, article and colour ----------------------
    const placeIds = [...new Set([...located.values()].flatMap((entry) => [...entry.at.keys()]))]
    const workshops =
      placeIds.length > 0
        ? await client.location.findMany({ where: { id: { in: placeIds }, kind: 'SUBCONTRACTOR' }, select: { id: true, code: true, name: true, party: { select: PARTY_SELECT } } })
        : []
    const workshopOf = new Map(workshops.map((row) => [row.id, row]))
    const outside = new Map<string, { location: (typeof workshops)[number]; lot: HideData['lot']; two: TwoNumbers }>()
    const outsideSums = new Map<AreaUom, TwoNumbers>()
    for (const hide of hides) {
      for (const [locationId, quantity] of located.get(hide.id)?.at ?? []) {
        const location = workshopOf.get(locationId)
        if (!location || !quantity.greaterThan(0)) continue
        const uom = areaUom(hide.lot.item.baseUom)
        const key = `${locationId}|${keyOf(hide.lot)}`
        const row = outside.get(key) ?? { location, lot: hide.lot, two: noArea(uom) }
        outside.set(key, { ...row, two: addArea(row.two, 1, quantity, uom) })
        outsideSums.set(uom, addArea(outsideSums.get(uom) ?? noArea(uom), 1, quantity, uom))
      }
    }

    // ---- on hold: in stock at the site, its lot not released, or an ACTIVE quality hold on the hide or its lot -----------
    const lotIds = [...new Set(hides.map((hide) => hide.lotId))]
    const holds =
      ids.length > 0
        ? await client.qualityHold.findMany({
            where: { status: 'ACTIVE', OR: [{ subjectType: 'Hide', subjectIds: { hasSome: ids } }, { subjectType: 'Lot', subjectIds: { hasSome: lotIds } }] },
            select: { subjectType: true, subjectIds: true },
          })
        : []
    const held = new Set(holds.flatMap((hold) => hold.subjectIds.map((subject) => `${hold.subjectType}|${subject}`)))
    interface HoldRow {
      readonly lot: HideData['lot']
      notReleased: TwoNumbers
      onHold: TwoNumbers
    }
    const holdRows = new Map<string, HoldRow>()
    const holdSums = new Map<AreaUom, { notReleased: TwoNumbers; onHold: TwoNumbers }>()
    for (const hide of hides) {
      const onHand = located.get(hide.id)?.onHand ?? ZERO
      if (!onHand.greaterThan(0)) continue
      const notReleased = hide.lot.qualityStatus !== 'RELEASED'
      const quality = !notReleased && (held.has(`Hide|${hide.id}`) || held.has(`Lot|${hide.lotId}`))
      if (!notReleased && !quality) continue
      const uom = areaUom(hide.lot.item.baseUom)
      const row = holdRows.get(keyOf(hide.lot)) ?? { lot: hide.lot, notReleased: noArea(uom), onHold: noArea(uom) }
      const sum = holdSums.get(uom) ?? { notReleased: noArea(uom), onHold: noArea(uom) }
      if (notReleased) {
        row.notReleased = addArea(row.notReleased, 1, onHand, uom)
        sum.notReleased = addArea(sum.notReleased, 1, onHand, uom)
      } else {
        row.onHold = addArea(row.onHold, 1, onHand, uom)
        sum.onHold = addArea(sum.onHold, 1, onHand, uom)
      }
      holdRows.set(keyOf(hide.lot), row)
      holdSums.set(uom, sum)
    }

    const two = (value: TwoNumbers) => ({ hides: value.hides, area: fixed(value.area) })
    const both = (a: TwoNumbers, b: TwoNumbers): TwoNumbers => addArea(a, b.hides, b.area, b.uom)
    return {
      asOf: toUtcIso(new Date()),
      atSubcontractors: {
        rows: [...outside.values()]
          .map((row) => ({
            location: { id: row.location.id, code: row.location.code, name: row.location.name },
            party: row.location.party ? { id: row.location.party.id, name: partyName(row.location.party)!.name } : null,
            item: { id: row.lot.item.id, code: row.lot.item.code, name: row.lot.item.name },
            colour: row.lot.itemColour,
            uom: row.two.uom,
            ...two(row.two),
            words: wordsOf(row.two),
          }))
          .sort((a, b) => a.location.code.localeCompare(b.location.code) || byArticle(a, b)),
        sums: [...outsideSums.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([uom, value]) => ({ uom, ...two(value), words: wordsOf(value) })),
      },
      onHold: {
        rows: [...holdRows.values()]
          .map((row) => ({
            item: { id: row.lot.item.id, code: row.lot.item.code, name: row.lot.item.name },
            colour: row.lot.itemColour,
            uom: row.notReleased.uom,
            lotNotReleased: two(row.notReleased),
            qualityHold: two(row.onHold),
            words: wordsOf(both(row.notReleased, row.onHold)),
          }))
          .sort(byArticle),
        sums: [...holdSums.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([uom, value]) => ({ uom, lotNotReleased: two(value.notReleased), qualityHold: two(value.onHold), words: wordsOf(both(value.notReleased, value.onHold)) })),
      },
    }
  })
}

/** GET /inventory/leather/photos. */
export async function readHidePhotos(caller: CommandCaller, query: { readonly hideIds: readonly string[] }) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const lotScope = scopeWhere(actor, INVENTORY_STOCK_VIEW, SCOPE) as Prisma.LotWhereInput
  return caller.withClient(async (client) => {
    const hides = await client.hide.findMany({ where: { id: { in: [...query.hideIds] }, lot: lotScope }, select: { id: true, lot: { select: { companyId: true, siteId: true } } } })
    const readable = hides.filter((hide) => can(actor, FILES_READ, { companyId: hide.lot.companyId, siteId: hide.lot.siteId }))
    const files =
      readable.length > 0
        ? await client.storedFile.findMany({
            where: { recordType: 'Hide', recordId: { in: readable.map((hide) => hide.id) }, kind: 'PHOTO', status: 'AVAILABLE' },
            select: { id: true, recordId: true, originalName: true, contentType: true, createdAt: true, visibility: true },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          })
        : []
    const fileIds = files.map((file) => file.id)
    const [cuts, marks] =
      fileIds.length > 0
        ? await Promise.all([
            client.cutLog.findMany({ where: { photoFileId: { in: fileIds } }, select: { photoFileId: true, workOrderId: true }, orderBy: { id: 'asc' } }),
            client.hideMark.findMany({ where: { photoFileId: { in: fileIds } }, select: { photoFileId: true } }),
          ])
        : [[], []]
    const orders = cuts.length > 0 ? await client.workOrder.findMany({ where: { id: { in: [...new Set(cuts.map((cut) => cut.workOrderId))] } }, select: { id: true, number: true } }) : []
    const numberOf = new Map(orders.map((order) => [order.id, order.number]))
    const cutOf = new Map<string, string>()
    for (const cut of cuts) if (cut.photoFileId && !cutOf.has(cut.photoFileId)) cutOf.set(cut.photoFileId, cut.workOrderId)
    const marked = new Set(marks.flatMap((mark) => (mark.photoFileId ? [mark.photoFileId] : [])))
    const byHide = new Map<string, typeof files>()
    for (const file of files) byHide.set(file.recordId, [...(byHide.get(file.recordId) ?? []), file])
    return {
      canRead: readable.length === hides.length,
      hides: hides.map((hide) => ({
        hideId: hide.id,
        photos: (byHide.get(hide.id) ?? []).map((file) => {
          const workOrderId = cutOf.get(file.id) ?? null
          return {
            fileId: file.id,
            originalName: file.originalName,
            contentType: file.contentType,
            createdAt: toUtcIso(file.createdAt),
            place: workOrderId ? ('CUTTING_TABLE' as const) : marked.has(file.id) ? ('INSPECTION' as const) : null,
            floor: file.visibility.includes('FLOOR'),
            workOrder: workOrderId ? { id: workOrderId, number: numberOf.get(workOrderId) ?? '' } : null,
          }
        }),
      })),
    }
  })
}
