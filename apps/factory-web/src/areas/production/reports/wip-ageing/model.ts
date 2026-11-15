import { isApiError } from '../../../../lib/api/errors'
import { AGE_BANDS, type AgeBand, type WipAgeing } from './api'

/** WIP ageing by line (B-W2b-435; ANA-015), pure. Words: `home-digest` keys. */

/** The panel needs the KPI library and the production reports (the drill's own rights). */
export const WIP_AGEING_NEEDS = ['home.kpis.view', 'production.reports.view'] as const
export const wipAgeingAllowed = (permissions: readonly string[]): boolean => WIP_AGEING_NEEDS.every((permission) => permissions.includes(permission))

export interface LineGroup {
  /** The line (null: work orders on no line). */
  readonly line: { readonly id: string; readonly code: string; readonly name: string } | null
  readonly waiting: number
  readonly stages: readonly { readonly code: string; readonly name: string; readonly waiting: number; readonly workOrders: number; readonly ageing: Readonly<Record<AgeBand, number>> }[]
}

/** The stages grouped by line, lines by code (no line last), stages in the drill's order. */
export function byLine(wip: WipAgeing): LineGroup[] {
  const groups = new Map<string, { line: LineGroup['line']; stages: LineGroup['stages'][number][] }>()
  for (const stage of wip.stages) {
    const key = stage.line?.id ?? ''
    const group = groups.get(key) ?? { line: stage.line, stages: [] }
    group.stages.push({ code: stage.operation.code, name: stage.operation.name, waiting: stage.waiting, workOrders: stage.workOrders, ageing: stage.ageing })
    groups.set(key, group)
  }
  return [...groups.values()]
    .map((group) => ({ line: group.line, waiting: group.stages.reduce((total, stage) => total + stage.waiting, 0), stages: group.stages }))
    .sort((a, b) => (a.line === null ? 1 : 0) - (b.line === null ? 1 : 0) || (a.line?.code ?? '').localeCompare(b.line?.code ?? ''))
}

/** The garments that waited over 10 days, across every line. */
export const oldWaiting = (wip: WipAgeing): number => wip.stages.reduce((total, stage) => total + stage.ageing.D11_PLUS, 0)

export const bandTone = (band: AgeBand): 'neutral' | 'info' | 'warning' | 'danger' => (band === 'D11_PLUS' ? 'danger' : band === 'D6_10' ? 'warning' : band === 'D3_5' ? 'info' : 'neutral')

export const BANDS = AGE_BANDS

export function wipProblem(error: unknown): string {
  if (!isApiError(error)) return 'wip.error.read'
  if (error.kind === 'forbidden') return 'wip.error.forbidden'
  if (error.kind === 'unavailable') return 'wip.error.offline'
  return 'wip.error.read'
}
