import type { z } from 'zod'
import { GRAINS, type Grain } from '../auth/grains/grains'
import type { Issue } from '../core/errors'
import { grainOfSchema, isGrainedJson, isMarkedJson, looksLikeMoney } from './marked'

/**
 * The money-grain filter (plan A1 §3.2 step 5, §3.11; feature PLT-034): shapes a value by its contract for a caller
 * who holds some grains. The API runs it on every answer (responses) and every request body (inputs).
 *
 *   filterForGrains(schema, value, held)   the answer without the marked fields whose grain is not held; inside a
 *                                          grainedJson() field (an audit row's before/after), a markMoney value is
 *                                          unwrapped when held and removed when not, and a key that looks like money
 *                                          but is not marked is removed unless every grain is held (fail closed: the
 *                                          guard should have caught it)
 *   unheldMoneyInput(schema, value, held)  the paths of marked fields a request sends without holding their grain
 *
 * The walk follows the zod schema: objects, arrays, records, tuples, unions (the option the value fits), optional,
 * nullable, default, readonly, pipe and lazy. A value the schema does not describe (an unknown key) is left as it is;
 * the serializer strips it. Values are never mutated: changed objects are copies.
 */

const HIDDEN: unique symbol = Symbol('hidden money')
type Walked = unknown | typeof HIDDEN

type Def = { readonly type: string } & Record<string, unknown>
const defOf = (schema: z.ZodType): Def => (schema as unknown as { _zod: { def: Def } })._zod.def
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const WRAPPERS = new Set(['optional', 'nullable', 'default', 'prefault', 'readonly', 'catch', 'nonoptional', 'promise'])

/** The object options of a union that a value fits, the discriminated one first. */
function unionOption(def: Def, value: unknown): z.ZodType | undefined {
  const options = def.options as z.ZodType[]
  const discriminator = def.discriminator as string | undefined
  if (discriminator !== undefined && isPlainObject(value)) {
    const found = options.find((option) => {
      const shape = defOf(option).shape as Record<string, z.ZodType> | undefined
      const literal = shape?.[discriminator]
      const values = literal ? (defOf(literal).values as unknown[] | undefined) : undefined
      return values?.includes(value[discriminator]) ?? false
    })
    if (found) return found
  }
  return options.find((option) => option.safeParse(value).success)
}

interface Walker {
  /** A marked field whose grain the caller lacks. */
  hidden(grain: Grain, path: string): Walked
  /** A grainedJson() value. */
  json(value: unknown, path: string): Walked
}

function walk(schema: z.ZodType, value: unknown, path: string, walker: Walker): Walked {
  if (value === undefined) return value
  const grain = grainOfSchema(schema)
  if (grain !== undefined) {
    const result = walker.hidden(grain, path)
    if (result === HIDDEN) return HIDDEN
  }
  if (isGrainedJson(schema)) return walker.json(value, path)
  const def = defOf(schema)
  if (WRAPPERS.has(def.type)) return walk(def.innerType as z.ZodType, value, path, walker)
  switch (def.type) {
    case 'object': {
      if (!isPlainObject(value)) return value
      const shape = def.shape as Record<string, z.ZodType>
      let copy: Record<string, unknown> | undefined
      for (const [key, field] of Object.entries(shape)) {
        if (!Object.hasOwn(value, key)) continue
        const result = walk(field, value[key], `${path}/${key}`, walker)
        if (result === value[key]) continue
        copy ??= { ...value }
        if (result === HIDDEN) delete copy[key]
        else copy[key] = result
      }
      return copy ?? value
    }
    case 'array':
      return Array.isArray(value) ? mapItems(value, (item, index) => walk(def.element as z.ZodType, item, `${path}/${index}`, walker), path) : value
    case 'tuple':
      return Array.isArray(value)
        ? mapItems(value, (item, index) => {
            const items = def.items as z.ZodType[]
            const itemSchema = items[index] ?? (def.rest as z.ZodType | null | undefined)
            return itemSchema ? walk(itemSchema, item, `${path}/${index}`, walker) : item
          }, path)
        : value
    case 'record': {
      if (!isPlainObject(value)) return value
      let copy: Record<string, unknown> | undefined
      for (const [key, item] of Object.entries(value)) {
        const result = walk(def.valueType as z.ZodType, item, `${path}/${key}`, walker)
        if (result === item) continue
        copy ??= { ...value }
        if (result === HIDDEN) delete copy[key]
        else copy[key] = result
      }
      return copy ?? value
    }
    case 'union': {
      const option = unionOption(def, value)
      return option ? walk(option, value, path, walker) : value
    }
    case 'intersection':
      return walk(def.right as z.ZodType, walk(def.left as z.ZodType, value, path, walker), path, walker)
    case 'pipe':
      // Answers are encoded from the output side; requests are read on the input side. Both sides of a money pipe
      // are walked: a marking on either counts.
      return walk(def.out as z.ZodType, walk(def.in as z.ZodType, value, path, walker), path, walker)
    case 'lazy':
      return walk((def.getter as () => z.ZodType)(), value, path, walker)
    default:
      return value
  }
}

/** An array with its items walked. A marked item cannot be dropped from a list (mark the field instead): fail closed. */
function mapItems(items: readonly unknown[], each: (item: unknown, index: number) => Walked, path: string): unknown[] {
  let changed = false
  const out = items.map((item, index) => {
    const result = each(item, index)
    if (result === HIDDEN) throw new Error(`Money is marked on the items of the list at ${path || '/'}; mark the field that holds the list instead.`)
    if (result !== item) changed = true
    return result
  })
  return changed ? out : (items as unknown[])
}

/** Free JSON for a caller: marked values unwrapped or removed, unmarked money-looking keys removed unless all held. */
function filterJson(value: unknown, held: ReadonlySet<Grain>, allHeld: boolean): Walked {
  if (isMarkedJson(value)) return held.has(value.$money) ? filterJson(value.value, held, allHeld) : HIDDEN
  if (Array.isArray(value)) return value.map((item) => {
    const result = filterJson(item, held, allHeld)
    return result === HIDDEN ? null : result
  })
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (!allHeld && looksLikeMoney(key) && !isMarkedJson(item)) continue
    const result = filterJson(item, held, allHeld)
    if (result !== HIDDEN) out[key] = result
  }
  return out
}

/** The value as the caller may see it (see the module comment). */
export function filterForGrains<T>(schema: z.ZodType, value: T, held: ReadonlySet<Grain>): T {
  const allHeld = GRAINS.every((grain) => held.has(grain))
  const result = walk(schema, value, '', {
    hidden: (grain) => (held.has(grain) ? undefined : HIDDEN),
    json: (json) => filterJson(json, held, allHeld),
  })
  // A marked schema at the top would hide the whole answer; answers are objects, so this means a contract mistake.
  if (result === HIDDEN) throw new Error('A whole answer is marked as money; mark its fields instead.')
  return result as T
}

/** The marked fields a request sends whose grain the caller does not hold (a 403 for the request). */
export function unheldMoneyInput(schema: z.ZodType, value: unknown, held: ReadonlySet<Grain>): Issue[] {
  const issues: Issue[] = []
  walk(schema, value, '', {
    hidden: (grain, path) => {
      if (!held.has(grain)) issues.push({ path: path.replace(/^\//, '') || '(body)', message: `Needs the ${grain} grain.` })
      return undefined
    },
    json: (json) => json,
  })
  return issues
}
