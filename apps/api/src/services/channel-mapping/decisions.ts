import type { MappingFieldRow } from '@nexus/shared/channel-mapping'

/**
 * CHMAP — the decisions of ONE mapping version, handed to a reader. Pure; no imports from the readers, so a
 * reader can import this type without an import cycle.
 */
export interface ReaderMapping {
  setId: string
  version: number
  status: string
  /** `Amazon IT · COAT+PANTS · v2 (active)` — named in every reason a decision writes. */
  label: string
  /** channelKey → decision. */
  byKey: Map<string, MappingFieldRow>
}

export function readerMapping(set: { id: string; version: number; status: string }, label: string, fields: readonly MappingFieldRow[]): ReaderMapping {
  const byKey = new Map<string, MappingFieldRow>()
  for (const f of fields) {
    byKey.set(f.channelKey, f)
    for (const alias of f.aliases) if (!byKey.has(alias)) byKey.set(alias, f)
  }
  return { setId: set.id, version: set.version, status: set.status, label, byKey }
}

/** The sentence a refused cell carries when its column is not mapped. */
export const unmappedReason = (mapping: Pick<ReaderMapping, 'label'>, column: string, why?: string | null) =>
  `Column ${column} is not mapped in ${mapping.label}${why ? ` (${why})` : ''}. Map or ignore it on the Mapping page, then import again.`

/** The sentence an excluded cell carries when the Owner chose to ignore its column. */
export const ignoredReason = (mapping: Pick<ReaderMapping, 'label'>, reason: string | null) =>
  `Ignored by ${mapping.label}: ${reason ?? 'no reason given'}`
