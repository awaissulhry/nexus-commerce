import type { Cell } from 'exceljs'
import type { FieldDefinition } from './registry/types'

export function isoDate(d: Date | string | null): string {
  if (!d) return ''
  const dt = d instanceof Date ? d : new Date(d)
  return dt.toISOString().slice(0, 10)
}

export function joinArray(a: unknown, delim: string): string {
  return Array.isArray(a)
    ? a.map(x => String(x).split(delim.trim()).join('/')).join(delim)
    : a == null
      ? ''
      : String(a)
}

export function writeCell(cell: Cell, field: FieldDefinition, value: unknown): void {
  if (value == null || value === '') {
    cell.value = ''
    if (field.forcedText) cell.numFmt = '@'
    return
  }

  switch (field.kind) {
    case 'decimal':
      cell.value = Number(value)
      cell.numFmt = '0.' + '0'.repeat(field.decimals ?? 2)
      break
    case 'number':
      cell.value = Number(value)
      break
    case 'date':
      cell.value = isoDate(value as any)
      cell.numFmt = '@'
      break
    case 'array':
      cell.value = joinArray(value, field.arrayDelimiter ?? ' | ')
      break
    case 'boolean':
      cell.value = value ? 'true' : 'false'
      break
    default:
      cell.value = String(value)
      if (field.forcedText) cell.numFmt = '@'
  }
}
