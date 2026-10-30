import type { ExportFormat } from '@nexus/factory-domain/views/exports'
import { ExportSourceError, type AnyExportSource } from './source'
import { EXPORT_SOURCES } from './sources'

/** The registry of export sources (./source.ts says what a source is; ./sources/index.ts lists them). */

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

/** Tests: the sources to use (undefined: the real ones again). */
export function useExportSources(sources: readonly AnyExportSource[] | undefined): void {
  configured = sources ? mapOf(sources) : undefined
}

export function processExportSources(): ReadonlyMap<string, AnyExportSource> {
  if (configured) return configured
  fromSources ??= mapOf(EXPORT_SOURCES)
  return fromSources
}

/** The formats a list exports to (empty: the list has no export). */
export function exportFormatsFor(listKey: string): ExportFormat[] {
  const source = processExportSources().get(listKey)
  if (!source) return []
  return [...(source.formats ?? ['CSV', 'XLSX'])]
}
