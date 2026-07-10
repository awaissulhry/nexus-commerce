/**
 * UFX P7 (item 8) — re-export shim.
 *
 * This was a byte-identical copy of app/bulk-operations/lib/find-replace.
 * The bulk-operations copy is the single implementation; this path stays
 * importable so nothing referencing the bulk-edit location breaks.
 */
export {
  buildSearchRegex,
  findMatches,
  applyScope,
  replaceInString,
  matchKeySet,
  type FindOptions,
  type FindScope,
  type FindCell,
  type FindMatch,
} from '@/app/bulk-operations/lib/find-replace'
