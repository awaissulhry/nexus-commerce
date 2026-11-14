import { kpiFileProblems, type KpiFile } from './catalogue'
import { KPI_FILES } from './defs'

/**
 * The KPI catalogue in code, by key (B-W2b-428): the calculation every reader uses. A KPI the database has versions of but
 * no file here (a KPI a later step brings, or one withdrawn) has no calculation: its value says so (NO_CALCULATION).
 */

const BY_KEY: ReadonlyMap<string, KpiFile> = new Map(KPI_FILES.map((file) => [file.key, file]))

export const KPI_CATALOGUE: readonly KpiFile[] = KPI_FILES

export const kpiFileOf = (key: string): KpiFile | null => BY_KEY.get(key) ?? null

/** What is wrong with the catalogue as a whole (empty when nothing): two files of a key, a bad file. */
export function catalogueProblems(files: readonly KpiFile[] = KPI_FILES): string[] {
  const problems = files.flatMap(kpiFileProblems)
  const keys = files.map((file) => file.key)
  for (const key of new Set(keys)) if (keys.filter((other) => other === key).length > 1) problems.push(`${key}: two files`)
  return problems
}
