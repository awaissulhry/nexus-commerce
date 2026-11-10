'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../../lib/api/client'
import { isApiError } from '../../../../../lib/api/errors'
import { useLocale } from '../../../../../lib/i18n/provider'
import { companyPrefix } from '../../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { isStepUpCancelled, liveMatches, useLive } from '../../../../quality/_shared/hooks'
import { failedRead, problemKey, ready, reading, type Notice, type Read } from '../../../../quality/_shared/model'
import { pickerReasons, type PickerReason } from '../../../../_shared/reasons/api'
import { RegisterMessages } from '../../view/parts'
import { cancelRecall, closeRecall, editRecall, getRecall, holdRecall, publishRecallNotice, recordProgress, startRecall, withdrawRecallNotice, type HoldsAnswer, type RecallDetail } from '../api'
import { depthCan, romeDay } from '../model'
import { issueLines, refusal, useDepth } from '../use-depth'
import { RecallBuilderView, type RecallDialog } from './view/RecallBuilderView'

/**
 * `/w/<company>/compliance/register/recall/<id>` (SCR-328; design pop:rg-recall, the Builder in page mode; B-W2b-271 on
 * B-W2b-260's API): reads the recall (scope, trace, holds, progress, its public notice), the HOLD reasons when holds may be
 * placed, and the entry's depth parts (the distributors' log, drafted for this recall); writes ONE thing at a time with
 * the version read; publishing the public notice asks a fresh code (403 `stepUp`). Live recall events read it again.
 */
export function RecallPage({ recallId }: { recallId: string }) {
  return (
    <RegisterMessages>
      <RecallContainer recallId={recallId} />
    </RegisterMessages>
  )
}

function RecallContainer({ recallId }: { recallId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const can = useMemo(() => depthCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const [recall, setRecall] = useState<Read<RecallDetail>>(reading())
  const [reasons, setReasons] = useState<Read<readonly PickerReason[]> | null>(null)
  const [dialog, setDialog] = useState<RecallDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<{ key: string; lines: readonly string[] } | null>(null)
  const [notice, setNotice] = useState<Notice | null>(params?.get('drafted') === '1' ? { key: 'done.recallDrafted', tone: 'success' } : null)
  const [holdResult, setHoldResult] = useState<Pick<HoldsAnswer, 'placed' | 'alreadyHeld'> | null>(null)
  const keys = useRef(new Map<string, string>())
  const keyFor = (name: string) => {
    const known = keys.current.get(name)
    if (known) return known
    const made = newIdempotencyKey()
    keys.current.set(name, made)
    return made
  }

  const load = useCallback(async () => {
    try {
      setRecall(ready(await getRecall(api, recallId)))
    } catch (error) {
      setRecall((current) => (current.value ? { value: current.value, problem: problemKey(error) } : failedRead(problemKey(error))))
    }
  }, [api, recallId])

  useEffect(() => {
    void load()
  }, [load])

  // Remove the one-off `?drafted=1` once the notice shows.
  useEffect(() => {
    if (params?.get('drafted') !== '1') return
    router.replace(pathname, { scroll: false })
  }, [params, pathname, router])

  useLive(
    (change) => {
      if (liveMatches(change, ['recall.changed', 'recall.progress_changed']) && change.fields.recallId === recallId) void load()
    },
    () => void load(),
  )

  // The HOLD reasons, once, when holds may be placed.
  useEffect(() => {
    if (dialog !== 'hold' || reasons !== null || !can.holdsPlace) return
    setReasons(reading())
    pickerReasons(api, ['HOLD'])
      .then((list) => setReasons(ready(list)))
      .catch((error) => setReasons(failedRead(problemKey(error))))
  }, [api, can.holdsPlace, dialog, reasons])

  const value = recall.value
  const depth = useDepth({
    api,
    permissions: session.permissions,
    entry: {
      id: value?.entryId ?? '',
      companyId: value?.companyId ?? '',
      reference: value?.entry.reference ?? '',
      kind: value?.entry.kind ?? 'RECALL',
      status: value?.entry.status ?? 'OPEN',
      risk: value?.entry.risk ?? 'ASSESSING',
      styleId: value?.style.id ?? '',
      styleCode: value?.style.code ?? '',
      batchNumbers: value?.scope.batchNumbers ?? [],
      reportedAt: value?.createdAt ?? new Date().toISOString(),
      version: value?.version ?? 0,
    },
    prefix,
    locale,
    onEntryChanged: () => void load(),
    navigate: (address) => router.push(address),
    recallId,
  })

  const run = async (work: (current: RecallDetail) => Promise<RecallDetail | HoldsAnswer>, done: { key: string; params?: Record<string, string | number> } | null, refusedKey: string) => {
    if (!value) return
    setBusy(true)
    setProblem(null)
    try {
      const answer = await work(value)
      keys.current.clear()
      if ('placed' in answer) {
        setRecall(ready(answer.recall))
        setHoldResult({ placed: answer.placed, alreadyHeld: answer.alreadyHeld })
      } else setRecall(ready(answer))
      setDialog(null)
      if (done) setNotice({ key: done.key, tone: 'success', params: done.params })
      depth.reload()
    } catch (error) {
      if (isStepUpCancelled(error)) return
      if (isApiError(error) && error.kind === 'conflict' && issueLines(error).length === 0) {
        keys.current.clear()
        await load()
        setProblem({ key: 'dialog.conflict', lines: [] })
      } else setProblem(refusal(error, refusedKey))
    } finally {
      setBusy(false)
    }
  }

  return (
    <RecallBuilderView
      model={{ prefix, can, recall, depth: value ? depth.model : null, reasons, dialog, busy, problem, notice, holdResult, today: romeDay() }}
      actions={{
        onRetry: () => void load(),
        onDialog: (next) => {
          setDialog(next)
          setProblem(null)
          keys.current.clear()
        },
        onScope: (body) => void run((current) => editRecall(api, current.id, current.version, body), { key: value?.status === 'ACTIVE' ? 'done.scopeWidened' : 'done.scopeSaved' }, 'refused.recall'),
        onHold: (input) =>
          void run((current) => holdRecall(api, current.id, current.version, { reasonCode: input.reasonCode, ...(input.reasonNote ? { reasonNote: input.reasonNote } : {}) }, keyFor('hold')), null, 'refused.holds'),
        onPublicWords: (words) => void run((current) => editRecall(api, current.id, current.version, { publicNotice: words }), { key: 'done.publicSaved' }, 'refused.public'),
        onPublish: (words) =>
          void run((current) => depth.guard('stepUp.publish', () => publishRecallNotice(api, current.id, current.version, words, keyFor('publish'))), { key: 'done.published' }, 'refused.public'),
        onWithdrawNotice: () => void run((current) => withdrawRecallNotice(api, current.id, current.version), { key: 'done.noticeDown' }, 'refused.public'),
        onProgress: (row, counts) => void run((current) => recordProgress(api, current.id, row.id, row.version, counts), { key: 'done.progress', params: { party: row.party.name } }, 'refused.progress'),
        onStart: () => void run((current) => startRecall(api, current.id, current.version, keyFor('start')), { key: 'done.started', params: { count: value?.trace.counts.concerned ?? 0 } }, 'refused.start'),
        onClose: (note) => void run((current) => closeRecall(api, current.id, current.version, note), { key: 'done.closed' }, 'refused.recall'),
        onCancel: (reason) => void run((current) => cancelRecall(api, current.id, current.version, reason), { key: 'done.cancelled' }, 'refused.recall'),
        onDismissNotice: () => setNotice(null),
        depth: depth.actions,
        depthNotice: depth.notice,
        onDismissDepthNotice: depth.dismissNotice,
      }}
    />
  )
}
