'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { problemKey } from '../../../quality/_shared/model'
import { refusalOf, type ReturnsCan, type Words } from '../model'
import { addLine, answerEstimate, changeLine, changeTerms, getEstimates, newEstimate, removeLine, sendEstimate, withdrawEstimate, type Estimates } from './api'
import { answerProblems, blankLine, cellBody, cellProblem, estimateRefusal, lineBody, lineDraftProblems, shownEstimate, termsBody, termsProblems } from './model'
import type { EstimateActions, EstimateDialog, EstimateModel } from './view-model'

/**
 * A repair's Estimate tab container (B-W2b-352), beside W2a's RepairRecord: reads the revisions (again whenever the repair's
 * version moves, and on a live change), writes ONE thing at a time at the estimate's version (each answer is the whole tab,
 * so the next write carries the new version): a cell autosaved (they wait for each other), a line added or removed, the
 * terms, a new revision (copying the newest's lines; a sent one replaced on purpose), Send (the customer sees it in the
 * portal; nothing is mailed), the customer's answer as the office heard it, Withdraw. A sent or accepted estimate moves the
 * repair's stage: the container reads the repair again (`reloadRepair`).
 */
export function useEstimate(input: {
  readonly api: ApiClient
  readonly repairId: string
  readonly repairVersion: number | null
  readonly can: ReturnsCan
  readonly today: string
  readonly reloadRepair: () => Promise<unknown>
  readonly onDone: (words: Words, tone?: 'success' | 'warning' | 'danger') => void
}): { model: EstimateModel; actions: EstimateActions; reload: () => void } {
  const { api, repairId, repairVersion, can, today, reloadRepair, onDone } = input
  const [value, setValue] = useState<Estimates | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [shownId, setShownId] = useState<string | null>(null)
  const [marks, setMarks] = useState<EstimateModel['marks']>({})
  const [dialog, setDialog] = useState<EstimateDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<Words | null>(null)
  const latest = useRef<Estimates | null>(null)
  latest.current = value
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const key = useRef(newIdempotencyKey())

  const load = useCallback(() => {
    getEstimates(api, repairId)
      .then((answer) => {
        latest.current = answer
        setValue(answer)
        setProblem(null)
      })
      .catch((error) => setProblem(`quality:${problemKey(error)}`))
  }, [api, repairId])
  useEffect(() => {
    if (can.repairsView && repairVersion !== null) load()
  }, [load, can.repairsView, repairVersion])

  const shown = () => shownEstimate(latest.current, shownId)
  const take = (answer: Estimates) => {
    latest.current = answer
    setValue(answer)
  }

  // ---- the cells (autosaved; each waits for the previous answer's version) ----------------------------------------------
  const saveCell: EstimateActions['onEstimateCell'] = (lineId, field, text) => {
    const estimate = shown()
    const line = estimate?.lines.find((entry) => entry.id === lineId)
    if (!estimate || !line) return
    const body = cellBody(field, text, line)
    const mark = `${lineId}:${field}`
    if (!body) {
      setMarks((current) => ({ ...current, [mark]: { state: 'refused', words: cellProblem(field) } }))
      return
    }
    setMarks((current) => ({ ...current, [mark]: { state: 'saving' } }))
    chain.current = chain.current.then(async () => {
      const now = shownEstimate(latest.current, estimate.id)
      if (!now) return
      try {
        take(await changeLine(api, now, lineId, body, newIdempotencyKey()))
        setMarks((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== mark)))
      } catch (error) {
        setMarks((current) => ({ ...current, [mark]: { state: 'refused', words: estimateRefusal(error) ?? refusalOf(error) } }))
        load()
      }
    })
  }

  const remove: EstimateActions['onEstimateRemove'] = (lineIds) => {
    const estimate = shown()
    if (!estimate || lineIds.length === 0) return
    chain.current = chain.current.then(async () => {
      try {
        for (const lineId of lineIds) {
          const now = shownEstimate(latest.current, estimate.id)
          if (!now) return
          take(await removeLine(api, now, lineId, newIdempotencyKey()))
        }
        onDone({ key: 'depth:estimate.done.removed', params: { count: lineIds.length } })
      } catch (error) {
        onDone(estimateRefusal(error) ?? refusalOf(error), 'danger')
        load()
      }
    })
  }

  const openDialog = (next: EstimateDialog | null) => {
    if (next && next.kind !== dialog?.kind) key.current = newIdempotencyKey()
    setDialogProblem(null)
    setDialog(next)
  }

  const finish = async (answer: Estimates, words: Words, repairMoved: boolean) => {
    take(answer)
    setDialog(null)
    key.current = newIdempotencyKey()
    if (repairMoved) await reloadRepair()
    onDone(words)
  }

  const submit = async () => {
    const current = latest.current
    const estimate = shown()
    if (!current || !dialog || busy) return
    setBusy(true)
    setDialogProblem(null)
    try {
      switch (dialog.kind) {
        case 'line': {
          if (!estimate) break
          if (lineDraftProblems(dialog.draft).length > 0) {
            setDialog({ ...dialog, showProblems: true })
            break
          }
          await chain.current
          const now = shownEstimate(latest.current, estimate.id) ?? estimate
          await finish(await addLine(api, now, lineBody(dialog.draft, current.seesCosts), key.current), { key: 'depth:estimate.done.added' }, false)
          break
        }
        case 'new': {
          const answer = await newEstimate(api, repairId, { copyLines: current.estimates.length > 0, ...(dialog.replaces ? { replaces: dialog.replaces } : {}) }, key.current)
          setShownId(answer.estimates[0]?.id ?? null)
          await finish(answer, { key: 'depth:estimate.done.new', params: { revision: answer.estimates[0]?.revision ?? 1 } }, false)
          break
        }
        case 'send': {
          if (!estimate) break
          await chain.current
          const now = shownEstimate(latest.current, estimate.id) ?? estimate
          await finish(await sendEstimate(api, now, key.current), { key: 'depth:estimate.done.sent', params: { revision: now.revision } }, true)
          break
        }
        case 'answer': {
          if (!estimate) break
          if (answerProblems(dialog.draft).length > 0 || !dialog.draft.answer) {
            setDialog({ ...dialog, showProblems: true })
            break
          }
          const draft = dialog.draft
          await finish(
            await answerEstimate(api, estimate, { answer: draft.answer as 'ACCEPTED' | 'DECLINED', how: draft.how.trim(), answeredByName: draft.name.trim() || null, ...(draft.answer === 'DECLINED' ? { declineReason: draft.declineReason.trim() } : {}) }, key.current),
            { key: draft.answer === 'ACCEPTED' ? 'depth:estimate.done.accepted' : 'depth:estimate.done.declined', params: { revision: estimate.revision } },
            true,
          )
          break
        }
        case 'withdraw': {
          if (!estimate) break
          await finish(await withdrawEstimate(api, estimate, dialog.reason.trim() || null, key.current), { key: 'depth:estimate.done.withdrawn', params: { revision: estimate.revision } }, false)
          break
        }
        case 'terms': {
          if (!estimate) break
          const problems = termsProblems(dialog.draft, today)
          if (estimate.status === 'DRAFT' && problems.length > 0) {
            setDialogProblem(problems[0]!)
            break
          }
          await finish(await changeTerms(api, estimate, termsBody(dialog.draft, estimate), key.current), { key: 'depth:estimate.done.terms' }, false)
          break
        }
      }
    } catch (error) {
      setDialogProblem(estimateRefusal(error) ?? refusalOf(error))
      key.current = newIdempotencyKey()
      load()
    } finally {
      setBusy(false)
    }
  }

  return {
    model: { value, problem, shownId, marks, dialog, busy, dialogProblem },
    actions: {
      onEstimateShow: (estimateId) => setShownId(estimateId),
      onEstimateCell: saveCell,
      onEstimateRemove: remove,
      onEstimateDialog: openDialog,
      onEstimateSubmit: () => void submit(),
      onEstimateRetry: load,
      onEstimateAdd: (kind) => openDialog({ kind: 'line', draft: blankLine(kind), showProblems: false }),
    },
    reload: load,
  }
}
