import { scoped, type Phrase } from '../../payments/riba/depth'
import type { AreaLine, AreaOutcome } from './api'

/**
 * The leather area check's rules without a screen (B-W2b-425): who may open an area claim, why the button waits, the tone of
 * an outcome. Pure: the tests hold it.
 */

export interface AreaCan {
  /** payables.view: the check is read. */
  view: boolean
  /** purchasing.view: the order and the claims open as links. */
  purchasing: boolean
}

export const areaCanOf = (permissions: readonly string[]): AreaCan => ({ view: permissions.includes('payables.view'), purchasing: permissions.includes('purchasing.view') })

export const AREA_TONE: Record<AreaOutcome, 'success' | 'danger' | 'warning' | 'neutral'> = { WITHIN: 'success', SHORT: 'danger', OVER: 'warning', NOT_RECEIVED: 'neutral' }

/**
 * Why "Open area claim" waits on a line (null: it opens), in the order the API refuses: no area to read, nothing received,
 * nothing short, no right over the supplier at the order's site (the answer's `claim.held` is set while the check opens a
 * claim), a write running.
 */
export function claimHeld(line: AreaLine, busy: boolean): Phrase | null {
  if (!line.check) return { key: scoped('area.held.noArea') }
  if (!line.check.opensClaim) return { key: scoped(line.check.outcome === 'NOT_RECEIVED' ? 'area.held.notReceived' : 'area.held.nothing') }
  if (line.claim.held) return { key: scoped('area.held.right') }
  if (busy) return { key: 'held.busy' }
  return null
}

/** A supplier invoice event or a receipt posted reads the check again (design page.live "inventory.receipt.posted → Match results"). */
export const areaTouched = (change: { type: string }): boolean => change.type.startsWith('supplier_invoice.') || change.type === 'receipt.posted' || change.type.startsWith('supplier_claim.')
