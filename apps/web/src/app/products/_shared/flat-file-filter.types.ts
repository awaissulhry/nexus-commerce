export interface GenericFFFilterState<T = Record<string, never>> {
  missingRequired: boolean
  channel: T
}

export interface AmazonFilterDims {
  parentage: 'any' | 'parent' | 'child'
  hasAsin: 'any' | 'yes' | 'no'
}

export interface EbayFilterDims {
  hasItemId: 'any' | 'yes' | 'no'
  isParent: 'any' | 'parent' | 'child'
}

export type AmazonFFFilterState = GenericFFFilterState<AmazonFilterDims>
export type EbayFFFilterState = GenericFFFilterState<EbayFilterDims>

export const AMAZON_FILTER_DEFAULT: AmazonFFFilterState = {
  missingRequired: false,
  channel: { parentage: 'any', hasAsin: 'any' },
}

export const EBAY_FILTER_DEFAULT: EbayFFFilterState = {
  missingRequired: false,
  channel: { hasItemId: 'any', isParent: 'any' },
}
