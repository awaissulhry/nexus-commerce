import type { WorkCentreKind } from '../../product/routing/operations'

/**
 * Keeping the factory's departments (owb-pd1 1.3; design § 5x "Manage departments", prototype prod.js `deptAdd`, `deptName`,
 * `deptClose`; S4 settle 7). Pure: what a new department gets, which tone it takes, when a name is free, and the words of every
 * refusal (English and Italian; apps/factory-api modules/production/departments sends the English words with the code at
 * `refusal/<code>`, the web shows its own words for the code).
 *
 *   new        a name only (the short name defaults to it); kind ASSEMBLY, icon circle-dot, not on the floor, the first of the ten
 *              grid tones no ACTIVE department uses (else slate), number = the highest ever given + 1 (never one used before),
 *              and its ONE default library operation DEPT-<number> in the same command.
 *   names      a name is free when no OTHER department (open or closed) answers to it as its name or its short name, letter case
 *              aside: two departments are never told apart by case alone.
 *   the floor  a department ready on the floor keeps its name and short name and never closes (the floor learnt it by that name;
 *              the database's G3 guard holds the name and the close too). Its names per language may still be given (the Urdu
 *              words a native reader checks).
 *   closed     a closed department keeps its names: it is opened again before a rename.
 */

/** The ten grid tones (owb-b1 G3, packages/ui --nds-grid-tone-*), in the order a new department takes the first free one. */
export const DEPARTMENT_TONES = ['slate', 'purple', 'emerald', 'pink', 'orange', 'blue', 'yellow', 'red', 'violet', 'cyan'] as const
export type DepartmentTone = (typeof DEPARTMENT_TONES)[number]

/** A name and a short name are 1 to 60 trimmed characters (the database's G3 rule). */
export const DEPARTMENT_NAME_MAX = 60

/** S4 settle 7: what a new department gets besides its name. */
export const NEW_DEPARTMENT: Readonly<{ workCentreKind: WorkCentreKind; icon: string; floorReady: boolean; fallbackTone: DepartmentTone }> = Object.freeze({
  workCentreKind: 'ASSEMBLY',
  icon: 'circle-dot',
  floorReady: false,
  fallbackTone: 'slate',
})

/** The first grid tone no ACTIVE department uses; all ten in use: slate. */
export function toneForNew(activeTones: readonly string[]): DepartmentTone {
  const used = new Set(activeTones)
  return DEPARTMENT_TONES.find((tone) => !used.has(tone)) ?? NEW_DEPARTMENT.fallbackTone
}

/** The next number: the highest ever given + 1 (a closed department keeps its number, so no number comes back). */
export function nextDepartmentNumber(numbers: readonly number[]): number {
  return numbers.reduce((top, number) => Math.max(top, number), 0) + 1
}

/** The code of a department's ONE default library operation (the seed's DEPT-1 … DEPT-9). */
export const defaultOperationCode = (number: number): string => `DEPT-${number}`

/** A name as it is kept: trimmed, every run of spaces made one. Empty: no name. */
export const cleanName = (value: string | null | undefined): string => (value ?? '').trim().replace(/\s+/g, ' ')

const folded = (value: string): string => value.toLocaleLowerCase('en')

export interface NamedDepartment {
  readonly id: string
  readonly name: string
  readonly shortName: string
}

/** The other department that already answers to `name` (its name or its short name, letter case aside), or null. */
export function nameTakenBy<Department extends NamedDepartment>(name: string, departments: readonly Department[], exceptId?: string): Department | null {
  const wanted = folded(cleanName(name))
  if (wanted === '') return null
  return departments.find((department) => department.id !== exceptId && (folded(department.name) === wanted || folded(department.shortName) === wanted)) ?? null
}

/** Why a department may not take these new names, or null (the order of the checks is the order of the words). */
export function renameRefusal(department: { readonly floorReady: boolean; readonly status: string; readonly name: string; readonly shortName: string }, next: { readonly name?: string | undefined; readonly shortName?: string | undefined }): DepartmentRefusal | null {
  const name = next.name === undefined ? undefined : cleanName(next.name)
  const shortName = next.shortName === undefined ? undefined : cleanName(next.shortName)
  if (name === '' || shortName === '') return 'NAME_EMPTY'
  const renamed = (name !== undefined && name !== department.name) || (shortName !== undefined && shortName !== department.shortName)
  if (!renamed) return null
  if (department.floorReady) return 'FLOOR_FIXED'
  if (department.status === 'CLOSED') return 'CLOSED'
  return null
}

/** Why a department may not close, or null. */
export const closeRefusal = (department: { readonly floorReady: boolean }): DepartmentRefusal | null => (department.floorReady ? 'FLOOR_FIXED' : null)

export const DEPARTMENT_REFUSAL_CODES = ['NAME_EMPTY', 'NAME_TAKEN', 'FLOOR_FIXED', 'CLOSED', 'CODE_TAKEN'] as const
export type DepartmentRefusal = (typeof DEPARTMENT_REFUSAL_CODES)[number]

/** The words of each refusal; CODE_TAKEN names the code ({code}). NAME_EMPTY is a 400, every other one a 409. */
export const DEPARTMENT_REFUSALS: Readonly<Record<DepartmentRefusal, { readonly en: string; readonly it: string }>> = Object.freeze({
  NAME_EMPTY: { en: 'A department needs a name.', it: 'Un reparto ha bisogno di un nome.' },
  NAME_TAKEN: { en: 'This name is used by another department.', it: 'Questo nome è già usato da un altro reparto.' },
  FLOOR_FIXED: { en: 'This department has screens on the floor: its name stays and it cannot be closed.', it: 'Questo reparto ha schermate in produzione: il nome resta e non si può chiudere.' },
  CLOSED: { en: 'This department is closed: open it again before you change its name.', it: 'Questo reparto è chiuso: riaprilo prima di cambiarne il nome.' },
  CODE_TAKEN: {
    en: 'The operation code {code} is used by another operation of the library: give that one another code first.',
    it: 'Il codice operazione {code} è già usato da un’altra operazione della libreria: dai prima un altro codice a quella.',
  },
})

/** A refusal's words in a language, with its facts filled in. */
export function departmentRefusalWords(code: DepartmentRefusal, language: 'en' | 'it' = 'en', facts: { readonly code?: string } = {}): string {
  return DEPARTMENT_REFUSALS[code][language].replace('{code}', facts.code ?? '')
}
