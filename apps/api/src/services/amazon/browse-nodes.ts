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

/** Read the flat-file row's chosen browse node id (col.id key). null if unset. */
export function browseNodeIdFromRow(row: Record<string, unknown>): string | null {
  const v = row['recommended_browse_nodes']
  return v == null || v === '' ? null : String(v)
}

/** The browse node id to persist on sync: the row's chosen node, else an
 *  existing/predicted node already on the listing (so a node-less sync never
 *  wipes it). null only when neither has one. */
export function resolveBrowseNodeId(
  row: Record<string, unknown>,
  existingPlatformAttributes: unknown,
): string | null {
  const fromRow = browseNodeIdFromRow(row)
  if (fromRow) return fromRow
  const ex = (existingPlatformAttributes as { browseNodeId?: unknown } | null | undefined)?.browseNodeId
  return ex == null || ex === '' ? null : String(ex)
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
