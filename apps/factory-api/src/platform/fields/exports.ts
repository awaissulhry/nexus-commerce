import { columnIdOf, columnOf, grainOfColumn } from '@nexus/factory-domain/fields/access'
import { exportCellOf } from '@nexus/factory-domain/fields/values'
import type { ExportCell } from '@nexus/factory-domain/views/exports'
import type { CommandCaller } from '../../core/command'
import { actorOf } from '../../core/context'
import { ApiError } from '../../core/errors'
import { rowIdOf, type AnyExportSource, type ExportColumn, type ExportPage, type ExportReadOptions } from '../exports/source'
import { CUSTOM_RECORDS } from './records'
import { customFilter, fieldsOfModel, fieldsSeen, kept, referenceWords, valuesOfRecords } from './registry'

/**
 * The custom fields in a list's export (B-W2b-421; PLT-111): the export source of every list of platform/fields/records.ts
 * is read through this wrapper (platform/exports registry), so a file may hold the list's custom columns beside its own:
 *
 *   columns   `cf:<code>` (a money field `cf:<grain>:<code>`): the grain in the id makes the engine leave a money column
 *             out — and name it in the file — for a person without the grain, exactly like a built-in money column; a
 *             field the person does not see (personal data without the right, another company's) writes no value
 *   rows      the list's own rows (its own read, filters and scopes), with the custom values of the fields this person
 *             sees, in the file's language (a select's labels, a person's name, a linked record's code)
 *   filter    the view's `cf` term (platform/fields registry customFilter) keeps only the rows it matches
 *
 * Nothing else of the source changes (its words, formats, re-import, selected rows).
 */

interface CustomRow {
  readonly row: unknown
  readonly cells: Readonly<Record<string, ExportCell>>
}

interface CustomQuery {
  readonly inner: unknown
  readonly cf: string | null
}

const RECORD_OF_LIST = new Map(CUSTOM_RECORDS.map((record) => [record.listKey, record]))

function customColumns(source: AnyExportSource): Readonly<Record<string, ExportColumn<CustomRow>>> {
  const own: Record<string, ExportColumn<CustomRow>> = {}
  for (const [key, column] of Object.entries(source.columns)) own[key] = { ...(column.grain ? { grain: column.grain } : {}), value: (wrapped, words) => column.value(wrapped.row, words) }
  const custom = (key: string): ExportColumn<CustomRow> => {
    const grain = grainOfColumn(key)
    return { ...(grain ? { grain } : {}), value: (wrapped) => wrapped.cells[key] ?? null }
  }
  const isCustom = (property: string | symbol): property is string => typeof property === 'string' && !Object.hasOwn(own, property) && columnOf(property) !== null
  return new Proxy(own, {
    getOwnPropertyDescriptor: (target, property) => (isCustom(property) ? { value: custom(property), writable: false, enumerable: false, configurable: true } : Reflect.getOwnPropertyDescriptor(target, property)),
    has: (target, property) => isCustom(property) || Reflect.has(target, property),
    get: (target, property, receiver) => (isCustom(property) ? custom(property) : Reflect.get(target, property, receiver)),
  })
}

const WRAPPED = new WeakMap<AnyExportSource, AnyExportSource>()

/** The source of a list with its custom columns and `cf` filter; a list that takes no custom fields: the source itself. */
export function withCustomFields(source: AnyExportSource): AnyExportSource {
  const record = RECORD_OF_LIST.get(source.listKey)
  if (!record) return source
  const known = WRAPPED.get(source)
  if (known) return known
  const read = async (caller: CommandCaller, query: unknown, cursor: string | null, limit: number, options?: ExportReadOptions): Promise<ExportPage<CustomRow>> => {
    const { inner, cf } = query as CustomQuery
    const page = await source.read(caller, inner, cursor, limit, options)
    if (!caller.factoryContext) throw new ApiError('unauthenticated')
    const actor = actorOf(caller.factoryContext)
    const locale = options?.locale ?? 'it'
    const rows = await caller.withClient(async (client) => {
      const match = await customFilter(client, record.model, cf, actor)
      const ids = page.rows.map((row) => rowIdOf(source, row))
      const fields = fieldsSeen(actor, await fieldsOfModel(client, record.model))
      const values = await valuesOfRecords(client, record.model, ids.filter((id): id is string => id !== null), fields.map((field) => field.id))
      const references = await referenceWords(client, actor, fields, [...values.values()].flatMap((byField) => [...byField.values()]))
      return page.rows.flatMap((row, index) => {
        const id = ids[index] ?? null
        if (match && (id === null || !kept(match, id))) return []
        const own = id ? values.get(id) : undefined
        const cells: Record<string, ExportCell> = {}
        for (const field of fields) {
          const value = own?.get(field.id)
          if (value) cells[columnIdOf(field)] = exportCellOf(field, value.value, locale, (refId) => references.get(refId) ?? null)
        }
        return [{ row, cells }]
      })
    })
    return { rows, next: page.next }
  }
  const wrapped = {
    ...source,
    query: (address: URLSearchParams): CustomQuery => ({ inner: source.query(address), cf: address.get('cf') }),
    read,
    columns: customColumns(source),
    idOf: (row: CustomRow) => rowIdOf(source, row.row) ?? '',
    ...(source.count ? { count: async (caller: CommandCaller, query: unknown) => ((query as CustomQuery).cf ? countFiltered(caller, query) : source.count!(caller, (query as CustomQuery).inner)) } : {}),
    ...(source.reimport ? { reimport: { importer: source.reimport.importer, key: (row: CustomRow) => source.reimport!.key(row.row) } } : {}),
  }
  /** With a `cf` term the module's own count is too many: count by reading the view (filtered) once. */
  async function countFiltered(caller: CommandCaller, query: unknown): Promise<number> {
    let total = 0
    let cursor: string | null = null
    do {
      const page: ExportPage<CustomRow> = await read(caller, query, cursor, 500)
      total += page.rows.length
      cursor = page.next
    } while (cursor !== null)
    return total
  }
  const result = Object.freeze(wrapped) as unknown as AnyExportSource
  WRAPPED.set(source, result)
  return result
}
