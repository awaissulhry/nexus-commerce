// UC.7 — Shared cockpit health model.
//
// The canonical health shape both channels produce (a "check pack") and
// the shared HealthPanel renders. Amazon's computeHealthScore already
// emits this shape (its JumpTarget is a string-literal subset of
// `target: string`), so its report passes straight through; eBay builds
// the same shape from its own checks.

export type CheckGroup = 'blocker' | 'required' | 'recommended' | 'polish'
export type CheckStatus = 'pass' | 'fail' | 'warn'
export type HealthStatus = 'ready' | 'warn' | 'blocked' | 'suppressed'

export interface HealthCheck {
  id: string
  group: CheckGroup
  label: string
  /** Short rationale when failing — shown beneath the row. */
  hint?: string
  /** Concrete current value, rendered as a mono pill on the right. */
  value?: string
  /** Optional scoring weight (not used by the renderer). */
  weight?: number
  status: CheckStatus
  /** Jump-target id for click-to-jump. */
  target: string
}

export interface HealthReport {
  score: number
  status: HealthStatus
  summary: {
    blocker: { pass: number; total: number }
    required: { pass: number; total: number }
    recommended: { pass: number; total: number }
    polish: { pass: number; total: number }
  }
  checks: HealthCheck[]
}
