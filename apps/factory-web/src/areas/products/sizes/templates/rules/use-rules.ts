'use client'

import { useCallback, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'
import type { TemplateRules } from '../api'
import type { Notice, Phrase } from '../model'
import { saveRules } from './api'
import { draftOf, newRuleDraft, rulesBody, saveRulesHeld, saveRulesProblem, withKind, type LimitDraft, type RuleDraft, type RulesDraft, type Tie } from './model'

/**
 * The rule editor's state (B-W2b-371, XF2:05): the draft while open, the fields a refused save named, one write at a time with one
 * Idempotency-Key per attempt; a moved version reads the rules again (never overwritten).
 */
export interface RulesEditModel {
  readonly draft: RulesDraft | null
  readonly busy: boolean
  readonly fields: Readonly<Record<string, Phrase>>
  readonly notice: Notice | null
}

export interface RulesEditActions {
  onOpen?: () => void
  onCancel?: () => void
  onRule?: (key: string, patch: Partial<RuleDraft>) => void
  onAddRule?: () => void
  onRemoveRule?: (key: string) => void
  onBasePoints?: (points: readonly string[]) => void
  onTie?: (tie: Tie) => void
  onLimit?: (code: string, patch: Partial<LimitDraft>) => void
  onSave?: () => void
}

export function useRulesEditor(input: { readonly api: ApiClient; readonly templateId: string; readonly rules: TemplateRules | null; readonly onSaved: (rules: TemplateRules) => void; readonly onStale: () => void }) {
  const { api, templateId, rules, onSaved, onStale } = input
  const [draft, setDraft] = useState<RulesDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [fields, setFields] = useState<Record<string, Phrase>>({})
  const [notice, setNotice] = useState<Notice | null>(null)
  const key = useRef<string | null>(null)

  const edit = useCallback((change: (now: RulesDraft) => RulesDraft) => {
    setDraft((now) => (now ? change(now) : now))
    setFields({})
  }, [])

  const save = useCallback(async () => {
    if (!rules || !draft || saveRulesHeld(rules, draft, busy)) return
    setBusy(true)
    setNotice(null)
    try {
      key.current ??= newIdempotencyKey()
      const kept = await saveRules(api, templateId, rulesBody(draft, rules.template.version), key.current)
      key.current = null
      setDraft(null)
      setFields({})
      setNotice({ key: 'rules.done', tone: 'success' })
      onSaved(kept)
    } catch (error) {
      const said = saveRulesProblem(error, draft)
      setFields(said.fields)
      setNotice({ ...said.notice, tone: 'danger' })
      if (said.reload) {
        key.current = null
        onStale()
      }
    } finally {
      setBusy(false)
    }
  }, [api, templateId, rules, draft, busy, onSaved, onStale])

  const model: RulesEditModel = { draft, busy, fields, notice }
  const actions: RulesEditActions = {
    onOpen: () => {
      if (!rules) return
      key.current = null
      setNotice(null)
      setFields({})
      setDraft(draftOf(rules))
    },
    onCancel: () => {
      setDraft(null)
      setFields({})
    },
    onRule: (ruleKey, patch) => edit((now) => ({ ...now, rules: now.rules.map((rule) => (rule.key !== ruleKey ? rule : patch.kind && patch.kind !== rule.kind ? withKind({ ...rule, ...patch }, patch.kind) : { ...rule, ...patch })) })),
    onAddRule: () => edit((now) => ({ ...now, rules: [...now.rules, newRuleDraft(rules?.points ?? [])] })),
    onRemoveRule: (ruleKey) => edit((now) => ({ ...now, rules: now.rules.filter((rule) => rule.key !== ruleKey) })),
    onBasePoints: (points) => edit((now) => ({ ...now, basePoints: [...points] })),
    onTie: (tie) => edit((now) => ({ ...now, tie })),
    onLimit: (code, patch) => edit((now) => ({ ...now, limits: now.limits.map((limit) => (limit.code === code ? { ...limit, ...patch } : limit)) })),
    onSave: () => void save(),
  }
  return { model, actions }
}
