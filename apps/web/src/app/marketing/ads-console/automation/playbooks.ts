/**
 * Playbooks — one-click strategy bundles. A playbook activates several distinct
 * automations at once so an operator adopts a whole posture in a single click.
 * References automation ids (resolved at enable time; missing ids are skipped).
 */

import { AUTOMATIONS, type AutomationDef } from './automations'

export interface Playbook {
  id: string
  name: string
  icon: string
  goal: string
  desc: string
  automationIds: string[]
}

export const PLAYBOOKS: Playbook[] = [
  { id: 'profit-autopilot', name: 'Profit Autopilot', icon: '🤖', goal: 'Hands-off profitable growth', desc: 'The full set-and-forget stack: profit-native bid optimisation, daily harvest & negate, retail guard, and a monthly spend cap.', automationIds: ['profit-bid-opt', 'harvest-negate', 'retail-guard', 'monthly-cap'] },
  { id: 'margin-defender', name: 'Margin Defender', icon: '🛟', goal: 'Protect profitability', desc: 'Clamps down when ads stop paying: trim budget on weak ACOS, cut bids on spikes, bid down on profit breach, and alert on negative margin.', automationIds: ['trim-budget-losers', 'cut-bids-acos', 'biddown-profit-breach', 'alert-profit-breach'] },
  { id: 'aggressive-growth', name: 'Aggressive Growth', icon: '🚀', goal: 'Scale winners fast', desc: 'Lean into momentum: target-ACOS bidding, scale budget on capped winners, and aggressive harvesting.', automationIds: ['target-acos-bid-opt', 'scale-budget-winners', 'harvest-negate'] },
  { id: 'waste-eliminator', name: 'Waste Eliminator', icon: '🧹', goal: 'Kill wasted spend', desc: 'Stop the bleed: pause dead targets, negate wasted terms, and drop wasted keywords to the bid floor.', automationIds: ['pause-wasted-adgroup', 'negate-wasted-term', 'floor-wasted-kw'] },
  { id: 'launch-mode', name: 'Launch Mode', icon: '🎬', goal: 'Win a new product launch', desc: 'Discovery-first for new ASINs: promote converting terms, scale budget on early winners, and boost starved keywords.', automationIds: ['promote-converting', 'scale-budget-winners', 'boost-no-impressions'] },
  { id: 'inventory-safe', name: 'Inventory-Safe', icon: '📦', goal: 'Never waste spend on dead stock', desc: 'Inventory-aware defense: retail guard on stock & Buy Box, plus auto-liquidation of aged stock.', automationIds: ['retail-guard', 'liquidate-aged'] },
  { id: 'tight-budget', name: 'Tight Budget', icon: '🪙', goal: 'Spend every euro well', desc: 'For lean budgets: a hard monthly cap, ACOS bid cuts, and archiving of wasted keywords.', automationIds: ['monthly-cap', 'cut-bids-acos', 'archive-wasted-kw'] },
  { id: 'set-and-forget', name: 'Set & Forget Lite', icon: '😌', goal: 'Safe automation for beginners', desc: 'A gentle posture: profit bid optimisation, harvest & negate, and a negative-margin alert (notify-only).', automationIds: ['profit-bid-opt', 'harvest-negate', 'alert-profit-breach'] },
]

export const playbookAutomations = (p: Playbook): AutomationDef[] =>
  p.automationIds.map((id) => AUTOMATIONS.find((a) => a.id === id)).filter((a): a is AutomationDef => !!a)
