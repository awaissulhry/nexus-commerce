import type { Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { problemPartOf } from '@nexus/factory-domain/sales/portal-ordering/office'
import { customLineProblems, customLineShapeProblems, linePieces, type CustomLineFacts, type CustomLineInput, type CustomLineKind, type Problem, type Words } from '@nexus/factory-domain/sales/portal-ordering/rules'
import type { CommandTx } from '../../../core/command'
import type { CustomerCatalogue } from './catalogue'
import { draftFilesWhere, type DraftFileRow, type LineRow, type PersonRow, type Reader, type RequestRow } from './store'
// B-CP-076: "Your price" on a described or made-to-measure line (the price grain).
import { asMoney } from '@nexus/factory-domain/money/marked'
import { priceShown } from '@nexus/factory-domain/sales/portal-ordering/rules'
import { priceOrNull } from './store'
// od-s s.4 (addendum R3, the products table): a row's sizing and its open choices (names only).
import { choicesOf, choicesRow, type DraftChoice } from '@nexus/factory-domain/sales/portal-ordering/choices'
import type { Prisma } from '@nexus/factory-db'
import { stillOpenOf, type ConfirmTyped, type StillOpen } from '@nexus/factory-domain/sales/portal-ordering/still-open'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { dayText } from './store'

/**
 * B-CP-075 (customer page plan C5; 12 §2 parts 1 and 4; review A5, F1, F2): a draft's lines of the customer's own kinds — DESCRIBED
 * (its words, colours in words, maybe its own private-label style, a total) and MADE_TO_MEASURE (a garment type, maybe a style of its
 * catalogue, always by person) — and the people of a by-person line (a name, maybe a number, measured by a size, a measurement
 * sheet of the draft, or later). This module reads, checks, shows and writes them; the routes are ./requests.ts' (every write is a
 * draft command at the draft's version: one rule for every part). Kept apart from ./requests.ts and ./office.ts (both read it).
 *
 *   made to measure   open for the customer while PortalSettings.mtmDraftsOn (on by default, the lead's pick; drafts only — a
 *                     quote or an order made to measure follows GATE-MTM); the garment types are the ACTIVE measurement
 *                     templates of the company (or every company). Both are the office's tables: read in the tenant's scope.
 *   a measurement     a person measured by SHEET names a MEASUREMENTS file of this very draft (its own or one of its lines'), of
 *   sheet             its party, not deleted — another draft's, another customer's or a logo is "File not found." (W-CP-3); in the
 *                     office the sheet is named only with sales.measurements.view (else a lock without a name)
 *   "saved by"        the party's own person who saved the draft last (a display name; never an id, an e-mail or an office name)
 */

export type MadeToMeasure = { readonly open: boolean; readonly garmentTypes: readonly { readonly code: string; readonly words: Words }[] }

/** Whether the customer may keep made-to-measure lines, and the garment types it may choose (the tenant's scope: the office's tables). */
export async function madeToMeasureOf(db: Reader, companyId: string, partyId: string): Promise<MadeToMeasure> {
  const settings = await db.portalSettings.findUnique({ where: { id: partyId }, select: { mtmDraftsOn: true } })
  const templates = await db.measurementTemplate.findMany({ where: { status: 'ACTIVE', OR: [{ companyId: null }, { companyId }] }, select: { code: true, name: true, nameI18n: true }, orderBy: [{ code: 'asc' }] })
  const words = (row: (typeof templates)[number]): Words => {
    const named = (row.nameI18n ?? {}) as { it?: string; en?: string }
    return { it: named.it ?? row.name, en: named.en ?? row.name }
  }
  // A party with no portal settings row keeps the column's default (on).
  return { open: settings?.mtmDraftsOn ?? true, garmentTypes: templates.map((row) => ({ code: row.code, words: words(row) })) }
}

/** The display name of one of the party's own portal people (never an office person, an id or an e-mail); null: none or unknown. */
export async function colleagueNameOf(db: Reader, partyId: string, userId: string | null): Promise<string | null> {
  if (userId === null || !isUuid(userId)) return null
  const person = await db.user.findFirst({ where: { id: userId, partyId, audience: 'PARTNER' }, select: { displayName: true } })
  return person?.displayName ?? null
}

// ---- reading the lines and their people ---------------------------------------------------------------------------------------

export const isCustomLine = (line: LineRow): line is LineRow & { readonly kind: CustomLineKind } => line.kind === 'DESCRIBED' || line.kind === 'MADE_TO_MEASURE'

/** The lines of a draft that hold a measurement sheet (it stands for their roster). */
export const sheetLinesOf = (files: readonly Pick<DraftFileRow, 'recordType' | 'recordId' | 'category'>[]): Set<string> =>
  new Set(files.filter((file) => file.recordType === 'PortalOrderRequestLine' && file.category === 'MEASUREMENTS').map((file) => file.recordId))

/** A line's pieces by its kind (its people, a described total, its sizes). */
export const piecesOfLine = (line: LineRow, people: readonly PersonRow[]): number =>
  linePieces({ kind: line.kind, quantity: line.quantity, sizes: line.sizes, byPerson: line.byPerson, people: people.filter((person) => person.lineId === line.id).length })

/** The facts of a described or made-to-measure line the domain judges (its problems). */
export function customLineFactsOf(line: LineRow & { readonly kind: CustomLineKind }, people: readonly PersonRow[], sheetLines: ReadonlySet<string>, catalogue: CustomerCatalogue, mtm: MadeToMeasure): CustomLineFacts {
  const own = people.filter((person) => person.lineId === line.id)
  const style = line.styleId ? catalogue.styles.get(line.styleId) : undefined
  const code = line.styleId ? catalogue.codes.get(line.styleId) : undefined
  const colourway = line.colourwayId ? style?.colourways.find((entry) => entry.id === line.colourwayId) : undefined
  return {
    id: line.id,
    kind: line.kind,
    quantity: line.quantity,
    sizes: line.sizes.map((size) => ({ size: size.size, quantity: size.quantity })),
    byPerson: line.byPerson,
    people: own.map((person) => ({ id: person.id, size: person.measureBy === 'SIZE' ? person.size : null })),
    sheetOnLine: sheetLines.has(line.id),
    style: line.styleId ? { code: code?.code ?? '', sold: style !== undefined, range: style?.range ?? [] } : null,
    colourway: line.colourwayId ? { name: colourway?.name ?? catalogue.colourways.get(line.colourwayId)?.name ?? '', active: colourway?.available ?? false } : null,
    mtmOpen: mtm.open,
    garmentType: line.garmentType ? { code: line.garmentType, active: mtm.garmentTypes.some((type) => type.code === line.garmentType) } : null,
  }
}

/** A problem as the answers show it: its part of the checklist, the line, the size and the person it is on. */
export const problemView = (problem: Problem) => ({ code: problem.code, part: problemPartOf(problem), lineId: problem.lineId, size: problem.size, personId: problem.personId ?? null, words: problem.words })

/** How a person's measurement sheet is shown: the customer's own (named); the office's without sales.measurements.view (locked, no name). */
export type SheetOf = (fileId: string) => { readonly id: string; readonly originalName: string | null; readonly locked: boolean } | null

export const personView = (person: PersonRow, sheetOf: SheetOf) => ({
  id: person.id,
  seq: person.seq,
  version: person.version,
  name: person.name,
  number: person.number,
  measureBy: person.measureBy,
  size: person.size,
  sheet: person.measurementFileId ? sheetOf(person.measurementFileId) : null,
  note: person.note,
})

/** A described or made-to-measure line as the customer and the office read it (one shape; the office's sheets may be locked). */
export function customLineView(line: LineRow & { readonly kind: CustomLineKind }, people: readonly PersonRow[], sheetLines: ReadonlySet<string>, catalogue: CustomerCatalogue, mtm: MadeToMeasure, sheetOf: SheetOf) {
  const own = people.filter((person) => person.lineId === line.id)
  const code = line.styleId ? catalogue.codes.get(line.styleId) : undefined
  const colourway = line.colourwayId ? catalogue.colourways.get(line.colourwayId) : undefined
  const garment = line.garmentType ? mtm.garmentTypes.find((type) => type.code === line.garmentType) : undefined
  return {
    id: line.id,
    seq: line.seq,
    version: line.version,
    kind: line.kind,
    description: line.description,
    colourText: line.colourText,
    style: line.styleId ? { id: line.styleId, code: code?.code ?? '', name: code?.name ?? '' } : null,
    colourway: line.colourwayId ? { id: line.colourwayId, code: colourway?.code ?? '', name: colourway?.name ?? '' } : null,
    garmentType: line.garmentType ? { code: line.garmentType, words: garment?.words ?? { it: line.garmentType, en: line.garmentType } } : null,
    quantity: line.quantity,
    sizes: line.sizes.map((size) => ({ size: size.size, quantity: size.quantity })),
    byPerson: line.byPerson,
    pieces: piecesOfLine(line, people),
    people: own.map((person) => personView(person, sheetOf)),
    /** By person with no one typed and a measurement sheet on the line: "People: in the attached sheet". */
    peopleInSheet: line.byPerson && own.length === 0 && sheetLines.has(line.id),
    note: line.note,
    problems: customLineProblems(customLineFactsOf(line, people, sheetLines, catalogue, mtm)).map(problemView),
    brandUnitPrice: ownPriceView(line), // B-CP-076
    sizing: line.sizing, // od-s s.4: null = not decided yet
    choices: choicesOf(line.choices), // od-s s.4: null = none
  }
}

// ---- B-CP-076 (customer page plan 11 §1.3 D3): the customer's own net unit price of a line, as the answers show it (price grain) ----
export const ownPriceView = (line: Pick<LineRow, 'brandUnitPrice'>) => {
  const price = priceOrNull(line.brandUnitPrice)
  return asMoney('price', price === null ? null : priceShown(price))
}
/** "Your price" as a body sends it: absent keeps it, null clears it (only a person with the price grain sends it: the grain filter). */
export type OwnPriced = { readonly brandUnitPrice?: string | null | undefined }
// ---- end B-CP-076

// ---- checking and writing ---------------------------------------------------------------------------------------------------

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/** A described or made-to-measure line against the customer's catalogue today and the garment types (400 issues; made to measure off is the caller's 409). */
export function checkCustomLine(line: CustomLineInput, catalogue: CustomerCatalogue, mtm: MadeToMeasure, at = 'body/line'): Issue[] {
  const issues: Issue[] = customLineShapeProblems(line).map((message) => ({ path: at, message }))
  const styleId = blankToNull(line.styleId)
  const style = styleId ? catalogue.styles.get(styleId) : undefined
  if (styleId) {
    // od-s s.4 (addendum R3): a product row names any style of the customer's catalogue (the open range or its own label; never
    // another customer's own label: the catalogue holds only what may be offered to this customer).
    if (!style) issues.push({ path: `${at}/styleId`, message: 'Not a style of your catalogue.' })
  }
  const colourwayId = blankToNull(line.colourwayId)
  if (style && colourwayId && !style.colourways.some((entry) => entry.id === colourwayId && entry.available)) issues.push({ path: `${at}/colourwayId`, message: `Not an available colour of ${style.code}.` })
  // owb- po1.3 (S1 lead): a DESCRIBED line ("A new design: <kind>") names one of the same garment types as a made-to-measure one.
  if (blankToNull(line.garmentType) && !mtm.garmentTypes.some((type) => type.code === line.garmentType!.trim())) issues.push({ path: `${at}/garmentType`, message: line.kind === 'MADE_TO_MEASURE' ? 'Not a garment type we make to measure.' : 'Not a garment type we make.' })
  return issues
}

/**
 * The line's own columns as written but its kind (blanks as null; a made-to-measure line always by person, never a total). od-s
 * s.4: its sizing (a made-to-measure line is sized MADE_TO_MEASURE: the line guard). Its choices are written by `writeChoices`.
 */
export function customLineData(line: Omit<CustomLineInput, 'choices'>) {
  const mtm = line.kind === 'MADE_TO_MEASURE'
  return {
    description: blankToNull(line.description),
    colourText: blankToNull(line.colourText),
    styleId: blankToNull(line.styleId),
    colourwayId: blankToNull(line.colourwayId),
    garmentType: blankToNull(line.garmentType), // owb- po1.3: a described line keeps its garment type too ("A new design: <kind>")
    quantity: mtm ? null : (line.quantity ?? null),
    byPerson: mtm ? true : line.byPerson === true,
    note: blankToNull(line.note),
    // od-s s.1 (the line guard): a made-to-measure line is sized MADE_TO_MEASURE (the guard refuses it otherwise); od-s s.4: else the
    // sizing asked (STANDARD, or null: not decided yet), kept when the input names none.
    ...(mtm ? { sizing: 'MADE_TO_MEASURE' as const } : line.sizing !== undefined ? { sizing: line.sizing === 'MADE_TO_MEASURE' ? null : line.sizing } : {}),
  }
}

// ---- od-s s.4 (addendum R3): "Still open" of a draft (information only: it never holds Send), for both doors' reads ----------------
/** The draft's delivery address is in use: its own, active; or none named and the customer has an active default one. */
export const shipToInUseOf = (row: Pick<RequestRow, 'shipToAddressId'>, addresses: readonly { readonly id: string; readonly status: string; readonly isDefaultShipTo: boolean }[]): boolean =>
  row.shipToAddressId !== null ? addresses.some((address) => address.id === row.shipToAddressId && address.status === 'ACTIVE') : addresses.some((address) => address.isDefaultShipTo && address.status === 'ACTIVE')

/** Each row's people's sizes in roster order (null: by a sheet, or later). */
export const peopleSizesOf = (line: Pick<LineRow, 'id'>, people: readonly PersonRow[]): (string | null)[] => people.filter((person) => person.lineId === line.id).map((person) => (person.measureBy === 'SIZE' ? person.size : null))

/** The draft's Still open list (`typed`: the Confirm's body per row — what is still open after it is MISSING). */
export function draftStillOpen(lines: readonly LineRow[], people: readonly PersonRow[], row: Pick<RequestRow, 'requestedDate'>, shipToInUse: boolean, today: BusinessDate, typed?: ReadonlyMap<string, ConfirmTyped>, /* od-fx7 */ sheetLines?: ReadonlySet<string>): StillOpen {
  return stillOpenOf(
    {
      // od-fx7 (walk W-04): + what the row holds in the customer's terms (its words, colours in words, a total, a sheet on it).
      lines: lines.map((line) => ({ id: line.id, seq: line.seq, kind: line.kind, styleId: line.styleId, colourwayId: line.colourwayId, sizing: line.sizing, sizes: line.sizes.map((size) => ({ size: size.size, quantity: size.quantity })), byPerson: line.byPerson, peopleSizes: peopleSizesOf(line, people), choices: choicesOf(line.choices), ownWords: line.description ?? line.garmentType, colourText: line.colourText, quantity: line.quantity, sheetOnLine: sheetLines?.has(line.id) ?? false })),
      requestedDate: dayText(row.requestedDate),
      today,
      shipToInUse,
    },
    typed,
  )
}
// ---- end od-s s.4

// ---- od-s s.4 (addendum R3): a row's open choices, names only (null: none). factory-db exports Prisma's types, not its runtime DbNull:
// a JSON column is cleared in SQL (as modules/sales/terms does).
/** The `choices` column's value for a create or an update (none: the key left out, the column stays as it is or null). */
export function choicesData(choices: readonly DraftChoice[] | null | undefined): { choices?: Prisma.InputJsonValue } {
  const row = choicesRow(choices)
  return row === null ? {} : { choices: row as unknown as Prisma.InputJsonValue }
}

/** Inside a draft command: the row's choices as asked (undefined: kept; null or []: cleared, in SQL). */
export async function writeChoices(tx: CommandTx, lineId: string, choices: readonly DraftChoice[] | null | undefined): Promise<void> {
  if (choices === undefined) return
  const row = choicesRow(choices)
  if (row === null) await tx.$executeRaw`UPDATE "PortalOrderRequestLine" SET "choices" = NULL WHERE "id" = ${lineId}::uuid AND "choices" IS NOT NULL`
  else await tx.portalOrderRequestLine.update({ where: { id: lineId }, data: { choices: row as unknown as Prisma.InputJsonValue }, select: { id: true } })
}
// ---- end od-s s.4

/** Writes a described or made-to-measure line and its sizes (partner scope, inside the draft's command). */
export async function insertCustomLine(tx: CommandTx, row: Pick<RequestRow, 'id' | 'partyId'>, line: CustomLineInput & OwnPriced /* B-CP-076 */, seq: number, actorId: string, now: Date): Promise<string> {
  const id = newId()
  await tx.portalOrderRequestLine.create({ data: { id, partyId: row.partyId, requestId: row.id, seq, kind: line.kind, ...customLineData(line), ...choicesData(line.choices) /* od-s s.4 */, sourceOrderLineId: null, unitPriceShown: null, brandUnitPrice: line.brandUnitPrice ?? null /* B-CP-076 */, createdById: actorId, createdAt: now, updatedAt: now }, select: { id: true } })
  const sizes = line.sizes ?? []
  if (sizes.length > 0) await tx.portalOrderRequestSize.createMany({ data: sizes.map((ask) => ({ id: newId(), partyId: row.partyId, lineId: id, size: ask.size.trim(), quantity: ask.quantity, createdById: actorId, createdAt: now, updatedAt: now })) })
  return id
}

/** Whether a file is a measurement sheet of this very draft (its own or one of its lines'), of its party, not deleted (W-CP-3). */
export async function isDraftSheet(db: Reader, row: Pick<RequestRow, 'id' | 'partyId'>, lineIds: readonly string[], fileId: string): Promise<boolean> {
  if (!isUuid(fileId)) return false
  const file = await db.storedFile.findFirst({ where: { AND: [draftFilesWhere([row.id], lineIds), { id: fileId, partyId: row.partyId, category: 'MEASUREMENTS' }] }, select: { id: true } })
  return file !== null
}

/** The measurement sheets the customer reads by name (its own draft files). */
export const ownSheetOf = (files: readonly Pick<DraftFileRow, 'id' | 'originalName'>[]): SheetOf => {
  const names = new Map(files.map((file) => [file.id, file.originalName]))
  return (fileId) => (names.has(fileId) ? { id: fileId, originalName: names.get(fileId)!, locked: false } : null)
}
