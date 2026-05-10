// MC.11.1 — Marketing-content automation rule types.
//
// The shared AutomationRule model stores conditions[] + actions[]
// (both arrays). Marketing-content rules use a single trigger config
// + a single action — we wrap them into the array shape on save +
// unwrap on load. The unwrapping helpers below normalise.

export interface SharedRuleRow {
  id: string
  domain: string
  name: string
  description: string | null
  trigger: string
  conditions: unknown
  actions: unknown
  enabled: boolean
  dryRun: boolean
  evaluationCount: number
  matchCount: number
  executionCount: number
  lastEvaluatedAt: string | null
  lastMatchedAt: string | null
  lastExecutedAt: string | null
  createdAt: string
  updatedAt: string
  createdBy: string | null
}

/** Marketing-content rules normalise to this shape on the client. */
export interface RuleRow {
  id: string
  name: string
  description: string | null
  trigger: string
  triggerConfig: Record<string, unknown>
  action: string
  actionConfig: Record<string, unknown>
  enabled: boolean
  dryRun: boolean
  executionCount: number
  lastExecutedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ExecutionRow {
  id: string
  ruleId: string
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  status: string
  triggerData: unknown
  actionResults: unknown
  dryRun: boolean
  errorMessage: string | null
}

export function normaliseRule(raw: SharedRuleRow): RuleRow {
  const cond = Array.isArray(raw.conditions) && raw.conditions[0]
    ? (raw.conditions[0] as { type?: string; data?: Record<string, unknown> })
    : null
  const act = Array.isArray(raw.actions) && raw.actions[0]
    ? (raw.actions[0] as { type?: string; config?: Record<string, unknown> })
    : null
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    trigger: raw.trigger,
    triggerConfig: cond?.data ?? {},
    action: act?.type ?? 'noop',
    actionConfig: act?.config ?? {},
    enabled: raw.enabled,
    dryRun: raw.dryRun,
    executionCount: raw.executionCount,
    lastExecutedAt: raw.lastExecutedAt,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  }
}
