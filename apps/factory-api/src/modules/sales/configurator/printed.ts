import type { FactoryClient, Prisma } from '@nexus/factory-db'
import type { DocumentLanguage } from '@nexus/factory-domain/documents/model'
import type { PrintedOption } from '@nexus/factory-domain/documents/options-block'
import { nameIn } from '@nexus/factory-domain/product/options/rules'
import type { CommandTx } from '../../../core/command'
import { namesOf } from '../../product/options/store'

/**
 * The options of lines as paper prints them (B-W2b-374; XF3:03): the quote PDF and its link page, the order confirmation, the
 * invoice copy and the work-order traveller (factory-domain documents/options-block.ts). Read with a reader that sees the
 * library (an office or a tenant system scope): group, value, colour and material names in the document's language.
 * Never a surcharge.
 */

type Reader = FactoryClient | CommandTx

/** An option row as the readers below take it (QuoteLineOption or SalesOrderLineOption). */
export interface OptionRowOfLine {
  readonly lineId: string
  readonly groupId: string
  readonly valueId: string
  readonly freeText: string | null
  readonly colourId: string | null
  readonly itemId: string | null
  readonly itemColourId: string | null
}

const ROW = { lineId: true, groupId: true, valueId: true, freeText: true, colourId: true, itemId: true, itemColourId: true } as const

/** The printed options of each line (by line id, in the order they were chosen), in `language`. */
export async function printedOptionsOf(db: Reader, rows: readonly OptionRowOfLine[], language: DocumentLanguage): Promise<Map<string, PrintedOption[]>> {
  const out = new Map<string, PrintedOption[]>()
  if (rows.length === 0) return out
  const uniq = (ids: readonly (string | null)[]) => [...new Set(ids.filter((value): value is string => value !== null))]
  const [groups, values, colours, items, itemColours] = await Promise.all([
    db.optionGroup.findMany({ where: { id: { in: uniq(rows.map((row) => row.groupId)) } }, select: { id: true, name: true, nameI18n: true } }),
    db.optionValue.findMany({ where: { id: { in: uniq(rows.map((row) => row.valueId)) } }, select: { id: true, name: true, nameI18n: true } }),
    db.colour.findMany({ where: { id: { in: uniq(rows.map((row) => row.colourId)) } }, select: { id: true, code: true, name: true, nameI18n: true } }),
    db.item.findMany({ where: { id: { in: uniq(rows.map((row) => row.itemId)) } }, select: { id: true, code: true, name: true } }),
    db.itemColour.findMany({ where: { id: { in: uniq(rows.map((row) => row.itemColourId)) } }, select: { id: true, name: true } }),
  ])
  const named = <T extends { id: string; name: string; nameI18n: Prisma.JsonValue }>(list: readonly T[]) => new Map(list.map((row) => [row.id, nameIn({ name: row.name, nameI18n: namesOf(row.nameI18n) }, language)]))
  const groupName = named(groups)
  const valueName = named(values)
  const colourOf = new Map(colours.map((row) => [row.id, `${nameIn({ name: row.name, nameI18n: namesOf(row.nameI18n) }, language)} (${row.code})`]))
  const itemOf = new Map(items.map((row) => [row.id, `${row.name} ${row.code}`]))
  const itemColourOf = new Map(itemColours.map((row) => [row.id, row.name]))
  for (const row of rows) {
    const material = row.itemId ? [itemOf.get(row.itemId), row.itemColourId ? itemColourOf.get(row.itemColourId) : undefined].filter(Boolean).join(' · ') : null
    const list = out.get(row.lineId) ?? []
    list.push({ group: groupName.get(row.groupId) ?? '?', value: valueName.get(row.valueId) ?? '?', text: row.freeText, colour: row.colourId ? (colourOf.get(row.colourId) ?? null) : null, material: material || null })
    out.set(row.lineId, list)
  }
  return out
}

/** The options of quote lines, as printed. */
export async function quoteLinesPrinted(db: Reader, lineIds: readonly string[], language: DocumentLanguage): Promise<Map<string, PrintedOption[]>> {
  if (lineIds.length === 0) return new Map()
  const rows = await db.quoteLineOption.findMany({ where: { lineId: { in: [...new Set(lineIds)] } }, select: ROW, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  return printedOptionsOf(db, rows, language)
}

/** The options of order lines, as printed. */
export async function orderLinesPrinted(db: Reader, lineIds: readonly string[], language: DocumentLanguage): Promise<Map<string, PrintedOption[]>> {
  if (lineIds.length === 0) return new Map()
  const rows = await db.salesOrderLineOption.findMany({ where: { lineId: { in: [...new Set(lineIds)] } }, select: ROW, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  return printedOptionsOf(db, rows, language)
}

/**
 * The options each cell of a work order is made with: a cell made from an order line prints that line's options (texts,
 * colours and materials included); a cell without one prints the values it names (WorkOrderSize.optionValueIds).
 */
export async function cellsPrinted(db: Reader, cells: readonly { readonly id: string; readonly salesOrderLineId: string | null; readonly optionValueIds: readonly string[] }[], language: DocumentLanguage): Promise<Map<string, PrintedOption[]>> {
  const out = new Map<string, PrintedOption[]>()
  const ofLines = await orderLinesPrinted(db, cells.flatMap((cell) => (cell.salesOrderLineId ? [cell.salesOrderLineId] : [])), language)
  const bare = [...new Set(cells.filter((cell) => !cell.salesOrderLineId || !ofLines.has(cell.salesOrderLineId)).flatMap((cell) => cell.optionValueIds))]
  const values = bare.length === 0 ? [] : await db.optionValue.findMany({ where: { id: { in: bare } }, select: { id: true, groupId: true, name: true, nameI18n: true } })
  const groups = values.length === 0 ? [] : await db.optionGroup.findMany({ where: { id: { in: [...new Set(values.map((value) => value.groupId))] } }, select: { id: true, name: true, nameI18n: true } })
  const valueOf = new Map(values.map((value) => [value.id, value]))
  const groupOf = new Map(groups.map((group) => [group.id, group]))
  for (const cell of cells) {
    const fromLine = cell.salesOrderLineId ? ofLines.get(cell.salesOrderLineId) : undefined
    if (fromLine) {
      out.set(cell.id, fromLine)
      continue
    }
    out.set(
      cell.id,
      cell.optionValueIds.flatMap((valueId) => {
        const value = valueOf.get(valueId)
        const group = value ? groupOf.get(value.groupId) : undefined
        return value && group ? [{ group: nameIn({ name: group.name, nameI18n: namesOf(group.nameI18n) }, language), value: nameIn({ name: value.name, nameI18n: namesOf(value.nameI18n) }, language) }] : []
      }),
    )
  }
  return out
}
