import { kitActions, KIT_HELD, type KitHeld } from '@nexus/factory-domain/inventory/kits/rules'
import { lineName, type PickList } from '../model'
import type { Walk } from '../picklist/model'

/**
 * Kit staging on the floor (B-W2b-310, follow-up FT2:01; design floor.pick sec:kit "Location, the list with ticks, 'Kit complete'
 * (main)"; SCM-213; apps/factory-api modules/inventory/kits, B-W2b-15): where the work order's picked material waits (a place of
 * the site, set by scanning its label) and the "kit complete" check, held while a line is short — the same rules as the office's
 * Picking & kits (factory-domain inventory/kits kitActions), so a held button says why before the office's answer does. Who checked
 * it is the record's; the screen says only when. Pure.
 */

export type KitState = 'checked' | 'complete' | 'partly' | 'open'

export interface KitLine {
  readonly key: string
  readonly name: string
  readonly covered: boolean
  readonly toIssue: string
  readonly uom: string
}

export interface KitView {
  readonly workOrder: { readonly id: string; readonly number: string; readonly status: string }
  readonly style: string | null
  readonly location: { readonly id: string; readonly code: string; readonly name: string } | null
  readonly checkedAt: string | null
  readonly version: number
  readonly lines: readonly KitLine[]
}

/** The kit of the work order on screen: the walk's kit record (place, check, version) over the pick list's lines and ticks. */
export function kitOf(walk: Walk, list: PickList): KitView {
  return {
    workOrder: { id: walk.workOrder.id, number: walk.workOrder.number, status: walk.workOrder.status },
    style: `${list.workOrder.style.code} · ${list.workOrder.style.name}`,
    location: walk.kit.location,
    checkedAt: walk.kit.checkedAt,
    version: walk.kit.version,
    lines: list.lines.map((line) => ({ key: line.key, name: lineName(line), covered: line.covered, toIssue: line.toIssue, uom: line.baseUom })),
  }
}

export function kitState(kit: Pick<KitView, 'checkedAt' | 'lines'>): KitState {
  if (kit.checkedAt) return 'checked'
  const picked = kit.lines.filter((line) => line.covered).length
  if (kit.lines.length > 0 && picked === kit.lines.length) return 'complete'
  return picked > 0 ? 'partly' : 'open'
}

export const KIT_TONE: Readonly<Record<KitState, 'success' | 'info' | 'warning' | 'neutral'>> = { checked: 'success', complete: 'info', partly: 'warning', open: 'neutral' }

/** Why "Kit complete" or a staging scan waits now, or null. The office's answer keeps the last word (a 409 `kit/<CODE>`). */
export type KitHeldNow = 'offline' | 'busy' | KitHeld | null

export function kitHeldNow(kit: Pick<KitView, 'workOrder' | 'checkedAt' | 'lines'>, action: 'stage' | 'complete', state: { readonly online: boolean; readonly busy: boolean }): { held: KitHeldNow; count?: number } {
  if (!state.online) return { held: 'offline' }
  if (state.busy) return { held: 'busy' }
  const actions = kitActions({ workOrderStatus: kit.workOrder.status, lines: kit.lines.length, short: kit.lines.filter((line) => !line.covered).length, checked: kit.checkedAt !== null })
  const now = actions[action]
  return now.allowed ? { held: null } : { held: now.held, ...(now.count === undefined ? {} : { count: now.count }) }
}

/** The kit's refusals the screen says in its own words: the rules' held codes, a label no place carries, a place no kit waits at. */
export const KIT_REFUSALS = [...KIT_HELD, 'NOT_A_PLACE', 'NOT_A_KIT_PLACE'] as const

/** The last kit step, as the strip shows it: staged at a place, or checked complete. */
export type KitLast = { readonly kind: 'staged'; readonly place: string } | { readonly kind: 'checked' }
