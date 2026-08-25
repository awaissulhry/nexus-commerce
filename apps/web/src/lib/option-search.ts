/**
 * Moved into the design system (2026-08-25): the DS `Listbox` needs it for in-popover search, and
 * the DS may not import from the app. Re-exported here so the 7 existing importers are untouched.
 */
export { normalizeForSearch, searchTokens, matchScore, searchOptions } from '@/design-system/lib/option-search'
