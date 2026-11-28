import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { routeStepsInput, routeStepView } from './contracts'
import { LINE_ROUTE_SOURCES } from './route-of-line'

/**
 * The route of each order line (owb-pd2 2.4; design § 5v, § 5z "Route of each line"; S4 settles 2, 3, 5): what
 * GET /sales/orders/:orderId/line-routes answers and what the line's two writes accept. The words of `source` are routeOfLine()'s
 * (REVISION "From the product" · MODEL "Model" · CUSTOMER "For this customer" · EXCEPTION "Only this order"; S3 adds STRUCTURE and
 * RULE). Office only, never a price; the customer never reads a route.
 */

export const LINE_EXCEPTION_REASON_MAX = 500

export const lineRouteView = output({
  lineId: id(),
  seq: z.number().int(),
  product: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  source: z.enum(LINE_ROUTE_SOURCES),
  /** The model or customer route's name; null: the product's route or the line's own. */
  routeName: z.string().nullable(),
  steps: z.array(routeStepView),
  /** The model routes sales may pick on this line (its revision's MODEL routes for any customer or for the order's). */
  choices: z.array(output({ routeId: id(), name: z.string() })),
  pickedRouteId: id().nullable(),
  exception: output({ reason: z.string(), by: z.string().nullable(), at: instant() }).nullable(),
  /** The line route row's version (sent back by a write); null: the line has none yet. */
  version: z.number().int().nullable(),
})
export type LineRouteView = z.infer<typeof lineRouteView>

export const lineRoutesView = output({
  /** The basket cards are printed (an OrderPrint FIRST): every route of the order is fixed. */
  frozen: z.boolean(),
  /** What the reader may do now: pick a model (orders.manage), make an exception (product.routing.manage); never once frozen. */
  may: output({ pick: z.boolean(), exception: z.boolean() }),
  lines: z.array(lineRouteView),
})
export type LineRoutesView = z.infer<typeof lineRoutesView>

const rowVersion = () => z.number().int().min(1)

/** Sales picks a model route; null: back to the normal route. `version`: the line route row's, when it has one. */
export const pickLineRouteBody = input({ version: rowVersion().optional(), routeId: id().nullable() })
export type PickLineRouteBody = z.output<typeof pickLineRouteBody>

/** The production manager's route for this one line, with why. */
/** At most 50 steps (the wave's guard on SalesOrderLineRoute.exceptionSteps). */
export const LINE_EXCEPTION_STEPS_MAX = 50
export const lineRouteExceptionBody = input({ version: rowVersion().optional(), steps: routeStepsInput().max(LINE_EXCEPTION_STEPS_MAX), reason: z.string().trim().min(1).max(LINE_EXCEPTION_REASON_MAX) })
export type LineRouteExceptionBody = z.output<typeof lineRouteExceptionBody>

export const dropLineRouteExceptionQuery = input({ version: z.coerce.number().int().min(1).optional() })

/**
 * The refusals of a line's route (code at `refusal/<code>`; the API sends the English words): FROZEN 409 (an OrderPrint FIRST:
 * "a route of a line is fixed when the basket cards are printed", DS § 5v) · ONLY_PRODUCTION_MANAGER 403 (an exception is
 * product.routing.manage's: sales picks a model, nothing more, S4 settle 5) · NOT_A_MODEL 400 (sales picks a MODEL route of the
 * line's product revision, for any customer or for the order's).
 */
export const LINE_ROUTE_REFUSALS = Object.freeze({
  FROZEN: { en: 'Fixed at the print of the basket cards.', it: 'Fissato alla stampa dei cartellini dei cesti.' },
  ONLY_PRODUCTION_MANAGER: { en: 'Only the production manager changes the route of one line.', it: 'Solo il responsabile di produzione cambia il percorso di una riga.' },
  NOT_A_MODEL: { en: 'This is not a model route of this product for this customer.', it: 'Questo non è un percorso modello di questo prodotto per questo cliente.' },
})
export type LineRouteRefusal = keyof typeof LINE_ROUTE_REFUSALS
