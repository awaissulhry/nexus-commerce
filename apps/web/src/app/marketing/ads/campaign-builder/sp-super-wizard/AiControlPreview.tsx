'use client'

/**
 * RC.4 — AI Control "Control preview", extracted from AiControlPanel so it renders at the very END of
 * Step 3 (after Product Group Details + Sponsored Campaign Set) — the same place the Rule Setting
 * preview sits — and is INTERACTIVE: clicking a module toggles aiControl.modules, so the operator can
 * verify + adjust how the AI will run the set right before launch.
 */
import { InfoTip } from '../../campaigns/InfoTip'
import { AutopilotCanvas } from '../../autopilot/AutopilotCanvas'
import type { AiControlConfig } from './AiControlPanel'

export function AiControlPreview({ value, onChange }: { value: AiControlConfig; onChange: (v: AiControlConfig) => void }) {
  const toggle = (k: string) => onChange({ ...value, modules: { ...value.modules, [k]: !value.modules[k as keyof AiControlConfig['modules']] } })
  return (
    <div className="h10-spw-card">
      <h3>Control preview <InfoTip tip="How the AI will run this set. Click a module to turn it on or off before launch." /></h3>
      <p className="h10-spw-desc">Signals → Goal → modules → Guardrails → Actions. Click a module to manage it. You get the full drag-and-drop control room on the Autopilot page after launch.</p>
      <AutopilotCanvas config={{ goal: value.goal, modules: { ...value.modules } }} onToggleModule={toggle} compact />
    </div>
  )
}
