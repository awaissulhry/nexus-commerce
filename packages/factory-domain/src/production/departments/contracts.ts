import { z } from 'zod'
import { input } from '../../core/contracts'
import { DEPARTMENT_NAME_MAX } from './rules'

/**
 * Keeping the departments (owb-pd1 1.3): what POST /production/departments, PATCH /production/departments/:id and
 * POST …/:id/close | /open accept. The answer is the base's department row (apps/factory-api modules/production/departments
 * `departmentView`) as `{ department }`. A blank name is refused by the API in words (NAME_EMPTY, 400), not here, so the screen
 * gets the code.
 */

/** The languages a department's names are kept in (the office's two and the floor's Urdu, marked draft until a reader checks it). */
export const DEPARTMENT_LANGUAGES = ['en', 'it', 'ur'] as const

const name = () => z.string().trim().max(DEPARTMENT_NAME_MAX)
const version = () => z.number().int().min(1)

export const createDepartmentBody = input({
  name: name(),
  /** The ONE name on every chip ("Patch" for "Patch & print"); left out or blank: the name. */
  shortName: name().nullish(),
})
export type CreateDepartmentBody = z.output<typeof createDepartmentBody>

export const updateDepartmentBody = input({
  version: version(),
  name: name().optional(),
  shortName: name().optional(),
  /** The names per language; null clears them (the name is shown). */
  nameI18n: z.partialRecord(z.enum(DEPARTMENT_LANGUAGES), z.string().trim().min(1).max(DEPARTMENT_NAME_MAX)).nullish(),
})
export type UpdateDepartmentBody = z.output<typeof updateDepartmentBody>

export const departmentMoveBody = input({ version: version() })
export type DepartmentMoveBody = z.output<typeof departmentMoveBody>
