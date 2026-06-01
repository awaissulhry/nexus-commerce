'use client'

/**
 * Custom playbooks — operator-saved strategy bundles (from the Composer),
 * persisted in localStorage so they can be re-activated any time alongside the
 * built-in playbooks.
 */

export interface CustomPlaybook { id: string; name: string; automationIds: string[] }
const KEY = 'ads-console:custom-playbooks:v1'

export function loadCustomPlaybooks(): CustomPlaybook[] {
  try { const s = localStorage.getItem(KEY); const a = s ? JSON.parse(s) : []; return Array.isArray(a) ? a : [] } catch { return [] }
}
export function saveCustomPlaybook(name: string, automationIds: string[]): CustomPlaybook[] {
  const pb: CustomPlaybook = { id: `cpb-${Date.now()}-${Math.round(Math.random() * 1e4)}`, name: name.trim() || 'My strategy', automationIds }
  const next = [...loadCustomPlaybooks().filter((p) => p.name !== pb.name), pb]
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* ignore */ }
  return next
}
export function deleteCustomPlaybook(id: string): CustomPlaybook[] {
  const next = loadCustomPlaybooks().filter((p) => p.id !== id)
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* ignore */ }
  return next
}
