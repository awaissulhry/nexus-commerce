'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { ApprovalDecision } from '@nexus/factory-domain/approvals-out/kinds'
import { isApiError } from '../../../lib/api/errors'
import { formatTime } from '../../../lib/i18n/format'
import { WithMessages } from '../../../record-panels/i18n'
import { usePortalApi, usePortalBand, usePortalFrame, usePortalLive } from '../../shell/frame'
import { answerApproval, approvalFileBytes, fetchApproval } from '../home/api'
import { fetchSamples, techPackBytes, type RoundRead, type SamplesRead, type StyleRead } from './api'
import { addressOf, addressQuery, answerProblem, answerRefusal, decisionHeld, isPdf, isPicture, neighbourOf, NS, PAGE_PERMISSION, roundsShown, samplesBandOf, type DialogFile, type SamplesAddress } from './model'
import type { DecisionDialogModel } from './view/DecisionDialog'
import { SamplesClosedView, SamplesView } from './view/SamplesView'
import { useSamplesWords } from './words'

/**
 * `/p/<party>/samples?style=&decide=` for a brand (B-W2b-262, SCR-225; design portal.customer.samples): reads the page in
 * one answer (GET /portal/samples); "Decide on Fit 2" reads the request (B-W2b-184's GET /portal/approvals/:id) and its
 * photos, and signs the answer (POST …/answer): the round is decided by the office's settle (B-W2b-252), the request's
 * task closes, the page reads again. A tech pack PDF opens in a new tab through the logged open. `?decide=<request>` (a
 * task's link, Home's row, a mail) opens the dialog on it; `?style=<style>` shows that style's rounds. Live: a request
 * asked or answered, a notification → the page reads again. Nothing reaches a real customer: mails stay FAKE locally.
 */
export function CustomerSamplesRoute() {
  return (
    <WithMessages namespaces={[NS, 'portal', 'ds-words', 'lists']}>
      <Suspense fallback={null}>
        <SamplesGate />
      </Suspense>
    </WithMessages>
  )
}

function SamplesGate() {
  const frame = usePortalFrame()
  const opens = frame.kinds.includes('CUSTOMER') && frame.me.permissions.includes(PAGE_PERMISSION)
  return opens ? <SamplesContainer /> : <Closed />
}

function Closed() {
  const { t } = useSamplesWords()
  const frame = usePortalFrame()
  usePortalBand({ title: t('title'), back: { href: frame.prefix, label: t('noAccess.home') } })
  return <SamplesClosedView model={{ homeHref: frame.prefix, admins: (frame.access?.admins ?? []).map((admin) => admin.displayName) }} />
}

type Dialog = Omit<DecisionDialogModel, 'held' | 'position' | 'row'> & { queue: string[] }

function saveBytes(name: string, bytes: Uint8Array, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function SamplesContainer() {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const params = useSearchParams()
  const { t, locale } = useSamplesWords()
  const address = addressOf(params)
  const preview = frame.me.preview
  const admins = (frame.access?.admins ?? []).map((admin) => admin.displayName)

  const [read, setRead] = useState<{ state: 'loading' | 'error' | 'ready'; value: SamplesRead | null }>({ state: 'loading', value: null })
  const [slow, setSlow] = useState(false)
  const [selectedStyles, setSelectedStyles] = useState<string[]>([])
  const [selectedRounds, setSelectedRounds] = useState<string[]>([])
  const [busyPack, setBusyPack] = useState<string | null>(null)
  const [problem, setProblem] = useState<{ key: string; params?: Record<string, string | number>; tone: 'warning' | 'info' } | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const reading = useRef<AbortController | null>(null)

  const readPage = useCallback(async () => {
    reading.current?.abort()
    const control = new AbortController()
    reading.current = control
    try {
      const value = await fetchSamples(api, control.signal)
      if (control.signal.aborted) return
      setRead({ state: 'ready', value })
      setSelectedStyles((current) => current.filter((id) => value.styles.some((style) => style.id === id)))
      setSelectedRounds((current) => current.filter((id) => value.rounds.some((round) => round.id === id)))
    } catch {
      if (control.signal.aborted) return
      setRead((current) => ({ state: current.value ? 'ready' : 'error', value: current.value }))
    }
  }, [api])
  useEffect(() => {
    void readPage()
    return () => reading.current?.abort()
  }, [readPage])
  useEffect(() => {
    if (read.state !== 'loading') {
      setSlow(false)
      return
    }
    const timer = window.setTimeout(() => setSlow(true), 1000)
    return () => window.clearTimeout(timer)
  }, [read.state])

  // A request asked or answered (its task), a notification: read again in place.
  const live = usePortalLive({
    onChange: (change) => {
      if (change.type.startsWith('partner_task.') || change.type.startsWith('partner_notification.')) void readPage()
    },
    onReconnect: () => void readPage(),
  })
  const [online, setOnline] = useState(true)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  const offline = !online || live === 'offline'
  const openHeld = preview ? { key: 'held.preview' } : offline ? { key: 'held.offline' } : null

  const go = (next: SamplesAddress) => router.replace(`${pathname}${addressQuery(next)}`, { scroll: false })

  // ── the decision dialog ──
  const pictures = useRef<string[]>([])
  const dropPictures = () => {
    for (const url of pictures.current) URL.revokeObjectURL(url)
    pictures.current = []
  }
  const loadPicture = (requestId: string, fileId: string, name: string) => {
    approvalFileBytes(api, fileId)
      .then((bytes) => {
        const page = latestDialog.current?.page
        const type = page?.files.find((file) => file.id === fileId)?.contentType ?? 'image/png'
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
        pictures.current.push(url)
        setDialog((current) => (current?.requestId === requestId ? { ...current, pictures: current.pictures.map((picture) => (picture.id === fileId ? { ...picture, state: 'ready', src: url } : picture)) } : current))
      })
      .catch(() => setDialog((current) => (current?.requestId === requestId ? { ...current, pictures: current.pictures.map((picture) => (picture.id === fileId ? { id: fileId, name, state: 'error', src: null, pdf: false } : picture)) } : current)))
  }
  const latestDialog = useRef<Dialog | null>(null)
  latestDialog.current = dialog
  const openDecision = (requestId: string, queue: readonly string[]) => {
    dropPictures()
    setDialog({ requestId, queue: [...queue], state: 'loading', page: null, decision: null, comment: '', answer: 'idle', problem: null, field: null, pictures: [], pdf: null })
    fetchApproval(api, requestId)
      .then((page) => {
        const shown: DialogFile[] = page.files.filter((file) => isPicture(file.contentType)).map((file) => ({ id: file.id, name: file.originalName, state: 'loading', src: null, pdf: false }))
        setDialog((current) => (current?.requestId === requestId ? { ...current, state: 'ready', page, pictures: shown } : current))
        for (const picture of shown) loadPicture(requestId, picture.id, picture.name)
      })
      .catch((error: unknown) => setDialog((current) => (current?.requestId === requestId ? { ...current, state: isApiError(error) && error.kind === 'not_found' ? 'gone' : 'error' } : current)))
  }
  const waitingQueue = (read.value?.waiting ?? []).map((row) => row.requestId)
  const decide = (requestId: string, queue?: readonly string[]) => {
    const list = queue && queue.length > 0 ? queue : waitingQueue.includes(requestId) ? waitingQueue : [requestId]
    openDecision(requestId, list)
    if (address.decide !== requestId) go({ ...address, decide: requestId })
  }
  // `?decide=` opens the dialog once the page is read (a request no longer waiting says so in the dialog).
  const opened = useRef<string | null>(null)
  useEffect(() => {
    if (!address.decide || read.state !== 'ready' || opened.current === address.decide) return
    opened.current = address.decide
    if (latestDialog.current?.requestId !== address.decide) openDecision(address.decide, waitingQueue.includes(address.decide) ? waitingQueue : [address.decide])
  }, [address.decide, read.state])
  const closeDecision = () => {
    const answered = latestDialog.current?.answer === 'done'
    dropPictures()
    setDialog(null)
    opened.current = null
    go({ ...address, decide: null })
    if (answered) void readPage()
  }
  useEffect(() => () => dropPictures(), [])

  const mayApprove = read.value?.mayApprove ?? false
  const held = (current: Dialog | null) => {
    const reason = decisionHeld({ preview, mayApprove, offline, busy: current?.answer === 'busy', page: current?.page ?? null, admins })
    return reason ? t(reason.key, reason.params) : null
  }
  const sign = (typedName: string) => {
    const current = latestDialog.current
    if (!current?.page || current.answer !== 'idle' || held(current)) return
    const check = answerProblem(current.decision, current.comment)
    if (check) {
      setDialog({ ...current, problem: check.key, field: check.field })
      return
    }
    const page = current.page
    setDialog({ ...current, answer: 'busy', problem: null, field: null })
    answerApproval(api, page.request.id, { decision: current.decision as ApprovalDecision, answer: current.comment.trim() || null, typedName: typedName.trim(), version: page.request.version })
      .then((answered) => {
        setDialog((now) => (now?.requestId === page.request.id ? { ...now, page: answered, answer: 'done' } : now))
        frame.refreshTasks()
        void readPage()
      })
      .catch((error: unknown) => {
        const refusal = answerRefusal(isApiError(error) ? error.kind : null)
        setDialog((now) => (now?.requestId === page.request.id ? { ...now, answer: 'idle', problem: refusal.key, field: null, ...(refusal.gone ? { state: 'gone' as const } : {}) } : now))
        if (refusal.reload) fetchApproval(api, page.request.id).then((fresh) => setDialog((now) => (now?.requestId === page.request.id ? { ...now, page: fresh } : now)), () => undefined)
      })
  }
  const openPdf = (fileId: string | null) => {
    const current = latestDialog.current
    if (!current?.page) return
    if (!fileId) {
      setDialog({ ...current, pdf: null })
      return
    }
    const file = current.page.files.find((entry) => entry.id === fileId)
    if (!file || !isPdf(file.contentType)) return
    setDialog({ ...current, pdf: { id: fileId, name: file.originalName, state: 'loading', src: null, pdf: true } })
    approvalFileBytes(api, fileId)
      .then((bytes) => setDialog((now) => (now?.pdf?.id === fileId ? { ...now, pdf: { ...now.pdf, state: 'ready', src: bytes } } : now)))
      .catch(() => setDialog((now) => (now?.pdf?.id === fileId ? { ...now, pdf: { ...now.pdf, state: 'error' } } : now)))
  }
  const step = (direction: 1 | -1) => {
    const current = latestDialog.current
    if (!current) return
    const queue = current.answer === 'done' ? current.queue.filter((id) => id !== current.requestId) : current.queue
    const next = current.answer === 'done' ? (queue[Math.max(0, current.queue.indexOf(current.requestId))] ?? queue[0] ?? null) : neighbourOf(current.queue, current.requestId, direction)
    if (!next) return
    if (current.answer === 'done') void readPage()
    openDecision(next, queue)
    opened.current = next
    go({ ...address, decide: next })
  }

  // ── tech packs ──
  const openTechPack = (style: StyleRead) => {
    const pack = style.techPack
    if (!pack || openHeld || busyPack) return
    // Opened now, while the click allows a new tab; filled when the bytes are here.
    const tab = window.open('', '_blank')
    setBusyPack(style.id)
    setProblem(null)
    techPackBytes(api, pack.id, 'preview')
      .then(({ name, bytes }) => {
        if (!tab || tab.closed) return saveBytes(name, bytes, 'application/pdf')
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
        tab.location.href = url
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
      })
      .catch((error: unknown) => {
        tab?.close()
        setProblem({ key: isApiError(error) && error.kind === 'not_found' ? 'pack.gone' : 'pack.failed', params: { code: style.code }, tone: 'warning' })
        if (isApiError(error) && error.kind === 'not_found') void readPage()
      })
      .finally(() => setBusyPack(null))
  }
  const downloadPacks = async (styleIds: readonly string[]) => {
    if (openHeld || busyPack) return
    setProblem(null)
    let failed = 0
    for (const id of styleIds) {
      const style = read.value?.styles.find((entry) => entry.id === id)
      if (!style?.techPack) continue
      setBusyPack(style.id)
      try {
        const { name, bytes } = await techPackBytes(api, style.techPack.id, 'download')
        saveBytes(name, bytes, 'application/pdf')
      } catch {
        failed += 1
      }
    }
    setBusyPack(null)
    setProblem(failed > 0 ? { key: 'pack.someFailed', params: { count: failed }, tone: 'warning' } : { key: 'pack.downloaded', params: { count: styleIds.length }, tone: 'info' })
  }

  // ── the band ──
  const waitingCount = read.value?.waiting?.length ?? 0
  usePortalBand({
    ...samplesBandOf({
      t,
      asOf: read.value ? formatTime(read.value.asOf, { locale }) : null,
      waiting: waitingCount,
      onDecideFirst: waitingCount > 0 ? () => decide(waitingQueue[0]!, waitingQueue) : null,
      held: null,
    }),
  })

  const value = read.value
  const styleFilter = address.style ? (value?.styles.find((style) => style.id === address.style) ?? null) : null
  const rounds: RoundRead[] = value ? roundsShown(value.rounds, styleFilter ? styleFilter.id : null) : []
  const row = dialog ? (value?.waiting?.find((entry) => entry.requestId === dialog.requestId) ?? null) : null
  return (
    <SamplesView
      model={{
        state: read.state,
        slow,
        now: Date.now(),
        prefix: frame.prefix,
        waiting: value ? value.waiting : [],
        styles: value?.styles ?? [],
        rounds,
        roundsTotal: value?.rounds.length ?? 0,
        styleFilter: styleFilter ? { id: styleFilter.id, code: styleFilter.code } : null,
        selectedStyles,
        selectedRounds,
        openHeld,
        busyPack,
        admins,
        problem,
        decision: dialog
          ? {
              ...dialog,
              row,
              held: held(dialog),
              position: dialog.queue.length > 1 && dialog.queue.includes(dialog.requestId) ? { index: dialog.queue.indexOf(dialog.requestId) + 1, count: dialog.queue.length } : null,
            }
          : null,
      }}
      actions={{
        onRetry: () => {
          setRead((current) => ({ ...current, state: current.value ? 'ready' : 'loading' }))
          void readPage()
        },
        onDecide: decide,
        onStyle: (style) => go({ ...address, style: address.style === style.id ? null : style.id }),
        onAllRounds: () => go({ ...address, style: null }),
        onTechPack: openTechPack,
        onSelectStyles: setSelectedStyles,
        onSelectRounds: setSelectedRounds,
        onDownloadPacks: (ids) => void downloadPacks(ids),
        onOpenRound: (round) => router.push(`${frame.prefix}/open/SampleRound/${encodeURIComponent(round.id)}`),
        onDismissProblem: () => setProblem(null),
        decision: {
          onClose: closeDecision,
          onRetry: () => dialog && openDecision(dialog.requestId, dialog.queue),
          onDecision: (decision) => setDialog((current) => (current && current.answer === 'idle' ? { ...current, decision, problem: null, field: null } : current)),
          onComment: (comment) => setDialog((current) => (current && current.answer === 'idle' ? { ...current, comment, problem: current.field === 'comment' ? null : current.problem, field: current.field === 'comment' ? null : current.field } : current)),
          onSign: sign,
          onStep: step,
          onOpenPdf: openPdf,
          onRetryPicture: (fileId) => {
            const current = latestDialog.current
            const picture = current?.pictures.find((entry) => entry.id === fileId)
            if (!current || !picture) return
            setDialog({ ...current, pictures: current.pictures.map((entry) => (entry.id === fileId ? { ...entry, state: 'loading' } : entry)) })
            loadPicture(current.requestId, fileId, picture.name)
          },
        },
      }}
    />
  )
}
