// Pure action model for canvas actions (P3.1). Computes the per-campaign change
// set + blast-radius for the safe campaign-level levers, and the relative endpoint
// path + body for each (the apply step adds the backend base, applyImmediately, and
// reason, and routes through the existing write-gate). No side effects here.

export interface ActionBudget {
  kind: 'budget'
  mode: 'set' | 'incPct' | 'decPct'
  value: number
}
export interface ActionStatus {
  kind: 'status'
  status: 'ENABLED' | 'PAUSED' | 'ARCHIVED'
}
export interface ActionTargetAcos {
  kind: 'targetAcos'
  pct: number
}
export interface ActionPlacement {
  kind: 'placement'
  placement: 'PLACEMENT_TOP' | 'PLACEMENT_PRODUCT_PAGE' | 'PLACEMENT_REST_OF_SEARCH'
  percentage: number
}
export type ActionSpec = ActionBudget | ActionStatus | ActionTargetAcos | ActionPlacement

export interface CampaignInput {
  id: string
  name: string
  dailyBudget?: number
  status?: string
}
export interface PerCampaignChange {
  id: string
  name: string
  label: string
  before: string
  after: string
  path: string
  body: Record<string, unknown>
}
export interface Staged {
  changes: PerCampaignChange[]
  blastRadius: { count: number; budgetDeltaEur: number }
}

const r2 = (n: number) => Math.round(n * 100) / 100
const eur = (n: number) => `€${r2(n).toLocaleString('en-IE')}`
const MIN_BUDGET = 1

export function stageActions(camps: CampaignInput[], action: ActionSpec): Staged {
  let budgetDelta = 0
  const changes: PerCampaignChange[] = camps.map((c) => {
    switch (action.kind) {
      case 'budget': {
        const cur = c.dailyBudget ?? 0
        const raw =
          action.mode === 'set'
            ? action.value
            : action.mode === 'incPct'
              ? cur * (1 + action.value / 100)
              : cur * (1 - action.value / 100)
        const next = Math.max(MIN_BUDGET, r2(raw))
        budgetDelta += next - cur
        return {
          id: c.id,
          name: c.name,
          label: 'Daily budget',
          before: eur(cur),
          after: eur(next),
          path: `/campaigns/${c.id}`,
          body: { dailyBudget: next },
        }
      }
      case 'status':
        return {
          id: c.id,
          name: c.name,
          label: 'Status',
          before: c.status ?? '—',
          after: action.status,
          path: `/campaigns/${c.id}`,
          body: { status: action.status },
        }
      case 'targetAcos':
        return {
          id: c.id,
          name: c.name,
          label: 'Target ACoS',
          before: '—',
          after: `${action.pct}%`,
          path: `/campaigns/${c.id}/automation`,
          body: { targetAcos: r2(action.pct / 100) },
        }
      case 'placement':
        return {
          id: c.id,
          name: c.name,
          label: `Placement · ${action.placement}`,
          before: '—',
          after: `${action.percentage}%`,
          path: `/campaigns/${c.id}/placements`,
          body: { adjustments: [{ placement: action.placement, percentage: action.percentage }] },
        }
    }
  })
  return { changes, blastRadius: { count: changes.length, budgetDeltaEur: r2(budgetDelta) } }
}
