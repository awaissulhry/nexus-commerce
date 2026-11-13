'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { PanelRead } from '../../../../record-panels/model'
import { listRoles } from '../../../admin/shared/api'
import { createRule, fetchKinds, fetchRules, testRule, updateRule, type ApprovalRule, type ConditionBody, type KindsAnswer, type RulesAnswer, type RuleTest } from './api'
import { bodyOf, changesOf, type ApproverRole, type RuleDialogState, type RuleDraft } from './model'
// B-W2b-382 (XF7:06): `?rule=new&kind=` starts the new rule with its kind.
import { newRuleKindOf } from './new-kind/new-kind'

/** An API failure of this page as a key of approvals-depth. */
export function rulesProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.internal'
  const paths = error.issues.map(issuePath)
  if (error.kind === 'invalid' && paths.some((path) => path.includes('approver'))) return 'rules.problem.approver'
  if (error.kind === 'invalid' && paths.some((path) => path.includes('condition'))) return 'rules.problem.condition'
  if (error.kind === 'conflict' && paths.some((path) => path.includes('condition'))) return 'rules.held.money'
  if (error.kind === 'conflict') return 'rules.problem.moved'
  if (error.kind === 'invalid') return 'rules.problem.invalid'
  if (['forbidden', 'unavailable', 'rate_limited', 'signed_out', 'step_up'].includes(error.kind)) return `problem.${error.kind}`
  return 'problem.internal'
}

/**
 * The container of Admin › Automation › Approval rules (B-W2b-307): reads the kinds, the rules and the roles that may
 * decide approvals (roles.view; GET /auth/roles, office roles with approvals.decide), opens the pop-up from the address
 * (`?rule=<id>|new`), saves (POST — written OFF — or a PUT of what changed with the version as read), switches (PUT
 * `active`), tests. A refusal is said in the pop-up; a moved rule is read again.
 */
export function useApprovalRules(input: { readonly api: ApiClient; readonly enabled: boolean; readonly ruleParam: string | null; /** B-W2b-382: `&kind=` of a new rule. */ readonly newKind?: string | null; readonly readRoles: boolean; readonly onNotice: (notice: { key: string; tone: 'success' | 'danger' | 'warning'; params?: Record<string, string | number> } | null) => void }) {
  const { api, enabled, ruleParam, newKind = null, readRoles, onNotice } = input
  const [rules, setRules] = useState<PanelRead<RulesAnswer>>({ status: 'loading' })
  const [kinds, setKinds] = useState<PanelRead<KindsAnswer>>({ status: 'loading' })
  const [roles, setRoles] = useState<PanelRead<readonly ApproverRole[]>>({ status: 'loading' })
  const [saving, setSaving] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState<PanelRead<RuleTest> | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const notice = useRef(onNotice)
  notice.current = onNotice

  const readRules = useCallback(async () => {
    try {
      setRules({ status: 'ready', data: await fetchRules(api) })
    } catch (error) {
      setRules({ status: 'error', problem: rulesProblem(error) })
    }
  }, [api])
  const readKinds = useCallback(async () => {
    setKinds({ status: 'loading' })
    try {
      setKinds({ status: 'ready', data: await fetchKinds(api) })
    } catch (error) {
      setKinds({ status: 'error', problem: rulesProblem(error) })
    }
  }, [api])
  const readRoleList = useCallback(async () => {
    if (!readRoles) {
      setRoles({ status: 'ready', data: [] })
      return
    }
    try {
      const all = await listRoles(api)
      setRoles({ status: 'ready', data: all.filter((role) => role.audience === 'office' && role.permissions.includes('approvals.decide')).map((role) => ({ id: role.id, name: role.name })) })
    } catch (error) {
      setRoles({ status: 'error', problem: rulesProblem(error) })
    }
  }, [api, readRoles])

  useEffect(() => {
    if (!enabled) return
    void readRules()
    void readKinds()
    void readRoleList()
  }, [enabled, readRules, readKinds, readRoleList])

  useEffect(() => {
    setTest(null)
    setProblem(null)
  }, [ruleParam])

  const ready = rules.status === 'ready' ? rules.data : null
  const opened = ruleParam && ruleParam !== 'new' ? (ready?.rules.find((rule) => rule.id === ruleParam) ?? null) : null
  const dialog: RuleDialogState | null = !enabled || !ruleParam ? null : ruleParam === 'new' ? { mode: 'new', rule: null, kind: newRuleKindOf(newKind, kinds.status === 'ready' ? kinds.data.kinds : null), test, problem } : opened ? { mode: 'edit', rule: opened, test, problem } : null

  const save = async (draft: RuleDraft): Promise<boolean> => {
    setBusy(true)
    setProblem(null)
    try {
      if (opened) {
        const change = changesOf(opened, draft)
        if (Object.keys(change).length > 0) await updateRule(api, opened, change)
        notice.current({ key: 'rules.notice.saved', tone: 'success', params: { rule: draft.name.trim() } })
      } else {
        await createRule(api, { kind: draft.kind!, companyId: draft.companyId, ...bodyOf(draft) })
        notice.current({ key: 'rules.notice.created', tone: 'success', params: { rule: draft.name.trim() } })
      }
      await readRules()
      return true
    } catch (error) {
      const key = rulesProblem(error)
      setProblem(key)
      if (key === 'rules.problem.moved') void readRules()
      return false
    } finally {
      setBusy(false)
    }
  }

  const switchRule = async (rule: ApprovalRule, next: boolean) => {
    setSaving((current) => [...current, rule.id])
    try {
      await updateRule(api, rule, { active: next })
      notice.current({ key: next ? 'rules.notice.on' : 'rules.notice.off', tone: 'success', params: { rule: rule.name } })
      await readRules()
    } catch (error) {
      notice.current({ key: rulesProblem(error), tone: 'danger' })
      void readRules()
    } finally {
      setSaving((current) => current.filter((id) => id !== rule.id))
    }
  }

  const runTest = async (body: { kind: string; companyId: string | null; condition: ConditionBody; approver?: { roleId: string } | { userId: string } }) => {
    setTest({ status: 'loading' })
    try {
      setTest({ status: 'ready', data: await testRule(api, body) })
    } catch (error) {
      setTest({ status: 'error', problem: rulesProblem(error) })
    }
  }

  return { rules, kinds, roles, saving, busy, dialog, save, switchRule, runTest, refresh: () => void readRules(), retryKinds: () => void readKinds(), retry: () => {
    setRules({ status: 'loading' })
    void readRules()
    void readKinds()
  } }
}
