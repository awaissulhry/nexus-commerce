'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { problemKey, type Loaded } from '../../shared/model'
import type { CompanyOption } from '../model'
import { changeRule, createRule, listRules, type Rule } from './api'
import { draftAfter, draftHeld, EMPTY_DRAFT, requiredQuery, type CompanyChoice, type Read, type RequiredDialog, type RequiredModel } from './model'
import { RequiredView } from './view/RequiredView'

/**
 * `/w/<company>/admin/documents?view=required&company=<id>&off=1&rule=new` (SCR-014 › Required documents, B-W2b-177): reads
 * the rules (`GET /files/required-rules`), switches Blocks and On in place (`PATCH …/:ruleId` at the row's version; a
 * stale row is read again), Switch off / on N one rule at a time, New rule (`POST /files/required-rules`, one key per
 * dialog). Reads again when the tab comes back into view. The address keeps the company, "show switched off" and the dialog.
 */
export function RequiredSection({ companies, askedCompany, onView, onCompany }: { companies: Loaded<CompanyOption>; askedCompany: string | null; onView: (view: 'numbers' | 'documents' | 'branding') => void; onCompany: (companyId: string) => void }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const choices: CompanyChoice[] = useMemo(
    () => (companies.items ? companies.items.filter((company) => company.status === 'ACTIVE').map((company) => ({ id: company.id, name: company.legalName })) : session.companies.map((company) => ({ id: company.id, name: company.name }))),
    [companies.items, session.companies],
  )
  const companyId = askedCompany ?? (choices.length === 1 ? choices[0]!.id : null)
  const showOff = params?.get('off') === '1'
  const wantsDialog = params?.get('rule') === 'new'
  const [read, setRead] = useState<Read>({ status: 'loading' })
  const [selected, setSelected] = useState<readonly string[]>([])
  const [dialog, setDialog] = useState<RequiredDialog | null>(null)
  const [saving, setSaving] = useState<readonly string[]>([])
  const [notice, setNotice] = useState<RequiredModel['notice']>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const createKey = useRef<string | null>(null)

  const go = useCallback(
    (change: { showOff?: boolean; dialog?: boolean }) => {
      const query = requiredQuery({ companyId, showOff: change.showOff ?? showOff, dialog: change.dialog ?? wantsDialog })
      router.replace(`${pathname}?${query}`, { scroll: false })
    },
    [companyId, pathname, router, showOff, wantsDialog],
  )

  const load = useCallback(async () => {
    try {
      setRead({ status: 'ready', answer: await listRules(api, null) })
      setAsOf(new Date().toISOString())
    } catch (error) {
      setRead({ status: 'failed', problem: problemKey(error) })
    }
  }, [api])

  useEffect(() => {
    void load()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  // The dialog follows the address (Back closes it; a link opens it).
  useEffect(() => {
    if (wantsDialog && !dialog) {
      createKey.current = newIdempotencyKey()
      setDialog({ draft: draftAfter(read.status === 'ready' ? read.answer : null, EMPTY_DRAFT, {}), busy: false, problem: null })
    } else if (!wantsDialog && dialog) setDialog(null)
  }, [wantsDialog, dialog, read])

  const replace = (rule: Rule) => setRead((current) => (current.status === 'ready' ? { status: 'ready', answer: { ...current.answer, rules: current.answer.rules.map((item) => (item.id === rule.id ? rule : item)) } } : current))
  const writeProblem = (error: unknown) => (isApiError(error) && error.kind === 'conflict' ? 'req.problem.conflict' : isApiError(error) && error.kind === 'forbidden' ? 'req.held.noRight' : problemKey(error))

  const change = async (rule: Rule, body: { level?: 'BLOCK' | 'WARN'; active?: boolean }) => {
    setSaving((list) => [...list, rule.id])
    try {
      const after = await changeRule(api, rule, body)
      replace(after)
      setNotice({ key: body.active === undefined ? 'req.done.level' : body.active ? 'req.done.on' : 'req.done.off', tone: 'success' })
      return true
    } catch (error) {
      setNotice({ key: writeProblem(error), tone: 'danger' })
      if (isApiError(error) && error.kind === 'conflict') void load()
      return false
    } finally {
      setSaving((list) => list.filter((id) => id !== rule.id))
    }
  }

  const model: RequiredModel = { companies: choices, companyId, read, showOff, selected, dialog, saving, notice, asOf }

  return (
    <RequiredView
      model={model}
      actions={{
        onView: (next) => (next === 'required' ? undefined : onView(next)),
        onCompany: (next) => (next ? onCompany(next) : onCompany('all')),
        onShowOff: (show) => go({ showOff: show }),
        onSelect: setSelected,
        onRetry: () => {
          setRead({ status: 'loading' })
          void load()
        },
        onDismissNotice: () => setNotice(null),
        onLevel: (rule, level) => void change(rule, { level }),
        onActive: (rule, active) => void change(rule, { active }),
        onSwitchMany: (rules, active) =>
          void (async () => {
            let done = 0
            for (const rule of rules) if (await change(rule, { active })) done++
            setSelected([])
            setNotice({ key: active ? 'req.bulk.doneOn' : 'req.bulk.doneOff', tone: done === rules.length ? 'success' : 'warning', params: { count: done, of: rules.length } })
          })(),
        onNew: (open) => go({ dialog: open }),
        onDraft: (patch) => setDialog((current) => (current ? { ...current, problem: null, draft: draftAfter(read.status === 'ready' ? read.answer : null, current.draft, patch) } : current)),
        onCreate: () => {
          if (!dialog || !companyId || draftHeld(model, dialog.draft)) return
          setDialog({ ...dialog, busy: true, problem: null })
          void createRule(api, { companyId, recordType: dialog.draft.recordType, category: dialog.draft.category, beforeStatus: dialog.draft.beforeStatus, partyRole: dialog.draft.partyRole === '' ? null : dialog.draft.partyRole, level: dialog.draft.level }, createKey.current ?? newIdempotencyKey())
            .then((rule) => {
              setRead((current) => (current.status === 'ready' ? { status: 'ready', answer: { ...current.answer, rules: [...current.answer.rules, rule] } } : current))
              setNotice({ key: 'req.done.created', tone: 'success' })
              setDialog(null)
              go({ dialog: false })
            })
            .catch((error: unknown) => setDialog((current) => (current ? { ...current, busy: false, problem: writeProblem(error) } : current)))
        },
      }}
    />
  )
}
