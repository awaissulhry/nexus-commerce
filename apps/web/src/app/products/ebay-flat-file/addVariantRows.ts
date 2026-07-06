// Pure helper — no React / Next.js / path-alias dependencies.
// Produces only VARIANT rows under an already-existing parent listing.
// Called by AddListingPopover when familyMode === 'existing'.

// ── Cartesian product ────────────────────────────────────────────────────────

function cartesian<T>(arrays: T[][]): T[][] {
  if (!arrays.length) return [[]]
  return arrays.reduce<T[][]>(
    (acc, arr) => acc.flatMap((prev) => arr.map((v) => [...prev, v])),
    [[]],
  )
}

// ── SKU template renderer ────────────────────────────────────────────────────

function renderTemplate(
  template: string,
  parentSku: string,
  values: Record<string, string>,
): string {
  let result = template.replace(/\{PARENT\}/gi, parentSku)
  for (const [axis, val] of Object.entries(values)) {
    result = result.replace(new RegExp(`\\{${axis}\\}`, 'gi'), val)
  }
  return result
}

// ── Return type ──────────────────────────────────────────────────────────────

/** Minimal structural subset of EbayRow / BaseRow used by this helper. */
export interface VariantRowResult {
  _rowId: string
  _isNew: true
  _dirty: true
  _status: 'idle'
  sku: string
  _isParent: false
  platformProductId: string
  parentage: 'child'
  parent_sku: string
  [key: string]: unknown
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface GenerateVariantRowsOpts {
  /** _rowId / _productId / platformProductId of the existing parent row */
  parentId: string
  /** Ordered list of axis names, e.g. ['Color', 'Size'] */
  axes: string[]
  /** Per-axis value lists, e.g. { Color: ['Red','Blue'], Size: ['M'] } */
  axisValues: Record<string, string[]>
  /** SKU template string, e.g. '{PARENT}-{Color}-{Size}' */
  skuTemplate: string
  /** Parent row's SKU, used to expand the {PARENT} token */
  parentSku: string
}

// Module-level sequence guarantees unique _rowIds even across rapid successive calls.
let _idSeq = 0

/**
 * Generates variant rows under an existing parent — NO parent row is included.
 *
 * For each cartesian combination of axis values, one row is produced:
 *   { _isParent: false, platformProductId: parentId, aspect_<axis>: value, sku: <rendered> }
 */
export function generateVariantRowsUnderParent(
  opts: GenerateVariantRowsOpts,
): VariantRowResult[] {
  const { parentId, axes, axisValues, skuTemplate, parentSku } = opts
  const ts = Date.now()

  const axisArrays = axes.map((a) => axisValues[a] ?? [])
  const combinations = cartesian(axisArrays)

  return combinations.map((combo, i) => {
    const valueMap: Record<string, string> = {}
    axes.forEach((axis, j) => {
      valueMap[axis] = combo[j] ?? ''
    })

    const varSku = renderTemplate(skuTemplate, parentSku, { ...valueMap, PARENT: parentSku })

    return {
      _rowId: `new-${ts}-${++_idSeq}-${i}`,
      _isNew: true,
      _dirty: true,
      _status: 'idle',
      sku: varSku,
      _isParent: false,
      platformProductId: parentId,
      parentage: 'child' as const,
      parent_sku: parentSku,
      ...Object.fromEntries(
        axes.map((axis) => [`aspect_${axis.replace(/\s+/g, '_')}`, valueMap[axis]]),
      ),
    }
  })
}
