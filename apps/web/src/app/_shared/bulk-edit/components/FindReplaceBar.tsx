/**
 * UFX P7 (item 8) — re-export shim.
 *
 * There were two byte-divergent copies of the Find & Replace bar (this path
 * and app/bulk-operations/components/FindReplaceBar). The bulk-operations
 * copy is now the single implementation (it carries the aria-labelled
 * Listboxes); this path stays importable for existing consumers
 * (CommandMatrixClient).
 */
export { FindReplaceBar, type FindReplaceBarProps } from '@/app/bulk-operations/components/FindReplaceBar'
