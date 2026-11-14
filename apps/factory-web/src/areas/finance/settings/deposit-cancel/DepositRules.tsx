'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useCoalesced, useLive } from '../../_shared/hooks'
import { readProblem } from '../../_shared/model'
import { depthProblem, scoped, type DepthProblem } from '../../invoices/test-mode/depth'
import { archiveDepositRule, createDepositRule, depositRulesTouched, listDepositRules, updateDepositRule, type DepositRules as Rules } from './api'
import { emptyRule, ruleAbilitiesOf, ruleBodyOf, ruleDraftOf, ruleStatusOf, type RuleDraft, type RuleRows } from './model'
import { DepositRulesCard, type DepositRulesModel, type RuleDialog } from './view/DepositRulesCard'

/**
 * Finance settings › Refund on cancellation's container (B-W2b-417 on B-W2b-396's API), for the company the settings page
 * shows: reads its rules (the rows chosen), adds one, changes one, archives one or several — each one command with an
 * Idempotency-Key and the rule's version; reads again on a live change of another person.
 */
export function DepositRules({ companyId }: { companyId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => ruleAbilitiesOf(session.permissions), [session.permissions])
  const [rows, setRows] = useState<RuleRows>('active')
  const [list, setList] = useState<{ value: Rules | null; problem: string | null }>({ value: null, problem: null })
  const [dialog, setDialog] = useState<RuleDialog | null>(null)
  const [draft, setDraft] = useState<RuleDraft>(emptyRule())
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<DepthProblem | null>(null)
  const [notice, setNotice] = useState<DepositRulesModel['notice']>(null)

  const read = useCallback(async () => {
    if (!can.view) return
    try {
      setList({ value: await listDepositRules(api, companyId, ruleStatusOf(rows)), problem: null })
    } catch (error) {
      setList({ value: null, problem: readProblem(error) })
    }
  }, [api, can.view, companyId, rows])
  useEffect(() => {
    setList({ value: null, problem: null })
    void read()
  }, [read])
  const reread = useCoalesced(() => void read(), 900)
  useLive(
    (change) => {
      if (depositRulesTouched(change)) reread()
    },
    () => reread(),
    can.view,
  )

  const write = async (work: () => Promise<DepositRulesModel['notice']>, creating = false) => {
    if (busy) return
    setBusy(true)
    setProblem(null)
    setNotice(null)
    try {
      setNotice(await work())
      setDialog(null)
      await read()
    } catch (error) {
      const words = depthProblem(error, ['DATABASE'])
      // One active rule per deposit, side and kind of order: the API's 409 without a version path.
      setProblem(creating && words.key === 'problem.write.state' ? { key: scoped('rule.problem.oneActive'), reload: false } : words)
      if (words.reload) void read()
    } finally {
      setBusy(false)
    }
  }

  return (
    <DepositRulesCard
      model={{ can, rows, list, dialog, draft, busy, problem, notice }}
      actions={{
        onRows: setRows,
        onRetry: () => void read(),
        onDismissNotice: () => setNotice(null),
        onDraft: (patch) => setDraft((current) => ({ ...current, ...patch })),
        onDialog: (next) => {
          setProblem(null)
          if (next?.kind === 'add') setDraft(emptyRule())
          if (next?.kind === 'edit') setDraft(ruleDraftOf(next.rule))
          setDialog(next)
        },
        onSave: () => {
          const editing = dialog?.kind === 'edit' ? dialog.rule : null
          const body = ruleBodyOf(draft)
          void write(async () => {
            if (editing) {
              await updateDepositRule(api, editing, { refundRule: body.refundRule, keepPct: body.keepPct, documentKind: body.documentKind, note: body.note }, newIdempotencyKey())
              return { tone: 'success', words: { key: 'rule.saved' } }
            }
            await createDepositRule(api, companyId, body, newIdempotencyKey())
            return { tone: 'success', words: { key: 'rule.created' } }
          }, !editing)
        },
        onArchive: () => {
          const picked = dialog?.kind === 'archive' ? dialog.rules : []
          void write(async () => {
            for (const rule of picked) await archiveDepositRule(api, rule, newIdempotencyKey())
            return { tone: 'success', words: { key: 'rule.archived', params: { count: picked.length } } }
          })
        },
      }}
    />
  )
}
