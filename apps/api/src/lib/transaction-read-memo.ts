import { Prisma } from '@prisma/client'

/**
 * P2 (2026-09-30) — one read, once, inside one snapshot transaction.
 *
 * A bulk save runs the row writer once per row inside ONE Serializable transaction, and the writer re-reads the same
 * rows many times: measured on a 21-row eBay IT save, 77 statements a row, and 851 of 1,613 were a read that had
 * already been answered in this transaction with nothing written since (the same marketplace, channel schema,
 * category tree … for every row; the same product and translation several times within a row).
 *
 * Why answering those from memory is the same answer: a Serializable (or Repeatable Read) transaction reads ONE
 * snapshot plus its own writes. A read repeated with no write of this transaction in between returns the same rows,
 * and its predicate locks were taken the first time. So:
 *   - every write this transaction makes (a model write, raw SQL that is not a plain SELECT, a savepoint rolled back)
 *     forgets every remembered read — except reads of REFERENCE tables, which a product save never writes, and which
 *     are forgotten too when a write touches one of them, carries a nested relation write, or cannot be read;
 *   - raw SQL is never answered from memory (it may lock or have effects), only watched for writes;
 *   - every caller gets its own copy, so a caller that edits a result never edits another's;
 *   - a read stays lazy, as Prisma's is: it runs (or is answered) when awaited, so a read created before a write and
 *     awaited after it still sees the write.
 */

/** Configuration a product save reads and never writes; kept across the save's writes until one touches them. */
const REFERENCE_MODELS = new Set(['Marketplace', 'ChannelConnection', 'CategorySchema', 'ChannelSchema', 'CustomAttribute', 'AttributeGroup',
  'AttributeOption', 'FamilyAttribute', 'ProductFamily', 'CategoryChannelMapping', 'CategoryClosure', 'Category',
  // B31 — the eBay description themes a theme cell is checked against (`reference-values.service.ts`), once per row.
  'EbayDescriptionTheme'])
const READS = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy'])
const delegateModels = new Map(Prisma.dmmf.datamodel.models.map(model => [model.name[0].toLowerCase() + model.name.slice(1), model.name]))
/** Each model's relation fields: a write that names one reaches another table (a nested create, connect, update …). */
const relationFields = new Map(Prisma.dmmf.datamodel.models.map(model => [model.name, new Set(model.fields.filter(field => field.kind === 'object').map(field => field.name))]))
/** Database table name → model name, for raw SQL. */
const tableModels = new Map(Prisma.dmmf.datamodel.models.map(model => [model.dbName ?? model.name, model.name]))

type Thenable = PromiseLike<unknown> & { catch?: unknown; finally?: unknown }

export interface ReadMemo {
  /** Forget every remembered read (a savepoint rolled back, or anything else that may have changed what was read). */
  clear(): void
  readonly stats: { hits: number; misses: number }
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

/** A copy of a Prisma result: new objects, arrays and dates; immutable values (Decimal) shared; bytes copied. */
function copy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copy)
  if (value instanceof Date) return new Date(value.getTime())
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (!isPlain(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) out[key] = copy(value[key])
  return out
}

/**
 * Does this read look beyond its own table — a relation in `where`, `select`, `include` or `orderBy`, an `include`,
 * or a `_count`? Then it depends on other tables' rows, and is remembered only until the next write (code review P2 #6).
 */
function readsThroughRelation(model: string, input: unknown): boolean {
  const relations = relationFields.get(model)
  if (!relations) return true
  const visit = (value: unknown, depth: number): boolean => {
    if (depth > 12) return true
    if (Array.isArray(value)) return value.some(item => visit(item, depth + 1))
    if (!isPlain(value)) return false
    return Object.entries(value).some(([key, item]) => relations.has(key) || key === 'include' || key === '_count' || visit(item, depth + 1))
  }
  return visit(input, 0)
}

/**
 * A raw read remembered with the reference tables must read reference tables only: every FROM / JOIN names one, no
 * FROM list joins with a comma, and no quoted identifier names any other table (code review P2 #6).
 */
function rawReadsReferenceOnly(sql: string): boolean {
  const tables = [...sql.matchAll(/\b(?:FROM|JOIN)\s+(?:"?public"?\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi)].map(match => match[1])
  if (!tables.length || !tables.every(table => REFERENCE_MODELS.has(tableModels.get(table) ?? table))) return false
  const fromLists = [...sql.matchAll(/\bFROM\b([\s\S]*?)(?=\bWHERE\b|\bGROUP\b|\bORDER\b|\bLIMIT\b|\bHAVING\b|\bWINDOW\b|\bUNION\b|\bEXCEPT\b|\bINTERSECT\b|\bJOIN\b|\)|;|$)/gi)].map(match => match[1])
  if (fromLists.some(list => list.includes(','))) return false
  const quoted = [...sql.matchAll(/"([^"]+)"/g)].map(match => match[1])
  return quoted.every(name => !name.startsWith('_') && (!tableModels.has(name) || REFERENCE_MODELS.has(tableModels.get(name)!)))
}

/** Does this write's data name a relation field (and so write through it to another table)? */
function nestedWrite(model: string, data: unknown): boolean {
  if (Array.isArray(data)) return data.some(row => nestedWrite(model, row))
  if (!isPlain(data)) return false
  const relations = relationFields.get(model)
  return !relations || Object.keys(data).some(key => relations.has(key) && data[key] !== undefined)
}

function rawText(args: unknown[]): string {
  const first = args[0] as { sql?: string; strings?: readonly string[] } | readonly string[] | string | undefined
  if (typeof first === 'string') return first
  if (Array.isArray(first)) return first.join(' ? ')
  return (first as { sql?: string })?.sql ?? (first as { strings?: readonly string[] })?.strings?.join(' ? ') ?? ''
}

const cleanSql = (sql: string) => sql.replace(/'(?:''|[^'])*'/g, "''").replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').trim()
/** A plain read: one SELECT, no locking clause, no data-changing word anywhere. */
const plainSelect = (sql: string) => /^SELECT\b/i.test(sql) && !/\b(INSERT|UPDATE|DELETE|MERGE|FOR\s+(SHARE|NO\s+KEY|KEY)|nextval|setval)\b|\bpg_advisory/i.test(sql.replace(/"(?:""|[^"])*"/g, '""'))
/** The one table a single-table raw write names, or null when that cannot be told for sure. */
function rawWriteTable(sql: string): string | null {
  const match = /^(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(?:"?public"?\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(sql)
  return match && !/;\s*\S/.test(sql) ? match[1] : null
}

/** A thenable that starts its work only when awaited, as a Prisma query does. */
function lazy(start: () => Promise<unknown>): Thenable {
  let promise: Promise<unknown> | undefined
  const run = () => (promise ??= start())
  return {
    then: (fulfilled, rejected) => run().then(fulfilled, rejected),
    catch: (rejected: (reason: unknown) => unknown) => run().catch(rejected),
    finally: (callback: () => void) => run().finally(callback),
    [Symbol.toStringTag]: 'PrismaPromise',
  } as Thenable
}

/**
 * The transaction client, with repeated reads answered from memory as described above. Only for a Serializable or
 * Repeatable Read transaction: under Read Committed a repeated read may legitimately see another transaction's commit.
 */
export function memoizeReads<T extends object>(client: T): { client: T; memo: ReadMemo } {
  const epoch = new Map<string, Promise<unknown>>()
  const reference = new Map<string, Promise<unknown>>()
  const stats = { hits: 0, misses: 0 }
  const forgetRows = () => epoch.clear()
  const forgetAll = () => { epoch.clear(); reference.clear() }
  const memo: ReadMemo = { clear: forgetAll, stats }

  /** The remembered answer to `key`, or the read itself (remembered) the first time; each asker gets its own copy. */
  function remember(store: Map<string, Promise<unknown>>, key: string, read: () => unknown): Thenable {
    return lazy(() => {
      let remembered = store.get(key)
      if (remembered) stats.hits++
      else {
        stats.misses++
        remembered = Promise.resolve(read() as PromiseLike<unknown>)
        store.set(key, remembered)
        // A failed read is not an answer: the next asker reads again.
        remembered.catch(() => { if (store.get(key) === remembered) store.delete(key) })
      }
      return remembered.then(copy)
    })
  }

  /** Forget at the call and again when the write settles: a read in between ran before the write reached the server. */
  function watchWrite(result: unknown, forget: () => void): unknown {
    forget()
    if (!result || typeof (result as Thenable).then !== 'function') return result
    const original = result as Thenable
    return new Proxy(original, {
      get(target, property) {
        if (property === 'then') return (fulfilled?: (value: unknown) => unknown, rejected?: (reason: unknown) => unknown) =>
          target.then(value => { forget(); return fulfilled ? fulfilled(value) : value }, reason => { forget(); if (rejected) return rejected(reason); throw reason })
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  function delegate(name: string, model: string, target: Record<string, unknown>) {
    return new Proxy(target, {
      get(owner, method) {
        const original = Reflect.get(owner, method, owner)
        if (typeof method !== 'string' || typeof original !== 'function') return original
        return (...args: unknown[]) => {
          if (!READS.has(method)) {
            const input = args[0]
            const touchesReference = REFERENCE_MODELS.has(model) || !isPlain(input) || nestedWrite(model, input.data) || nestedWrite(model, input.create) || nestedWrite(model, input.update)
            return watchWrite(original.apply(owner, args), touchesReference ? forgetAll : forgetRows)
          }
          let key: string
          try { key = `${name}.${method}:${JSON.stringify(args)}` } catch { return original.apply(owner, args) }
          const store = REFERENCE_MODELS.has(model) && !readsThroughRelation(model, args[0]) ? reference : epoch
          return remember(store, key, () => original.apply(owner, args))
        }
      },
    })
  }

  function wrap<C extends object>(target: C): C {
    const delegates = new Map<string, unknown>()
    return new Proxy(target, {
      get(owner, property) {
        if (typeof property === 'string' && delegateModels.has(property)) {
          if (!delegates.has(property)) delegates.set(property, delegate(property, delegateModels.get(property)!, Reflect.get(owner, property, owner) as Record<string, unknown>))
          return delegates.get(property)
        }
        const value = Reflect.get(owner, property, owner)
        if (typeof value !== 'function') return value
        if (property === '$executeRaw' || property === '$executeRawUnsafe' || property === '$queryRaw' || property === '$queryRawUnsafe') {
          return (...args: unknown[]) => {
            const sql = cleanSql(rawText(args))
            if (plainSelect(sql)) {
              // A plain read of reference tables only (the dictionary stamp, say) is remembered like a model read of them.
              if (property !== '$queryRaw' && property !== '$queryRawUnsafe' || !rawReadsReferenceOnly(sql)) return value.apply(owner, args)
              let key: string
              try { key = `raw:${JSON.stringify([rawText(args), args.slice(1), (args[0] as { values?: unknown })?.values ?? null])}` } catch { return value.apply(owner, args) }
              return remember(reference, key, () => value.apply(owner, args))
            }
            const table = rawWriteTable(sql)
            return watchWrite(value.apply(owner, args), table && !REFERENCE_MODELS.has(table) ? forgetRows : forgetAll)
          }
        }
        // A savepoint shares the connection and the snapshot: its client answers from the same memory. A list of
        // statements runs in order on this transaction, as `contextualDatabase` runs one inside a transaction.
        if (property === '$transaction') return async (work: unknown, ...rest: unknown[]) => {
          if (Array.isArray(work)) { const results: unknown[] = []; for (const statement of work) results.push(await statement); return results }
          try {
            return await value.call(owner, typeof work === 'function' ? (nested: object) => (work as (client: object) => unknown)(wrap(nested)) : work, ...rest)
          } catch (error) {
            // A nested transaction that failed rolled back to its savepoint: what was read after its writes is gone
            // too (code review P2 #7).
            forgetAll()
            throw error
          }
        }
        return value.bind(owner)
      },
    })
  }

  return { client: wrap(client), memo }
}
