import { parsePercent } from '../../quotes/model'
import type { MarginFloors } from './api'

/**
 * Margin floor % per role (B-W2b-343; design sales.settings "Quote approval rules › Margin floor % per role", SAL-189): the
 * pure rules — the row the page's scope edits (the company's own or the group's), the floors as typed per role, what stops
 * Save (in words), whether a change lowers a floor (the save then asks a fresh code), the body. No fetching, no React.
 */

export interface FloorWords {
  key: string
  params?: Record<string, string | number>
}

/** The row this scope keeps its floors in (null: it has none of its own yet; the quote rules' first save makes it). */
export function rowOf(floors: MarginFloors, scope: 'company' | 'group') {
  return scope === 'company' ? floors.company : floors.tenant
}

/** The floors as typed per role key ('' = none: the role keeps the company floor). */
export function draftOf(floors: MarginFloors, scope: 'company' | 'group'): Record<string, string> {
  const own = rowOf(floors, scope)?.floors ?? {}
  return Object.fromEntries(floors.roles.map((role) => [role.key, own[role.key] !== undefined ? String(Number(own[role.key])) : '']))
}

/** What stops Save (the first, in words), or null. */
export function floorsHeld(draft: Readonly<Record<string, string>>, roles: MarginFloors['roles']): FloorWords | null {
  for (const role of roles) {
    const text = (draft[role.key] ?? '').trim()
    if (text !== '' && parsePercent(text) === null) return { key: 'floors.held.pct', params: { role: role.name } }
  }
  return null
}

/** The body's floors: role → percent; none typed → null. */
export function floorsBody(draft: Readonly<Record<string, string>>): Record<string, string> | null {
  const entries = Object.entries(draft)
    .map(([key, text]) => [key, parsePercent(text.trim())] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null)
  return entries.length === 0 ? null : Object.fromEntries(entries)
}

/** The draft differs from the row's floors. */
export function floorsChanged(draft: Readonly<Record<string, string>>, floors: MarginFloors, scope: 'company' | 'group'): boolean {
  const before = draftOf(floors, scope)
  const same = (a: string, b: string) => (a === '' || b === '' ? a === b : Number(a.replace(',', '.')) === Number(b.replace(',', '.')))
  return Object.keys({ ...before, ...draft }).some((key) => !same((before[key] ?? '').trim(), (draft[key] ?? '').trim()))
}

/**
 * A change that lets more quotes through (a floor lowered, a floor removed or added under the company floor): the API
 * asks a fresh code for it; said before the click.
 */
export function lowers(draft: Readonly<Record<string, string>>, floors: MarginFloors, scope: 'company' | 'group'): boolean {
  const before = rowOf(floors, scope)?.floors ?? {}
  const company = Number(floors.inForce.companyFloorPct ?? 'NaN')
  for (const [key, text] of Object.entries(draft)) {
    const next = parsePercent(text.trim())
    const was = before[key]
    if (was !== undefined && (next === null || Number(next) < Number(was))) return true
    if (was === undefined && next !== null && Number.isFinite(company) && Number(next) < company) return true
  }
  return false
}
