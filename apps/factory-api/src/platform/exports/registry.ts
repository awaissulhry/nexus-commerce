import type { ExportFormat } from '@nexus/factory-domain/views/exports'
import { ExportSourceError, formatsOf, type AnyExportSource } from './source'
import { EXPORT_SOURCES } from './sources'
import { reportSourceOf } from './sources/reports'

/**
 * The registry of export sources (./source.ts says what a source is; ./sources/index.ts lists the lists'). W2b
 * (B-W2b-11): besides that fixed list, DYNAMIC sources made when asked for — every report of the pack
 * (`home.reports.<key>`, ./sources/reports.ts), from the report registry folder, so a new report exports with no line
 * here. A fixed source wins over a dynamic one of the same key.
 */

let configured: ReadonlyMap<string, AnyExportSource> | undefined
let fromSources: ReadonlyMap<string, AnyExportSource> | undefined

function mapOf(sources: readonly AnyExportSource[]): ReadonlyMap<string, AnyExportSource> {
  const map = new Map<string, AnyExportSource>()
  for (const source of sources) {
    if (map.has(source.listKey)) throw new ExportSourceError(`${source.listKey}: two export sources`)
    map.set(source.listKey, source)
  }
  return map
}

/** Tests: the fixed sources to use (undefined: the real ones again). The dynamic sources stay. */
export function useExportSources(sources: readonly AnyExportSource[] | undefined): void {
  configured = sources ? mapOf(sources) : undefined
}

/** The fixed sources (one per list, ./sources/index.ts). */
export function processExportSources(): ReadonlyMap<string, AnyExportSource> {
  if (configured) return configured
  fromSources ??= mapOf(EXPORT_SOURCES)
  return fromSources
}

/** The source of a list key: a fixed one, else a dynamic one (a report), else undefined (the list has no export). */
export function exportSourceOf(listKey: string): AnyExportSource | undefined {
  return processExportSources().get(listKey) ?? reportSourceOf(listKey)
}

/** The formats a list exports to (empty: the list has no export). */
export function exportFormatsFor(listKey: string): ExportFormat[] {
  const source = exportSourceOf(listKey)
  return source ? formatsOf(source) : []
}
