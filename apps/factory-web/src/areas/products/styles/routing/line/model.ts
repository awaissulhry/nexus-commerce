import { unknownDepartment, type Department } from '../../../../../lib/department/model'
import { stepDepartment, type DeptLook, type Words } from '../route/model'
import type { LineRoute, LineRoutes } from './api'

/**
 * owb-pd6 step 6.4 (S4; design plan § 5v, § 5z; prototype prod.js lineRoutesSec, lineRouteV, lineRouteBack) — the order's "Route of
 * each line", its pure side: where each line's route comes from in words (From the product · Model · For this customer · Order
 * structure · Only this order), what each person may do on a line (sales picks a model; the production manager makes or takes back
 * an exception; once the basket cards are printed every route is read only), and each line's steps as departments. No React, no API.
 */

export type SourceTone = 'neutral' | 'info' | 'warning'

/** The source words and the tag's tone (never colour alone: the words say it). STRUCTURE and RULE are both "Order structure". */
export const SOURCE_WORDS: Readonly<Record<string, { readonly key: string; readonly tone: SourceTone }>> = Object.freeze({
  REVISION: { key: 'line.source.REVISION', tone: 'neutral' },
  MODEL: { key: 'line.source.MODEL', tone: 'info' },
  CUSTOMER: { key: 'line.source.CUSTOMER', tone: 'info' },
  STRUCTURE: { key: 'line.source.STRUCTURE', tone: 'neutral' },
  RULE: { key: 'line.source.STRUCTURE', tone: 'neutral' },
  EXCEPTION: { key: 'line.source.EXCEPTION', tone: 'warning' },
})

/** Where a line's route comes from, in words; a source this web does not know yet says "Its route". */
export const sourceOf = (source: string): { readonly key: string; readonly tone: SourceTone } => (Object.hasOwn(SOURCE_WORDS, source) ? SOURCE_WORDS[source]! : { key: 'line.source.other', tone: 'neutral' })

/** The route's own name is shown beside the source for a model, a customer's route and an order structure (not for the product's). */
export const showsRouteName = (line: Pick<LineRoute, 'source' | 'routeName'>): boolean => !!line.routeName && ['MODEL', 'CUSTOMER', 'STRUCTURE', 'RULE'].includes(line.source)

export interface LineMay {
  /** Sales: a select of the model routes (orders.manage, before the print, no exception on the line). */
  readonly pick: boolean
  /** The production manager: "Another route for this order…" (the builder in line mode). */
  readonly exception: boolean
  /** The production manager: "Back to the normal route" (an exception is on the line). */
  readonly back: boolean
}

/** What the person may do on a line; nothing once the basket cards are printed (`frozen`) or on a line with no product. */
export function lineMayOf(answer: Pick<LineRoutes, 'frozen' | 'may'>, line: Pick<LineRoute, 'source' | 'choices' | 'product'>): LineMay {
  const open = !answer.frozen && line.product !== null
  const excepted = line.source === 'EXCEPTION'
  return {
    pick: open && answer.may.pick && !excepted && line.choices.length > 0,
    exception: open && answer.may.exception && !excepted,
    back: open && answer.may.exception && excepted,
  }
}

/** The section's answer line: before the print (who picks, who makes an exception) or after it ("Fixed at the print of the basket cards"). */
export const answerOfLines = (answer: Pick<LineRoutes, 'frozen'>): Words => ({ key: answer.frozen ? 'line.answer.frozen' : 'line.answer.open' })

/** A line's steps as departments, in its route's order; a department no list names is "Department n". */
export function lineDepartments(line: Pick<LineRoute, 'steps'>, looks: readonly DeptLook[], fixed: readonly Department[], unknownWords: (no: number) => string): Department[] {
  return line.steps.map((step) => stepDepartment(looks, step.departmentId, step.number, fixed) ?? unknownDepartment(step.number, unknownWords(step.number)))
}

/** "1 · DEMO-JKT-01 Demo jacket", or the line's number and "No product yet". */
export function lineTitleOf(line: Pick<LineRoute, 'seq' | 'product'>): Words {
  return line.product ? { key: 'line.title', params: { seq: line.seq, product: `${line.product.code} ${line.product.name}` } } : { key: 'line.titleNoProduct', params: { seq: line.seq } }
}

/** The steps a line's exception starts from: the route it has now (its departments and minutes). */
export const exceptionStartOf = (line: Pick<LineRoute, 'steps'>): { departmentId: string; minutes: string | null | undefined }[] => line.steps.map((step) => ({ departmentId: step.departmentId, minutes: step.minutes }))

/** The value of the pick's select: the picked model route, or '' for the normal route. */
export const pickValueOf = (line: Pick<LineRoute, 'pickedRouteId' | 'choices'>): string => (line.pickedRouteId && line.choices.some((choice) => choice.routeId === line.pickedRouteId) ? line.pickedRouteId : '')

/** One line of the section, as the view draws it. */
export interface LineRow {
  readonly lineId: string
  readonly title: Words
  readonly source: { readonly key: string; readonly tone: SourceTone }
  /** The model's, the customer's route's or the order structure's name; null: none to show. */
  readonly routeName: string | null
  readonly route: readonly Department[]
  readonly exception: { readonly reason: string; readonly by: string | null; readonly at: string } | null
  readonly may: LineMay
  readonly choices: readonly { readonly routeId: string; readonly name: string }[]
  /** The pick's value: the picked model route, '' for the normal route. */
  readonly pickValue: string
}

/** Every line of the answer as a row: its title, where its route comes from, its departments, its exception, what the person may do. */
export function lineRowsOf(answer: LineRoutes, looks: readonly DeptLook[], fixed: readonly Department[], unknownWords: (no: number) => string): LineRow[] {
  return answer.lines.map((line) => ({
    lineId: line.lineId,
    title: lineTitleOf(line),
    source: sourceOf(line.source),
    routeName: showsRouteName(line) ? (line.routeName ?? null) : null,
    route: lineDepartments(line, looks, fixed, unknownWords),
    exception: line.exception ? { reason: line.exception.reason, by: line.exception.by ?? null, at: line.exception.at } : null,
    may: lineMayOf(answer, line),
    choices: line.choices,
    pickValue: pickValueOf(line),
  }))
}

/** A failed read in the section kit's words (`orders` problem.read.*: the kit's PartFailed says them). */
export function readProblemKeyOf(error: unknown): string {
  const kind = (error as { kind?: string } | null)?.kind
  switch (kind) {
    case 'signed_out':
    case 'forbidden':
    case 'not_found':
    case 'unavailable':
    case 'rate_limited':
      return `problem.read.${kind}`
    case 'step_up':
      return 'problem.read.forbidden'
    default:
      return 'problem.read.internal'
  }
}
