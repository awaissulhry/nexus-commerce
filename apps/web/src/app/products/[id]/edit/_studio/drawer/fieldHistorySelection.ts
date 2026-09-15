import { languageColumn } from '../sheet/languages'
import type { DrawerScope } from './types'

/** Resolve a visible (possibly language-qualified) column to the history API coordinate. */
export function fieldHistorySelection(columnKey: string | null, writeField: string | null | undefined, scope: DrawerScope): {
  fieldKey: string | null
  scope: DrawerScope
} {
  if (!columnKey) return { fieldKey: null, scope }
  const column = languageColumn(columnKey)
  return {
    fieldKey: writeField ?? column.fieldKey,
    scope: column.locale ? { ...scope, locale: column.locale } : scope,
  }
}
