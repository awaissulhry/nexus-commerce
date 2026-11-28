'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../lib/api/client'
import { getProductionCustomers } from '../_shared/customer/use-customers'
import { closeRule, createRule, getRules, getStructures, patchRule, type RuleRow, type StructureRow } from './api'
import { newRuleDraftOf, placeOf, problemKeyOf, ruleBodyOf, ruleDraftOf, ruleHeldOf, ruleNoOf, rulesOf, type RuleDraft } from './model'
import type { RuleWindowActions, RuleWindowModel } from './view/Windows'

/**
 * owb-ss8 (8.3 + 8.4) — the window of one rule for its three doors (the page, the customer's part "How its orders are handled", a
 * structure's "New rule with it…"): it uses what the page holds (structures, rules, customers) or reads them, keeps the draft, and
 * saves with ONE call (POST a new rule — the API places it above the first rule that would take all its orders — or PATCH at the read
 * version); "Close this rule" closes it (kept, can open again). Done → `onSaved()`.
 */

interface Held {
  readonly structures?: readonly StructureRow[] | null
  readonly rules?: readonly RuleRow[] | null
  readonly customers?: readonly { readonly id: string; readonly name: string }[] | null
  readonly manageStructures?: boolean
  readonly onSaved?: (done: 'saved' | 'added' | 'closed') => void
}

interface RuleState {
  readonly draft: RuleDraft | null
  readonly rule: RuleRow | null
  readonly busy: boolean
  readonly problem: string | null
  readonly structures: readonly StructureRow[] | null
  readonly rules: readonly RuleRow[] | null
  readonly customers: readonly { readonly id: string; readonly name: string }[] | null
  readonly manage: boolean
}

const CLOSED: RuleState = { draft: null, rule: null, busy: false, problem: null, structures: null, rules: null, customers: null, manage: false }

export function useRuleWindow(api: ApiClient | null, held: Held = {}): { readonly openNew: (preset?: Parameters<typeof newRuleDraftOf>[0]) => void; readonly openRule: (rule: RuleRow) => void; readonly model: RuleWindowModel; readonly actions: RuleWindowActions } {
  const [state, setState] = useState<RuleState>(CLOSED)
  const latest = useRef(held)
  latest.current = held

  const readWhatIsMissing = useCallback(() => {
    if (!api) return
    if (!latest.current.structures)
      getStructures(api)
        .then((answer) => setState((current) => ({ ...current, structures: answer.structures, manage: answer.may.manage })))
        .catch(() => setState((current) => ({ ...current, structures: [] })))
    if (!latest.current.rules)
      getRules(api)
        .then((answer) => setState((current) => ({ ...current, rules: answer.rules })))
        .catch(() => setState((current) => ({ ...current, rules: [] })))
    if (!latest.current.customers)
      getProductionCustomers(api, 'work-orders')
        .then((answer) => setState((current) => ({ ...current, customers: answer.customers.map((party) => ({ id: party.id, name: party.name })) })))
        .catch(() => setState((current) => ({ ...current, customers: [] })))
  }, [api])

  const openNew = useCallback(
    (preset: Parameters<typeof newRuleDraftOf>[0] = {}) => {
      setState({ ...CLOSED, draft: newRuleDraftOf(preset) })
      readWhatIsMissing()
    },
    [readWhatIsMissing],
  )
  const openRule = useCallback(
    (rule: RuleRow) => {
      setState({ ...CLOSED, draft: ruleDraftOf(rule), rule })
      readWhatIsMissing()
    },
    [readWhatIsMissing],
  )

  const structures = held.structures ?? state.structures ?? []
  const open = rulesOf(held.rules ?? state.rules ?? []).open
  const heldWords = state.draft ? ruleHeldOf(state.draft, open, structures) : null
  const set = (patch: Partial<RuleDraft>) => setState((current) => (current.draft && !current.busy ? { ...current, draft: { ...current.draft, ...patch }, problem: null } : current))

  const save = async () => {
    const draft = state.draft
    if (!api || !draft || state.busy || heldWords) return
    setState((current) => ({ ...current, busy: true, problem: null }))
    try {
      if (draft.id === null) await createRule(api, ruleBodyOf(draft))
      else await patchRule(api, draft.id, { version: draft.version, ...ruleBodyOf(draft) })
      setState(CLOSED)
      latest.current.onSaved?.(draft.id === null ? 'added' : 'saved')
    } catch (error) {
      setState((current) => ({ ...current, busy: false, problem: problemKeyOf(error, true) }))
    }
  }
  const closeIt = async () => {
    const rule = state.rule
    if (!api || !rule || state.busy) return
    setState((current) => ({ ...current, busy: true, problem: null }))
    try {
      await closeRule(api, rule.id, false)
      setState(CLOSED)
      latest.current.onSaved?.('closed')
    } catch (error) {
      setState((current) => ({ ...current, busy: false, problem: problemKeyOf(error, true) }))
    }
  }

  const model = useMemo<RuleWindowModel>(
    () => ({
      open: state.draft !== null,
      draft: state.draft,
      rule: state.rule,
      ruleNo: state.rule ? ruleNoOf(open, state.rule.id) : 0,
      structures,
      customers: held.customers ?? state.customers,
      place: state.draft ? placeOf(open, state.draft, state.draft.id) : 0,
      total: open.length,
      manageStructures: held.manageStructures ?? state.manage,
      held: heldWords,
      busy: state.busy,
      problem: state.problem,
    }),
    [state, open, structures, held.customers, held.manageStructures, heldWords],
  )

  const actions: RuleWindowActions = {
    onClose: () => setState((current) => (current.busy ? current : CLOSED)),
    onParty: (partyId) => set({ partyId }),
    onCategory: (category) => set({ category }),
    onStructure: (structureId) => set({ structureId }),
    onNote: (note) => set({ note }),
    onSave: () => void save(),
    onCloseRule: () => void closeIt(),
  }
  return { openNew, openRule, model, actions }
}
