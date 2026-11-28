/**
 * owb-b4 w4.2 (order workflow build; design plan § 5x, § 5zl "a department chip: ONE name in every door, the short one; the long name is
 * the hint"; PL-schema § 2) — the department parts' pure side: a department as the parts draw it, the fixed table of the nine (shown
 * until `GET /production/departments` answers), the route's step states and the strip's columns.
 *
 * A department is DATA (the `Department` table: a number kept for ever, a tone of the ten DS group tones, a lucide icon id, names per
 * language). The parts never take a work-centre kind: the server bridges kinds to departments (`departmentOfKind`). Owner after the
 * base: S4 (PL-split § 3). Pure: no React, no API.
 */

/** The ten DS group tones (`--nds-grid-tone-<tone>-{bg,fg,rule}`, packages/ui tokens.css): the only colours a department takes. */
export const DEPARTMENT_TONES = ['slate', 'purple', 'emerald', 'pink', 'orange', 'blue', 'yellow', 'red', 'violet', 'cyan'] as const
export type DepartmentTone = (typeof DEPARTMENT_TONES)[number]

/** A department as every part draws it (office, portal, floor). Never a kind. */
export interface Department {
  /** Its number, kept for ever (the number on its wall). */
  readonly no: number
  readonly tone: DepartmentTone
  /** A lucide icon id, kebab case (`scissors`, `shield-check`); an unknown id draws a plain dot. */
  readonly icon: string
  /** The long name in the page's language: the chip's hint. */
  readonly name: string
  /** The ONE short name every chip says. */
  readonly shortName: string
  /** The Urdu name for the floor (a draft until a reader of Urdu checked it); absent: none yet. */
  readonly nameUr?: string
  /** The server's id (`RoutingOperation.departmentId` names it); null: the fixed table's (nothing read yet). */
  readonly id?: string | null
  /** A closed department: kept, drawn on old routes, offered for no new step. */
  readonly closed?: boolean
}

/** A tone the server names, or slate for one the parts do not know (never a raw colour). */
export const departmentToneOf = (tone: string | null | undefined): DepartmentTone => ((DEPARTMENT_TONES as readonly string[]).includes(tone ?? '') ? (tone as DepartmentTone) : 'slate')

/** The class that sets `--fw-dept-bg` / `--fw-dept-fg` / `--fw-dept-rule` for a tone (department.css). */
export const departmentToneClass = (tone: DepartmentTone): string => `fw-dept-tone-${tone}`

// ---- the fixed table of the nine (the seed's; owb-b1 a.6) ----------------------------------------------------------------------

/** The look of each seeded department; its names are the catalogue's (`department:fixed.<no>.name|short`). */
export interface FixedDepartment {
  readonly no: number
  readonly tone: DepartmentTone
  readonly icon: string
}

/** The nine of the seed, in their order: drawn until the read answers (the server's names then replace the catalogue's). */
export const FIXED_DEPARTMENTS: readonly FixedDepartment[] = Object.freeze([
  { no: 1, tone: 'blue', icon: 'ruler' },
  { no: 2, tone: 'orange', icon: 'scissors' },
  { no: 3, tone: 'pink', icon: 'layers' },
  { no: 4, tone: 'cyan', icon: 'shirt' },
  { no: 5, tone: 'purple', icon: 'shield-check' },
  { no: 6, tone: 'yellow', icon: 'package' },
  { no: 7, tone: 'violet', icon: 'pen-tool' },
  { no: 8, tone: 'slate', icon: 'cylinder' },
  { no: 9, tone: 'emerald', icon: 'puzzle' },
])

/** The fixed table as departments, its names from the catalogue (`say` = the department catalogue's translator). */
export function fixedDepartments(say: (key: string) => string): Department[] {
  return FIXED_DEPARTMENTS.map((fixed) => ({ ...fixed, name: say(`fixed.${fixed.no}.name`), shortName: say(`fixed.${fixed.no}.short`), id: null }))
}

// ---- the server's answer → a department -----------------------------------------------------------------------------------------

/** One row of `GET /production/departments` as the web reads it (use-departments.ts parses it with its own zod). */
export interface DepartmentAnswer {
  readonly id: string
  readonly number: number
  readonly name: string
  readonly shortName?: string | null
  readonly nameI18n?: Readonly<Record<string, string>> | null
  readonly tone: string
  readonly icon: string
  readonly status?: 'ACTIVE' | 'CLOSED' | null
  // ---- owb-pd6 (S4, the route builder): read by the builder only, never drawn by a chip (a chip never takes a kind).
  /** The kind of work centre it runs at: the builder's live rules ask "is the last step Packing?" and "is there a quality check?". */
  readonly workCentreKind?: string
  /** It has screens on the floor: its name stays and it cannot be closed (design § 5x). */
  readonly floorReady?: boolean
  /** Its place in the factory's ONE order of departments. */
  readonly seq?: number
  /** Sent back with a rename, a close or an open (production.departments.manage). */
  readonly version?: number
}

/**
 * A department of the answer in a language: its long name in that language (`nameI18n[locale]`, else `name`); its short name the
 * server's `shortName` in English, in another language the language's name (the server keeps one short name, in English), else the
 * long name; the Urdu name from `nameI18n.ur`.
 */
export function departmentOfAnswer(row: DepartmentAnswer, locale: string): Department {
  const names = row.nameI18n ?? {}
  const name = names[locale]?.trim() || row.name
  const short = locale === 'en' ? row.shortName?.trim() || name : names[locale]?.trim() || row.shortName?.trim() || name
  const ur = names.ur?.trim()
  return { no: row.number, tone: departmentToneOf(row.tone), icon: row.icon, name, shortName: short, ...(ur ? { nameUr: ur } : {}), id: row.id, ...(row.status === 'CLOSED' ? { closed: true } : {}) }
}

/** The department with this number in a list, or null (a number no list names: the parts draw "Department <no>"). */
export const departmentByNo = (list: readonly Department[], no: number | null | undefined): Department | null => (no == null ? null : (list.find((dept) => dept.no === no) ?? null))

/** A department no list names (an old number, a read not answered): its number in words, slate, a plain dot. */
export const unknownDepartment = (no: number, words: string): Department => ({ no, tone: 'slate', icon: '', name: words, shortName: words, id: null })

// ---- the route bar ---------------------------------------------------------------------------------------------------------------

/** Where a step of a route stands: left behind, the current one (drawn strong), still to come. */
export type DeptStepState = 'done' | 'now' | 'next'

/**
 * The steps of a route with their state. `current`: the index of the step the basket (or the slowest basket) is at; null: not started
 * (every step to come); at or past the end: every step done.
 */
export function routeStepsOf(route: readonly Department[], current: number | null): { readonly dept: Department; readonly state: DeptStepState }[] {
  return route.map((dept, index) => ({ dept, state: current === null ? 'next' : index < current ? 'done' : index === current ? 'now' : 'next' }))
}

// ---- the strip --------------------------------------------------------------------------------------------------------------------

/**
 * The strip's columns in a middle room (design round 36: "3 + 3"): up to four departments in rows of two, five or six in rows of three,
 * seven or eight in rows of four, more in rows of a third. A narrow room has two; a wide one as many as fit (department.css).
 */
export function stripColumnsOf(count: number): number {
  if (count <= 4) return 2
  if (count <= 6) return 3
  if (count <= 8) return 4
  return Math.ceil(count / 3)
}

/** From this room (CSS px) the strip fits as many tiles a row as it holds (one row for the nine); under STRIP_NARROW_PX two a row (department.css). */
export const STRIP_ONE_ROW_PX = 960
export const STRIP_NARROW_PX = 480
