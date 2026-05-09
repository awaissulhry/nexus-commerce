/**
 * P.1f — shared types for /products.
 *
 * Extracted from ProductsWorkspace.tsx as part of the
 * file-decomposition sweep so the grid view's components and the
 * workspace can both import the same canonical shape.
 */

export type ProductRow = {
  id: string
  sku: string
  name: string
  brand: string | null
  basePrice: number
  totalStock: number
  lowStockThreshold: number
  status: string
  syncChannels: string[]
  imageUrl: string | null
  isParent: boolean
  parentId: string | null
  productType: string | null
  fulfillmentMethod: string | null
  /**
   * W2.12 — ProductFamily attached via Product.familyId. Null when
   * the row hasn't been categorised yet (the legacy categoryAttributes
   * JSON path still applies). Cheap projection — id/code/label only.
   */
  family: { id: string; code: string; label: string } | null
  /**
   * W3.9 — Workflow stage attached via Product.workflowStageId.
   * Null when the product isn't on any workflow. Includes the parent
   * workflow's id+label so the grid chip can deep-link to the
   * workflow editor + distinguish same-named stages across workflows.
   */
  workflowStage: {
    id: string
    code: string
    label: string
    isPublishable: boolean
    isTerminal: boolean
    workflow: { id: string; code: string; label: string }
  } | null
  /**
   * P.7 — Product.version for optimistic-concurrency check on inline
   * edits. Sent as If-Match on PATCH /api/products/:id; server
   * returns 409 if the row changed since this list was fetched.
   * Optional because older list responses (and lazy-loaded children
   * fallback) may not include it.
   */
  version?: number
  photoCount: number
  channelCount: number
  variantCount: number
  /**
   * Number of child Products (Product.children self-relation). Used
   * by the grid to decide whether a parent gets a chevron. Differs
   * from variantCount, which counts ProductVariation rows (matrix
   * cells).
   */
  childCount?: number
  coverage: Record<
    string,
    { live: number; draft: number; error: number; total: number }
  > | null
  tags?: Array<{ id: string; name: string; color: string | null }>
  updatedAt: string
  createdAt: string
}

export type Tag = {
  id: string
  name: string
  color: string | null
  productCount?: number
}
