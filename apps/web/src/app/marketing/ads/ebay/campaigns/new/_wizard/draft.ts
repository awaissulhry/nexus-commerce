/**
 * ER2 — draft persistence (SPEC §7): localStorage per (type, marketplace),
 * versioned; incompatible versions are discarded. Client-only by design —
 * single-operator console (server drafts recorded as an ER4 proposal).
 */
import type { CampaignPlan, WizardType } from './plan'

const key = (type: WizardType, marketplace: string) => `ebay-builder-draft:${type}:${marketplace}`

export function saveDraft(plan: CampaignPlan): void {
  try { localStorage.setItem(key(plan.type, plan.marketplace), JSON.stringify({ ...plan, savedAt: new Date().toISOString() })) } catch { /* quota — drafts are best-effort */ }
}

export function loadDraft(type: WizardType, marketplace: string): (CampaignPlan & { savedAt?: string }) | null {
  try {
    const raw = localStorage.getItem(key(type, marketplace))
    if (!raw) return null
    const p = JSON.parse(raw) as CampaignPlan & { savedAt?: string }
    if (p.v !== 1) { localStorage.removeItem(key(type, marketplace)); return null }
    return p
  } catch { return null }
}

export function clearDraft(type: WizardType, marketplace: string): void {
  try { localStorage.removeItem(key(type, marketplace)) } catch { /* noop */ }
}
