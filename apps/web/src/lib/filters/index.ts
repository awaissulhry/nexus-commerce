/**
 * Phase 10a — public surface of the filter contract.
 *
 *   import { parseFilters, serializeFilters, EMPTY_FILTERS } from '@/lib/filters'
 *
 * See ./types.ts for the contract docs and ./url.ts for the helpers.
 */

export type { CommonFilters, FilterDelta } from './types'
export { EMPTY_FILTERS, isEmpty, activeCount } from './types'
export {
  parseFilters,
  serializeFilters,
  mergeFilters,
  clearAll,
  toQueryString,
} from './url'
