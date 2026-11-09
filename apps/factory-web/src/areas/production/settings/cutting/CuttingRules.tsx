'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { changeCuttingRules, getCuttingRules, getLeatherTolerance, putLeatherTolerance, type CuttingRules as Rules, type LeatherTolerance } from './api'
import { CuttingRulesView, type CuttingModel, type Part } from './CuttingRulesView'
import { cuttingChange, cuttingProblem, readProblem, toleranceChange, type CuttingDraft, type ToleranceDraft } from './model'

const LOADING = { value: null, problem: null }

/**
 * The Cutting card's container (B-W2b-219): reads the site's cutting rules (production.settings.view) and, for a person who
 * reads purchasing (purchasing.view), the leather area tolerance of the site's company; applies a change with the site's
 * floor rules version (`version`: the page's, shared by every part of the row; the answer's goes back through `onVersion`)
 * and its own Idempotency-Key per attempt; a conflict tells the page (`onConflict`: "Changed by someone else · Reload").
 */
export function CuttingRules({ siteId, companyId, version, onVersion, onConflict, timeZone, reloadKey }: { siteId: string; companyId: string; version: number | null; onVersion: (version: number | null) => void; onConflict: () => void; timeZone: string; reloadKey?: number }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const canManage = session.permissions.includes('production.settings.manage')
  const readsPurchasing = session.permissions.includes('purchasing.view')
  const [rules, setRules] = useState<Part<Rules>>(LOADING)
  const [tolerance, setTolerance] = useState<Part<LeatherTolerance>>(LOADING)
  const [busy, setBusy] = useState<CuttingModel['busy']>(null)
  const [notice, setNotice] = useState<CuttingModel['notice']>(null)
  // One key per attempt of the same body: a lost answer sent again is answered from its receipt.
  const attempt = useRef<{ body: string; key: string } | null>(null)
  const keyFor = (body: unknown) => {
    const text = JSON.stringify(body)
    if (attempt.current?.body !== text) attempt.current = { body: text, key: newIdempotencyKey() }
    return attempt.current.key
  }

  const load = useCallback(() => {
    setRules(LOADING)
    getCuttingRules(api, siteId)
      .then((value) => setRules({ value, problem: null }))
      .catch((error: unknown) => setRules({ value: null, problem: readProblem(error) }))
    if (readsPurchasing) {
      setTolerance(LOADING)
      getLeatherTolerance(api, companyId)
        .then((value) => setTolerance({ value, problem: null }))
        .catch((error: unknown) => setTolerance({ value: null, problem: readProblem(error) }))
    }
  }, [api, siteId, companyId, readsPurchasing])

  useEffect(() => {
    load()
  }, [load, reloadKey])

  const model: CuttingModel = { rules, tolerance: readsPurchasing ? tolerance : null, canManage, version, busy, notice, timeZone }

  return (
    <CuttingRulesView
      model={model}
      actions={{
        onRetry: load,
        onDismiss: () => setNotice(null),
        onApply: (draft: CuttingDraft) => {
          const current = rules.value
          if (!current || busy) return
          const { body, count } = cuttingChange(current, draft, Math.max(version ?? 0, current.version ?? 0) || null)
          if (count === 0) return
          setBusy('rules')
          setNotice(null)
          changeCuttingRules(api, siteId, body, keyFor(body))
            .then((answer) => {
              attempt.current = null
              setRules({ value: answer, problem: null })
              onVersion(answer.version)
              setNotice({ tone: 'success', key: answer.changed ? 'cr.done' : 'cr.unchanged' })
            })
            .catch((error: unknown) => {
              const problem = cuttingProblem(error)
              if (problem.conflict) onConflict()
              setNotice({ tone: 'danger', key: problem.key })
            })
            .finally(() => setBusy(null))
        },
        onTolerance: (draft: ToleranceDraft) => {
          const current = tolerance.value
          if (!current || busy) return
          const body = toleranceChange(current, draft)
          if (!body) return
          setBusy('tolerance')
          setNotice(null)
          putLeatherTolerance(api, body, keyFor(body))
            .then((answer) => {
              attempt.current = null
              setTolerance({ value: answer, problem: null })
              setNotice({ tone: 'success', key: answer.changed ? 'cr.tolerance.done' : 'cr.unchanged' })
            })
            .catch((error: unknown) => setNotice({ tone: 'danger', key: cuttingProblem(error).key }))
            .finally(() => setBusy(null))
        },
      }}
    />
  )
}
