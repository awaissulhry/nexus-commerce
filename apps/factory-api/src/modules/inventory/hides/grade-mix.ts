import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { addArea, noArea, twoNumbersWords, type AreaUom } from '@nexus/factory-domain/inventory/hides/area'
import { activeRules, gradeMix, type MixHide } from '@nexus/factory-domain/inventory/hides/usable'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeContextOf } from '../ledger/access'
import { fixed, locatedBy, SCOPE } from '../stock/read-kit'
import { areaUom, gradeRefOf, gradesOf, ruleFactsOf, rulesOf } from './facts'

/**
 * Grade mix and usable area, hides beside area (B-W2b-94; SCM-250 "Grade mix and usable area feed planning", SCM-258 "Hide
 * count beside area"; design warehouse.hides dashboard "stacked bar: grade mix per lot"). Office, inventory.stock.view,
 * over the hides (and tagged remnants) of the companies and sites the caller's grants reach.
 *
 *   GET /inventory/leather/grade-mix   per article and colour (groupBy=article, what planning reads: B-W2b-132) or per lot
 *                                      (groupBy=lot, the grade mix as delivered): the hides and their measured area, what
 *                                      the site's ledger holds of them now (`left`) and its usable area per grade (the
 *                                      article's rule, else the grade's default share), the ungraded hides apart, the
 *                                      tagged remnants in stock (pieces beside area), the two numbers in words; and the
 *                                      totals per unit. `inStock` (default true): only full, partly cut and remnant hides.
 *
 * `left` is the ledger's on hand at the site: a hide at a work order (issued) holds nothing at the site and adds its hide
 * to the count with 0 left. A W1 hide graded in text takes the grade whose code its text is (counted in `byText`).
 */

export interface GradeMixQuery {
  readonly siteId?: string | undefined
  readonly itemId?: string | undefined
  readonly itemColourId?: string | undefined
  readonly lotId?: string | undefined
  readonly groupBy?: 'article' | 'lot' | undefined
  readonly inStock?: boolean | undefined
}

const IN_STOCK = ['FULL', 'PARTLY_CUT', 'REMNANT'] as const

const HIDE_SELECT = {
  id: true,
  itemId: true,
  lotId: true,
  gradeId: true,
  grade: true,
  baseArea: true,
  lot: {
    select: {
      id: true,
      code: true,
      dyeBatch: true,
      receivedAt: true,
      itemColourId: true,
      item: { select: { id: true, code: true, name: true, baseUom: true } },
      itemColour: { select: { id: true, code: true, name: true } },
    },
  },
} as const satisfies Prisma.HideSelect
type HideRow = Prisma.HideGetPayload<{ select: typeof HIDE_SELECT }>
type LotRow = HideRow['lot']

interface Group {
  readonly key: string
  readonly lot: LotRow
  readonly hides: MixHide[]
  remnantPieces: number
  remnantArea: Decimal
}

/** GET /inventory/leather/grade-mix. */
export async function readGradeMix(caller: CommandCaller, query: GradeMixQuery) {
  const context = officeContextOf(caller)
  const groupBy = query.groupBy ?? 'article'
  const lotScope = scopeWhere(actorOf(context), INVENTORY_STOCK_VIEW, SCOPE) as Prisma.LotWhereInput
  const lotFilter: Prisma.LotWhereInput = {
    AND: [lotScope, query.siteId ? { siteId: query.siteId } : {}, query.itemId ? { itemId: query.itemId } : {}, query.itemColourId ? { itemColourId: query.itemColourId } : {}, query.lotId ? { id: query.lotId } : {}, { item: { tracking: 'HIDE' } }],
  }
  const inStock = query.inStock ?? true
  return caller.withClient(async (client) => {
    const hides = await client.hide.findMany({ where: { AND: [{ lot: lotFilter }, inStock ? { state: { in: [...IN_STOCK] } } : {}] }, select: HIDE_SELECT, orderBy: { id: 'asc' } })
    const remnants = await client.remnant.findMany({
      where: { state: 'IN_STOCK', hide: { lot: lotFilter } },
      select: { baseArea: true, hide: { select: { lot: { select: HIDE_SELECT.lot.select } } } },
    })
    const located = hides.length > 0 ? await locatedBy(client, 'hideId', { hideId: { in: hides.map((hide) => hide.id) } }) : new Map()
    const grades = await gradesOf(client)
    const itemIds = [...new Set([...hides.map((hide) => hide.lot.item.id), ...remnants.map((row) => row.hide.lot.item.id)])]
    const rulesByItem = await rulesOf(client, itemIds)

    const keyOf = (lot: LotRow) => (groupBy === 'lot' ? lot.id : `${lot.item.id}|${lot.itemColourId ?? ''}`)
    const groups = new Map<string, Group>()
    const groupOf = (lot: LotRow): Group => {
      const key = keyOf(lot)
      const found = groups.get(key)
      if (found) return found
      const created: Group = { key, lot, hides: [], remnantPieces: 0, remnantArea: ZERO }
      groups.set(key, created)
      return created
    }
    for (const hide of hides) {
      groupOf(hide.lot).hides.push({ gradeId: hide.gradeId, grade: hide.grade, measured: hide.baseArea.toString(), left: (located.get(hide.id)?.onHand ?? ZERO).toString() })
    }
    for (const remnant of remnants) {
      const group = groupOf(remnant.hide.lot)
      group.remnantPieces += 1
      group.remnantArea = group.remnantArea.plus(remnant.baseArea.toString())
    }

    const ordered = [...groups.values()].sort((a, b) =>
      groupBy === 'lot' ? (a.lot.code < b.lot.code ? -1 : a.lot.code > b.lot.code ? 1 : 0) : `${a.lot.item.code}|${a.lot.itemColour?.code ?? ''}`.localeCompare(`${b.lot.item.code}|${b.lot.itemColour?.code ?? ''}`),
    )
    const totals = new Map<AreaUom, { left: ReturnType<typeof noArea>; measured: Decimal; usable: Decimal; ungradedLeft: Decimal; pieces: number; remnantArea: Decimal }>()
    const result = ordered.map((group) => {
      const uom = areaUom(group.lot.item.baseUom)
      const rules = activeRules((rulesByItem.get(group.lot.item.id) ?? []).map(ruleFactsOf))
      const mix = gradeMix(group.hides, grades, rules)
      const total = totals.get(uom) ?? { left: noArea(uom), measured: ZERO, usable: ZERO, ungradedLeft: ZERO, pieces: 0, remnantArea: ZERO }
      totals.set(uom, {
        left: addArea(total.left, mix.hides, mix.left, uom),
        measured: total.measured.plus(mix.measured),
        usable: total.usable.plus(mix.usable),
        ungradedLeft: total.ungradedLeft.plus(mix.ungradedLeft),
        pieces: total.pieces + group.remnantPieces,
        remnantArea: total.remnantArea.plus(group.remnantArea),
      })
      const two = { hides: mix.hides, area: mix.left, uom }
      return {
        item: { id: group.lot.item.id, code: group.lot.item.code, name: group.lot.item.name },
        colour: group.lot.itemColour,
        lot: groupBy === 'lot' ? { id: group.lot.id, code: group.lot.code, dyeBatch: group.lot.dyeBatch, receivedAt: group.lot.receivedAt ? toUtcIso(group.lot.receivedAt) : null } : null,
        uom,
        hides: mix.hides,
        measured: fixed(mix.measured),
        left: fixed(mix.left),
        usable: fixed(mix.usable),
        ungradedLeft: fixed(mix.ungradedLeft),
        words: { it: twoNumbersWords(two, 'it'), en: twoNumbersWords(two, 'en') },
        grades: mix.rows.map((row) => ({
          grade: row.grade ? gradeRefOf(row.grade) : null,
          texts: [...row.texts],
          hides: row.hides,
          measured: fixed(row.measured),
          left: fixed(row.left),
          byText: row.byText,
          share: row.share?.share ?? null,
          source: row.share?.source ?? null,
          usable: row.usable ? fixed(row.usable) : null,
          percentOfArea: row.percentOfArea,
        })),
        remnants: { pieces: group.remnantPieces, area: fixed(group.remnantArea) },
      }
    })
    return {
      groupBy,
      groups: result,
      totals: [...totals.entries()].map(([uom, total]) => ({
        uom,
        hides: total.left.hides,
        measured: fixed(total.measured),
        left: fixed(total.left.area),
        usable: fixed(total.usable),
        ungradedLeft: fixed(total.ungradedLeft),
        remnants: { pieces: total.pieces, area: fixed(total.remnantArea) },
        words: { it: twoNumbersWords(total.left, 'it'), en: twoNumbersWords(total.left, 'en') },
      })),
    }
  })
}
