import { FieldDefinition } from './registry/types'

export function resolveEffective(
  listing: Record<string, unknown>,
  field: FieldDefinition,
): { value: unknown; followsMaster: boolean } {
  const fm = field.followMaster
  if (!fm) return { value: listing[field.source.column] ?? '', followsMaster: false }
  const followsMaster = listing[fm.followColumn] !== false // default true
  const value = followsMaster ? listing[fm.masterCacheColumn] ?? '' : listing[fm.overrideColumn] ?? listing[field.source.column] ?? ''
  return { value, followsMaster }
}
