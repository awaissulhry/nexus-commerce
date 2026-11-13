'use client'

import type { ItemRulePatch } from '@nexus/factory-domain/planning/lot-sizing/parameters'
import type { ApiClient } from '../../../../lib/api/client'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { createItemParameters, editItemParameters, type ItemEntry, type ItemParameters, type ItemParametersFields, type PlanningSite } from '../api'
import type { SaveStatus } from '../model'
import { refusalWords, withRow, type ItemRow, type Mark, type Notice } from '../params/model'
import { clearedRuleWords, parseRule, rulesPlan, type RuleField, type RuleNumberField } from './model'

/** What a rule cell or dialog asks: a typed number cell, or a dialog's patch. */
export type RuleInput = { readonly raw: unknown } | { readonly patch: ItemRulePatch }

export interface RuleSaveHost {
  api: ApiClient
  site: PlanningSite
  /** The row as it is now (after the row's earlier writes). */
  rowNow: (rowKey: string) => ItemRow | null
  /** The Items tab's one queue per row: a row's writes wait for each other. */
  queue: <T>(rowKey: string, work: () => Promise<T>) => Promise<T>
  expectEcho: (rowKey: string) => void
  setEntries: (update: (current: ItemEntry[] | null) => ItemEntry[] | null) => void
  setMark: (rowKey: string, field: string, mark: Mark | null) => void
  fade: (rowKey: string, field: string) => void
  onStatus: (status: SaveStatus | null) => void
  failedCount: number
  setNotice: (notice: Notice | null) => void
  setChangedElsewhere: (changed: boolean) => void
}

/**
 * B-W2b-335: saving the planning rules per item (lot sizing with its lot or period, plan level, scrap, yield, delay days)
 * from Planning settings › Item parameters — the same rules as a W2a cell: checked with factory-domain's rules before it
 * is sent (refused at the cell, in words), then one PATCH at the version the row has now (POST when the item has no row
 * yet), in the row's queue, with its save mark; a lot-sizing switch that cleared a number says so. A plan level the
 * person may not set answers 403 (the cell is held before that).
 */
export function useRuleSave(host: RuleSaveHost): (row: ItemRow, field: RuleField, input: RuleInput) => void {
  return (row, field, input) => {
    let patch: ItemRulePatch
    if ('raw' in input) {
      const parsed = parseRule(field as RuleNumberField, input.raw)
      if ('problem' in parsed) {
        host.setMark(row.key, field, { state: 'refused', problem: parsed.problem })
        return
      }
      patch = { [field]: parsed.value } as ItemRulePatch
    } else patch = input.patch
    const first = rulesPlan(host.rowNow(row.key)?.row ?? row.row, row.item.kind, patch)
    if (first.kind === 'none') return
    if (first.kind === 'refused') {
      host.setMark(row.key, field, { state: 'refused', problem: first.words })
      return
    }
    host.setMark(row.key, field, { state: 'saving' })
    host.onStatus({ kind: 'saving' })
    void host
      .queue(row.key, async (): Promise<{ ok: true; row: ItemParameters; cleared: string[] } | { ok: false; words: Mark['problem']; unknown: boolean }> => {
        const now = host.rowNow(row.key)
        if (!now) return { ok: false, words: { key: 'ps.problem.gone' }, unknown: false }
        const plan = rulesPlan(now.row, now.item.kind, patch)
        if (plan.kind === 'refused') return { ok: false, words: plan.words, unknown: false }
        if (plan.kind === 'none') return now.row ? { ok: true, row: now.row, cleared: [] } : { ok: false, words: { key: 'pp.held.same' }, unknown: false }
        host.expectEcho(row.key)
        try {
          const body = plan.patch as ItemParametersFields
          const answer = now.row
            ? await editItemParameters(host.api, now.row.id, { ...body, version: now.row.version }, newIdempotencyKey())
            : await createItemParameters(host.api, { siteId: host.site.id, itemId: now.item.id, itemColourId: now.colour?.id ?? null, ...body }, newIdempotencyKey())
          host.setEntries((current) => (current ? withRow(current, answer.parameters) : current))
          return { ok: true, row: answer.parameters, cleared: answer.cleared }
        } catch (error) {
          const refusal = refusalWords(error)
          if (refusal.conflict) host.setChangedElsewhere(true)
          return { ok: false, words: refusal.words, unknown: refusal.unknown }
        }
      })
      .then((outcome) => {
        if (outcome.ok) {
          host.setMark(row.key, field, { state: 'saved' })
          host.fade(row.key, field)
          host.onStatus({ kind: 'saved', at: new Date().toISOString() })
          const cleared = clearedRuleWords(outcome.cleared)
          if (cleared) host.setNotice({ tone: 'info', words: cleared })
        } else {
          host.setMark(row.key, field, { state: outcome.unknown ? 'unknown' : 'refused', problem: outcome.words })
          host.onStatus({ kind: 'failed', count: host.failedCount + 1 })
        }
      })
  }
}
