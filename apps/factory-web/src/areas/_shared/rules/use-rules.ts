'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ApiClient } from '../../../lib/api/client'
import type { PanelRead } from '../../../record-panels/model'
import { createRule, getRule, listRules, ruleChoices, ruleTimers, testRule, updateRule, type AlertRule, type RuleBody, type RuleChoices, type RuleKindInfo, type RulesList, type RuleTrigger } from './api'
import { changesOf, createBodyOf, draftOf, readProblemOf, refusalOf, testBodyOf, type RuleDraft } from './model'
import type { RuleDialogState } from './view/RuleDialog'

/** A notice a host page shows (its key is a `rules` key, prefixed `rules:`). */
export interface RulesNotice {
  readonly key: string
  readonly tone: 'success' | 'danger'
}

interface DialogExtra {
  readonly key: string
  readonly rule: AlertRule | null
  readonly test: RuleDialogState['test']
  readonly timers: RuleDialogState['timers']
  readonly problem: string | null
}

/**
 * The exception rules for a page (Home › Alerts "Rules", Admin › Reminders & timers): the list (GET /alerts/rules, a
 * trigger's), the list's own changes of one rule (its switch, its number: PUT with the version read), and the rule dialog
 * of the address (`?rule=<id>`, `?rule=new`): the roles and places (GET /alerts/rules/choices, once, when the person keeps
 * rules), the rule read alone when the list does not hold it, a date rule's timers, the dry run and the save (only what
 * changed; a stale version reads the rules again and the dialog opens on the rule as it is now). One hook, so both pages
 * keep rules exactly the same way.
 */
export function useRules(options: {
  readonly api: ApiClient
  readonly enabled: boolean
  /** alerts.rules.manage: the choices and the timers are read. */
  readonly manage: boolean
  readonly trigger?: RuleTrigger
  /** The rule dialog of the address. */
  readonly ruleParam: string | null
  /** New: which kinds may be chosen (Admin: the date kinds). */
  readonly kinds?: (kind: RuleKindInfo) => boolean
  readonly onClose: () => void
  readonly onNotice: (notice: RulesNotice | null) => void
}) {
  const { api, enabled, manage, trigger, ruleParam, onClose, onNotice } = options
  const [rules, setRules] = useState<PanelRead<RulesList>>({ status: 'loading' })
  const [saving, setSaving] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [choices, setChoices] = useState<PanelRead<RuleChoices> | null>(null)
  const [extra, setExtra] = useState<DialogExtra | null>(null)

  const load = useCallback(async () => {
    try {
      setRules({ status: 'ready', data: await listRules(api, trigger ? { trigger } : {}) })
    } catch (error) {
      setRules({ status: 'error', problem: readProblemOf(error) })
    }
  }, [api, trigger])
  useEffect(() => {
    if (enabled) void load()
  }, [enabled, load])

  const list = rules.status === 'ready' ? rules.data.rules : []
  const ruleOf = (id: string): AlertRule | null => list.find((rule) => rule.id === id) ?? (extra?.key === id ? extra.rule : null)

  const loadChoices = useCallback(async () => {
    setChoices({ status: 'loading' })
    try {
      setChoices({ status: 'ready', data: await ruleChoices(api) })
    } catch (error) {
      setChoices({ status: 'error', problem: readProblemOf(error) })
    }
  }, [api])
  const loadTimers = useCallback(
    async (id: string) => {
      setExtra((current) => (current?.key === id ? { ...current, timers: { status: 'loading' } } : current))
      try {
        const timers = await ruleTimers(api, id)
        setExtra((current) => (current?.key === id ? { ...current, timers: { status: 'ready', data: timers } } : current))
      } catch (error) {
        setExtra((current) => (current?.key === id ? { ...current, timers: { status: 'error', problem: readProblemOf(error) } } : current))
      }
    },
    [api],
  )

  // The dialog of the address: what it needs, read once per rule.
  useEffect(() => {
    if (!ruleParam) {
      setExtra(null)
      return
    }
    if (!enabled || rules.status !== 'ready' || extra?.key === ruleParam) return
    const listed = ruleParam === 'new' ? null : (rules.data.rules.find((rule) => rule.id === ruleParam) ?? null)
    setExtra({ key: ruleParam, rule: listed, test: null, timers: null, problem: null })
    if (manage && choices === null) void loadChoices()
    if (ruleParam !== 'new' && !listed) {
      getRule(api, ruleParam)
        .then((rule) => {
          setExtra((current) => (current?.key === ruleParam ? { ...current, rule } : current))
          if (rule.trigger === 'DATE' && manage) void loadTimers(ruleParam)
        })
        .catch((error: unknown) => setExtra((current) => (current?.key === ruleParam ? { ...current, problem: refusalOf(error) } : current)))
    } else if (listed?.trigger === 'DATE' && manage) void loadTimers(ruleParam)
  }, [ruleParam, enabled, manage, rules, extra, choices, api, loadChoices, loadTimers])

  const save = async (draft: RuleDraft): Promise<boolean> => {
    const key = extra?.key
    if (!key) return false
    setBusy(true)
    onNotice(null)
    try {
      if (key === 'new') await createRule(api, createBodyOf(draft))
      else {
        const rule = ruleOf(key)
        if (!rule) return false
        await updateRule(api, rule, changesOf(rule, draft))
      }
      onNotice({ key: key === 'new' ? 'rules:notice.created' : 'rules:notice.saved', tone: 'success' })
      setExtra(null)
      onClose()
      await load()
      return true
    } catch (error) {
      const problem = refusalOf(error)
      setExtra((current) => (current ? { ...current, problem } : current))
      // Changed meanwhile: the rules are read again, and the dialog opens on the rule as it is now (its new version).
      if (problem === 'refusal.changed' || problem === 'refusal.gone') await load()
      return false
    } finally {
      setBusy(false)
    }
  }

  /** The list's own change of one rule (its switch, its number), with the rule's version as read. */
  const quick = async (rule: AlertRule, body: RuleBody, done: RulesNotice) => {
    setSaving((current) => [...current, rule.id])
    onNotice(null)
    try {
      await updateRule(api, rule, body)
      onNotice(done)
    } catch (error) {
      onNotice({ key: `rules:${refusalOf(error)}`, tone: 'danger' })
    } finally {
      setSaving((current) => current.filter((id) => id !== rule.id))
      await load()
    }
  }

  const dialogRule = extra && extra.key !== 'new' ? ruleOf(extra.key) : null
  const dialog: RuleDialogState | null =
    ruleParam && extra && rules.status === 'ready' && (ruleParam === 'new' || dialogRule)
      ? {
          mode: ruleParam === 'new' ? 'new' : 'edit',
          rule: dialogRule,
          kinds: options.kinds ? rules.data.kinds.filter(options.kinds) : rules.data.kinds,
          choices: manage ? choices : null,
          test: extra.test,
          timers: extra.timers,
          problem: extra.problem,
        }
      : null

  return {
    rules,
    saving,
    busy,
    dialog,
    /** The dialog asked for a rule that could not be read (gone, not visible): its refusal key. */
    dialogProblem: ruleParam && extra && !dialog ? extra.problem : null,
    reload: () => {
      setRules({ status: 'loading' })
      void load()
    },
    refresh: () => void load(),
    save,
    test: async (draft: RuleDraft, ruleId: string) => {
      setExtra((current) => (current ? { ...current, test: { status: 'loading' } } : current))
      try {
        const answer = await testRule(api, ruleId, testBodyOf(draft))
        setExtra((current) => (current ? { ...current, test: { status: 'ready', data: answer } } : current))
      } catch (error) {
        setExtra((current) => (current ? { ...current, test: { status: 'error', problem: refusalOf(error) } } : current))
      }
    },
    retryChoices: () => void loadChoices(),
    retryTimers: () => {
      if (extra?.key && extra.key !== 'new') void loadTimers(extra.key)
    },
    switchRule: (rule: AlertRule, next: boolean) => void quick(rule, { enabled: next }, { key: next ? 'rules:notice.switchedOn' : 'rules:notice.switchedOff', tone: 'success' }),
    numberRule: (rule: AlertRule, key: string, value: number) => {
      if (rule.threshold[key] === value) return
      const draft = draftOf(rule)
      void quick(rule, changesOf(rule, { ...draft, numbers: { ...draft.numbers, [key]: String(value) } }), { key: 'rules:notice.saved', tone: 'success' })
    },
    /** A rule from the list or the dialog's own read. */
    ruleOf,
  }
}
