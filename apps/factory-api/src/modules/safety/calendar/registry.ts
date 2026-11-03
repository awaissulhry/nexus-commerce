import { pathToFileURL } from 'node:url'
import { isCalendarSource, type CalendarSource } from './source'
import { sourceFiles } from './source-files'

/**
 * The safety calendar's sources of this process (B-W2b-120): the default export of every file in `./sources/`
 * (./source-files.ts), loaded once when the calendar routes register. A file without a source, or two sources of one kind,
 * stop the API at start (and fail the test), never at the first request. Tests may set their own.
 */

let configured: readonly CalendarSource[] | undefined
let loaded: readonly CalendarSource[] | undefined

export class CalendarSourceError extends Error {
  override name = 'CalendarSourceError'
}

function checked(sources: readonly CalendarSource[]): readonly CalendarSource[] {
  const kinds = new Set<string>()
  for (const source of sources) {
    if (kinds.has(source.kind)) throw new CalendarSourceError(`Two calendar sources of kind ${source.kind}`)
    kinds.add(source.kind)
  }
  return Object.freeze([...sources])
}

/** Loads every source file under `root` (`src/` or `dist/`). */
export async function loadSources(root: string): Promise<readonly CalendarSource[]> {
  if (loaded) return loaded
  const sources: CalendarSource[] = []
  for (const file of sourceFiles(root)) {
    const module = (await import(pathToFileURL(file).href)) as { default?: unknown }
    if (!isCalendarSource(module.default)) throw new CalendarSourceError(`${file} does not default-export defineCalendarSource({…})`)
    sources.push(module.default)
  }
  loaded = checked(sources)
  return loaded
}

/** Tests: the sources to use (undefined: the loaded ones again). */
export function useSources(sources: readonly CalendarSource[] | undefined): void {
  configured = sources ? checked(sources) : undefined
}

/** The sources of this process (after loadSources). */
export function processSources(): readonly CalendarSource[] {
  if (configured) return configured
  if (!loaded) throw new CalendarSourceError('The calendar sources are not loaded yet (loadSources runs when the calendar routes register).')
  return loaded
}
