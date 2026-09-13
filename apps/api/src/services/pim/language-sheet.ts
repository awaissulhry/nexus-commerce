import { normalizeLanguage } from './content-language.js'
import { isLocalizableContent } from './content-resolver.js'
import { completenessFor } from './sheet-rows.service.js'
import type { StudioSheet } from './studio-sheet.service.js'

/** The request and every saved view use the same canonical language-only keys. */
export function sheetLanguages(locales: readonly string[]): string[] {
  if (!locales.length) throw Object.assign(new Error('Choose at least one content language.'), { statusCode: 400 })
  try { return [...new Set(locales.map(normalizeLanguage))] }
  catch (error) { throw Object.assign(error instanceof Error ? error : new Error('Choose valid content languages.'), { statusCode: 400 }) }
}

/** Widen the actual scope projections; keep each cell's write address, CAS and explicit list clears. */
export function widenLanguageSheets(sheets: StudioSheet[]): StudioSheet {
  const base = sheets[0]
  if (!base) throw new Error('A Languages view needs a sheet.')
  const textKeys = new Set(base.columns.filter(column => isLocalizableContent(column.slot?.of ?? column.key, column.storage)).map(column => column.key))
  const byLanguage = new Map(sheets.map(sheet => [sheet.scope.locale, new Map(sheet.rows.map(row => [`${row.id}:${row.aliasId ?? ''}`, row]))]))
  const columns = base.columns.flatMap(column => textKeys.has(column.key)
    ? sheets.map(sheet => ({ ...column, key: `${column.key}@${sheet.scope.locale}`, locale: sheet.scope.locale,
      group: column.label, groupKey: `language:${column.key}` }))
    : [column])
  return { ...base, columns,
    rows: base.rows.map(row => {
      const values = Object.fromEntries(columns.map(column => {
        if (!column.locale) return [column.key, row.values[column.key]]
        const key = column.key.slice(0, column.key.lastIndexOf('@'))
        return [column.key, byLanguage.get(column.locale)?.get(`${row.id}:${row.aliasId ?? ''}`)?.values[key]]
      }).filter(([, value]) => value !== undefined))
      const parts = sheets.flatMap((sheet, index) => {
        const source = byLanguage.get(sheet.scope.locale)?.get(`${row.id}:${row.aliasId ?? ''}`)
        if (!source) return []
        const qualify = (key: string) => textKeys.has(key) ? `${key}@${sheet.scope.locale}` : key
        // Evaluate conditional requirements against this language's canonical keys before projection.
        const included = sheet.columns.filter(column => index === 0 || textKeys.has(column.key))
          .map(column => ({ ...column, group: textKeys.has(column.key) ? column.label : column.group }))
        const completeness = completenessFor(included, source, source.values)
        return [{ completeness: { ...completeness, required: { ...completeness.required,
          missing: completeness.required.missing.map(missing => ({ ...missing, key: qualify(missing.key) })) } },
          issues: (source.readiness?.issues ?? []).filter(issue => index === 0 || textKeys.has(issue.key)).map(issue => ({ ...issue, key: qualify(issue.key) })) }]
      })
      const filled = parts.reduce((sum, part) => sum + part.completeness.overall.filled, 0)
      const total = parts.reduce((sum, part) => sum + part.completeness.overall.total, 0)
      const groups = new Map<string, { group: string; filled: number; total: number }>()
      for (const part of parts) for (const group of part.completeness.byGroup) {
        const previous = groups.get(group.group)
        groups.set(group.group, { ...group, filled: group.filled + (previous?.filled ?? 0), total: group.total + (previous?.total ?? 0) })
      }
      return { ...row, values, readiness: { ...row.readiness, issues: parts.flatMap(part => part.issues) },
        completeness: { overall: { filled, total, pct: total ? Math.round(filled / total * 100) : 100 },
          required: { filled: parts.reduce((sum, part) => sum + part.completeness.required.filled, 0),
            total: parts.reduce((sum, part) => sum + part.completeness.required.total, 0), missing: parts.flatMap(part => part.completeness.required.missing) },
          byGroup: [...groups.values()] } }
    }),
    groups: columns.reduce<StudioSheet['groups']>((groups, column) => {
      const key = column.groupKey ?? column.group
      if (!groups.some(group => group.key === key)) groups.push({ key, label: column.group, channelLabel: null, order: groups.length })
      return groups
    }, []),
    meta: { ...base.meta, tookMs: sheets.reduce((sum, sheet) => sum + sheet.meta.tookMs, 0) },
  }
}
