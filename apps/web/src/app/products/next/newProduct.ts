/**
 * The "New product" dialog's logic, apart from React so it can be tested (Node, no DOM): what is sent to
 * `POST /api/products`, how its answer becomes what the dialog shows, and where the studio of the new product is.
 * The field rules themselves are the API's, shared through `@nexus/shared/product-create`.
 */
import { newProductProblems, normaliseNewProduct, type NewProductField, type NewProductKind, type NewProductProblems } from '@nexus/shared/product-create'

export interface NewProductDraft {
  sku: string
  name: string
  kind: NewProductKind
  /** '' = no family. */
  familyId: string
}

export const EMPTY_NEW_PRODUCT: NewProductDraft = { sku: '', name: '', kind: 'single', familyId: '' }

/** The order the dialog shows its fields in, so the first one with a problem takes the focus. */
export const NEW_PRODUCT_FIELD_ORDER: readonly NewProductField[] = ['sku', 'name', 'kind', 'familyId']

/** What the dialog can check before sending; the API checks the rest (an existing SKU, the family). */
export const draftProblems = (draft: NewProductDraft): NewProductProblems => newProductProblems(draft)

export const firstProblemField = (problems: NewProductProblems): NewProductField | null =>
  NEW_PRODUCT_FIELD_ORDER.find((field) => problems[field]) ?? null

/** The request body: trimmed, and without `familyId` when no family was chosen. */
export function newProductBody(draft: NewProductDraft): { sku: string; name: string; kind: NewProductKind; familyId?: string } {
  const { sku, name, kind, familyId } = normaliseNewProduct(draft)
  return { sku, name, kind, ...(familyId ? { familyId } : {}) }
}

/** The new (or existing) product's studio, inside the business the page is in: navigate with the workspace router. */
export const productStudioPath = (productId: string) => `/products/${encodeURIComponent(productId)}/edit/studio`

export type CreateOutcome =
  | { kind: 'created'; id: string; sku: string }
  /** A refusal about one field, shown under it. `productId`: the live product that already has this SKU. */
  | { kind: 'field'; field: NewProductField; message: string; productId?: string }
  /** Anything else, shown in one banner above the fields. */
  | { kind: 'failed'; message: string }

const FIELDS = new Set<string>(NEW_PRODUCT_FIELD_ORDER)

/** The API's answer, as the dialog shows it. Never a raw status code for the person to decode. */
export function createOutcome(status: number, body: unknown): CreateOutcome {
  const data = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  if (status === 201 && typeof data.id === 'string' && typeof data.sku === 'string') return { kind: 'created', id: data.id, sku: data.sku }
  const error = typeof data.error === 'string' && data.error.trim() ? data.error : null
  if ((status === 400 || status === 409) && error && typeof data.field === 'string' && FIELDS.has(data.field)) {
    return { kind: 'field', field: data.field as NewProductField, message: error, ...(typeof data.productId === 'string' ? { productId: data.productId } : {}) }
  }
  if (status === 401) return { kind: 'failed', message: 'Your session has ended. Sign in again, then create the product.' }
  if (status === 403) return { kind: 'failed', message: 'You do not have permission to create products in this business.' }
  if (error && status >= 400 && status < 500) return { kind: 'failed', message: error }
  return { kind: 'failed', message: 'The product could not be created. Try again in a moment.' }
}

/** The families endpoint's answer as Listbox options, by name; the search finds a family by its name or its code. */
export function familyOptions(body: unknown): Array<{ value: string; label: string; searchText: string }> {
  const families = (body && typeof body === 'object' ? (body as { families?: unknown }).families : null)
  if (!Array.isArray(families)) return []
  return families
    .filter((f): f is { id: string; label?: unknown; code?: unknown } => !!f && typeof f === 'object' && typeof (f as { id?: unknown }).id === 'string')
    .map((f) => {
      const code = typeof f.code === 'string' ? f.code : ''
      const label = typeof f.label === 'string' && f.label.trim() ? f.label : code || f.id
      // `searchText` replaces the label in the Listbox search, so it carries both.
      return { value: f.id, label, searchText: code && code !== label ? `${label} ${code}` : label }
    })
    .sort((a, b) => a.label.localeCompare(b.label))
}
