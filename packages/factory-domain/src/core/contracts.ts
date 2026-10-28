import { z } from 'zod'
import { ERROR_CODES } from './errors'
import { isCurrencyCode, fitsDecimal, isMinorUnits, QUANTITY, UNIT_PRICE } from './money'
import { isBusinessDate, parseInstant } from './time'

/**
 * Contract helpers (plan A1 D2): the zod schemas the API validates requests and shapes responses with, and the web's
 * typed client reads. A module's contracts live in `src/<module>/contracts.ts` and use these building blocks.
 *
 *   input(shape)    a request body or query: unknown keys are refused (a typo never passes silently)
 *   output(shape)   a response: unknown keys are stripped on the way out (A1 §3.2 step 5)
 *
 * Money fields marked with a grain (cost, margin, price, wages) come with the roles step; until then a contract has
 * no money field.
 */

/** A record id: a UUID (the app makes UUIDv7, `newId()`). */
export const id = () => z.uuid()

/** A calendar day `YYYY-MM-DD` in the company's time zone (`core/time`). */
export const businessDate = () =>
  z.string().refine(isBusinessDate, { message: 'Expected a calendar day written YYYY-MM-DD.' })

/** An instant: ISO 8601 with its zone (Z or ±hh:mm). Responses always send UTC with milliseconds (`toUtcIso`). */
export const instant = () =>
  z.string().refine((value) => parseInstant(value) !== null, { message: 'Expected an ISO 8601 time with a zone.' })

export const currency = () => z.string().refine(isCurrencyCode, { message: 'Expected an ISO 4217 currency code.' })

/** An amount in minor units (an integer in PostgreSQL's Int range). */
export const amountMinor = () => z.number().refine(isMinorUnits, { message: 'Expected an integer amount in minor units.' })

/** A unit price or unit cost as a decimal string, Decimal(18,6). */
export const unitPrice = () =>
  z.string().refine((value) => fitsDecimal(value, UNIT_PRICE.precision, UNIT_PRICE.scale), {
    message: 'Expected a decimal string with at most 12 digits before and 6 after the dot.',
  })

/** A quantity as a decimal string, Decimal(18,4). */
export const quantity = () =>
  z.string().refine((value) => fitsDecimal(value, QUANTITY.precision, QUANTITY.scale), {
    message: 'Expected a decimal string with at most 14 digits before and 4 after the dot.',
  })

/** A request body or query: unknown keys are refused. */
export const input = <Shape extends z.ZodRawShape>(shape: Shape) => z.strictObject(shape)

/** A response: unknown keys are stripped. */
export const output = <Shape extends z.ZodRawShape>(shape: Shape) => z.object(shape)

/** The body of every error answer. */
export const errorBody = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    requestId: z.string(),
    issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
})
export type ErrorBody = z.infer<typeof errorBody>

/** What one route accepts and answers. Every response status the route sends has a schema. */
export interface RouteContract {
  readonly params?: z.ZodType
  readonly querystring?: z.ZodType
  readonly body?: z.ZodType
  readonly headers?: z.ZodType
  readonly response: Readonly<Record<number, z.ZodType>>
}

/** Declares a contract (identity, for the types). */
export const defineContract = <Contract extends RouteContract>(contract: Contract): Contract => contract

/** `GET /health`: the process is up. `time` is the server's clock (UTC), for devices that check their own. */
export const healthContract = defineContract({
  response: { 200: output({ status: z.literal('ok'), time: instant() }) },
})

/** The state of one dependency in `GET /ready`. */
export const readinessState = z.enum(['ok', 'failed', 'not_configured'])

const readyBody = output({
  status: z.enum(['ready', 'not_ready']),
  checks: output({ database: readinessState, redis: readinessState }),
})

/** `GET /ready`: 200 when the database and Redis answer, 503 otherwise (no error detail; that goes to the log). */
export const readyContract = defineContract({ response: { 200: readyBody, 503: readyBody } })
