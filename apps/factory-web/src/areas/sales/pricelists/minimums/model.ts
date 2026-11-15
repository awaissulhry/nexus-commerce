import { MINIMUM_ACTIONS, MINIMUM_PER } from '@nexus/factory-domain/sales/pricing-depth/rules'
import { parsePercent } from '../../quotes/model'
import type { Minimum } from '../depth/api'
import { parseListPrice, type Phrase, type PriceListAbilities } from '../model'

/**
 * Minimum order quantities edited in place (B-W2b-380, XF6:03; design sales.pricelists record tab Breaks & surcharges, column
 * "MOQ action"; B-W2b-343 left it archive + new): each cell of the Minimums list frame saves alone (`PATCH /sales/minimums/:id`
 * with the minimum's version) — the minimum (2 to 1,000,000 pieces), per what, what happens below it, the small-run surcharge
 * (an amount in the list's currency, or a percent: typing one makes the minimum a small-run surcharge) and the note. Its company
 * and subject stay (a new minimum for another). Pure: the words are `prices-followups` keys.
 */

export type MinimumPer = (typeof MINIMUM_PER)[number]
export type MinimumAction = (typeof MINIMUM_ACTIONS)[number]
export type MinimumField = 'minQuantity' | 'per' | 'action' | 'surcharge' | 'note'
export const MINIMUM_FIELDS: readonly MinimumField[] = ['minQuantity', 'per', 'action', 'surcharge', 'note']

/** What one cell sends (only what changed). */
export interface MinimumPatch {
  minQuantity?: number
  per?: MinimumPer
  action?: MinimumAction
  surchargeAmount?: string | null
  surchargePct?: string | null
  currency?: string | null
  note?: string | null
}

/** The minimums' in-place edits: each cell's save (`<ruleId>:<field>`) and the last word about them. */
export interface MinimumEditState {
  cells: Readonly<Record<string, 'saving' | 'failed'>>
  notice: { tone: 'success' | 'warning' | 'danger'; words: Phrase } | null
}

export const NOTE_LIMIT = 500

const isPhrase = (value: unknown): value is Phrase => typeof value === 'object' && value !== null && 'key' in value

/** The small-run surcharge as its cell shows it while typed: `12.5` or `3%` (empty: none). */
export function surchargeTyped(row: Pick<Minimum, 'surchargeAmount' | 'surchargePct'>): string {
  if (row.surchargeAmount) return row.surchargeAmount
  if (row.surchargePct) return `${row.surchargePct}%`
  return ''
}

/**
 * The patch one typed cell makes, or why it cannot be saved (a Phrase), or null when nothing changes. `currency`: the list's
 * (a surcharge amount is in it).
 */
export function minimumPatch(row: Minimum, field: MinimumField, text: string, currency: string): MinimumPatch | Phrase | null {
  const typed = text.trim()
  switch (field) {
    case 'minQuantity': {
      if (!/^\d{1,7}$/.test(typed) || Number(typed) < 2 || Number(typed) > 1_000_000) return { key: 'minimums.problem.quantity' }
      return Number(typed) === row.minQuantity ? null : { minQuantity: Number(typed) }
    }
    case 'per': {
      if (!(MINIMUM_PER as readonly string[]).includes(typed)) return { key: 'minimums.problem.per' }
      return typed === row.per ? null : { per: typed as MinimumPer }
    }
    case 'action': {
      if (!(MINIMUM_ACTIONS as readonly string[]).includes(typed)) return { key: 'minimums.problem.action' }
      if (typed === row.action) return null
      // A small-run surcharge needs its amount or percent: typed in its own cell, which makes the minimum one.
      if (typed === 'SURCHARGE') return { key: 'minimums.problem.surchargeFirst' }
      return { action: typed as MinimumAction }
    }
    case 'surcharge': {
      if (typed === '') return row.action === 'SURCHARGE' ? { key: 'minimums.problem.surchargeNeeded' } : null
      if (typed.endsWith('%')) {
        const pct = parsePercent(typed)
        if (pct === null || !(Number(pct) > 0)) return { key: 'minimums.problem.surcharge' }
        return row.action === 'SURCHARGE' && row.surchargePct !== null && row.surchargePct !== undefined && Number(row.surchargePct) === Number(pct) ? null : { action: 'SURCHARGE', surchargePct: pct, surchargeAmount: null, currency: null }
      }
      const amount = parseListPrice(typed)
      if (amount === null) return { key: 'minimums.problem.surcharge' }
      return row.action === 'SURCHARGE' && row.surchargeAmount !== null && row.surchargeAmount !== undefined && Number(row.surchargeAmount) === Number(amount) ? null : { action: 'SURCHARGE', surchargeAmount: amount, surchargePct: null, currency }
    }
    case 'note': {
      if (typed.length > NOTE_LIMIT) return { key: 'minimums.problem.note', params: { limit: NOTE_LIMIT } }
      return (typed || null) === (row.note ?? null) ? null : { note: typed || null }
    }
  }
}

export const patchProblem = (value: MinimumPatch | Phrase | null): Phrase | null => (isPhrase(value) ? value : null)

/** Why a minimum's cells cannot change (a Phrase), or null: the right, the list, the minimum itself. */
export function minimumEditHeld(row: Pick<Minimum, 'status'>, can: Pick<PriceListAbilities, 'manage'>, listArchived: boolean): Phrase | null {
  if (!can.manage) return { key: 'minimums.held.noManage' }
  if (listArchived) return { key: 'minimums.held.listArchived' }
  if (row.status === 'ARCHIVED') return { key: 'minimums.held.archived' }
  return null
}

/** The surcharge cell needs the price grain besides the edit (the amount is a price). */
export function surchargeHeld(row: Pick<Minimum, 'status'>, can: Pick<PriceListAbilities, 'manage' | 'price'>, listArchived: boolean): Phrase | null {
  return minimumEditHeld(row, can, listArchived) ?? (can.price ? null : { key: 'minimums.held.noPrice' })
}

/** A minimum with the answer of its PATCH put in its place (the list keeps its order). */
export const withMinimum = (rows: readonly Minimum[], next: Minimum): Minimum[] => rows.map((row) => (row.id === next.id ? next : row))
