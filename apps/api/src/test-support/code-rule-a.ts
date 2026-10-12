/**
 * Tests only — the Owner's code rule A (2026-10-07) set back on: every big door it named asks the approver's
 * authenticator code again. Since 2026-10-12 (Owner, "B") every line of the table is off; the tests that prove the code
 * path call `codeRuleA()` in a beforeEach (the table's own `__codeRuleTest.reset()` puts it back), as the Owner could
 * set a line back on.
 */
import { __codeRuleTest, type CodeDoor } from '../services/agents/tools/ads-code-rule.js'

/** The big doors of rule A, as the table named them until 2026-10-12. */
export const RULE_A_DOORS: readonly CodeDoor[] = [
  'create-ad-group: startLive',
  'set-ad-group: op start',
  'add-product-ads',
  'set-campaign-live-writes: on',
  'restore-campaign: born at the floor',
  'apply-ads-playbook: start',
  'apply-ads-playbook: a phase switch that raises',
  'set-ads-playbook: adds spend',
  'set-ads-strategy: a raise',
  'enable-ads: includePeoplesPauses',
  'set-bid-brain-enrollment: live',
  'set-ads-brain: a lever to AUTO',
  'set-ads-brain: leave lifts the brain\'s pauses',
  'set-ads-brain: a portfolio cap limit raised',
  'set-brain-kill-switch: end',
]

/** Every big door of rule A asks the code again, until `__codeRuleTest.reset()`. */
export function codeRuleA(): void {
  __codeRuleTest.reset()
  for (const door of RULE_A_DOORS) __codeRuleTest.flip(door, true)
}
