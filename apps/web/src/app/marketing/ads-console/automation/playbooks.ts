/**
 * Playbooks — one-click strategy bundles. A playbook enables several catalogue
 * automations at once so an operator can adopt a whole posture ("Profit
 * Autopilot", "Margin Defender", …) in a single click instead of wiring rules
 * one by one. Each references catalogue template ids (resolved at enable time;
 * missing ids are skipped, so this stays safe even if the catalogue shifts).
 */

import { CATALOG, type AutoTemplate } from './catalog'

export interface Playbook {
  id: string
  name: string
  icon: string
  goal: string
  desc: string
  templateIds: string[]
}

export const PLAYBOOKS: Playbook[] = [
  {
    id: 'profit-autopilot', name: 'Profit Autopilot', icon: '🤖', goal: 'Hands-off profitable growth',
    desc: 'The full set-and-forget stack: profit-native bid optimisation, daily harvest & negate, retail guard, and a €2k monthly safety cap. The closest thing to a 24/7 PPC manager.',
    templateIds: ['profit-bidding', 'harvest-60-2-10', 'retail-guard', 'cap-2000'],
  },
  {
    id: 'margin-defender', name: 'Margin Defender', icon: '🛟', goal: 'Protect profitability',
    desc: 'Clamps down the moment ads stop paying: trim budget at ACOS ≥ 40%, bid −20% at ACOS ≥ 50%, auto-defend on profit breach, and alert on negative ad margin.',
    templateIds: ['trim-40-15', 'bid-down-50-20', 'negative-margin-defend', 'negative-margin-alert'],
  },
  {
    id: 'aggressive-growth', name: 'Aggressive Growth', icon: '🚀', goal: 'Scale winners fast',
    desc: 'Lean into momentum: target-ACOS bid optimisation, scale budget +20% on ROAS ≥ 3 winners, and aggressive harvesting of converting terms.',
    templateIds: ['target-acos-bidding', 'scale-3-20', 'harvest-30-1-5'],
  },
  {
    id: 'waste-eliminator', name: 'Waste Eliminator', icon: '🧹', goal: 'Kill wasted spend',
    desc: 'Stops the bleed: pause targets that spent €20 with no sales, negate wasted search terms, and bid −25% on campaigns over 80% ACOS.',
    templateIds: ['prune-20-0', 'harvest-60-2-10', 'bid-down-80-25'],
  },
  {
    id: 'launch-mode', name: 'Launch Mode', icon: '🎬', goal: 'Win a new product launch',
    desc: 'Discovery-first for new ASINs: short-window harvesting to find converting terms fast, plus eager budget scaling on early ROAS ≥ 2.5 signals.',
    templateIds: ['harvest-14-1-5', 'scale-2.5-25'],
  },
  {
    id: 'inventory-safe', name: 'Inventory-Safe', icon: '📦', goal: 'Never waste spend on dead stock',
    desc: 'Inventory-aware defense: pause ads on out-of-stock / lost-Buy-Box products, and auto-liquidate stock nearing long-term-storage with a promo.',
    templateIds: ['retail-guard', 'aged-14'],
  },
  {
    id: 'tight-budget', name: 'Tight Budget', icon: '🪙', goal: 'Spend every euro well on a small budget',
    desc: 'For lean budgets: a hard €1k monthly cap, ACOS ≥ 35% bid cuts, and pause targets after just €10 of wasted spend.',
    templateIds: ['cap-1000', 'bid-down-35-15', 'prune-10-0'],
  },
  {
    id: 'set-and-forget', name: 'Set & Forget Lite', icon: '😌', goal: 'Safe automation for beginners',
    desc: 'A gentle starting posture: profit bid optimisation, harvest & negate, and a negative-margin alert (notify-only) — nothing aggressive.',
    templateIds: ['profit-bidding', 'harvest-60-2-10', 'negative-margin-alert'],
  },
]

export const playbookTemplates = (p: Playbook): AutoTemplate[] =>
  p.templateIds.map((id) => CATALOG.find((t) => t.id === id)).filter((t): t is AutoTemplate => !!t)
