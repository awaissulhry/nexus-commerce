export interface SummaryLevel {
  locationType: string
  quantity: number
}

/**
 * Pure: roll StockLevel rows into the FBA / FBM / total split the products
 * grid shows. FBM = the sum of every location that isn't AMAZON_FBA, matching
 * GET /api/products' own aggregation.
 */
export function summarizeProductStock(levels: SummaryLevel[]): {
  fbaStock: number
  fbmStock: number
  totalStock: number
} {
  let fba = 0
  let fbm = 0
  for (const l of levels) {
    if (l.locationType === 'AMAZON_FBA') fba += l.quantity
    else fbm += l.quantity
  }
  return { fbaStock: fba, fbmStock: fbm, totalStock: fba + fbm }
}
