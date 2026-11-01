import { z } from 'zod'
import { isGrain, type Grain } from '../auth/grains/grains'

/**
 * Marked money (plan A1 §3.11 "Money fields", PLAN §4.6 item 4: every money field is a marked type; feature PLT-034).
 * A contract field that carries money says its grain, and the API filters by the marking, never by the field's name
 * (stripping by name was a flaw of the old app: a field with an unexpected name leaked).
 *
 *   money.price(schema)   unit prices, line amounts, totals       contract fields: the value only for callers with
 *   money.cost(schema)    unit and standard costs, PO prices      the grain; the field is optional, because the
 *   money.margin(schema)  margin % and amounts                    serializer drops it for everyone else, and a
 *   money.wages(schema)   piece rates and earnings                request that sends it without the grain is refused
 *   money.pay(schema)     piece pay (B-W2b-34): rates, earnings   (HR and the worker only)
 *
 *   notMoney(schema)      a field whose name looks like money but is not (`totalLines`), said explicitly
 *   markMoney(grain, v)   a money value inside free JSON (an audit row's before/after): `{ $money: grain, value }`
 *   grainedJson()         a contract field of free JSON whose marked values are filtered (the audit history)
 *
 * The TypeScript type of a marked field is `Money<grain, T>` (a zod brand): a handler must state the grain of what it
 * returns (`asMoney('cost', value)`), so an amount never lands in a money field by accident.
 * `scripts/factory/check-money-grains.mjs` fails on a contract field or a Prisma column whose name looks like money
 * (MONEY_NAME) and that is not marked. The filter itself is `./filter`.
 */

/** Names that look like money (A1 §3.11: *cost*, *margin*, *price*, *amount*, *total*; and wages). */
export const MONEY_NAME = /cost|margin|price|amount|total|wage/i

export const looksLikeMoney = (name: string): boolean => MONEY_NAME.test(name)

/** The grain of each marked contract field (the schema object money.<grain>() returned). */
export const MONEY_FIELDS = z.registry<{ readonly grain: Grain }>()
/** Fields declared not money despite their name. */
export const NOT_MONEY = z.registry<{ readonly notMoney: true }>()
/** Free-JSON fields whose marked values are filtered. */
export const GRAINED_JSON = z.registry<{ readonly grainedJson: true }>()

/** A money value of a grain, as a contract's output type. */
export type Money<G extends Grain, T = unknown> = T & z.$brand<`money.${G}`>

/** States the grain of a value a handler returns in a marked field. */
export const asMoney = <G extends Grain, T>(_grain: G, value: T): Money<G, T> => value as Money<G, T>

type MarkedField<G extends Grain, S extends z.ZodType> = z.ZodOptional<z.ZodType<Money<G, z.output<S>>, z.input<S>>>

function marker<G extends Grain>(grain: G) {
  return <S extends z.ZodType>(schema: S): MarkedField<G, S> => {
    const field = schema.brand<`money.${G}`>().optional()
    field.register(MONEY_FIELDS, { grain })
    return field as unknown as MarkedField<G, S>
  }
}

/** The contract markers, one per grain. */
export const money = {
  price: marker('price'),
  cost: marker('cost'),
  margin: marker('margin'),
  wages: marker('wages'),
  pay: marker('pay'),
} as const

/** A field whose name looks like money but carries none (the guard accepts it; the filter leaves it alone). */
export function notMoney<S extends z.ZodType>(schema: S): S {
  NOT_MONEY.add(schema, { notMoney: true })
  return schema
}

/** The grain a schema object was marked with, if any. */
export function grainOfSchema(schema: z.ZodType): Grain | undefined {
  return MONEY_FIELDS.get(schema)?.grain
}

export function isGrainedJson(schema: z.ZodType): boolean {
  return GRAINED_JSON.has(schema)
}

/** Free JSON (e.g. an audit row's before and after) whose `markMoney` values are filtered by grain. */
export const grainedJson = (): z.ZodUnknown => z.unknown().register(GRAINED_JSON, { grainedJson: true })

/** A money value inside free JSON: what the audit rows of a command store for a money field. */
export interface MarkedJson<G extends Grain = Grain> {
  readonly $money: G
  readonly value: unknown
}

export function markMoney<G extends Grain>(grain: G, value: unknown): MarkedJson<G> {
  if (!isGrain(grain)) throw new TypeError(`not a money grain: ${String(grain)}`)
  return { $money: grain, value }
}

export function isMarkedJson(value: unknown): value is MarkedJson {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === 2 && keys.includes('$money') && keys.includes('value') && isGrain((value as { $money: unknown }).$money)
}
