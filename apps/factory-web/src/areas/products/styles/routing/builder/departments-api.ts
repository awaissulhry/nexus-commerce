import { z } from 'zod'
import type { ApiClient } from '../../../../../lib/api/client'
import type { DepartmentAnswer } from '../../../../../lib/department/model'
import { departmentsAnswerSchema } from '../../../../../lib/department/use-departments'
import { writeKey } from '../route/api'

/**
 * owb-pd6 step 6.3 (S4; design plan § 5x; brief owb-pd-server.md pd1 step 1.3) — Manage, inside the route builder: add a department
 * (a name only; the server gives the number, the tone, the icon and its ONE default library operation), rename it, close it (it leaves
 * the list, the routes keep it, nothing is deleted) or open it again. Right: production.departments.manage. Each answers
 * `{ department }` — the same row as `GET /production/departments` (lib/department's own zod). Refusals: NAME_EMPTY 400 · NAME_TAKEN
 * 409 · FLOOR_FIXED 409 · a stale version 409 (builder/model.ts refusalOf says them in words).
 */

const oneDepartment = z.object({ department: departmentsAnswerSchema.shape.departments.element })
const PATH = '/production/departments'
const at = (id: string) => `${PATH}/${encodeURIComponent(id)}`

/** `POST /production/departments { name }` — a new department, ACTIVE, with the next number. */
export function addDepartment(api: ApiClient, name: string): Promise<DepartmentAnswer> {
  return api.post(PATH, { body: { name }, schema: oneDepartment, ...writeKey() }).then((answer) => answer.department)
}

/** A rename as sent: the base name and short name (English), or the page language's name. */
export type DepartmentRename = { readonly name: string; readonly shortName: string } | { readonly nameI18n: Readonly<Record<string, string>> }

/** `PATCH /production/departments/:id { version, … }` — a new name; every route shows it (its default operation is renamed too). */
export function renameDepartment(api: ApiClient, row: Pick<DepartmentAnswer, 'id' | 'version'>, rename: DepartmentRename): Promise<DepartmentAnswer> {
  return api.request('PATCH', at(row.id), { body: { version: row.version ?? 1, ...rename }, schema: oneDepartment, ...writeKey() }).then((answer) => answer.department)
}

/** `POST /production/departments/:id/close|open { version }`. */
export function setDepartmentOpen(api: ApiClient, row: Pick<DepartmentAnswer, 'id' | 'version'>, open: boolean): Promise<DepartmentAnswer> {
  return api.post(`${at(row.id)}/${open ? 'open' : 'close'}`, { body: { version: row.version ?? 1 }, schema: oneDepartment, ...writeKey() }).then((answer) => answer.department)
}
