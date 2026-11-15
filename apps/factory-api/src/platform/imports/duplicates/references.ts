import type { TableUse } from '@nexus/factory-domain/imports/duplicates/rules'
import type { CommandTx } from '../../../core/command'

/**
 * What points to a record (B-W2b-427): every foreign key of the database that references the table's `id`, read from
 * the catalogue (so a table a later step adds is counted too, with no list here to forget), and how many rows of each
 * point to the given ids. Read only.
 *
 * Only what the caller's role may read is counted (`has_column_privilege` on the referencing column), under the row
 * walls of the session: a table the office role cannot read is not counted. A merge never deletes nor re-points a
 * document, so a row not counted still points to a record that exists (archived) — the same as a plain archive.
 */

/** The tables whose references are counted, by their own names (the model names: the schema maps none). */
export type ReferencedTable = 'Party' | 'PartyContact' | 'PartyAddress' | 'PartyTaxIdentity' | 'Item' | 'ItemColour'

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/
const quote = (name: string): string => {
  if (!IDENTIFIER.test(name)) throw new Error(`Not an identifier: ${JSON.stringify(name)}.`)
  return `"${name}"`
}

interface ForeignKey {
  readonly table: string
  readonly column: string
}

/** The (table, column) pairs that reference `<table>.id`, readable by the current role. */
async function foreignKeysTo(tx: Pick<CommandTx, '$queryRaw'>, table: ReferencedTable): Promise<ForeignKey[]> {
  const rows = await tx.$queryRaw<ForeignKey[]>`
    SELECT rel.relname::text AS "table", a.attname::text AS "column"
      FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
      JOIN pg_class target ON target.oid = c.confrelid
      JOIN pg_namespace ns ON ns.oid = target.relnamespace
      CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(local, referenced)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.local
      JOIN pg_attribute r ON r.attrelid = c.confrelid AND r.attnum = k.referenced
     WHERE c.contype = 'f'
       AND target.relname = ${table}
       AND ns.nspname = current_schema()
       AND r.attname = 'id'
       AND has_column_privilege(c.conrelid, a.attnum, 'SELECT')
     ORDER BY 1, 2`
  return rows.filter((row) => IDENTIFIER.test(row.table) && IDENTIFIER.test(row.column))
}

/**
 * For each id, the tables (other than `except`) whose rows point to it and how many: one query over every foreign key.
 * Ids nothing points to are absent from the answer.
 */
export async function referencesTo(tx: Pick<CommandTx, '$queryRaw' | '$queryRawUnsafe'>, table: ReferencedTable, ids: readonly string[], except: readonly ForeignKey[] = []): Promise<Map<string, TableUse[]>> {
  const found = new Map<string, TableUse[]>()
  if (ids.length === 0) return found
  const keys = (await foreignKeysTo(tx, table)).filter((key) => !except.some((left) => left.table === key.table && left.column === key.column))
  if (keys.length === 0) return found
  const parts = keys.map(
    (key) =>
      `SELECT '${key.table}'::text AS "table", ${quote(key.column)}::text AS "id", count(*)::int AS "count" FROM ${quote(key.table)} WHERE ${quote(key.column)} = ANY($1::uuid[]) GROUP BY ${quote(key.column)}`,
  )
  const rows = await tx.$queryRawUnsafe<{ table: string; id: string; count: number }[]>(parts.join('\nUNION ALL\n'), [...ids])
  for (const row of rows) {
    const list = found.get(row.id) ?? []
    const same = list.find((use) => use.table === row.table)
    if (same) found.set(row.id, list.map((use) => (use === same ? { table: use.table, count: use.count + Number(row.count) } : use)))
    else found.set(row.id, [...list, { table: row.table, count: Number(row.count) }])
  }
  return found
}

/** The uses of one id (an empty list: nothing points to it). */
export async function usesOf(tx: Pick<CommandTx, '$queryRaw' | '$queryRawUnsafe'>, table: ReferencedTable, id: string, except: readonly ForeignKey[] = []): Promise<TableUse[]> {
  return (await referencesTo(tx, table, [id], except)).get(id) ?? []
}
