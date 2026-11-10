'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { formatTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { useLiveBus } from '../../../../shell/live/use-live'
import {
  addComment,
  addShipment,
  cancelRound,
  decideRound,
  decideSwatch,
  makeWorkOrder,
  moveRound,
  nextRound,
  raiseChangeRequest,
  readApproval,
  readFit,
  readRound,
  readStyle,
  recordTestResult,
  removeComment,
  removeShipment,
  saveFit,
  sendSwatch,
  updateComment,
  updateRound,
  updateShipment,
  workOrderOptions,
  type ApprovalView,
  type FitCell,
  type FitView,
  type RoundView,
  type StyleDetail,
} from '../api'
import { approvalHeld, fieldOfPath, panelOf, readProblem, recordHref, recordTabOf, requestChanges, requestDraftOf, samplesCan, todayOf, writeProblem, type ManualStage, type Notice, type Phrase, type RequestDraft } from '../model'
import type { DecideModel } from '../view/DecideDialog'
import type { CellState, FitState, Loaded, Part, RecordDialog, SampleRecordModel } from './view-model'
import { SampleRecordView } from './view/SampleRecordView'
import { workOrderFacts } from './view/RecordDialogs'
import { swatchHeld } from './view/ApprovalTab'

const LIVE_TYPES = ['sample_round.', 'sample_shipment.', 'sample_swatch.'] as const
const EMPTY_COMMENT: FitState['comment'] = { pointOfMeasureId: '', bodyArea: '', text: '', busy: false, notice: null }

/**
 * `/w/<company>/products/samples/<round>?tab=request|sample|fit|approval|shipments|activity&panel=` (the round's record,
 * also opened in a new tab by ⌘-click on a card). It reads the round, then each tab's part on its own (the style for the
 * Request's grid, the Approval, the Fit) and does what the view asks — every write with the version read and one
 * Idempotency-Key per attempt. Live `sample_round.*` of this round read it again (while the Request holds unsaved work:
 * the "changed elsewhere" banner instead).
 */
export function SampleRecord({ roundId }: { roundId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const params = useSearchParams()
  const locale = useLocale()
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = useMemo(() => samplesCan(session.permissions), [session.permissions])
  const tab = recordTabOf(params)
  const panel = panelOf(params)
  const [opened] = useState(() => new Date().toISOString())
  const today = todayOf(opened)

  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [asOf, setAsOf] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [lines, setLines] = useState<readonly Phrase[]>([])
  const [busy, setBusy] = useState(false)
  const [stale, setStale] = useState<string | null>(null)
  const round = loaded.status === 'ready' ? loaded.round : null
  const roundRef = useRef<RoundView | null>(null)
  roundRef.current = round

  const say = useCallback((phrase: Phrase, tone: Notice['tone'], places: readonly Phrase[] = []) => {
    setNotice({ ...phrase, tone })
    setLines(places)
  }, [])
  const refused = useCallback(
    (error: unknown) => {
      const problem = writeProblem(error)
      say(problem, 'danger', [...new Set(problem.paths.map(fieldOfPath))].map((key) => ({ key })))
      return problem
    },
    [say],
  )

  const load = useCallback(async () => {
    if (!can.view) return
    try {
      const value = await readRound(api, roundId)
      setLoaded({ status: 'ready', round: value })
      setAsOf(new Date().toISOString())
      setStale(null)
    } catch (error) {
      const kind = isApiError(error) ? error.kind : null
      setLoaded(kind === 'not_found' ? { status: 'notFound' } : kind === 'forbidden' ? { status: 'forbidden' } : { status: 'error', problem: readProblem(error) })
    }
  }, [api, can.view, roundId])
  useEffect(() => {
    setLoaded({ status: 'loading' })
    void load()
  }, [load])

  // ---- the Request: the draft and the style's colourways, sizes and revisions ------------------------------------------------------
  const [draft, setDraft] = useState<RequestDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [style, setStyle] = useState<Part<StyleDetail>>({ value: null, problem: null })
  const styleId = round?.style.id ?? null
  useEffect(() => {
    if (!styleId || !can.styles || !can.manage) return
    const controller = new AbortController()
    readStyle(api, styleId, controller.signal)
      .then((value) => setStyle({ value, problem: null }))
      .catch((error: unknown) => !controller.signal.aborted && setStyle({ value: null, problem: readProblem(error) }))
    return () => controller.abort()
  }, [api, styleId, can.styles, can.manage])
  const saveRequest = useCallback(async () => {
    const now = roundRef.current
    if (!now || !draft || saving) return
    const changes = requestChanges(now, draft, can)
    if (!changes.body) return
    setSaving(true)
    try {
      const value = await updateRound(api, now.id, changes.body)
      setLoaded({ status: 'ready', round: value })
      setDraft(null)
      setStale(null)
      say({ key: 'request.saved' }, 'success')
    } catch (error) {
      const problem = refused(error)
      if (problem.stale) setStale(formatTime(new Date().toISOString(), { locale }))
    } finally {
      setSaving(false)
    }
  }, [api, draft, saving, can, say, refused, locale])

  // ---- the Approval (read with the record: "Decide…" in the band needs it) -------------------------------------------------------
  const [approval, setApproval] = useState<Part<ApprovalView>>({ value: null, problem: null })
  const readApprovalNow = useCallback(async () => {
    if (!can.view) return
    try {
      setApproval({ value: await readApproval(api, roundId), problem: null })
    } catch (error) {
      setApproval({ value: null, problem: readProblem(error) })
    }
  }, [api, can.view, roundId])
  useEffect(() => {
    void readApprovalNow()
  }, [readApprovalNow])

  // ---- the Fit (read while its tab is open) -------------------------------------------------------------------------------------
  const [fit, setFit] = useState<FitState>({ part: { value: null, problem: null }, cells: {}, savedAt: null, failed: null, comment: EMPTY_COMMENT, working: null })
  const fitRef = useRef<FitView | null>(null)
  fitRef.current = fit.part.value
  const readFitNow = useCallback(async () => {
    try {
      const value = await readFit(api, roundId)
      setFit((now) => ({ ...now, part: { value, problem: null } }))
    } catch (error) {
      setFit((now) => ({ ...now, part: { value: now.part.value, problem: readProblem(error) } }))
    }
  }, [api, roundId])
  useEffect(() => {
    if (tab === 'fit' && can.view) void readFitNow()
  }, [tab, can.view, readFitNow])
  // A typed cell or a pasted column: gathered for one tick, then ONE save with each cell's version as read.
  const pending = useRef<Map<string, FitCell>>(new Map())
  const flush = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sendFit = useCallback(async () => {
    flush.current = null
    const cells = [...pending.current.values()]
    pending.current.clear()
    if (cells.length === 0) return
    const keys = cells.map((cell) => `${cell.pointOfMeasureId}/${cell.size}`)
    const mark = (state: CellState) => setFit((now) => ({ ...now, cells: { ...now.cells, ...Object.fromEntries(keys.map((key) => [key, state])) } }))
    mark('saving')
    try {
      const value = await saveFit(api, roundId, cells)
      setFit((now) => ({ ...now, part: { value, problem: null }, cells: { ...now.cells, ...Object.fromEntries(keys.map((key) => [key, 'saved' as const])) }, savedAt: new Date().toISOString(), failed: null }))
    } catch (error) {
      const problem = writeProblem(error)
      setFit((now) => ({ ...now, cells: { ...now.cells, ...Object.fromEntries(keys.map((key) => [key, 'failed' as const])) }, failed: problem }))
      if (problem.stale) void readFitNow()
    }
  }, [api, roundId, readFitNow])
  const onFitCell = useCallback(
    (pointOfMeasureId: string, size: string, measured: string | null) => {
      const view = fitRef.current
      const cell = view?.points.find((point) => point.pointOfMeasureId === pointOfMeasureId)?.cells.find((one) => one.size === size)
      const version = cell?.measurement?.version
      if (measured === null && !cell?.measurement) return
      pending.current.set(`${pointOfMeasureId}/${size}`, { pointOfMeasureId, size, measured, ...(version ? { version } : {}) })
      if (!flush.current) flush.current = setTimeout(() => void sendFit(), 0)
    },
    [sendFit],
  )
  useEffect(() => () => void (flush.current && clearTimeout(flush.current)), [])

  // ---- live -------------------------------------------------------------------------------------------------------------------
  const live = useLiveBus(
    {
      onChange: (change) => {
        if (!LIVE_TYPES.some((type) => change.type.startsWith(type))) return
        const fields = change.fields as Record<string, unknown>
        if (fields.sampleRoundId !== roundId && fields.roundId !== roundId) return
        if (draft) setStale(formatTime(new Date().toISOString(), { locale }))
        else void load()
        void readApprovalNow()
        if (tab === 'fit' && change.type === 'sample_round.fit_changed') void readFitNow()
      },
      onReconnect: () => {
        void load()
        void readApprovalNow()
      },
    },
    can.view,
  )
  const offline = live === 'offline'

  // ---- Decide on the sample (the round or a swatch) ------------------------------------------------------------------------------
  const [decide, setDecide] = useState<DecideModel | null>(null)
  const decideKey = useRef<string | null>(null)
  const decideVersion = useRef<number | null>(null)
  const openDecide = useCallback(() => {
    const now = roundRef.current
    if (!now) return
    decideKey.current = null
    const view = approval.value
    decideVersion.current = view?.round.version ?? null
    setDecide({
      subject: 'round',
      id: now.id,
      name: { key: 'decide.subject', params: { number: now.number, kind: `kind.${now.kind}`, n: now.roundNo } },
      revision: view?.round.revision.revision ?? now.revision.revision,
      blocked: view ? approvalHeld(view, 'decide', false) : null,
      reading: !view,
      problem: view ? null : approval.problem,
      draft: { decision: null, comments: '' },
      busy: false,
      notice: null,
      offline,
    })
    if (!view)
      readApproval(api, now.id)
        .then((value) => {
          setApproval({ value, problem: null })
          decideVersion.current = value.round.version
          setDecide((model) => (model ? { ...model, reading: false, problem: null, blocked: approvalHeld(value, 'decide', false) } : model))
        })
        .catch((error: unknown) => setDecide((model) => (model ? { ...model, reading: false, problem: readProblem(error) } : model)))
  }, [api, approval, offline])
  const swatchVersion = useRef<number | null>(null)
  const submitDecide = useCallback(async () => {
    if (!decide || decide.busy || !decide.draft.decision) return
    setDecide({ ...decide, busy: true, notice: null })
    decideKey.current ??= newIdempotencyKey()
    const comments = decide.draft.comments.trim()
    try {
      if (decide.subject === 'round') {
        const version = decideVersion.current ?? roundRef.current?.version ?? 1
        const value = await decideRound(api, decide.id, { version, decision: decide.draft.decision, ...(comments ? { comments } : {}) }, decideKey.current)
        setApproval({ value, problem: null })
        say({ key: 'decide.done', params: { number: value.round.number, decision: `decision.${decide.draft.decision}` } }, 'success')
        void load()
      } else {
        await decideSwatch(api, { id: decide.id, version: swatchVersion.current ?? 1 }, { decision: decide.draft.decision, ...(comments ? { comments } : {}) }, decideKey.current)
        say({ key: 'approval.swatchDecided', params: { decision: `decision.${decide.draft.decision}` } }, 'success')
        void readApprovalNow()
      }
      decideKey.current = null
      setDecide(null)
    } catch (error) {
      decideKey.current = null
      const problem = writeProblem(error)
      setDecide((now) => (now ? { ...now, busy: false, notice: { ...problem, tone: 'danger' } } : now))
      if (problem.stale) void readApprovalNow()
    }
  }, [decide, api, say, load, readApprovalNow])

  // ---- dialogs ----------------------------------------------------------------------------------------------------------------
  const [dialog, setDialog] = useState<RecordDialog | null>(null)
  const dialogKey = useRef<string | null>(null)
  const openDialog = useCallback(
    (next: RecordDialog | null) => {
      dialogKey.current = null
      setDialog(next)
      if (next?.kind === 'workOrder' && !next.options) {
        workOrderOptions(api, roundId)
          .then((options) => {
            const lineIds = options.lines.filter((line) => line.proposed.length > 0).map((line) => line.id)
            const site = options.lines.find((line) => line.siteId && options.sites.some((one) => one.id === line.siteId))?.siteId ?? options.sites[0]?.id ?? ''
            setDialog((now) => (now?.kind === 'workOrder' ? { ...now, options, lineIds, siteId: site, dueDate: now.dueDate || (roundRef.current?.dueDate ?? '') } : now))
          })
          .catch((error: unknown) => setDialog((now) => (now?.kind === 'workOrder' ? { ...now, problem: readProblem(error) } : now)))
      }
    },
    [api, roundId],
  )
  const submitDialog = useCallback(async () => {
    const now = roundRef.current
    if (!dialog || dialog.busy || !now) return
    setDialog({ ...dialog, busy: true, notice: null } as RecordDialog)
    dialogKey.current ??= newIdempotencyKey()
    const fail = (error: unknown) => {
      dialogKey.current = null
      const problem = writeProblem(error)
      setDialog((open) => (open ? ({ ...open, busy: false, notice: { ...problem, tone: 'danger' }, ...(open.kind === 'shipment' ? { lines: [...new Set(problem.paths.map(fieldOfPath))].map((key) => ({ key })) } : {}) } as RecordDialog) : open))
      if (problem.stale) void load()
    }
    try {
      switch (dialog.kind) {
        case 'cancel': {
          const value = await cancelRound(api, now.id, { version: now.version, reason: dialog.reason.trim() }, dialogKey.current)
          setLoaded({ status: 'ready', round: value })
          setDialog(null)
          say({ key: 'cancel.done', params: { number: value.number } }, 'success')
          void readApprovalNow()
          break
        }
        case 'nextRound': {
          const value = await nextRound(api, now.id, { version: approval.value?.round.version ?? now.version, ...(dialog.dueDate ? { dueDate: dialog.dueDate } : {}), ...(dialog.instructions.trim() ? { instructions: dialog.instructions.trim() } : {}) }, dialogKey.current)
          setDialog(null)
          router.push(recordHref(prefix, value.id))
          break
        }
        case 'change': {
          await raiseChangeRequest(api, { styleId: now.style.id, sampleRoundId: now.id, revisionId: now.revision.id, title: dialog.title.trim(), reason: dialog.reason.trim() }, dialogKey.current)
          setDialog(null)
          say({ key: 'change.done' }, 'success')
          void readApprovalNow()
          break
        }
        case 'testResult': {
          if (!dialog.result) break
          const value = await recordTestResult(api, now.id, { version: approval.value?.round.version ?? now.version, testResult: dialog.result }, dialogKey.current)
          setApproval({ value, problem: null })
          setDialog(null)
          say({ key: 'test.done', params: { result: `test.${dialog.result}` } }, 'success')
          void load()
          break
        }
        case 'shipment': {
          const body = {
            direction: dialog.direction,
            ...(dialog.carrierName.trim() ? { carrierName: dialog.carrierName.trim() } : {}),
            ...(dialog.trackingNumber.trim() ? { trackingNumber: dialog.trackingNumber.trim() } : {}),
            ...(dialog.trackingUrl.trim() ? { trackingUrl: dialog.trackingUrl.trim() } : {}),
            ...(dialog.note.trim() ? { note: dialog.note.trim() } : {}),
          }
          const value = await addShipment(api, now.id, body, dialogKey.current)
          setLoaded({ status: 'ready', round: value.round })
          setDialog(null)
          say({ key: 'ship.added' }, 'success')
          break
        }
        case 'workOrder': {
          if (!dialog.options || workOrderFacts(dialog.options, dialog.lineIds).blockers.length > 0) break
          const made = await makeWorkOrder(
            api,
            now.id,
            { version: now.version, siteId: dialog.siteId, ...(dialog.dueDate ? { dueDate: dialog.dueDate } : {}), lines: dialog.lineIds.map((salesOrderLineId) => ({ salesOrderLineId })) },
            dialogKey.current,
          )
          setLoaded({ status: 'ready', round: made.round })
          setDialog((open) => (open?.kind === 'workOrder' ? { ...open, busy: false, made: { id: made.workOrder.id, number: made.workOrder.number } } : open))
          break
        }
      }
      dialogKey.current = null
    } catch (error) {
      fail(error)
    }
  }, [dialog, api, approval.value, say, load, readApprovalNow, router, prefix])

  // ---- shipments: a cell, sent / received now, remove -----------------------------------------------------------------------------
  const [shipmentCells, setShipmentCells] = useState<Record<string, CellState>>({})
  const patchShipment = useCallback(
    async (shipmentId: string, field: string, body: Record<string, unknown>) => {
      const now = roundRef.current
      const shipment = now?.shipmentsList.find((one) => one.id === shipmentId)
      if (!now || !shipment) return
      setShipmentCells((cells) => ({ ...cells, [`${shipmentId}/${field}`]: 'saving' }))
      try {
        const value = await updateShipment(api, shipmentId, { version: shipment.version, ...body })
        setLoaded({ status: 'ready', round: value.round })
        setShipmentCells((cells) => ({ ...cells, [`${shipmentId}/${field}`]: 'saved' }))
      } catch (error) {
        setShipmentCells((cells) => ({ ...cells, [`${shipmentId}/${field}`]: 'failed' }))
        const problem = refused(error)
        if (problem.stale) void load()
      }
    },
    [api, refused, load],
  )

  // ---- the model ----------------------------------------------------------------------------------------------------------------
  const model: SampleRecordModel = {
    prefix,
    me: session.user.id,
    today,
    can,
    tab,
    panel,
    loaded,
    asOf,
    live,
    stale,
    notice,
    lines,
    busy,
    request: { draft, style, saving },
    fit,
    approval,
    shipmentCells,
    decide: decide ? { ...decide, offline } : null,
    dialog,
  }

  const panels =
    round && tab === 'activity' && can.thread ? (
      <RecordPanels record={{ type: 'SampleRound', id: round.id, companyId: round.companyId, siteId: null }} title={`${round.number} · ${round.style.code}`} party={round.party ? { id: round.party.id, name: round.party.name, emails: [] } : null} tab={panel ?? undefined} />
    ) : null

  return (
    <SampleRecordView
      model={model}
      panels={panels}
      actions={{
        onRetry: () => {
          setLoaded({ status: 'loading' })
          void load()
        },
        onReload: () => {
          setDraft(null)
          void load()
        },
        onDismissNotice: () => {
          setNotice(null)
          setLines([])
        },
        onMove: (to: ManualStage) => {
          const now = roundRef.current
          if (!now) return
          setBusy(true)
          moveRound(api, now.id, { version: now.version, to })
            .then((value) => {
              setLoaded({ status: 'ready', round: value })
              say({ key: 'board.moved', params: { number: value.number, stage: `stage.${value.stage}` } }, 'success')
            })
            .catch((error: unknown) => {
              if (refused(error).stale) void load()
            })
            .finally(() => setBusy(false))
        },
        onRequestDraft: (patch) => round && setDraft((now) => ({ ...(now ?? requestDraftOf(round, locale)), ...patch })),
        onRequestGrid: (grid) => round && setDraft((now) => ({ ...(now ?? requestDraftOf(round, locale)), grid })),
        onRequestDiscard: () => setDraft(null),
        onRequestSave: () => void saveRequest(),
        onMakeWorkOrder: () => openDialog({ kind: 'workOrder', options: null, problem: null, lineIds: [], siteId: '', dueDate: '', busy: false, notice: null, made: null }),
        onFitCell,
        onFitRefused: (size, text) => setFit((now) => ({ ...now, failed: { key: 'fit.notNumber', params: { size, text } } })),
        onFitRetry: () => void readFitNow(),
        onComment: (patch) => setFit((now) => ({ ...now, comment: { ...now.comment, ...patch } })),
        onCommentAdd: () => {
          const comment = fit.comment
          if (!comment.text.trim() || comment.busy) return
          setFit((now) => ({ ...now, comment: { ...now.comment, busy: true, notice: null } }))
          addComment(api, roundId, { ...(comment.pointOfMeasureId ? { pointOfMeasureId: comment.pointOfMeasureId } : {}), ...(comment.bodyArea.trim() ? { bodyArea: comment.bodyArea.trim() } : {}), text: comment.text.trim() })
            .then(() => {
              setFit((now) => ({ ...now, comment: { ...EMPTY_COMMENT, notice: { key: 'fit.comment.added', tone: 'success' } } }))
              void readFitNow()
            })
            .catch((error: unknown) => setFit((now) => ({ ...now, comment: { ...now.comment, busy: false, notice: { ...writeProblem(error), tone: 'danger' } } })))
        },
        onCommentResolve: (commentId, resolved) => {
          const comment = fit.part.value?.comments.find((one) => one.id === commentId)
          if (!comment) return
          setFit((now) => ({ ...now, working: commentId }))
          updateComment(api, comment, { resolved })
            .then(() => readFitNow())
            .catch((error: unknown) => setFit((now) => ({ ...now, failed: writeProblem(error) })))
            .finally(() => setFit((now) => ({ ...now, working: null })))
        },
        onCommentRemove: (commentId) => {
          const comment = fit.part.value?.comments.find((one) => one.id === commentId)
          if (!comment) return
          setFit((now) => ({ ...now, working: commentId }))
          removeComment(api, comment)
            .then(() => readFitNow())
            .catch((error: unknown) => setFit((now) => ({ ...now, failed: writeProblem(error) })))
            .finally(() => setFit((now) => ({ ...now, working: null })))
        },
        onApprovalRetry: () => void readApprovalNow(),
        onDecide: openDecide,
        onSwatchSend: (swatch) => {
          sendSwatch(api, swatch, new Date().toISOString())
            .then(() => {
              say({ key: 'approval.swatchSent' }, 'success')
              void readApprovalNow()
            })
            .catch((error: unknown) => refused(error))
        },
        onSwatchDecide: (swatch) => {
          decideKey.current = null
          swatchVersion.current = swatch.version
          setDecide({
            subject: 'swatch',
            id: swatch.id,
            name: { key: 'decide.swatchName', params: { item: `${swatch.item.code} · ${swatch.item.name}`, colour: swatch.itemColour?.name ?? swatch.lot?.code ?? '—' } },
            revision: null,
            blocked: swatchHeld(swatch, 'decide', false),
            reading: false,
            problem: null,
            draft: { decision: null, comments: '' },
            busy: false,
            notice: null,
            offline,
          })
        },
        decide: {
          onDraft: (patch) => setDecide((now) => (now ? { ...now, draft: { ...now.draft, ...patch } } : now)),
          onSubmit: () => void submitDecide(),
          onClose: () => setDecide(null),
          onRetry: () => {
            setDecide(null)
            openDecide()
          },
        },
        onShipmentCell: (shipmentId, field, value) => void patchShipment(shipmentId, field, { [field]: value }),
        onShipmentMark: (shipmentId, field) => void patchShipment(shipmentId, field, { [field]: new Date().toISOString() }),
        onShipmentRemove: (shipmentId) => {
          const shipment = roundRef.current?.shipmentsList.find((one) => one.id === shipmentId)
          if (!shipment) return
          removeShipment(api, shipmentId, shipment.version)
            .then((value) => {
              setLoaded({ status: 'ready', round: value })
              say({ key: 'ship.removed' }, 'success')
            })
            .catch((error: unknown) => refused(error))
        },
        onDialog: openDialog,
        onDialogPatch: (patch) => setDialog((now) => (now ? ({ ...now, ...patch } as RecordDialog) : now)),
        onDialogSubmit: () => void submitDialog(),
        onCopy: () => {
          if (!round) return
          void navigator.clipboard
            ?.writeText(round.number)
            .then(() => say({ key: 'record.copied', params: { number: round.number } }, 'success'))
            .catch(() => undefined)
        },
      }}
    />
  )
}

