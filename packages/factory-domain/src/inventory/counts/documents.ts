import { toMinorUnits, type CurrencyCode, type MinorUnits } from '../../core/money'
import { BUSINESS_TIME_ZONE, type BusinessDate } from '../../core/time'
import { formatDate, formatDateTime, formatMoney, formatQuantity, formatUnitPrice } from '../../documents/format'
import { DOCUMENT_WORDS } from '../../documents/i18n'
import type { DocumentLanguage } from '../../documents/model'
import { Dec, type Decimal, type DecimalInput } from '../../tax/decimal'
import { quantityText } from '../ledger/moves'
import type { ValuationMethod } from '../ledger/valuation'
import type { StockCountKind } from './rules'

/**
 * The papers of a stock count (B-W2a-15; design warehouse.counts tabs cn-tab-sheets and cn-tab-valued), composed here
 * and painted by the API (modules/inventory/counts/papers.ts): every word in the paper's language, every number
 * formatted. Pure and deterministic.
 *
 *   count sheets   the lines in walking order for the counters, with or without what the ledger expects (a blind
 *                  sheet), an empty column to write what was counted, and the counters' signatures;
 *   valued list    the year-end inventory as of its inventory date (c.c. art. 2217): per item, colour and lot the
 *                  quantity counted, its unit cost and value (the cost grain), totals per kind of material and in all.
 *                  Each row's value is rounded once; the totals are the sums of the rows, so the list adds up.
 */

export interface PaperColumn {
  readonly label: string
  /** Share of the table's width, per mille. */
  readonly width: number
  readonly align: 'left' | 'right'
}

export interface PaperFact {
  readonly label: string
  readonly value: string
}

/** What the API's painter prints: A4 landscape, the company at the top, a ruled table, totals, notes, signatures. */
export interface CountPaper {
  readonly language: DocumentLanguage
  readonly title: string
  readonly number: string
  readonly issuer: { readonly name: string; readonly lines: readonly string[] }
  /** A preview's banner, or null. */
  readonly banner: string | null
  readonly facts: readonly PaperFact[]
  readonly table: { readonly columns: readonly PaperColumn[]; readonly rows: readonly (readonly string[])[] }
  readonly totals: readonly (PaperFact & { readonly strong: boolean })[]
  readonly notes: readonly string[]
  readonly signatures: readonly string[]
  readonly footer: { readonly legal: string; readonly page: string; readonly continued: string }
  readonly meta: { readonly title: string; readonly subject: string; readonly createdAt: string }
}

export interface PaperCompany {
  /** The legal name as printed and the lines under it (documents/legal: legalName, legalLines). */
  readonly name: string
  readonly lines: readonly string[]
  /** documents/legal legalFooter. */
  readonly legal: string
}

/** The count's header as the papers print it (names already resolved by the API). */
export interface PaperCount {
  readonly number: string
  readonly kind: StockCountKind
  readonly site: string
  /** The scope in words (`A1-STORE and below · SEED-LIN-200`), or null: the whole site. */
  readonly scope: string | null
  readonly countTeam: string | null
  readonly snapshotAt: Date | null
  readonly inventoryDate: BusinessDate | null
}

const WORDS = {
  it: {
    sheetTitle: 'Foglio di conta',
    listTitle: 'Inventario valorizzato',
    kind: { CYCLE: 'Conta ciclica', YEAR_END: 'Inventario di fine esercizio' } as Record<StockCountKind, string>,
    facts: { kind: 'Tipo', site: 'Stabilimento', scope: 'Ambito', wholeSite: 'Tutto lo stabilimento', team: 'Squadra di conta', snapshot: 'Giacenza attesa al', inventoryDate: 'Inventario al', signedOff: 'Approvato in Nexus', lines: 'Righe' },
    blind: 'Foglio cieco: le quantità attese non sono stampate.',
    columns: { line: 'Riga', location: 'Ubicazione', item: 'Articolo', description: 'Descrizione', colour: 'Colore', lot: 'Lotto', hide: 'Pelle', expected: 'Attesa', counted: 'Contata', uom: 'U.M.', kind: 'Tipo', hides: 'Pelli', quantity: 'Quantità', unitCost: 'Costo unitario', method: 'Criterio', value: 'Valore' },
    method: { LOT_COST: 'Costo del lotto', STANDARD_COST: 'Costo standard', PURCHASE_PRICE: "Prezzo d'acquisto", MANUAL: 'Costo indicato' } as Record<ValuationMethod, string>,
    noCost: 'senza costo',
    totalKind: (kind: string) => `Totale ${kind}`,
    total: 'Totale inventario',
    unvalued: (n: number) => `${n} righe senza costo: il loro valore non è compreso nel totale.`,
    otherCurrency: (n: number) => `${n} righe in un'altra valuta: il loro valore non è compreso nel totale.`,
    basis: 'Valutazione al costo: il costo del lotto (media ponderata di ciò che è entrato), altrimenti il costo standard dell\'articolo. Quantità nell\'unità di base dell\'articolo.',
    legalNote: "Inventario redatto ai sensi dell'art. 2217 del Codice civile.",
    sheetSignatures: ['Contato da', 'Controllato da'],
    listSignatures: ["Il responsabile del magazzino", "L'imprenditore o il legale rappresentante"],
    preview: 'ANTEPRIMA - non ancora approvato: i valori possono cambiare fino all\'approvazione.',
    empty: 'Nessuna giacenza nell\'ambito dell\'inventario.',
  },
  en: {
    sheetTitle: 'Count sheet',
    listTitle: 'Valued inventory list',
    kind: { CYCLE: 'Cycle count', YEAR_END: 'Year-end inventory' } as Record<StockCountKind, string>,
    facts: { kind: 'Kind', site: 'Site', scope: 'Scope', wholeSite: 'The whole site', team: 'Count team', snapshot: 'Expected as of', inventoryDate: 'Inventory as of', signedOff: 'Signed off in Nexus', lines: 'Lines' },
    blind: 'Blind sheet: the expected quantities are not printed.',
    columns: { line: 'Line', location: 'Location', item: 'Item', description: 'Description', colour: 'Colour', lot: 'Lot', hide: 'Hide', expected: 'Expected', counted: 'Counted', uom: 'UoM', kind: 'Kind', hides: 'Hides', quantity: 'Quantity', unitCost: 'Unit cost', method: 'Basis', value: 'Value' },
    method: { LOT_COST: 'Lot cost', STANDARD_COST: 'Standard cost', PURCHASE_PRICE: 'Purchase price', MANUAL: 'Typed cost' } as Record<ValuationMethod, string>,
    noCost: 'no cost',
    totalKind: (kind: string) => `Total ${kind}`,
    total: 'Inventory total',
    unvalued: (n: number) => `${n} line(s) without a cost: their value is not in the total.`,
    otherCurrency: (n: number) => `${n} line(s) in another currency: their value is not in the total.`,
    basis: "Valued at cost: the lot's cost (the weighted average of what came in), else the item's standard cost. Quantities in the item's base unit.",
    legalNote: 'Inventory drawn up under art. 2217 of the Italian Civil Code.',
    sheetSignatures: ['Counted by', 'Checked by'],
    listSignatures: ['Warehouse manager', 'The owner or legal representative'],
    preview: 'PREVIEW - not signed off yet: values may change until the sign-off.',
    empty: 'No stock inside the inventory scope.',
  },
} as const

export const COUNT_PAPER_WORDS = WORDS

function headerFacts(count: PaperCount, language: DocumentLanguage, lines: number): PaperFact[] {
  const words = WORDS[language]
  const facts: PaperFact[] = [
    { label: words.facts.kind, value: words.kind[count.kind] },
    { label: words.facts.site, value: count.site },
    { label: words.facts.scope, value: count.scope ?? words.facts.wholeSite },
  ]
  if (count.inventoryDate) facts.push({ label: words.facts.inventoryDate, value: formatDate(count.inventoryDate, language) })
  if (count.snapshotAt) facts.push({ label: words.facts.snapshot, value: formatDateTime(count.snapshotAt, BUSINESS_TIME_ZONE, language) })
  if (count.countTeam) facts.push({ label: words.facts.team, value: count.countTeam })
  facts.push({ label: words.facts.lines, value: String(lines) })
  return facts
}

// ---- count sheets ---------------------------------------------------------------------------------------------------------

export interface SheetLine {
  readonly seq: number
  readonly location: string
  readonly itemCode: string
  readonly itemName: string
  readonly colour: string | null
  readonly lot: string | null
  readonly hide: string | null
  readonly expected: DecimalInput
  readonly uom: string
}

export interface SheetOptions {
  readonly language: DocumentLanguage
  /** Print what the ledger expects; false: a blind sheet. */
  readonly withExpected: boolean
  /** When the paper was made (its metadata). */
  readonly at: Date
}

export function countSheetPaper(count: PaperCount, lines: readonly SheetLine[], company: PaperCompany, options: SheetOptions): CountPaper {
  const { language } = options
  const words = WORDS[language]
  const c = words.columns
  const columns: PaperColumn[] = options.withExpected
    ? [
        { label: c.line, width: 50, align: 'right' },
        { label: c.location, width: 110, align: 'left' },
        { label: c.item, width: 110, align: 'left' },
        { label: c.description, width: 190, align: 'left' },
        { label: c.colour, width: 70, align: 'left' },
        { label: c.lot, width: 110, align: 'left' },
        { label: c.hide, width: 100, align: 'left' },
        { label: c.expected, width: 85, align: 'right' },
        { label: c.counted, width: 120, align: 'right' },
        { label: c.uom, width: 55, align: 'left' },
      ]
    : [
        { label: c.line, width: 50, align: 'right' },
        { label: c.location, width: 120, align: 'left' },
        { label: c.item, width: 120, align: 'left' },
        { label: c.description, width: 210, align: 'left' },
        { label: c.colour, width: 75, align: 'left' },
        { label: c.lot, width: 115, align: 'left' },
        { label: c.hide, width: 105, align: 'left' },
        { label: c.counted, width: 150, align: 'right' },
        { label: c.uom, width: 55, align: 'left' },
      ]
  const rows = lines.map((line) => {
    const cells = [String(line.seq), line.location, line.itemCode, line.itemName, line.colour ?? '', line.lot ?? '', line.hide ?? '']
    if (options.withExpected) cells.push(formatQuantity(quantityText(line.expected), language))
    cells.push('', line.uom)
    return cells
  })
  const title = `${words.sheetTitle} ${count.number}`
  return {
    language,
    title: words.sheetTitle,
    number: count.number,
    issuer: { name: company.name, lines: company.lines },
    banner: null,
    facts: headerFacts(count, language, lines.length),
    table: { columns, rows },
    totals: [],
    notes: [options.withExpected ? null : words.blind, lines.length === 0 ? words.empty : null].filter((note): note is NonNullable<typeof note> => note !== null),
    signatures: [...words.sheetSignatures],
    footer: { legal: company.legal, page: DOCUMENT_WORDS[language].page, continued: DOCUMENT_WORDS[language].continued },
    meta: { title, subject: words.kind[count.kind], createdAt: options.at.toISOString() },
  }
}

// ---- the valued list ------------------------------------------------------------------------------------------------------

export interface ValuedListLine {
  readonly itemId: string
  readonly itemCode: string
  readonly itemName: string
  readonly itemKind: string
  readonly uom: string
  readonly colour: string | null
  readonly lotId: string | null
  readonly lot: string | null
  readonly hideId: string | null
  /** What is held as of the inventory date: the final count, in the base unit. */
  readonly quantity: DecimalInput
  /** Per base unit; null: nothing gives one. */
  readonly unitCost: DecimalInput | null
  readonly method: ValuationMethod | null
  readonly currency: CurrencyCode
}

export interface ValuedListRow {
  readonly itemCode: string
  readonly itemName: string
  readonly itemKind: string
  readonly uom: string
  readonly colour: string | null
  readonly lot: string | null
  /** Hides counted in the row (leather), else 0. */
  readonly hides: number
  readonly quantity: string
  readonly unitCost: string | null
  readonly method: ValuationMethod | null
  /** quantity × unit cost, rounded once, in minor units; null without a cost. */
  readonly value: MinorUnits | null
  readonly currency: CurrencyCode
}

export interface ValuedListKind {
  readonly kind: string
  readonly rows: number
  /** The sum of its rows' values in the company's currency. */
  readonly value: MinorUnits
  readonly unvalued: number
}

export interface ValuedList {
  readonly currency: CurrencyCode
  readonly rows: readonly ValuedListRow[]
  readonly kinds: readonly ValuedListKind[]
  /** The sum of every row's value in the company's currency. */
  readonly total: MinorUnits
  /** Rows without a cost. */
  readonly unvalued: number
  /** Rows in another currency (not added). */
  readonly otherCurrency: number
}

const ORDER_OF_KINDS = ['LEATHER', 'TEXTILE', 'LINING', 'MEMBRANE', 'PADDING', 'THREAD', 'TRIM', 'HARDWARE', 'PROTECTOR', 'LABEL', 'PACKAGING', 'COMPONENT', 'FINISHED']
const kindRank = (kind: string): number => {
  const index = ORDER_OF_KINDS.indexOf(kind)
  return index === -1 ? ORDER_OF_KINDS.length : index
}

/**
 * The year-end valued list from the count's lines: per item, colour and lot (the hides of a lot summed, and counted),
 * only what is held; each row valued at its unit cost, rounded once; totals per kind of material and in all.
 */
export function valuedList(lines: readonly ValuedListLine[], companyCurrency: CurrencyCode): ValuedList {
  const groups = new Map<string, { first: ValuedListLine; quantity: Decimal; hides: number }>()
  for (const line of lines) {
    const quantity = new Dec(line.quantity)
    if (!quantity.greaterThan(0)) continue
    const key = [line.itemId, line.colour ?? '-', line.lotId ?? '-'].join('|')
    const group = groups.get(key)
    if (group) {
      group.quantity = group.quantity.plus(quantity)
      if (line.hideId) group.hides += 1
    } else groups.set(key, { first: line, quantity, hides: line.hideId ? 1 : 0 })
  }
  const rows: ValuedListRow[] = [...groups.values()]
    .map(({ first, quantity, hides }) => {
      const unitCost = first.unitCost === null ? null : new Dec(first.unitCost).toFixed(6)
      const value = unitCost === null ? null : toMinorUnits(quantity.times(unitCost), first.currency)
      return {
        itemCode: first.itemCode,
        itemName: first.itemName,
        itemKind: first.itemKind,
        uom: first.uom,
        colour: first.colour,
        lot: first.lot,
        hides,
        quantity: quantityText(quantity),
        unitCost,
        method: unitCost === null ? null : first.method,
        value: value === 0 ? 0 : value,
        currency: first.currency,
      }
    })
    .sort((a, b) => kindRank(a.itemKind) - kindRank(b.itemKind) || compare(a.itemCode, b.itemCode) || compare(a.colour ?? '', b.colour ?? '') || compare(a.lot ?? '', b.lot ?? ''))
  const kinds = new Map<string, { kind: string; rows: number; value: number; unvalued: number }>()
  let total = 0
  let unvalued = 0
  let otherCurrency = 0
  for (const row of rows) {
    const kind = kinds.get(row.itemKind) ?? { kind: row.itemKind, rows: 0, value: 0, unvalued: 0 }
    kinds.set(row.itemKind, kind)
    kind.rows += 1
    if (row.value === null) {
      kind.unvalued += 1
      unvalued += 1
    } else if (row.currency !== companyCurrency) otherCurrency += 1
    else {
      kind.value += row.value
      total += row.value
    }
  }
  return { currency: companyCurrency, rows, kinds: [...kinds.values()], total, unvalued, otherCurrency }
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export interface ValuedListOptions {
  readonly language: DocumentLanguage
  /** Before the sign-off: printed with a banner, never stored. */
  readonly preview: boolean
  /** The sign-off: when and by whom (a person's name inside the one record). */
  readonly signedOff: { readonly at: Date; readonly by: string } | null
  readonly at: Date
}

export function valuedListPaper(count: PaperCount, list: ValuedList, company: PaperCompany, options: ValuedListOptions): CountPaper {
  const { language } = options
  const words = WORDS[language]
  const c = words.columns
  const columns: PaperColumn[] = [
    { label: c.item, width: 100, align: 'left' },
    { label: c.description, width: 175, align: 'left' },
    { label: c.kind, width: 75, align: 'left' },
    { label: c.colour, width: 55, align: 'left' },
    { label: c.lot, width: 105, align: 'left' },
    { label: c.hides, width: 45, align: 'right' },
    { label: c.quantity, width: 85, align: 'right' },
    { label: c.uom, width: 40, align: 'left' },
    { label: c.unitCost, width: 85, align: 'right' },
    { label: c.method, width: 85, align: 'left' },
    { label: c.value, width: 150, align: 'right' },
  ]
  const rows = list.rows.map((row) => [
    row.itemCode,
    row.itemName,
    row.itemKind,
    row.colour ?? '',
    row.lot ?? '',
    row.hides > 0 ? String(row.hides) : '',
    formatQuantity(row.quantity, language),
    row.uom,
    row.unitCost === null ? words.noCost : formatUnitPrice(row.unitCost, language),
    row.method === null ? '' : words.method[row.method],
    row.value === null ? '' : formatMoney(row.value, row.currency, language),
  ])
  const totals = [
    ...list.kinds.map((kind) => ({ label: words.totalKind(kind.kind), value: formatMoney(kind.value, list.currency, language), strong: false })),
    { label: words.total, value: formatMoney(list.total, list.currency, language), strong: true },
  ]
  const facts = headerFacts(count, language, list.rows.length)
  if (options.signedOff) facts.push({ label: words.facts.signedOff, value: `${formatDateTime(options.signedOff.at, BUSINESS_TIME_ZONE, language)} · ${options.signedOff.by}` })
  const notes = [
    words.basis,
    list.unvalued > 0 ? words.unvalued(list.unvalued) : null,
    list.otherCurrency > 0 ? words.otherCurrency(list.otherCurrency) : null,
    list.rows.length === 0 ? words.empty : null,
    count.kind === 'YEAR_END' ? words.legalNote : null,
  ].filter((note): note is NonNullable<typeof note> => note !== null)
  const title = `${words.listTitle} ${count.number}`
  return {
    language,
    title: words.listTitle,
    number: count.number,
    issuer: { name: company.name, lines: company.lines },
    banner: options.preview ? words.preview : null,
    facts,
    table: { columns, rows },
    totals,
    notes,
    signatures: [...words.listSignatures],
    footer: { legal: company.legal, page: DOCUMENT_WORDS[language].page, continued: DOCUMENT_WORDS[language].continued },
    meta: { title, subject: words.kind[count.kind], createdAt: options.at.toISOString() },
  }
}

/** A cell of the valued list's spreadsheet: text, a quantity (four decimals) or an amount in minor units. */
export type SheetCell = string | { readonly quantity: string } | { readonly unitCost: string } | { readonly minor: MinorUnits; readonly currency: CurrencyCode } | null

/** The valued list as spreadsheet rows (the header first), in the paper's words. */
export function valuedListRows(list: ValuedList, language: DocumentLanguage): SheetCell[][] {
  const words = WORDS[language]
  const c = words.columns
  const header: SheetCell[] = [c.item, c.description, c.kind, c.colour, c.lot, c.hides, c.quantity, c.uom, c.unitCost, c.method, c.value]
  const rows: SheetCell[][] = list.rows.map((row) => [
    row.itemCode,
    row.itemName,
    row.itemKind,
    row.colour ?? '',
    row.lot ?? '',
    row.hides > 0 ? String(row.hides) : '',
    { quantity: row.quantity },
    row.uom,
    row.unitCost === null ? words.noCost : { unitCost: row.unitCost },
    row.method === null ? '' : words.method[row.method],
    row.value === null ? null : { minor: row.value, currency: row.currency },
  ])
  const totals: SheetCell[][] = [
    ...list.kinds.map((kind): SheetCell[] => [words.totalKind(kind.kind), '', '', '', '', '', null, '', null, '', { minor: kind.value, currency: list.currency }]),
    [words.total, '', '', '', '', '', null, '', null, '', { minor: list.total, currency: list.currency }],
  ]
  return [header, ...rows, [], ...totals]
}
