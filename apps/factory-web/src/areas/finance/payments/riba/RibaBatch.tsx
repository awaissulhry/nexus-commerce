'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { downloadLink } from '../../../../record-panels/api'
import { storeUrl } from '../../../../record-panels/store'
import { isStepUpCancelled, useCoalesced, useLive, useStepUp } from '../../_shared/hooks'
import { readProblem, romeToday } from '../../_shared/model'
import { cancelRibaBatch, collectionsSettings, createRibaBatch, issueRibaBatch, pickRibaItems, ribaBatch, ribaBatches, ribaCandidates, setCollections, settleRibaBatch, type CollectionsSettings, type RibaBatch as Batch } from './api'
import { scoped, type Phrase } from './depth'
import { defaultWindow, freeKeys, pickKey, picksOf, rememberedSia, rememberSia, ribaProblem, settlementOf, siaOf, waitingItems, windowProblem, type RibaProblem } from './model'
import { PayStepUp } from './view/PayStepUp'
import { RibaDialog, type RibaStage } from './view/RibaDialog'

const READ_DELAY = 350

/**
 * The Ri.Ba. batch's container (B-W2b-425 on B-W2b-402's API; opened from Payments' ⋯ or `?riba=new|<batch id>`): reads the
 * Owner's switch, the recent batches and the instalments due in the window (read again as the window changes), makes a
 * draft of the ones picked, changes or cancels a draft, makes the CBI file (the SIA code remembered on this device; the
 * customers' banks typed when not known) and downloads it at once, and records the bank's report — one write each with an
 * Idempotency-Key and the batch's version. Turning the Owner's switch on asks a fresh code first. Live: a batch or a
 * settled receipt of the company reads the open batch again.
 */
export function RibaBatch({ prefix, start, onClose }: { prefix: string; start: string; onClose: () => void }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const companyId = session.company?.id ?? ''
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const can = { view: held.has('receivables.view'), manage: held.has('receivables.riba.manage'), record: held.has('payments.record'), price: held.has('money.price'), switchRiba: held.has('receivables.collections.switch') }
  const today = romeToday()
  const startWindow = defaultWindow(today)
  const emptyStart: RibaStage = { kind: 'start', batches: null, batchesProblem: null, candidates: null, candidatesProblem: null, reading: true, window: startWindow, picked: null, repick: null }
  const [stage, setStage] = useState<RibaStage>(start === 'new' ? emptyStart : { kind: 'batch', batch: null, problem: null })
  const [collections, setCollectionsState] = useState<CollectionsSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<RibaProblem | null>(null)
  const [notice, setNotice] = useState<Phrase | null>(null)
  const { stepUp, guard, ensureFresh, submitStepUp, cancelStepUp } = useStepUp(api)
  const stageRef = useRef(stage)
  stageRef.current = stage
  const asked = useRef(0)

  const readCollections = useCallback(async () => {
    if (!companyId) return
    try {
      setCollectionsState(await collectionsSettings(api, companyId))
    } catch {
      setCollectionsState(null)
    }
  }, [api, companyId])

  const readBatch = useCallback(
    async (batchId: string) => {
      try {
        const batch = await ribaBatch(api, batchId)
        setStage((current) => (current.kind === 'batch' || current.kind === 'cancel' ? { kind: 'batch', batch, problem: null } : current))
        return batch
      } catch (error) {
        setStage((current) => (current.kind === 'batch' ? { kind: 'batch', batch: null, problem: readProblem(error) } : current))
        return null
      }
    },
    [api],
  )

  const readStart = useCallback(
    async (window: { dueFrom: string; dueTo: string }, repick: Batch | null) => {
      const id = ++asked.current
      if (!companyId || windowProblem(window.dueFrom, window.dueTo)) {
        setStage((current) => (current.kind === 'start' ? { ...current, reading: false, candidates: null } : current))
        return
      }
      setStage((current) => (current.kind === 'start' ? { ...current, reading: true, candidatesProblem: null } : current))
      try {
        const candidates = await ribaCandidates(api, { companyId, dueFrom: window.dueFrom, dueTo: window.dueTo, ...(repick ? { batchId: repick.id } : {}) })
        if (id !== asked.current) return
        setStage((current) => (current.kind === 'start' ? { ...current, candidates, reading: false, candidatesProblem: null } : current))
      } catch (error) {
        if (id !== asked.current) return
        setStage((current) => (current.kind === 'start' ? { ...current, candidates: null, reading: false, candidatesProblem: readProblem(error) } : current))
      }
    },
    [api, companyId],
  )

  const readBatches = useCallback(async () => {
    if (!companyId) return
    try {
      const batches = await ribaBatches(api, { companyId })
      setStage((current) => (current.kind === 'start' ? { ...current, batches, batchesProblem: null } : current))
    } catch (error) {
      setStage((current) => (current.kind === 'start' ? { ...current, batches: null, batchesProblem: readProblem(error) } : current))
    }
  }, [api, companyId])

  useEffect(() => {
    void readCollections()
    if (start === 'new') {
      void readBatches()
      void readStart(startWindow, null)
    } else void readBatch(start)
    // Read once when opened; the stage's own moves read again.
  }, [start])

  const windowTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (windowTimer.current && clearTimeout(windowTimer.current)), [])

  const reread = useCoalesced(() => {
    const current = stageRef.current
    if (current.kind === 'batch' && current.batch) void readBatch(current.batch.id)
    if (current.kind === 'start' && !current.repick) void readBatches()
  }, 800)
  useLive(
    (change) => {
      if (change.type === 'riba_batch.changed' || change.type === 'riba_item.settled' || change.type === 'collections_settings.changed') reread()
      if (change.type === 'collections_settings.changed') void readCollections()
    },
    () => reread(),
    can.view,
  )

  const write = async (run: () => Promise<void>, items: Batch['items'] = []) => {
    if (busy) return
    setBusy(true)
    setProblem(null)
    try {
      await run()
    } catch (error) {
      if (isStepUpCancelled(error)) return
      const words = ribaProblem(error, items)
      setProblem(words)
      const current = stageRef.current
      if (words.reload && current.kind === 'batch' && current.batch) void readBatch(current.batch.id)
    } finally {
      setBusy(false)
    }
  }

  const download = async (fileId: string, name: string) => {
    try {
      const link = await downloadLink(api, fileId)
      const anchor = document.createElement('a')
      anchor.href = storeUrl(link.download.url)
      anchor.download = name
      anchor.rel = 'noopener'
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
    } catch (error) {
      setProblem(ribaProblem(error))
    }
  }

  const startStage = (current: RibaStage): Extract<RibaStage, { kind: 'start' }> | null => (current.kind === 'start' ? current : null)

  return (
    <>
      <RibaDialog
        model={{ prefix, today, can, stage, collections, busy, problem, notice, sia: companyId ? rememberedSia(companyId) : '' }}
        actions={{
          onClose,
          onRetry: () => {
            const current = stageRef.current
            if (current.kind === 'start') void readStart(current.window, current.repick)
            if (current.kind === 'batch' && current.batch) void readBatch(current.batch.id)
            if (current.kind === 'batch' && !current.batch && start !== 'new') void readBatch(start)
          },
          onDismissNotice: () => setNotice(null),
          onWindow: (window) => {
            setStage((current) => (current.kind === 'start' ? { ...current, window, picked: current.repick ? current.picked : null } : current))
            if (windowTimer.current) clearTimeout(windowTimer.current)
            const repick = startStage(stageRef.current)?.repick ?? null
            windowTimer.current = setTimeout(() => void readStart(window, repick), READ_DELAY)
          },
          onPicked: (keys) => setStage((current) => (current.kind === 'start' ? { ...current, picked: keys } : current)),
          onCreate: () => {
            const current = startStage(stageRef.current)
            if (!current?.candidates || !companyId) return
            const picks = picksOf(current.candidates.candidates, new Set(current.picked ?? freeKeys(current.candidates.candidates)))
            const key = newIdempotencyKey()
            void write(async () => {
              const batch = await createRibaBatch(api, { companyId, dueFrom: current.window.dueFrom, dueTo: current.window.dueTo, items: picks }, key)
              setStage({ kind: 'batch', batch, problem: null })
              setNotice({ key: scoped('riba.notice.created'), params: { count: batch.count } })
            })
          },
          onSavePicks: () => {
            const current = startStage(stageRef.current)
            if (!current?.candidates || !current.repick) return
            const batch = current.repick
            const picks = picksOf(current.candidates.candidates, new Set(current.picked ?? freeKeys(current.candidates.candidates)))
            const key = newIdempotencyKey()
            void write(async () => {
              const next = await pickRibaItems(api, batch, picks, key)
              setStage({ kind: 'batch', batch: next, problem: null })
              setNotice({ key: scoped('riba.notice.picked'), params: { count: next.count } })
            })
          },
          onOpenBatch: (batchId) => {
            setProblem(null)
            setNotice(null)
            setStage({ kind: 'batch', batch: null, problem: null })
            void readBatch(batchId)
          },
          onBack: () => {
            setProblem(null)
            setNotice(null)
            setStage(emptyStart)
            void readBatches()
            void readStart(startWindow, null)
          },
          onRepick: (batch) => {
            setProblem(null)
            setNotice(null)
            const window = { dueFrom: batch.dueFrom, dueTo: batch.dueTo }
            setStage({ kind: 'start', batches: null, batchesProblem: null, candidates: null, candidatesProblem: null, reading: true, window, picked: batch.items.map((item) => pickKey(item)), repick: batch })
            void readStart(window, batch)
          },
          onStage: (next) => {
            setProblem(null)
            setStage(next)
          },
          onIssue: ({ sia, banks }) => {
            const current = stageRef.current
            if (current.kind !== 'batch' || !current.batch) return
            const batch = current.batch
            rememberSia(batch.company.id, sia)
            const key = newIdempotencyKey()
            void write(async () => {
              const next = await issueRibaBatch(api, batch, { siaCode: siaOf(sia), banks }, key)
              setStage({ kind: 'batch', batch: next, problem: null })
              if (next.file) {
                setNotice({ key: scoped('riba.notice.issued'), params: { name: next.file.name } })
                void download(next.file.id, next.file.name)
              }
            }, batch.items)
          },
          onDownload: (fileId, name) => void download(fileId, name),
          onCancelBatch: (reason) => {
            const current = stageRef.current
            if (current.kind !== 'cancel') return
            const key = newIdempotencyKey()
            void write(async () => {
              const next = await cancelRibaBatch(api, current.batch, reason, key)
              setStage({ kind: 'batch', batch: next, problem: null })
            }, current.batch.items)
          },
          onSettle: (rows) => {
            const current = stageRef.current
            if (current.kind !== 'batch' || !current.batch) return
            const batch = current.batch
            const settlement = settlementOf(waitingItems(batch), rows, today)
            if (settlement.problem) return
            const key = newIdempotencyKey()
            const paid = settlement.items.filter((item) => item.status === 'PAID').length
            void write(async () => {
              const next = await settleRibaBatch(api, batch, settlement.items, key)
              setStage({ kind: 'batch', batch: next, problem: null })
              setNotice({ key: scoped('riba.notice.settled'), params: { paid, unpaid: settlement.items.length - paid } })
            }, batch.items)
          },
          onSwitchOn: () => {
            const current = stageRef.current
            if (current.kind !== 'switch' || !companyId) return
            const key = newIdempotencyKey()
            void write(async () => {
              await ensureFresh(scoped('stepUp.riba'))
              const body = { companyId, ribaOn: true, ...(collections?.source === 'COMPANY' && collections.version ? { version: collections.version } : {}) }
              const next = await guard(scoped('stepUp.riba'), () => setCollections(api, body, key))
              setCollectionsState(next)
              setStage(current.from)
              setNotice({ key: scoped('riba.notice.switchedOn') })
              if (current.from.kind === 'batch' && current.from.batch) void readBatch(current.from.batch.id)
            })
          },
        }}
      />
      <PayStepUp stepUp={stepUp} onSubmit={(code) => void submitStepUp(code)} onCancel={cancelStepUp} />
    </>
  )
}
