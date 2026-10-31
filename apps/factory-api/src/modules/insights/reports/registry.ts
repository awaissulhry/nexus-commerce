import { pathToFileURL } from 'node:url'
import { packProblems } from '@nexus/factory-domain/insights/reports/definition'
import { reportFiles } from './report-files'
import { isReport, ReportConfigError, type ReportDefinition } from './report'

/**
 * The standard reports of this process (B-W2a-79): the default export of every file in `./defs/` (./report-files.ts),
 * loaded once when the insights routes register. Two reports of one key, a file without a report or a file whose name is
 * not its key stop the API at start (and fail the registry test), never at the first request. Tests may set their own.
 */

let configured: readonly ReportDefinition[] | undefined
let loaded: readonly ReportDefinition[] | undefined

/** Checks a set of reports: good definitions, one per key, in the library's order (area, then title). */
export function checkReports(reports: readonly ReportDefinition[]): readonly ReportDefinition[] {
  const problems = packProblems(reports)
  if (problems.length > 0) throw new ReportConfigError(problems.join('; '))
  return Object.freeze([...reports])
}

/** Loads every report file under `root` (`src/` or `dist/`); the file `<key>.ts` holds the report `<key>`. */
export async function loadReports(root: string): Promise<readonly ReportDefinition[]> {
  if (loaded) return loaded
  const reports: ReportDefinition[] = []
  for (const file of reportFiles(root)) {
    const module = (await import(pathToFileURL(file).href)) as { default?: unknown }
    if (!isReport(module.default)) throw new ReportConfigError(`${file} does not default-export defineReport({…})`)
    const name = file.split(/[\\/]/).pop()!.replace(/\.(ts|js|mjs)$/, '')
    if (name !== module.default.key) throw new ReportConfigError(`${file} holds the report ${module.default.key}: name the file after its key`)
    reports.push(module.default)
  }
  loaded = checkReports(reports)
  return loaded
}

/** Tests: the reports to use (undefined: the loaded ones again). */
export function useReports(reports: readonly ReportDefinition[] | undefined): void {
  configured = reports ? checkReports(reports) : undefined
}

/** The reports of this process (after loadReports). */
export function processReports(): readonly ReportDefinition[] {
  if (configured) return configured
  if (!loaded) throw new ReportConfigError('The reports are not loaded yet (loadReports runs when the insights routes register).')
  return loaded
}

export function reportOf(key: string): ReportDefinition | undefined {
  return processReports().find((report) => report.key === key)
}
