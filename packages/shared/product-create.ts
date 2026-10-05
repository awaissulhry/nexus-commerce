/**
 * Creating a product from the Products page (2026-10-01): the one rule for what a new product needs, read by the
 * API (`POST /api/products`, which decides) and by the web dialog (which only checks early, so a typo is named
 * before the request is sent).
 *
 * The person types the SKU; Nexus never makes one up. The family is optional. A new product is a DRAFT.
 */

export const PRODUCT_SKU_MAX_LENGTH = 100
export const PRODUCT_NAME_MAX_LENGTH = 500

/**
 * Letters, numbers, dots, underscores and hyphens: the characters the family generator already allows in a SKU
 * code (`family-generate.service.ts`). No spaces, slashes or other symbols, which channel files and feeds treat
 * differently.
 */
export const PRODUCT_SKU_PATTERN = /^[A-Za-z0-9._-]+$/

export type NewProductKind = 'single' | 'parent'
export const NEW_PRODUCT_KINDS: readonly NewProductKind[] = ['single', 'parent']

export interface NewProductInput {
  sku: string
  name: string
  kind: NewProductKind
  /** A product family (attribute template) of this business. Absent, null or '' means none. */
  familyId?: string | null
}

export type NewProductField = 'sku' | 'name' | 'kind' | 'familyId'
export type NewProductProblems = Partial<Record<NewProductField, string>>

/** The SKU and name as they are stored: trimmed. */
export function normaliseNewProduct(input: NewProductInput): NewProductInput {
  const familyId = typeof input.familyId === 'string' && input.familyId.trim() ? input.familyId.trim() : null
  return { sku: input.sku.trim(), name: input.name.trim(), kind: input.kind, familyId }
}

/** What is wrong with a new product's fields, one plain sentence per field. Empty when it can be sent. */
export function newProductProblems(input: { sku?: unknown; name?: unknown; kind?: unknown; familyId?: unknown }): NewProductProblems {
  const problems: NewProductProblems = {}
  const sku = typeof input.sku === 'string' ? input.sku.trim() : ''
  if (!sku) problems.sku = 'Enter a SKU.'
  else if (sku.length > PRODUCT_SKU_MAX_LENGTH) problems.sku = `A SKU can have up to ${PRODUCT_SKU_MAX_LENGTH} characters. This one has ${sku.length}.`
  else if (!PRODUCT_SKU_PATTERN.test(sku)) problems.sku = 'Use only letters, numbers, dots (.), hyphens (-) and underscores (_). No spaces.'
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) problems.name = 'Enter a title.'
  else if (name.length > PRODUCT_NAME_MAX_LENGTH) problems.name = `A name can have up to ${PRODUCT_NAME_MAX_LENGTH} characters. This one has ${name.length}.`
  if (!NEW_PRODUCT_KINDS.includes(input.kind as NewProductKind)) problems.kind = 'Choose Single product or Product with variations.'
  if (input.familyId !== undefined && input.familyId !== null && typeof input.familyId !== 'string') problems.familyId = 'Choose a product family from the list, or none.'
  return problems
}
