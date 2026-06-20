'use client'

/** Negative Targeting tab — thin wrapper over the shared RuleListTab with the recorded rules. */
import { RuleListTab } from './RuleListTab'
import { TAB_RULES } from './placeholderSeeds'

export function NegativeTargetingTab({ onAddRule }: { onAddRule: () => void }) {
  const cfg = TAB_RULES['negative-targeting']
  return <RuleListTab noun={cfg.noun} seed={cfg.rows} onAddRule={onAddRule} />
}
