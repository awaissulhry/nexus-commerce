import type { SheetWriteRequest, SheetWriteResult } from '@/design-system/grid'

/** Separate language contexts while retaining the writer's one-row CAS sequence. */
export async function commitLanguageGroups<T>(request: SheetWriteRequest<T>, languageOf: (key: string) => string | undefined,
  commit: (request: SheetWriteRequest<T>, language: string | undefined) => Promise<SheetWriteResult>): Promise<SheetWriteResult> {
  const groups = new Map<string | undefined, typeof request.cells>()
  for (const cell of request.cells) { const language = languageOf(cell.colId); groups.set(language, [...(groups.get(language) ?? []), cell]) }
  if (groups.size < 2) return commit(request, groups.keys().next().value)
  const cells: NonNullable<SheetWriteResult['cells']> = {}
  let version = request.expectedVersion, failure: SheetWriteResult | undefined
  for (const [language, subset] of groups) {
    if (failure?.conflict || failure?.unreachable) {
      for (const cell of subset) cells[cell.colId] = { ok: false, reason: 'Refresh this row before saving the remaining languages.' }
      continue
    }
    const result = await commit({ ...request, cells: subset, expectedVersion: version }, language)
    if (result.version !== undefined) version = result.version
    for (const cell of subset) cells[cell.colId] = result.cells?.[cell.colId] ?? { ok: result.ok, reason: result.reason, unreachable: result.unreachable }
    if (!result.ok || result.conflict || result.unreachable) failure = result
  }
  return { ok: Object.values(cells).some(cell => cell.ok), cells, version, reason: failure?.reason, conflict: failure?.conflict, unreachable: failure?.unreachable }
}
