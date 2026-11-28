import type { Department, DepartmentAnswer } from '../../../../../lib/department/model'
import type { DeptLook, Words } from '../route/model'
import type { DepartmentRename } from './departments-api'

/**
 * owb-pd6 step 6.3 (S4; design plan § 5x; prototype prod.js deptAdd, deptName, deptClose) — Manage, the departments list's small
 * switch in the route builder: who sees it (production.departments.manage only: the designer and sales have no Manage), what each row
 * allows (a floor department — `floorReady` — keeps its name and never closes: "on the floor"; a closed one opens again and is not
 * renamed), the name rules before anything is sent (a name is needed; the same name twice is refused, case not counted), and the
 * list after the server's answer. No React, no API.
 */

export const MANAGE_RIGHT = 'production.departments.manage'
export const DEPARTMENT_NAME_MAX = 40

/** The Manage switch is drawn only for this right. */
export const mayManage = (can: (permission: string) => boolean): boolean => can(MANAGE_RIGHT)

export interface ManageRow {
  readonly id: string
  readonly dept: Department
  readonly closed: boolean
  /** "on the floor": fixed name, no lock. */
  readonly floorReady: boolean
  /** The name may be changed here. */
  readonly rename: boolean
  /** The lock (close / open) is drawn. */
  readonly lock: boolean
  /** Open: it may be added to the route at once (+). */
  readonly add: boolean
  /** Made in this window: the mark "new". */
  readonly fresh: boolean
}

/** Every department (closed ones too, at the end of their place), with what Manage allows on it. */
export function manageRowsOf(looks: readonly DeptLook[], fresh: ReadonlySet<string>): ManageRow[] {
  return looks.map((look) => ({
    id: look.id,
    dept: look.dept,
    closed: look.closed,
    floorReady: look.floorReady,
    rename: !look.floorReady && !look.closed,
    lock: !look.floorReady,
    add: !look.closed,
    fresh: fresh.has(look.id),
  }))
}

/** Why a name is refused before it is sent (the server checks again): none typed, or another department's name. */
export function nameProblemOf(name: string, looks: readonly DeptLook[], selfId: string | null): Words | null {
  const wanted = name.trim().toLowerCase()
  if (!wanted) return { key: 'refusal.NAME_EMPTY' }
  const taken = looks.some((look) => look.id !== selfId && [look.dept.name, look.dept.shortName].some((each) => each.trim().toLowerCase() === wanted))
  return taken ? { key: 'refusal.NAME_TAKEN' } : null
}

/** A rename as sent: in English the base name (and its short name, the ONE name of every chip); in another language that language's name. */
export function renameOf(row: Pick<DepartmentAnswer, 'nameI18n'>, name: string, locale: string): DepartmentRename {
  const value = name.trim().slice(0, DEPARTMENT_NAME_MAX)
  return locale === 'en' ? { name: value, shortName: value } : { nameI18n: { ...(row.nameI18n ?? {}), [locale]: value } }
}

/** The list after the server answered one department: replaced where it was, else added; in the factory's order. */
export function withDepartment(rows: readonly DepartmentAnswer[], row: DepartmentAnswer): DepartmentAnswer[] {
  const next = rows.some((each) => each.id === row.id) ? rows.map((each) => (each.id === row.id ? row : each)) : [...rows, row]
  return next.sort((a, b) => (a.seq ?? a.number) - (b.seq ?? b.number) || a.number - b.number)
}
