import type { Issue } from '../../core/errors'

/**
 * The clicking-die register (B-W2b-136; QHS-173; design plant.machines "Clicking dies": cutting dies per style, size and
 * piece), pure. A die is a steel shape the clicking press pushes through the leather: its number is stamped on it, it
 * cuts one piece of one style, in one size or in every size, and it hangs on a rack of the cutting room. The office keeps
 * the register (plant.machines.manage; plant.view reads); its cost is the cost grain's only; the floor reads the dies of
 * its site without their cost. Nothing here measures a person.
 *
 * The database (`…_plant_care_w2b_guards`, factory_clicking_die_guard) holds the same rules for every login: the company,
 * number, style and creation never change; a die is registered in use and RETIRED later, and a RETIRED die changes only
 * its note; a number without spaces, the piece in words, a size of the style's range, words not blank, a cost from 0;
 * never deleted.
 *
 * Owner question Q17 (is leather cut with a clicking press?) is open: the plan's default (knife and/or press) builds the
 * register; every part of it lives in its own files (this one, src/plant-dies/events.ts, apps/factory-api modules/plant/dies,
 * apps/factory-web areas/plant/machines/dies) so the lead can drop it in one cut.
 */

export const DIE_CONDITIONS = ['GOOD', 'WORN', 'DAMAGED', 'RETIRED'] as const
export type DieCondition = (typeof DIE_CONDITIONS)[number]

/** The conditions a person sets by hand (inline): RETIRED only through Retire. */
export const DIE_SETTABLE_CONDITIONS = ['GOOD', 'WORN', 'DAMAGED'] as const
export type DieSettableCondition = (typeof DIE_SETTABLE_CONDITIONS)[number]

/** The register's saved rows: in use (good, worn, damaged), worn or damaged (plan a new one), retired, all. */
export const DIE_ROWS = ['inUse', 'worn', 'retired', 'all'] as const
export type DieRows = (typeof DIE_ROWS)[number]

/** The conditions each saved row lists. */
export const DIE_ROW_CONDITIONS: Readonly<Record<DieRows, readonly DieCondition[]>> = Object.freeze({
  inUse: ['GOOD', 'WORN', 'DAMAGED'],
  worn: ['WORN', 'DAMAGED'],
  retired: ['RETIRED'],
  all: DIE_CONDITIONS,
})

export const DIE_LIMITS = Object.freeze({ code: 40, piece: 120, rackLocation: 120, material: 80, note: 1000, reason: 500, size: 20 })

/** The cost a die may carry, in minor units (from 0; a die costs well under a million euro). */
export const DIE_MAX_COST = 100_000_000

/** The number as stamped: upper case, no spaces (the DB refuses a space). */
export const normalDieCode = (value: string): string => value.trim().toUpperCase().replace(/\s+/g, '')

/** A die number: letters, digits, `-`, `_`, `/`, `.`; from a letter or digit. */
export const DIE_CODE = /^[A-Z0-9][A-Z0-9\-_/.]*$/

export interface DieDraft {
  readonly code?: string | undefined
  readonly piece?: string | undefined
  readonly size?: string | null | undefined
  readonly rackLocation?: string | null | undefined
  readonly material?: string | null | undefined
  readonly purchaseCost?: number | null | undefined
  readonly note?: string | null | undefined
}

const blank = (value: string | null | undefined): boolean => value !== undefined && value !== null && value.trim() === ''

/**
 * What is wrong with a die as typed (paths without `body/`): a number when creating (upper case, no spaces once
 * normalised), the piece in words, words not blank when given, a cost from 0 in whole minor units. `creating` asks the
 * number and the piece; a change checks what it sends.
 */
export function dieDraftProblems(draft: DieDraft, creating: boolean): Issue[] {
  const problems: Issue[] = []
  if (creating || draft.code !== undefined) {
    const code = normalDieCode(draft.code ?? '')
    if (code === '') problems.push({ path: 'code', message: 'Give the number stamped on the die.' })
    else if (code.length > DIE_LIMITS.code) problems.push({ path: 'code', message: `At most ${DIE_LIMITS.code} characters.` })
    else if (!DIE_CODE.test(code)) problems.push({ path: 'code', message: 'Letters, digits, - _ / . only.' })
  }
  if (creating || draft.piece !== undefined) {
    const piece = (draft.piece ?? '').trim()
    if (piece === '') problems.push({ path: 'piece', message: 'Say the piece it cuts, as the pattern names it ("Front left").' })
    else if (piece.length > DIE_LIMITS.piece) problems.push({ path: 'piece', message: `At most ${DIE_LIMITS.piece} characters.` })
  }
  if (blank(draft.size)) problems.push({ path: 'size', message: 'Pick a size of the style, or none for every size.' })
  if (blank(draft.rackLocation)) problems.push({ path: 'rackLocation', message: 'Say where the die hangs, or leave it empty.' })
  else if ((draft.rackLocation ?? '').length > DIE_LIMITS.rackLocation) problems.push({ path: 'rackLocation', message: `At most ${DIE_LIMITS.rackLocation} characters.` })
  if (blank(draft.material)) problems.push({ path: 'material', message: 'Say what it is made of, or leave it empty.' })
  else if ((draft.material ?? '').length > DIE_LIMITS.material) problems.push({ path: 'material', message: `At most ${DIE_LIMITS.material} characters.` })
  if (draft.purchaseCost !== undefined && draft.purchaseCost !== null && (!Number.isSafeInteger(draft.purchaseCost) || draft.purchaseCost < 0 || draft.purchaseCost > DIE_MAX_COST)) {
    problems.push({ path: 'purchaseCost', message: 'A cost from 0, in cents.' })
  }
  if ((draft.note ?? '').length > DIE_LIMITS.note) problems.push({ path: 'note', message: `At most ${DIE_LIMITS.note} characters.` })
  return problems
}

// ---- refusals ----------------------------------------------------------------------------------------------------------

export const DIE_REFUSALS = ['DIE_RETIRED', 'DIE_NUMBER_TAKEN', 'SIZE_NOT_IN_STYLE', 'PIECE_OTHER_STYLE', 'CONDITION_RETIRED_BY_RETIRE', 'STYLE_UNKNOWN'] as const
export type DieRefusalCode = (typeof DIE_REFUSALS)[number]

export interface DieRefusal {
  readonly code: DieRefusalCode
  /** What happened and why, in words. */
  readonly message: string
  /** The one thing to do about it. */
  readonly fix: string
}

export const dieRefusal = {
  retired: (code: string): DieRefusal => ({ code: 'DIE_RETIRED', message: `Die ${code} is retired: only its note changes (it stays for its history).`, fix: 'Register a new die if the piece is still cut.' }),
  numberTaken: (code: string): DieRefusal => ({ code: 'DIE_NUMBER_TAKEN', message: `Die number ${code} is taken: every die carries its own number.`, fix: 'Check the number stamped on the die, or give it a new one.' }),
  sizeNotInStyle: (size: string, style: string): DieRefusal => ({ code: 'SIZE_NOT_IN_STYLE', message: `Size ${size} is not in the size range of style ${style}.`, fix: 'Pick one of the style\'s sizes, or none for a die that cuts every size.' }),
  pieceOtherStyle: (style: string): DieRefusal => ({ code: 'PIECE_OTHER_STYLE', message: `That pattern piece is not one of style ${style}.`, fix: 'Pick a piece of the die\'s own style, or none.' }),
  retiredByRetire: (): DieRefusal => ({ code: 'CONDITION_RETIRED_BY_RETIRE', message: 'A die is retired with Retire, with the reason.', fix: 'Use Retire on the die.' }),
  styleUnknown: (): DieRefusal => ({ code: 'STYLE_UNKNOWN', message: 'That style is not one of the group\'s styles.', fix: 'Pick the style the die cuts.' }),
}

/** The size given: one of the style's sizes, or null (every size). */
export const sizeFits = (size: string | null, styleSizes: readonly string[]): boolean => size === null || styleSizes.includes(size)

/** Is the condition one a person sets by hand? */
export const isSettableCondition = (value: string): value is DieSettableCondition => (DIE_SETTABLE_CONDITIONS as readonly string[]).includes(value)

/** The note after a retirement: the reason added on its own line (the note keeps what was there). */
export function retiredNote(note: string | null, reason: string, day: string): string {
  const line = `Retired ${day}: ${reason.trim()}`
  const next = note && note.trim() !== '' ? `${note.trim()}\n${line}` : line
  return next.length > DIE_LIMITS.note ? next.slice(next.length - DIE_LIMITS.note) : next
}

/** The fields a change touches (the event names them; never their values). */
export const DIE_CHANGEABLE = ['size', 'piece', 'patternPieceId', 'rackLocation', 'material', 'supplierId', 'purchaseCost', 'condition', 'note'] as const
export type DieChangeable = (typeof DIE_CHANGEABLE)[number]

/** A RETIRED die may change only these. */
export const RETIRED_DIE_CHANGEABLE: readonly DieChangeable[] = ['note']
