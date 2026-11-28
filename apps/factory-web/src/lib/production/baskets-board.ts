import { z } from 'zod'
import type { ApiClient } from '../api/client'
import { departmentOfAnswer, type Department } from '../department/model'
import { departmentsAnswerSchema } from '../department/use-departments'

/**
 * owb-of5 / owb-of6 (L8) — ONE order's baskets as S5's board reads them (`GET /production/baskets/board?salesOrderId=`, owb-fl4:
 * office `production.bundles.view`): one column per department in use with its basket cards, and the cards ready to ship. The order
 * page's Overview draws the departments strip from it (how many baskets in each); the Production tab's Baskets rows read the cards
 * ("Step k of n", late). Until S5's read is on the server (or for a reader without the right) the read fails and the page keeps
 * today's work-order rows. Parsed with this web's own zod; a card field this web does not know is kept loose.
 */

const departmentSchema = departmentsAnswerSchema.shape.departments.element

export const basketCardSchema = z
  .object({
    /** S5's board card (owb-fl4 board-contract.ts `basketCard`): the bundle is the basket. */
    bundleId: z.string(),
    code: z.string().nullable().optional(),
    label: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    worker: z.object({ name: z.string() }).nullable().optional(),
    team: z.object({ name: z.string() }).passthrough().nullable().optional(),
    progress: z.object({ done: z.number(), total: z.number() }).nullable().optional(),
    late: z.object({ days: z.number(), reason: z.string().nullable().optional(), state: z.string().nullable().optional() }).nullable().optional(),
    byHand: z.boolean().optional(),
    workOrderId: z.string().nullable().optional(),
  })
  .passthrough()
export type BasketCard = z.infer<typeof basketCardSchema>

const boardSchema = z.object({
  columns: z.array(z.object({ department: departmentSchema, baskets: z.array(basketCardSchema) })),
  readyToShip: z.array(basketCardSchema).default([]),
  /** Baskets at a step of no department (an outside step): kept, never lost. */
  elsewhere: z.array(basketCardSchema).default([]),
})
export type OrderBasketsBoard = z.infer<typeof boardSchema>

export const BASKETS_BOARD_PATH = '/production/baskets/board'

/** One order's baskets (S5's board read, filtered to the order). */
export const readOrderBaskets = (api: ApiClient, orderId: string, signal?: AbortSignal): Promise<OrderBasketsBoard> =>
  api.get(BASKETS_BOARD_PATH, { query: { salesOrderId: orderId }, schema: boardSchema, signal })

/** The departments strip's tiles: each department that holds baskets of the order, with how many (empty columns left out). */
export function departmentTilesOf(board: OrderBasketsBoard, locale: string): { readonly dept: Department; readonly count: number }[] {
  return board.columns.filter((column) => column.baskets.length > 0).map((column) => ({ dept: departmentOfAnswer(column.department, locale), count: column.baskets.length }))
}

/** Every basket of the order once, with its department (the ready ones last, department null). */
export function basketsOf(board: OrderBasketsBoard, locale: string): { readonly card: BasketCard; readonly dept: Department | null }[] {
  return [...board.columns.flatMap((column) => column.baskets.map((card) => ({ card, dept: departmentOfAnswer(column.department, locale) }))), ...board.elsewhere.map((card) => ({ card, dept: null })), ...board.readyToShip.map((card) => ({ card, dept: null }))]
}
