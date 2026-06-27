// Re-export shim — canonical implementation is AmazonFFFilterPanel.
// Kept so existing imports in AmazonFlatFileClient don't break during transition.
export { AmazonFFFilterPanel as FFFilterPanel } from './AmazonFFFilterPanel'
export type { AmazonFFFilterState as FFFilterState } from './flat-file-filter.types'
export { FFFilterSection, FFFilterRadio } from './FFFilterPanelBase'
