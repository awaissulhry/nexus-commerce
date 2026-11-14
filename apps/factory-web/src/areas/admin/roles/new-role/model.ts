import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { RoleTemplate } from './api'

/**
 * New role (B-W2b-413; design admin.roles pop:new-role "Start from a ready-made role (cards with their plain line), name it.
 * Opens the copy's Permissions tab"), pure: the templates offered (office ones; the owner's and those holding more than the
 * person are shown held with why), the draft, its problems, the custom key from the name, and a refusal in words
 * (`admin-security-depth` `newRole.*`).
 */

export interface NewRoleDraft {
  basedOn: string | null
  name: string
}
export const EMPTY_NEW_ROLE: NewRoleDraft = { basedOn: null, name: '' }

/** The owner's ready-made role: never copied (factory-domain OWNER_TEMPLATE). */
export const OWNER_TEMPLATE = 'owner'

/** The office templates, those the person may copy first (the catalogue's order kept within each). */
export function offeredTemplates(templates: readonly RoleTemplate[]): RoleTemplate[] {
  const office = templates.filter((template) => template.audience === 'office')
  return [...office.filter((template) => template.copyable), ...office.filter((template) => !template.copyable)]
}

/** Why a template is not offered (a message key), or null when it may be copied. */
export const templateHeld = (template: RoleTemplate): string | null => (template.copyable ? null : template.key === OWNER_TEMPLATE ? 'newRole.held.owner' : 'newRole.held.beyond')

/** What is wrong with the draft, field → message key. */
export function newRoleErrors(draft: NewRoleDraft, templates: readonly RoleTemplate[]): Partial<Record<'basedOn' | 'name', string>> {
  const errors: Partial<Record<'basedOn' | 'name', string>> = {}
  const template = templates.find((item) => item.key === draft.basedOn)
  if (!template || !template.copyable) errors.basedOn = 'newRole.error.basedOn'
  const name = draft.name.trim()
  if (name === '') errors.name = 'newRole.error.name'
  else if (name.length > 100) errors.name = 'newRole.error.nameLong'
  return errors
}

/** The name's first suggestion: "<template> (copy)". */
export const copyName = (templateName: string, copy: string) => `${templateName} (${copy})`

/**
 * The custom role's slug from its name (factory-domain: 2 to 48 lower-case letters, digits or underscores, starting with a
 * letter), unique among the keys the tenant has (`custom.<slug>`): "Planner (copy)" → `planner_copy`, then `planner_copy_2`.
 */
export function slugOf(name: string, taken: readonly string[]): string {
  const folded = name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  let base = /^[a-z]/.test(folded) ? folded : `role_${folded}`.replace(/_+$/g, '')
  if (base.length < 2) base = 'role'
  base = base.slice(0, 40).replace(/_+$/g, '')
  const keys = new Set(taken)
  if (!keys.has(`custom.${base}`)) return base
  for (let n = 2; ; n += 1) if (!keys.has(`custom.${base}_${n}`)) return `${base}_${n}`
}

/** A refused create as a message key. */
export function createProblem(error: unknown): string {
  if (!isApiError(error)) return 'newRole.problem.failed'
  const paths = error.issues.map(issuePath)
  if (paths.some((path) => path.endsWith('/beyondYou'))) return 'newRole.problem.beyond'
  if (paths.some((path) => path.endsWith('/ownerCopy') || path.endsWith('/ownerEvery'))) return 'newRole.problem.owner'
  if (error.kind === 'conflict') return 'newRole.problem.taken'
  if (error.kind === 'forbidden') return 'newRole.problem.forbidden'
  if (error.kind === 'invalid') return 'newRole.problem.invalid'
  return 'newRole.problem.failed'
}
