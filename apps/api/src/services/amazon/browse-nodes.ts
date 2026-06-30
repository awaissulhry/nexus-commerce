export interface BrowseNode {
  id: string
  path: string
}

/** Deep-find the first node carrying a string `enum` (and optional parallel
 *  `enumNames`) under a schema subtree. Amazon nests the node-id enum under
 *  recommended_browse_nodes → items → properties.value (sometimes inside an
 *  allOf/anyOf scoped by marketplace_id). We walk defensively. */
function findEnumNode(
  node: unknown,
  marketplaceId: string,
): { enum: string[]; enumNames?: string[] } | null {
  if (!node || typeof node !== 'object') return null
  const obj = node as Record<string, unknown>

  // A marketplace-scoped block: skip blocks that pin a different marketplace.
  const mp = obj.marketplace_id ?? (obj.properties as any)?.marketplace_id
  const mpConst =
    (mp as any)?.const ??
    (Array.isArray((mp as any)?.enum) ? (mp as any).enum[0] : undefined)
  if (typeof mpConst === 'string' && mpConst !== marketplaceId) return null

  if (Array.isArray(obj.enum) && obj.enum.every((v) => typeof v === 'string')) {
    return {
      enum: obj.enum as string[],
      enumNames: Array.isArray(obj.enumNames) ? (obj.enumNames as string[]) : undefined,
    }
  }

  for (const key of ['items', 'properties', 'value', 'allOf', 'anyOf', 'oneOf']) {
    const child = obj[key]
    if (Array.isArray(child)) {
      for (const c of child) {
        const found = findEnumNode(c, marketplaceId)
        if (found) return found
      }
    } else if (child) {
      const found = findEnumNode(child, marketplaceId)
      if (found) return found
    }
  }
  return null
}

export function extractBrowseNodes(
  schema: Record<string, unknown>,
  marketplaceId: string,
): BrowseNode[] {
  const props = (schema?.properties ?? {}) as Record<string, unknown>
  const rbn = props.recommended_browse_nodes
  if (!rbn) return []
  const found = findEnumNode(rbn, marketplaceId)
  if (!found) return []
  const names = found.enumNames
  const usable = !!names && names.length === found.enum.length
  return found.enum.map((id, i) => ({ id, path: usable ? names![i] : id }))
}
