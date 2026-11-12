'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { problemKey } from '../../../quality/_shared/model'
import type { DecisionLine, Rma } from '../api'
import { minorOf, refusalOf, type ReturnsCan, type Words } from '../model'
import { applyPolicy, checkPolicy, creditWithoutReturn, getDepth, getOutcomes, previewCredit, previewFees, returnPapers, setScanCode, splitLine, type FeePreview, type ReturnDepth } from './api'
import { checkLinesOf, creditBody, creditDraftProblems, policyProblems, policyRefusal } from './model'
import type { DepthDialog, RmaDepthActions, RmaDepthModel } from './view-model'

/**
 * The W2b parts of a return's container (B-W2b-352), beside W2a's RmaRecord: reads the return in depth and its outcomes
 * (each on its own, again whenever the RMA's version moves — every write and every live change of it — and after each
 * write of these parts), the fee of the decisions being drafted (debounced; only on a return that names a policy), and runs
 * the parts' writes ONE at a time at the RMA's version as the container last read it: a credit without the goods (preview
 * while typing, then the ask: done, or waiting for a yes), split the rest, the return policy bound, the papers (the scan
 * code first, then the PDF in a new tab). After a write the container's RMA is read again (`reload`).
 */
export function useRmaDepth(input: {
  readonly api: ApiClient
  readonly returnId: string
  readonly version: number | null
  readonly can: ReturnsCan
  readonly latest: () => Rma | null
  readonly reload: () => Promise<Rma | null>
  readonly decisionLines: readonly DecisionLine[]
  readonly language: 'it' | 'en'
  readonly onDone: (words: Words, tone?: 'success' | 'warning' | 'danger') => void
}): { model: RmaDepthModel; actions: RmaDepthActions; reload: () => void } {
  const { api, returnId, version, can, latest, reload, decisionLines, language, onDone } = input
  const [depth, setDepth] = useState<RmaDepthModel['depth']>({ value: null, problem: null })
  const [outcomes, setOutcomes] = useState<RmaDepthModel['outcomes']>({ value: null, problem: null })
  const [fees, setFees] = useState<FeePreview | null>(null)
  const [dialog, setDialog] = useState<DepthDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Words | null>(null)
  const [printing, setPrinting] = useState(false)
  const key = useRef(newIdempotencyKey())
  const depthNow = useRef<ReturnDepth | null>(null)
  depthNow.current = depth.value

  const loadAll = useCallback(() => {
    getDepth(api, returnId)
      .then((value) => setDepth({ value, problem: null }))
      .catch((error) => setDepth((current) => ({ value: current.value, problem: `quality:${problemKey(error)}` })))
    getOutcomes(api, returnId)
      .then((value) => setOutcomes({ value, problem: null }))
      .catch((error) => setOutcomes((current) => ({ value: current.value, problem: `quality:${problemKey(error)}` })))
  }, [api, returnId])
  // The RMA's version is the dependency: each write and each live change of the return moves it.
  useEffect(() => {
    if (version !== null) loadAll()
  }, [loadAll, version])

  // The fee each drafted decision would withhold (no policy named: no fee, nothing to ask).
  const feeKey = JSON.stringify(decisionLines.map((line) => [line.lineId, line.disposition, line.creditAmount ?? null]))
  const feesApply = depth.value?.feesApply ?? false
  useEffect(() => {
    if (!can.decide || !feesApply || decisionLines.length === 0) {
      setFees(null)
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      previewFees(
        api,
        returnId,
        decisionLines.map((line) => ({ lineId: line.lineId, disposition: line.disposition, ...(line.creditAmount !== undefined && line.creditAmount !== null ? { creditAmount: line.creditAmount } : {}) })),
        controller.signal,
      )
        .then(setFees)
        .catch(() => setFees(null))
    }, 300)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
    // The drafts' text is the dependency.
  }, [api, returnId, can.decide, feesApply, feeKey])

  // The credit's preview while its amount changes (debounced; an amount that is not a number waits for a better one).
  const creditKey = dialog?.kind === 'credit' ? `${dialog.draft.lineId}|${dialog.draft.amount}` : ''
  useEffect(() => {
    if (dialog?.kind !== 'credit') return
    const { lineId, amount } = dialog.draft
    const typed = amount.trim() === '' ? null : minorOf(amount)
    if (amount.trim() !== '' && (typed === null || typed <= 0)) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setDialog((open) => (open?.kind === 'credit' ? { ...open, previewing: true } : open))
      previewCredit(api, returnId, lineId, typed, controller.signal)
        .then((preview) => setDialog((open) => (open?.kind === 'credit' && open.draft.lineId === lineId ? { ...open, preview, previewing: false } : open)))
        .catch(() => setDialog((open) => (open?.kind === 'credit' ? { ...open, previewing: false } : open)))
    }, 300)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [api, returnId, creditKey])

  // The policy check while its dialog is open (again when the withdrawal is asked or not).
  const policyKey = dialog?.kind === 'policy' ? String(dialog.draft.withdrawal) : ''
  useEffect(() => {
    const rma = latest()
    if (dialog?.kind !== 'policy' || !rma) return
    const controller = new AbortController()
    checkPolicy(api, { companyId: rma.companyId, partyId: rma.partyId, withdrawal: dialog.draft.withdrawal, lines: checkLinesOf(rma.lines) }, controller.signal)
      .then((check) => setDialog((open) => (open?.kind === 'policy' ? { ...open, check } : open)))
      .catch((error) => setProblem({ key: `quality:${problemKey(error)}` }))
    return () => controller.abort()
  }, [api, policyKey])

  const openDialog = (next: DepthDialog | null) => {
    if (next && next.kind !== dialog?.kind) key.current = newIdempotencyKey()
    setProblem(null)
    setDialog(next)
  }

  const afterWrite = async (words: Words) => {
    setDialog(null)
    key.current = newIdempotencyKey()
    await reload()
    loadAll()
    onDone(words, 'success')
  }

  const submit = async () => {
    const rma = latest()
    if (!rma || !dialog || busy) return
    setBusy(true)
    setProblem(null)
    try {
      switch (dialog.kind) {
        case 'credit': {
          const problems = creditDraftProblems(dialog.draft, dialog.preview)
          if (problems.length > 0) {
            setProblem(problems[0]!)
            break
          }
          const answer = await creditWithoutReturn(api, rma, dialog.draft.lineId, creditBody(dialog.draft), key.current)
          const seq = rma.lines.find((line) => line.id === dialog.draft.lineId)?.seq ?? '—'
          await afterWrite(answer.credited ? { key: 'depth:credit.done', params: { seq } } : { key: 'depth:credit.asked', params: { seq } })
          break
        }
        case 'policy': {
          const problems = policyProblems(dialog.check, dialog.draft)
          if (problems.length > 0) {
            setProblem(problems[0]!)
            break
          }
          const answer = await applyPolicy(api, rma, { withdrawal: dialog.draft.withdrawal, ...(dialog.draft.reason.trim() ? { reason: dialog.draft.reason.trim() } : {}) }, key.current)
          await afterWrite(answer.goodsDueBy ? { key: 'depth:policy.done', params: { date: answer.goodsDueBy } } : { key: 'depth:policy.doneNoDate' })
          break
        }
        case 'split': {
          const answer = await splitLine(api, rma, dialog.lineId, key.current)
          await afterWrite({ key: 'depth:split.done', params: { seq: answer.line.seq, kept: answer.line.quantity, newSeq: answer.newLine.seq, rest: answer.newLine.quantity } })
          break
        }
      }
    } catch (error) {
      setProblem((dialog.kind === 'policy' ? policyRefusal(error) : null) ?? refusalOf(error))
      key.current = newIdempotencyKey()
      void reload()
      loadAll()
    } finally {
      setBusy(false)
    }
  }

  // The papers: the scan code is set once (it names the RMA on the box), then the PDF opens in a new tab.
  const print = async () => {
    const rma = latest()
    if (!rma || printing) return
    const tab = window.open('', '_blank')
    setPrinting(true)
    try {
      if (!depthNow.current?.scanCode) {
        await setScanCode(api, rma, newIdempotencyKey())
        await reload()
        loadAll()
      }
      const bytes = await returnPapers(api, rma.id, language)
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
      if (tab) tab.location.href = url
      else window.open(url, '_blank')
    } catch (error) {
      tab?.close()
      onDone(refusalOf(error), 'danger')
    } finally {
      setPrinting(false)
    }
  }

  return {
    model: { depth, outcomes, fees, dialog, busy, problem, printing },
    actions: {
      onDepthDialog: openDialog,
      onDepthSubmit: () => void submit(),
      onPrintPapers: () => void print(),
      onDepthRetry: loadAll,
    },
    reload: loadAll,
  }
}
