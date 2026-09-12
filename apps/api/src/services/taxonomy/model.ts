/** Provider-neutral reference data. IDs never derive from labels or translations. */
export interface TaxonomyNodeInput {
  externalId: string
  parentId: string | null
  name: string
  path: string
  assignable: boolean
  metadata?: Record<string, unknown>
}

export interface TaxonomyDownload {
  providerVersion: string | null
  nodes: TaxonomyNodeInput[]
}

export class TaxonomyError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly retryable = true) { super(message) }
}

export function validateTaxonomy(download: TaxonomyDownload): TaxonomyDownload {
  if (download.providerVersion !== null && typeof download.providerVersion !== 'string') throw new TaxonomyError('The provider returned an invalid taxonomy version.', 502)
  if (!Array.isArray(download.nodes) || !download.nodes.length) throw new TaxonomyError('The provider returned an empty taxonomy. The previous version has been preserved.', 502)
  if (download.nodes.length > 500_000) throw new TaxonomyError('The taxonomy exceeds the supported import size.', 502)
  const nodes = new Map<string, TaxonomyNodeInput>()
  for (const node of download.nodes) {
    if (!node || typeof node !== 'object' || typeof node.externalId !== 'string' || !node.externalId || node.externalId.length > 300 || nodes.has(node.externalId) || typeof node.name !== 'string' || !node.name.trim() || typeof node.path !== 'string' || !node.path.trim() || (node.parentId !== null && typeof node.parentId !== 'string') || typeof node.assignable !== 'boolean') throw new TaxonomyError('The provider returned invalid or duplicate categories.', 502)
    nodes.set(node.externalId, node)
  }
  const checked = new Map<string, number>()
  for (const node of nodes.values()) {
    let current: TaxonomyNodeInput | undefined = node
    const visiting = new Set<string>()
    while (current && !checked.has(current.externalId)) {
      if (visiting.has(current.externalId) || visiting.size > 100) throw new TaxonomyError('The taxonomy contains a cycle or an invalid depth.', 502)
      visiting.add(current.externalId)
      if (current.parentId && !nodes.has(current.parentId)) throw new TaxonomyError('The taxonomy is incomplete: a parent category is missing.', 502)
      current = current.parentId ? nodes.get(current.parentId) : undefined
    }
    let depth = current ? checked.get(current.externalId)! + 1 : 0
    for (const id of [...visiting].reverse()) {
      if (depth > 100) throw new TaxonomyError('The taxonomy contains an invalid depth.', 502)
      checked.set(id, depth++)
    }
  }
  return download
}

export function flattenEbayTree(body: any): TaxonomyDownload {
  if (!body?.rootCategoryNode || !body.categoryTreeVersion) throw new TaxonomyError('eBay returned an incomplete category tree.', 502)
  const nodes: TaxonomyNodeInput[] = []
  const walk = (node: any, parentId: string | null, ancestors: string[], depth: number) => {
    if (depth > 100 || typeof node?.category?.categoryId !== 'string' || typeof node.category.categoryName !== 'string') throw new TaxonomyError('eBay returned an invalid category.', 502)
    const id = node.category.categoryId, names = [...ancestors, node.category.categoryName]
    nodes.push({ externalId: id, parentId, name: node.category.categoryName, path: names.join(' › '), assignable: node.leafCategoryTreeNode === true })
    if (node.childCategoryTreeNodes !== undefined && !Array.isArray(node.childCategoryTreeNodes)) throw new TaxonomyError('eBay returned invalid category children.', 502)
    if (node.leafCategoryTreeNode === true ? !!node.childCategoryTreeNodes?.length : !node.childCategoryTreeNodes?.length) throw new TaxonomyError('eBay returned an incomplete branch or inconsistent leaf category.', 502)
    for (const child of node.childCategoryTreeNodes ?? []) walk(child, id, names, depth + 1)
  }
  walk(body.rootCategoryNode, null, [], 0)
  return validateTaxonomy({ providerVersion: String(body.categoryTreeVersion), nodes })
}

export function flattenEtsyTree(body: any): TaxonomyDownload {
  if (!Array.isArray(body?.results)) throw new TaxonomyError('Etsy returned an incomplete seller taxonomy.', 502)
  const nodes: TaxonomyNodeInput[] = []
  const walk = (items: any[], parentId: string | null, ancestors: string[], depth: number) => {
    if (depth > 100) throw new TaxonomyError('Etsy returned an invalid category depth.', 502)
    for (const node of items) {
      if (!Number.isSafeInteger(node?.id) || node.id < 1 || typeof node.name !== 'string' || !Array.isArray(node.children)) throw new TaxonomyError('Etsy returned an invalid seller category.', 502)
      const id = String(node.id), names = [...ancestors, node.name]
      nodes.push({ externalId: id, parentId, name: node.name, path: names.join(' › '), assignable: true })
      walk(node.children, id, names, depth + 1)
    }
  }
  walk(body.results, null, [], 0)
  return validateTaxonomy({ providerVersion: null, nodes })
}

export function flattenAmazonTypes(body: any): TaxonomyDownload {
  if (!Array.isArray(body?.productTypes)) throw new TaxonomyError('Amazon returned an incomplete product-type list.', 502)
  return validateTaxonomy({ providerVersion: body.productTypeVersion ?? null, nodes: body.productTypes.map((node: any) => ({
    externalId: node.name, parentId: null, name: node.displayName || node.name, path: node.displayName || node.name, assignable: true,
  })) })
}

export function flattenShopifyTree(body: any): TaxonomyDownload {
  if (typeof body?.version !== 'string' || !Array.isArray(body.verticals)) throw new TaxonomyError('Shopify returned an incomplete taxonomy release.', 502)
  const nodes: TaxonomyNodeInput[] = []
  for (const vertical of body.verticals) {
    if (!Array.isArray(vertical.categories)) throw new TaxonomyError('Shopify returned an incomplete taxonomy vertical.', 502)
    for (const category of vertical.categories) {
      if (!/^gid:\/\/shopify\/TaxonomyCategory\//.test(category.id) || !Array.isArray(category.attributes)) throw new TaxonomyError('Shopify returned an invalid category.', 502)
      nodes.push({ externalId: category.id, parentId: category.parent_id, name: category.name, path: category.full_name, assignable: true, metadata: { attributes: category.attributes } })
    }
  }
  return validateTaxonomy({ providerVersion: body.version, nodes })
}
