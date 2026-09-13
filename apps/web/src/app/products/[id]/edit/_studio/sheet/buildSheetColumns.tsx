import type { ColDef, ColGroupDef } from '@/design-system/grid'
import { languageLabel } from '../scopes'
import { buildMasterColumns } from './master/columns'
import { buildChannelColumns } from './master/channelColumns'
import type { ChannelSheetRow } from './channel/types'

/** Both hosts enter here; language grouping is a sheet fact shared by their column adapters. */
export function buildSheetColumns(scope: 'master', options: Parameters<typeof buildMasterColumns>[0], rows: Parameters<typeof buildMasterColumns>[1]): ReturnType<typeof buildMasterColumns>
export function buildSheetColumns(scope: 'channel', options: Parameters<typeof buildChannelColumns>[0]): Array<ColDef<ChannelSheetRow> | ColGroupDef<ChannelSheetRow>>
export function buildSheetColumns(scope: 'master' | 'channel', options: any, rows?: any): any {
  return scope === 'master'
    ? groupLanguageColumns(buildMasterColumns(options, rows), options.columns)
    : groupLanguageColumns(buildChannelColumns(options), options.gridColumns)
}

export function groupLanguageColumns<T>(defs: Array<ColDef<T> | ColGroupDef<T>>, columns: Array<{ key: string; label: string; locale?: string; groupKey?: string }>): Array<ColDef<T> | ColGroupDef<T>> {
  const schema = new Map(columns.map(column => [column.key, column]))
  const groups = new Map<string, ColGroupDef<T>>()
  const result: Array<ColDef<T> | ColGroupDef<T>> = []
  for (const def of defs) {
    if ('children' in def) { result.push(def); continue }
    const column = schema.get(def.colId ?? String(def.field ?? ''))
    if (!column?.locale) { result.push(def); continue }
    const key = column.groupKey ?? column.key.slice(0, column.key.lastIndexOf('@'))
    let group = groups.get(key)
    if (!group) { group = { groupId: key, headerName: column.label, headerClass: 'nds-ag-group-start', marryChildren: true, children: [] }; groups.set(key, group); result.push(group) }
    group.children.push({ ...def, headerName: languageLabel(column.locale), headerTooltip: `${column.label} · ${languageLabel(column.locale)}` })
  }
  return result
}
