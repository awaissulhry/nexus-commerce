import type { Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { problemPartOf } from '@nexus/factory-domain/sales/portal-ordering/office'
import { customLineProblems, customLineShapeProblems, linePieces, type CustomLineFacts, type CustomLineInput, type CustomLineKind, type Problem, type Words } from '@nexus/factory-domain/sales/portal-ordering/rules'
import type { CommandTx } from '../../../core/command'
import type { CustomerCatalogue } from './catalogue'
import { draftFilesWhere, type DraftFileRow, type LineRow, type PersonRow, type Reader, type RequestRow } from './store'

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
  }
}

// ---- checking and writing ---------------------------------------------------------------------------------------------------

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/** A described or made-to-measure line against the customer's catalogue today and the garment types (400 issues; made to measure off is the caller's 409). */
export function checkCustomLine(line: CustomLineInput, catalogue: CustomerCatalogue, mtm: MadeToMeasure, at = 'body/line'): Issue[] {
  const issues: Issue[] = customLineShapeProblems(line).map((message) => ({ path: at, message }))
  const styleId = blankToNull(line.styleId)
  const style = styleId ? catalogue.styles.get(styleId) : undefined
  if (styleId) {
    // A described line names the customer's OWN label (its private-label style); a made-to-measure line any style of its catalogue.
    if (!style) issues.push({ path: `${at}/styleId`, message: 'Not a style of your catalogue.' })
    else if (line.kind === 'DESCRIBED' && !style.ownLabel) issues.push({ path: `${at}/styleId`, message: 'A described line names a style of your own label only (else pick it from the catalogue).' })
  }
  const colourwayId = blankToNull(line.colourwayId)
  if (style && colourwayId && !style.colourways.some((entry) => entry.id === colourwayId && entry.available)) issues.push({ path: `${at}/colourwayId`, message: `Not an available colour of ${style.code}.` })
  if (line.kind === 'MADE_TO_MEASURE' && blankToNull(line.garmentType) && !mtm.garmentTypes.some((type) => type.code === line.garmentType!.trim())) issues.push({ path: `${at}/garmentType`, message: 'Not a garment type we make to measure.' })
  return issues
}

/** The line's own columns as written but its kind (blanks as null; a made-to-measure line always by person, never a total). */
export function customLineData(line: CustomLineInput) {
  const mtm = line.kind === 'MADE_TO_MEASURE'
  return {
    description: blankToNull(line.description),
    colourText: blankToNull(line.colourText),
    styleId: blankToNull(line.styleId),
    colourwayId: blankToNull(line.colourwayId),
    garmentType: mtm ? blankToNull(line.garmentType) : null,
    quantity: mtm ? null : (line.quantity ?? null),
    byPerson: mtm ? true : line.byPerson === true,
    note: blankToNull(line.note),
  }
}

/** Writes a described or made-to-measure line and its sizes (partner scope, inside the draft's command). */
export async function insertCustomLine(tx: CommandTx, row: RequestRow, line: CustomLineInput, seq: number, actorId: string, now: Date): Promise<string> {
  const id = newId()
  await tx.portalOrderRequestLine.create({ data: { id, partyId: row.partyId, requestId: row.id, seq, kind: line.kind, ...customLineData(line), sourceOrderLineId: null, unitPriceShown: null, createdById: actorId, createdAt: now, updatedAt: now }, select: { id: true } })
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
