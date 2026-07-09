// Relative imports so the vitest suite (root config, no `@/` alias) can run this module.
import { normalizeCellValue } from '../../../components/flat-file/normalizeCellValue'
import type { FlatFileColumn } from '../../../components/flat-file/FlatFileGrid.types'

/**
 * FB1-client — enforcement for the Amazon flat file's TWO synthetic columns
 * (Follow / Buffer) on its own bulk write paths (paste, fill, find-replace, AI),
 * which bypass the shared FlatFileGrid.commitCells.
 *
 * Strictly scoped: any other column id passes through UNCHANGED, so
 * manifest-derived Amazon columns keep their existing behavior exactly.
 *
 * Returns the value to write; a rejected value returns `prev` (the cell's
 * previous value — never blanked). Reuses the shared normalizeCellValue rules:
 *  - follow: strict enum — case-insensitive match normalized to 'Follow'/'Pinned',
 *    anything else rejected;
 *  - buffer: numeric with min 0 (below-min clamps up), comma-decimal accepted,
 *    non-numeric rejected.
 */

const FOLLOW_DEF: FlatFileColumn = {
  id: 'follow', label: 'Follow', kind: 'enum', enumMode: 'strict',
  options: ['Follow', 'Pinned'], width: 96,
}
const BUFFER_DEF: FlatFileColumn = {
  id: 'buffer', label: 'Buffer', kind: 'number', min: 0, width: 84,
}

export function normalizeSyntheticCell(colId: string, value: unknown, prev: unknown): unknown {
  const def = colId === 'follow' ? FOLLOW_DEF : colId === 'buffer' ? BUFFER_DEF : null
  if (!def || typeof value !== 'string') return value
  const nv = normalizeCellValue(def, value)
  return nv === null ? prev : nv
}
