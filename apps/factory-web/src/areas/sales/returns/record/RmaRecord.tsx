'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { companyPrefix } from '../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { liveMatches, useLive, useRecordTab } from '../../../quality/_shared/hooks'
import { problemKey } from '../../../quality/_shared/model'
import { RecordProblem, RecordSkeleton } from '../../../quality/_shared/parts'
import {
  addReturnLines,
  cancelReturn,
  changeReturnLine,
  closeReturn,
  createRepair,
  decideReturn,
  getReturn,
  gradeReturn,
  issueSourceDdt,
  listPeople,
  listRepairs,
  listReturnable,
  listReturnReasons,
  makeReplacementOrder,
  previewDecisions,
  previewRepair,
  previewSourceDdt,
  receiveReturn,
  removeReturnLine,
  returnCreditNotes,
  type CreditNotes,
  type Person,
  type ReasonOption,
  type RepairRow,
  type Rma,
} from '../api'
import {
  addLinesBody,
  addLinesProblems,
  BLANK_REPAIR,
  closeReasonText,
  ddtBody,
  decisionLinesOf,
  garmentOf,
  newRepairBody,
  receiptBody,
  refusalOf,
  repairHref,
  returnHref,
  returnsCan,
  romeToday,
  takenOf,
  type DecisionDraft,
  type Words,
} from '../model'
import { RMA_TABS, type AddLinesModel, type CloseModel, type NewRepairModel, type RmaDialog, type RmaModel } from '../view-model'
import { ReturnsMessages, useWords } from '../view/parts'
import { RmaRecordView } from './view/RmaRecordView'

/**
 * A return's container (`/w/<company>/sales/returns/<id>?tab=…`, SCR-112): reads the RMA (its steps answered by the API,
 * held in our words), the return reasons, the office people, its credit notes (invoices.view) and the repairs of its
 * lines (sales.repairs.view); runs ONE write at a time with the version read (a stale one reads the RMA again and says
 * so); a line's cell edits queue so each carries the previous answer's version. Live return events of this RMA read it
 * again, or, while a dialog is open, say it changed with Reload. `?do=receive` opens Receive goods; `?created=1` says the
 * RMA was made. The thread dock (O1) and Activity mount the record panels.
 */
export function RmaRecord({ returnId }: { returnId: string }) {
  return (
    <ReturnsMessages>
      <Container returnId={returnId} />
    </ReturnsMessages>
  )
}

const WIDE = '(min-width: 1280px)'
const DOCK_KEY = 'fw.returns.dock'

function Container({ returnId }: { returnId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const t = useWords()
  const can = useMemo(() => returnsCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const tab = useRecordTab(RMA_TABS)
  const today = romeToday()
  const [offline, setOffline] = useState(false)
  useEffect(() => {
    const update = () => setOffline(typeof navigator !== 'undefined' && navigator.onLine === false)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  const [rma, setRma] = useState<Rma | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [changedAt, setChangedAt] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<RmaModel['receipt']>(null)
  const [people, setPeople] = useState<Person[]>([])
  const [reasons, setReasons] = useState<ReasonOption[] | null>(null)
  const [marks, setMarks] = useState<RmaModel['marks']>({})
  const [decisions, setDecisions] = useState<Record<string, DecisionDraft>>({})
  const [decisionPreview, setDecisionPreview] = useState<RmaModel['decisionPreview']>(null)
  const [decisionPreviewing, setDecisionPreviewing] = useState(false)
  const [credit, setCredit] = useState<{ value: CreditNotes | null; problem: string | null }>({ value: null, problem: null })
  const [repairs, setRepairs] = useState<{ items: RepairRow[] | null; problem: string | null }>({ items: null, problem: null })
  const [dialog, setDialog] = useState<RmaDialog | null>(null)
  const [dialogBusy, setDialogBusy] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<Words | null>(null)
  const [close, setClose] = useState<CloseModel | null>(null)
  const [newRepair, setNewRepair] = useState<NewRepairModel | null>(null)
  const [addLines, setAddLines] = useState<AddLinesModel | null>(null)
  const [dockOpen, setDockOpen] = useState(false)
  const latest = useRef<Rma | null>(null)
  latest.current = rma
  const quiet = useRef(false)
  quiet.current = dialog !== null || close !== null || newRepair !== null || addLines !== null
  const dialogKey = useRef<string>(newIdempotencyKey())
  // A row's cell edits wait for each other, so each carries the version the previous answer gave.
  const chain = useRef<Promise<unknown>>(Promise.resolve())

  const load = useCallback(async () => {
    try {
      const next = await getReturn(api, returnId)
      setRma(next)
      setProblem(null)
      setAsOf(new Date().toISOString())
      setChangedAt(null)
      return next
    } catch (error) {
      setProblem(problemKey(error))
      return null
    }
  }, [api, returnId])

  const loadCredit = useCallback(async () => {
    if (!can.invoicesView) return
    try {
      setCredit({ value: await returnCreditNotes(api, returnId), problem: null })
    } catch (error) {
      setCredit({ value: null, problem: `quality:${problemKey(error)}` })
    }
  }, [api, can.invoicesView, returnId])

  const loadRepairs = useCallback(async () => {
    if (!can.repairsView) return
    try {
      const answer = await listRepairs(api, { view: 'all', returnId })
      setRepairs({ items: answer.repairs, problem: null })
      setPeople((current) => [...current, ...answer.people.filter((person) => !current.some((known) => known.id === person.id))])
    } catch (error) {
      setRepairs({ items: null, problem: `quality:${problemKey(error)}` })
    }
  }, [api, can.repairsView, returnId])

  useEffect(() => {
    void load()
    void loadCredit()
    void loadRepairs()
  }, [load, loadCredit, loadRepairs])
  useEffect(() => {
    listReturnReasons(api)
      .then(setReasons)
      .catch(() => setReasons(null))
    if (can.people)
      listPeople(api)
        .then((list) => setPeople((current) => [...list, ...current.filter((person) => !list.some((known) => known.id === person.id))]))
        .catch(() => undefined)
  }, [api, can.people])
  useEffect(() => {
    try {
      setDockOpen(window.localStorage.getItem(DOCK_KEY) === '1' && window.matchMedia(WIDE).matches)
    } catch {
      setDockOpen(false)
    }
  }, [])

  const live = useLive(
    (change) => {
      if (!liveMatches(change, ['return.', 'invoice.return_credit_drafted', 'invoice.sdi_status_changed', 'repair.'])) return
      if (change.type.startsWith('return.') && change.fields.returnId !== returnId) return
      if (change.type.startsWith('invoice.')) return void loadCredit()
      if (change.type.startsWith('repair.')) return void loadRepairs()
      if (quiet.current) setChangedAt(new Date().toISOString())
      else void load()
    },
    () => void load(),
  )

  // `?created=1` says the RMA was made; `?do=receive` opens Receive goods once the RMA is read. Then the address forgets them.
  const askedDo = params?.get('do') ?? null
  const created = params?.get('created') === '1'
  useEffect(() => {
    if (!rma || (!askedDo && !created)) return
    if (created) setReceipt({ tone: 'success', words: { key: 'done.created', params: { number: rma.number } } })
    if (askedDo === 'receive') openDialog({ kind: 'receive', draft: { parcels: '1', condition: 'INTACT', carrierName: '', trackingNumber: '', ddtNumber: '', ddtDate: '', note: '', lines: Object.fromEntries(rma.lines.filter((line) => line.grade === null && line.receivedQuantity < line.quantity).map((line) => [line.id, String(line.quantity - line.receivedQuantity)])) } })
    router.replace(`${pathname}${tab === 'lines' ? '' : `?tab=${tab}`}`, { scroll: false })
    // Once, when the record arrives.
  }, [rma?.id, askedDo, created])

  const openDialog = (next: RmaDialog | null) => {
    if (next && (dialog === null || dialog.kind !== next.kind)) {
      dialogKey.current = newIdempotencyKey()
      setDialogProblem(null)
    }
    setDialog(next)
  }

  // The decision preview while the drafts change (debounced): the effect in words and the held outcomes.
  const decisionsKey = JSON.stringify(decisions)
  useEffect(() => {
    const current = latest.current
    if (!current || !can.decide) return
    const lines = decisionLinesOf(decisions, current.lines.filter((line) => line.disposition === null), can.price)
    if (lines.length === 0) {
      setDecisionPreview(null)
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setDecisionPreviewing(true)
      previewDecisions(api, current, lines, controller.signal)
        .then((preview) => setDecisionPreview(preview))
        .catch(() => setDecisionPreview(null))
        .finally(() => setDecisionPreviewing(false))
    }, 300)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [api, can.decide, can.price, decisionsKey, rma?.version])

  // The DDT preview of unchanged goods going back (debounced).
  const ddtKey = dialog?.kind === 'ddt' ? JSON.stringify(dialog.draft) : ''
  useEffect(() => {
    const current = latest.current
    if (!ddtKey || !current || dialog?.kind !== 'ddt') return
    const draft = dialog.draft
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setDialog((open) => (open?.kind === 'ddt' ? { ...open, previewing: true } : open))
      previewSourceDdt(api, 'ReturnAuthorisation', current, ddtBody(draft, 'RETURN'), controller.signal)
        .then((preview) => setDialog((open) => (open?.kind === 'ddt' ? { ...open, preview, previewing: false } : open)))
        .catch(() => setDialog((open) => (open?.kind === 'ddt' ? { ...open, previewing: false } : open)))
    }, 400)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [api, ddtKey])

  const after = async (words: Words, href?: string) => {
    setReceipt({ tone: 'success', words, ...(href ? { href } : {}) })
    await load()
  }

  // ---- the lines' cells (autosaved) ----------------------------------------------------------------------------------------
  const saveCell = (lineId: string, field: 'quantity' | 'reasonCode', patch: Parameters<typeof changeReturnLine>[3]) => {
    setMarks((current) => ({ ...current, [`${lineId}:${field}`]: { state: 'saving' } }))
    chain.current = chain.current.then(async () => {
      const current = latest.current
      if (!current) return
      try {
        const next = await changeReturnLine(api, current, lineId, patch)
        latest.current = next
        setRma(next)
        setMarks((marks) => ({ ...marks, [`${lineId}:${field}`]: { state: 'saved' } }))
      } catch (error) {
        setMarks((marks) => ({ ...marks, [`${lineId}:${field}`]: { state: 'refused', words: refusalOf(error) } }))
        await load()
      }
    })
  }

  // ---- the dialogs' writes -------------------------------------------------------------------------------------------------
  const submitDialog = async () => {
    const current = latest.current
    if (!current || !dialog || dialogBusy) return
    setDialogBusy(true)
    setDialogProblem(null)
    try {
      switch (dialog.kind) {
        case 'receive':
          await receiveReturn(api, current, receiptBody(dialog.draft), dialogKey.current)
          setDialog(null)
          await after({ key: 'done.received', params: { number: current.number } })
          break
        case 'grade':
          await gradeReturn(
            api,
            current,
            dialog.lineIds.map((lineId) => ({ lineId, grade: dialog.grade as never, cause: (dialog.cause || null) as never, conditionNote: dialog.note.trim() || null })),
          )
          setDialog(null)
          await after({ key: 'done.graded', params: { count: dialog.lineIds.length } })
          break
        case 'replacement': {
          const answer = await makeReplacementOrder(api, current, { internalNote: dialog.note.trim() || null }, dialogKey.current)
          setDialog(null)
          await after({ key: 'done.replacement', params: { number: answer.order.number } }, `${prefix}/sales/orders/${encodeURIComponent(answer.order.id)}`)
          break
        }
        case 'ddt': {
          const answer = await issueSourceDdt(api, 'ReturnAuthorisation', current, ddtBody(dialog.draft, 'RETURN'), dialogKey.current)
          setDialog(null)
          await after({ key: 'done.ddt', params: { number: answer.ddt.number } })
          break
        }
        case 'cancel':
          await cancelReturn(api, current, dialog.reason.trim())
          setDialog(null)
          await after({ key: 'done.cancelled', params: { number: current.number } })
          break
        case 'decide':
          break
      }
    } catch (error) {
      setDialogProblem(refusalOf(error))
      void load()
    } finally {
      setDialogBusy(false)
    }
  }

  const decide = async (lineIds: readonly string[]) => {
    const current = latest.current
    if (!current || dialogBusy) return
    const lines = decisionLinesOf(
      Object.fromEntries(Object.entries(decisions).filter(([id]) => lineIds.includes(id))),
      current.lines,
      can.price,
    )
    if (lines.length === 0) return
    setDialogBusy(true)
    setDialogProblem(null)
    try {
      const next = await decideReturn(api, current, lines, newIdempotencyKey())
      setRma(next)
      setDecisions((drafts) => Object.fromEntries(Object.entries(drafts).filter(([id]) => !lineIds.includes(id))))
      setDecisionPreview(null)
      setReceipt({ tone: 'success', words: { key: 'done.decided', params: { count: lines.length } } })
      void loadCredit()
    } catch (error) {
      setDialogProblem(refusalOf(error))
      void load()
    } finally {
      setDialogBusy(false)
    }
  }

  // ---- Make repair order from a line decided Repair (the New repair dialog with the line) -----------------------------------
  const repairKey = useRef<string>(newIdempotencyKey())
  const openRepair = async (lineId: string) => {
    const current = latest.current
    const line = current?.lines.find((entry) => entry.id === lineId)
    if (!current || !line) return
    repairKey.current = newIdempotencyKey()
    const draft = { ...BLANK_REPAIR, returnLineId: lineId }
    const model: NewRepairModel = { draft, fromLine: { returnNumber: current.number, seq: line.seq, garment: garmentOf(line) }, customers: { items: [], problem: null }, preview: null, previewing: true, showProblems: true, busy: false, problem: null, today }
    setNewRepair(model)
    const preview = await previewRepair(api, newRepairBody(draft, current.companyId)).catch(() => null)
    setNewRepair((open) => (open ? { ...open, preview, previewing: false } : open))
  }
  // The preview again while the dialog's words change (debounced): its problems stay true to what would be sent.
  const repairDraftKey = newRepair ? JSON.stringify(newRepair.draft) : ''
  useEffect(() => {
    const rmaNow = latest.current
    if (!repairDraftKey || !rmaNow || !newRepair) return
    const body = newRepairBody(newRepair.draft, rmaNow.companyId)
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      previewRepair(api, body, controller.signal)
        .then((preview) => setNewRepair((open) => (open ? { ...open, preview, previewing: false } : open)))
        .catch(() => undefined)
    }, 400)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [api, repairDraftKey])

  const submitRepair = async () => {
    const current = newRepair
    const rmaNow = latest.current
    if (!current || !rmaNow || current.busy) return
    if (current.preview && !current.preview.ok) return setNewRepair({ ...current, showProblems: true })
    setNewRepair({ ...current, busy: true, problem: null })
    try {
      const answer = await createRepair(api, newRepairBody(current.draft, rmaNow.companyId), repairKey.current)
      setNewRepair(null)
      setReceipt({ tone: 'success', words: { key: 'done.repair', params: { number: answer.repair.number } }, href: repairHref(prefix, answer.repair.id) })
      void loadRepairs()
    } catch (error) {
      setNewRepair((open) => (open ? { ...open, busy: false, problem: refusalOf(error) } : open))
    }
  }

  // ---- Add lines (B-W2b-16): what may still come back, picked; one POST at the version read ------------------------------
  const addKey = useRef<string>(newIdempotencyKey())
  const openAddLines = async () => {
    const current = latest.current
    if (!current) return
    addKey.current = newIdempotencyKey()
    setAddLines({ lines: {}, returnable: { value: null, loading: true, problem: null }, showProblems: false, busy: false, problem: null })
    try {
      const value = await listReturnable(api, { companyId: current.companyId, partyId: current.partyId })
      setAddLines((open) => (open ? { ...open, returnable: { value, loading: false, problem: null } } : open))
    } catch (error) {
      setAddLines((open) => (open ? { ...open, returnable: { value: null, loading: false, problem: `quality:${problemKey(error)}` } } : open))
    }
  }
  const submitAddLines = async () => {
    const current = latest.current
    const open = addLines
    if (!current || !open || open.busy) return
    const returnable = open.returnable.value?.lines ?? []
    const taken = takenOf(current)
    if (addLinesProblems(open.lines, returnable, taken).length > 0) {
      setAddLines({ ...open, showProblems: true })
      return
    }
    setAddLines({ ...open, busy: true, problem: null, showProblems: true })
    try {
      const answer = await addReturnLines(api, current, addLinesBody(open.lines, returnable, taken), addKey.current)
      setRma(answer.return)
      setAddLines(null)
      setReceipt({ tone: 'success', words: { key: 'addLines.done', params: { count: answer.lineIds.length } } })
    } catch (error) {
      setAddLines((latestOpen) => (latestOpen ? { ...latestOpen, busy: false, problem: refusalOf(error) } : latestOpen))
      addKey.current = newIdempotencyKey()
    }
  }

  // ---- Close --------------------------------------------------------------------------------------------------------------
  const closeKey = useRef<string>(newIdempotencyKey())
  const submitClose = async () => {
    const current = latest.current
    if (!current || !close || close.busy || !close.reason) return
    setClose({ ...close, busy: true, problem: null })
    try {
      const answer = await closeReturn(api, current, closeReasonText(t(`finish.${close.reason}`), close.note), closeKey.current)
      setRma(answer.return)
      setClose({ ...close, busy: false, warnings: answer.warnings.length })
    } catch (error) {
      setClose((open) => (open ? { ...open, busy: false, problem: refusalOf(error) } : open))
    }
  }

  if (problem && !rma) return <RecordProblem problem={problem} back={<a className="fw-q-link" href={`${prefix}/sales/returns`}>{t('record.back')}</a>} onRetry={() => void load()} />
  if (!rma) return <RecordSkeleton />

  const panels = can.threadsRead ? <RecordPanels record={{ type: 'ReturnAuthorisation', id: rma.id, companyId: rma.companyId, siteId: rma.siteId }} title={rma.number} party={rma.party ? { id: rma.party.id, name: rma.party.legalName, emails: [] } : null} /> : undefined

  const model: RmaModel = {
    prefix,
    can,
    me: session.user.id,
    tab,
    rma,
    people,
    reasons,
    asOf,
    live,
    offline,
    today,
    receipt,
    changedAt,
    marks,
    decisions,
    decisionPreview,
    decisionPreviewing,
    credit,
    repairs,
    dialog,
    dialogBusy,
    dialogProblem,
    close,
    newRepair,
    addLines,
    dockOpen,
  }

  return (
    <RmaRecordView
      model={model}
      panels={panels}
      actions={{
        onReload: () => void load(),
        onDismissReceipt: () => setReceipt(null),
        onDock: () =>
          setDockOpen((open) => {
            const next = !open
            if (next && !window.matchMedia(WIDE).matches) {
              router.push(returnHref(prefix, rma.id, '?tab=activity'))
              return open
            }
            try {
              window.localStorage.setItem(DOCK_KEY, next ? '1' : '0')
            } catch {
              // Not kept on this device; the dock still toggles.
            }
            return next
          }),
        onQuantity: (lineId, value) => {
          const line = latest.current?.lines.find((entry) => entry.id === lineId)
          const quantity = Number(value.trim())
          if (!line || !/^\d{1,6}$/.test(value.trim()) || quantity < 1) {
            setMarks((current) => ({ ...current, [`${lineId}:quantity`]: { state: 'refused', words: { key: 'refusal.quantityNumber' } } }))
            return
          }
          if (quantity === line.quantity) return
          saveCell(lineId, 'quantity', { quantity })
        },
        onReason: (lineId, code) => saveCell(lineId, 'reasonCode', { reasonCode: code }),
        onRemoveLine: (lineId) => {
          const current = latest.current
          if (!current) return
          chain.current = chain.current.then(async () => {
            try {
              const next = await removeReturnLine(api, latest.current ?? current, lineId)
              latest.current = next
              setRma(next)
              setReceipt({ tone: 'success', words: { key: 'done.lineRemoved' } })
            } catch (error) {
              setReceipt({ tone: 'danger', words: refusalOf(error) })
              await load()
            }
          })
        },
        onDialog: openDialog,
        onDialogSubmit: () => void submitDialog(),
        onDecision: (lineId, patch) => setDecisions((current) => ({ ...current, [lineId]: { ...(current[lineId] ?? { disposition: '', outcome: '', credit: '' }), ...patch } })),
        onDecide: (lineIds) => void decide(lineIds),
        onMakeRepair: (lineId) => void openRepair(lineId),
        onNewRepairDraft: (patch) => setNewRepair((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current)),
        onNewRepairSubmit: () => void submitRepair(),
        onNewRepairClose: () => setNewRepair(null),
        onCloseOpen: () => {
          closeKey.current = newIdempotencyKey()
          setClose({ number: rma.number, reason: '', note: '', busy: false, problem: null, warnings: null, pending: rma.closeWarnings })
        },
        onCloseDraft: (patch) => setClose((current) => (current ? { ...current, ...patch } : current)),
        onCloseSubmit: () => void submitClose(),
        onCloseDismiss: () => setClose(null),
        onAddLinesOpen: () => void openAddLines(),
        onAddLinesLine: (key, patch) => setAddLines((open) => (open ? { ...open, lines: { ...open.lines, [key]: { ...(open.lines[key] ?? { quantity: '', reasonCode: '', note: '' }), ...patch } } } : open)),
        onAddLinesSubmit: () => void submitAddLines(),
        onAddLinesClose: () => setAddLines(null),
        onCopy: (text) => {
          void navigator.clipboard?.writeText(text).then(
            () => setReceipt({ tone: 'success', words: { key: 'done.copied' } }),
            () => undefined,
          )
        },
      }}
    />
  )
}
