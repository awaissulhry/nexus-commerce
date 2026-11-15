'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useCoalesced, useLive, usePageKeys } from '../../../_shared/buying/hooks'
import { isStepUpCancelled } from '../../shared/step-up'
import { useFreshCode } from '../../security/step-up/fresh'
import { LOADING, type Read } from '../model'
import { problemOf } from '../requests/model'
import { changeRule, createRule, listRetention, listSweeps, setRuleActive, setRuleApply, sweepNow, type RetentionList, type Rule } from './api'
import { changeAsksCode, draftOfRule, monthsOf, newRuleDraft, retentionCan, ruleDraftHeld, rulePatch, type RetentionDialog, type RetentionViewModel } from './model'
import { RetentionView } from './view/RetentionView'

const TIME_ZONE = 'Europe/Rome'

/**
 * Admin › Privacy › Retention rules, live (B-W2b-414 on B-W2b-405's API): the rules of the page's company and the group's, the
 * record types a rule may name, the ledgers kept and the dated purges (`GET /privacy/retention`). A rule is added and changed
 * in its dialog (a shorter period, or another action while it applies, asks a fresh code FIRST); "Switch on to apply" is a
 * confirm, then a fresh code; off, back to reporting and Sweep now are plain commands. Live privacy.retention_* events put the
 * changes behind "N updates · Show". `a` adds a rule.
 */
export function RetentionRules({ companyId, companies }: { companyId: string | null; companies: readonly { id: string; name: string }[] }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => retentionCan(session.permissions), [session.permissions])
  const fresh = useFreshCode(api)
  const [list, setList] = useState<Read<RetentionList>>(LOADING)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [busyRule, setBusyRule] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [dialog, setDialog] = useState<RetentionDialog | null>(null)
  const [notice, setNotice] = useState<RetentionViewModel['notice']>(null)
  /** Rules this page just changed: their live echo reads the list again instead of counting as someone else's update. */
  const mine = useRef<Map<string, number>>(new Map())
  const keys = useRef<Record<string, string>>({})
  const keyFor = (name: string) => (keys.current[name] ??= newIdempotencyKey())
  const forget = (name: string) => delete keys.current[name]

  const load = useCallback(async () => {
    if (!can.view) return
    try {
      setList({ value: await listRetention(api, companyId), problem: null })
      setUpdates(0)
    } catch (error) {
      setList({ value: null, problem: problemOf(error) })
    }
  }, [api, can.view, companyId])
  useEffect(() => {
    setList(LOADING)
    void load()
  }, [load])

  const refresh = useCoalesced(() => void load(), 800)
  useLive(
    (change) => {
      if (change.type !== 'privacy.retention_rule_changed' && change.type !== 'privacy.retention_swept') return
      const ruleId = typeof change.fields.ruleId === 'string' ? change.fields.ruleId : ''
      if (busyRule || Date.now() - (mine.current.get(ruleId) ?? 0) < 15_000) refresh()
      else setUpdates((count) => count + 1)
    },
    () => void load(),
    can.view,
  )

  const ruleOf = (ruleId: string): Rule | null => list.value?.rules.find((rule) => rule.id === ruleId) ?? null
  /** A notice names the record type by its code; the view words it (`type`). */
  const typeName = (rule: Rule) => rule.recordType

  /** One step on one rule: its command, the list read again, a notice in words. */
  const step = async (rule: Rule, name: string, work: (key: string) => Promise<unknown>, done: string, sentence?: string) => {
    setBusyRule(rule.id)
    mine.current.set(rule.id, Date.now())
    setNotice(null)
    try {
      if (sentence) await fresh.ensureFresh(sentence)
      await (sentence ? fresh.guard(sentence, () => work(keyFor(name))) : work(keyFor(name)))
      forget(name)
      setNotice({ tone: 'success', key: done, params: { type: typeName(rule) } })
      await load()
      return true
    } catch (error) {
      setNotice({ tone: 'danger', key: isStepUpCancelled(error) ? 'dp.problem.stepUpClosed' : problemOf(error) })
      void load()
      return false
    } finally {
      setBusyRule(null)
    }
  }

  const saveRule = async () => {
    if (dialog?.kind !== 'rule') return
    const { draft } = dialog
    if (ruleDraftHeld(draft, list.value?.types ?? [], can)) return
    const rule = draft.ruleId ? ruleOf(draft.ruleId) : null
    setDialog({ ...dialog, busy: true, problem: null })
    try {
      if (rule) {
        const patch = rulePatch(rule, draft)
        if (patch) {
          mine.current.set(rule.id, Date.now())
          const sentence = changeAsksCode(rule, draft) ? 'dp.stepUp.shorten' : null
          if (sentence) await fresh.ensureFresh(sentence)
          await fresh.guard('dp.stepUp.shorten', () => changeRule(api, rule, patch, keyFor(`change:${rule.id}`)))
          forget(`change:${rule.id}`)
        }
      } else {
        await createRule(api, { companyId: draft.companyId || null, recordType: draft.recordType, keepMonths: monthsOf(draft)!, thenAction: draft.thenAction as Rule['thenAction'], legalReason: draft.legalReason.trim() }, keyFor('newRule'))
        forget('newRule')
      }
      setDialog(null)
      setNotice({ tone: 'success', key: rule ? 'dp.ret.done.changed' : 'dp.ret.done.added', params: { type: draft.recordType } })
      void load()
    } catch (error) {
      setDialog((current) => (current?.kind === 'rule' ? { ...current, busy: false, problem: isStepUpCancelled(error) ? 'dp.problem.stepUpClosed' : problemOf(error) } : current))
    }
  }

  const confirmApply = async () => {
    if (dialog?.kind !== 'apply' || dialog.busy) return
    const rule = ruleOf(dialog.ruleId)
    if (!rule) return
    setDialog({ ...dialog, busy: true, problem: null })
    mine.current.set(rule.id, Date.now())
    try {
      await fresh.ensureFresh('dp.stepUp.apply')
      await fresh.guard('dp.stepUp.apply', () => setRuleApply(api, rule, true, keyFor(`apply:${rule.id}`)))
      forget(`apply:${rule.id}`)
      setDialog(null)
      setNotice({ tone: 'warning', key: 'dp.ret.done.applyOn', params: { type: rule.recordType } })
      void load()
    } catch (error) {
      setDialog((current) => (current?.kind === 'apply' ? { ...current, busy: false, problem: isStepUpCancelled(error) ? 'dp.problem.stepUpClosed' : problemOf(error) } : current))
    }
  }

  const readSweeps = useCallback(
    async (ruleId: string) => {
      try {
        const sweeps = await listSweeps(api, ruleId)
        setDialog((current) => (current?.kind === 'sweeps' && current.ruleId === ruleId ? { ...current, sweeps: { value: sweeps, problem: null } } : current))
      } catch (error) {
        setDialog((current) => (current?.kind === 'sweeps' && current.ruleId === ruleId ? { ...current, sweeps: { value: null, problem: problemOf(error) } } : current))
      }
    },
    [api],
  )

  const newRule = () => {
    if (can.manage && list.value) setDialog({ kind: 'rule', draft: newRuleDraft(companyId), busy: false, problem: null })
  }
  usePageKeys((event) => {
    if (event.key === 'a' && !dialog) {
      event.preventDefault()
      newRule()
    }
  })

  if (!can.view) return null

  const model: RetentionViewModel = { can, companyId, companies, list, selected, busyRule, updates, timeZone: TIME_ZONE, dialog, stepUp: fresh.stepUp, notice }

  return (
    <RetentionView
      model={model}
      actions={{
        onNewRule: newRule,
        onChangeRule: (ruleId) => {
          const rule = ruleOf(ruleId)
          if (rule) setDialog({ kind: 'rule', draft: draftOfRule(rule), busy: false, problem: null })
        },
        onSwitch: (ruleId, active) => {
          const rule = ruleOf(ruleId)
          if (rule) void step(rule, `active:${rule.id}:${active}`, (key) => setRuleActive(api, rule, active, key), active ? 'dp.ret.done.on' : 'dp.ret.done.off')
        },
        onApply: (ruleId, on) => {
          const rule = ruleOf(ruleId)
          if (!rule) return
          if (on) setDialog({ kind: 'apply', ruleId, busy: false, problem: null })
          else void step(rule, `apply:${rule.id}:off`, (key) => setRuleApply(api, rule, false, key), 'dp.ret.done.applyOff')
        },
        onSweep: (ruleId) => {
          const rule = ruleOf(ruleId)
          if (rule) void step(rule, `sweep:${rule.id}`, (key) => sweepNow(api, rule.id, key), rule.applyOn ? 'dp.ret.done.sweptApply' : 'dp.ret.done.swept')
        },
        onSweeps: (ruleId) => {
          setDialog({ kind: 'sweeps', ruleId, sweeps: LOADING })
          void readSweeps(ruleId)
        },
        onSelect: setSelected,
        onSweepSelected: async (ids) => {
          let swept = 0
          for (const id of ids) {
            const rule = ruleOf(id)
            if (!rule || !(await step(rule, `sweep:${rule.id}`, (key) => sweepNow(api, rule.id, key), 'dp.ret.done.swept'))) break
            swept += 1
          }
          if (swept === ids.length) {
            setNotice({ tone: 'success', key: 'dp.ret.done.sweptMany', params: { count: swept } })
            setSelected([])
          }
        },
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onDismissNotice: () => setNotice(null),
        onDraft: (change) => setDialog((current) => (current?.kind === 'rule' ? { ...current, draft: { ...current.draft, ...change }, problem: null } : current)),
        onSaveRule: () => void saveRule(),
        onConfirmApply: () => void confirmApply(),
        onRetrySweeps: () => dialog?.kind === 'sweeps' && void readSweeps(dialog.ruleId),
        onCloseDialog: () => setDialog(null),
        onStepUpSubmit: (code) => void fresh.submit(code),
        onStepUpClose: fresh.cancel,
      }}
    />
  )
}
