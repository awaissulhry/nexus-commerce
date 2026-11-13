'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { downloadLink } from '../../../../record-panels/api'
import { storeUrl } from '../../../../record-panels/store'
import type { OfficeSession } from '../../../../lib/session/session'
import { getParty, getQuote } from '../../quotes/api'
import type { Order } from '../api'
import { romeToday, type RecordTab } from '../model'
import {
  applyPricedChange,
  askApproval,
  getApproval,
  getChanges,
  getConfirmation,
  getDepositKinds,
  getFreeze,
  getMaterials,
  getMilestones,
  getOrderDepth,
  getTechPack,
  listPromiseLines,
  listSeasons,
  makeConfirmation,
  planMaterials,
  previewPricedChange,
  putBack,
  sendConfirmation,
  setOrderSeason,
  setPriority,
  withdrawApproval,
  type Approval,
  type Changes,
  type Confirmation,
  type DepositKinds,
  type Freeze,
  type Materials,
  type OrderDepth,
  type PricedBody,
  type PricedPreview,
  type PriorityLevel,
  type Season,
  type TechPack,
} from './api'
import { confirmationRecipient, depthCanOf, forecastSites, forecastsOf, PRICED_EMPTY, pricedBodyOf, pricedProblems, priorityBody, readProblemOf, writeProblemOf, type DepthCan, type Forecast, type PricedDraft } from './model'
import type { Phrase } from '../model'

/** One part the depth reads: null value while it loads; a problem when the read failed (never drawn as empty). */
export interface DepthPart<T> {
  value: T | null
  problem: string | null
}

export type DepthDialog =
  | { kind: 'priority'; level: PriorityLevel; reason: string }
  | { kind: 'season'; seasonId: string }
  | { kind: 'ask'; note: string }
  | { kind: 'withdraw' }
  | { kind: 'send'; cc: string; subject: string; message: string }
  | { kind: 'priced' }
  | { kind: 'putBack'; changeId: string; reason: string }
  | { kind: 'plan' }

/** The priced change's dialog: the amendment it prices, the draft, the preview as last read. */
export interface PricedState {
  amendment: Pick<PricedBody, 'lines' | 'customerRef' | 'requestedDate'>
  draft: PricedDraft
  preview: { phase: 'reading' | 'ready' | 'failed'; value: PricedPreview | null; problem: string | null }
}

export interface SendState {
  recipient: { name: string; email: string } | null | undefined
  pdf: string | null
  result: { to: string; at: string } | null
}

export interface OrderDepthModel {
  can: DepthCan
  depth: DepthPart<OrderDepth>
  /** Only while the order waits for a yes (PENDING_APPROVAL). */
  approval: DepthPart<Approval> | null
  freeze: DepthPart<Freeze> | null
  changes: DepthPart<Changes> | null
  materials: DepthPart<Materials> | null
  confirmation: DepthPart<Confirmation> | null
  /** The newest confirmation's PDF (an address the browser reads), on the Documents tab. */
  confirmationPdf: DepthPart<string> | null
  /** null without sales.inquiries.view. */
  techPack: DepthPart<TechPack> | null
  /** null without planning.view (the planner's milestones). */
  milestones: DepthPart<Awaited<ReturnType<typeof getMilestones>>> | null
  /** null without planning.promise.view. */
  forecasts: DepthPart<ReadonlyMap<string, Forecast>> | null
  seasons: Season[] | null
  depositKinds: DepositKinds | null
  dialog: DepthDialog | null
  busy: boolean
  problem: Phrase | null
  notice: { tone: 'success' | 'warning' | 'danger' | 'info'; words: Phrase } | null
  priced: PricedState | null
  send: SendState | null
}

export interface OrderDepthActions {
  onDialog?: (dialog: DepthDialog | null) => void
  onPriority?: () => void
  onSeason?: () => void
  onAsk?: () => void
  onWithdraw?: () => void
  onMakeConfirmation?: () => void
  onSend?: () => void
  onPlan?: () => void
  onPutBack?: () => void
  onPricedStart?: (amendment: PricedState['amendment']) => void
  onPricedDraft?: (next: Partial<PricedDraft>) => void
  onPricedApply?: () => void
  onRetry?: (part: 'depth' | 'approval' | 'freeze' | 'changes' | 'materials' | 'confirmation' | 'techPack' | 'milestones' | 'forecasts') => void
  onOpenFile?: (fileId: string) => void
  onDismissNotice?: () => void
}

const LOADING = { value: null, problem: null } as const

/** Reads one part whenever its key changes (null: not read here); `again` reads it once more. */
function usePart<T>(key: string | null, read: (signal: AbortSignal) => Promise<T>): [DepthPart<T> | null, () => void, (value: T) => void] {
  const [part, setPart] = useState<DepthPart<T> | null>(key ? LOADING : null)
  const [tick, setTick] = useState(0)
  const readRef = useRef(read)
  readRef.current = read
  useEffect(() => {
    if (!key) {
      setPart(null)
      return
    }
    const abort = new AbortController()
    setPart((known) => (known?.value != null && tick === 0 ? known : LOADING))
    readRef
      .current(abort.signal)
      .then((value) => !abort.signal.aborted && setPart({ value, problem: null }))
      .catch((error: unknown) => !abort.signal.aborted && setPart({ value: null, problem: readProblemOf(error) }))
    return () => abort.abort()
  }, [key, tick])
  const again = useCallback(() => setTick((value) => value + 1), [])
  const put = useCallback((value: T) => setPart({ value, problem: null }), [])
  return [part, again, put]
}

/**
 * The order studio's depth (B-W2b-323): reads what each tab shows — the band's priority, season and the yes it waits for on
 * every tab; what is frozen on Lines and Changes; the customer's materials on Lines; the changes on Changes; the confirmation,
 * its PDF and the tech pack on Documents; the milestones and the finish forecast on Dates — again whenever the order's version
 * moves (every write moves it), and does the writes, one at a time, each with the order's version as read and one
 * Idempotency-Key per dialog. A write that answers the order hands it to the studio (`onOrder`).
 */
export function useOrderDepth(input: { api: ApiClient; session: OfficeSession; order: Order | null; tab: RecordTab; language: 'it' | 'en'; onOrder: (order: Order) => void; onReload: () => void; onAmendDone: () => void }): { model: OrderDepthModel; actions: OrderDepthActions } {
  const { api, session, order, tab } = input
  const can = useMemo(() => depthCanOf(session.permissions), [session.permissions])
  const id = order?.id ?? null
  const at = order ? `${order.id}:${order.version}` : null
  const on = (...tabs: RecordTab[]) => (at && tabs.includes(tab) ? at : null)

  const [depth, againDepth] = usePart(at && can.view ? at : null, (signal) => getOrderDepth(api, id!, signal))
  const [approval, againApproval] = usePart(at && order?.status === 'PENDING_APPROVAL' ? at : null, (signal) => getApproval(api, id!, signal))
  const [freeze, againFreeze] = usePart(on('lines', 'changes'), (signal) => getFreeze(api, id!, signal))
  const [changes, againChanges] = usePart(on('changes'), (signal) => getChanges(api, id!, signal))
  const [materials, againMaterials, putMaterials] = usePart(on('lines'), (signal) => getMaterials(api, id!, signal))
  const [confirmation, againConfirmation, putConfirmation] = usePart(at && tab === 'documents' ? at : null, (signal) => getConfirmation(api, id!, signal))
  const [techPack, againTechPack] = usePart(can.inquiries && at && tab === 'documents' ? `${id}` : null, (signal) => getTechPack(api, id!, signal))
  const [milestones, againMilestones] = usePart(can.planning && at && tab === 'dates' ? at : null, (signal) => getMilestones(api, id!, signal))
  const sites = useMemo(() => (order ? forecastSites(order, session.sites) : []), [order, session.sites])
  const [forecasts, againForecasts] = usePart<ReadonlyMap<string, Forecast>>(can.promise && at && tab === 'dates' && sites.length > 0 ? `${at}:${sites.join(',')}` : null, async (signal) => {
    const lines = await Promise.all(sites.map((site) => listPromiseLines(api, site, { q: order!.number, limit: 300 }, signal).then((answer) => answer.lines).catch(() => [])))
    return forecastsOf(lines.flat(), id!)
  })

  // The newest confirmation's PDF (Documents tab): a presigned address the browser reads (60 s).
  const newestFile = confirmation?.value?.versions[0]?.fileId ?? null
  const [confirmationPdf, againPdf] = usePart(tab === 'documents' && newestFile && can.files ? newestFile : null, async () => storeUrl((await downloadLink(api, newestFile!)).download.url))

  const [dialog, setDialog] = useState<DepthDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Phrase | null>(null)
  const [notice, setNotice] = useState<OrderDepthModel['notice']>(null)
  const [seasons, setSeasons] = useState<Season[] | null>(null)
  const [depositKinds, setDepositKinds] = useState<DepositKinds | null>(null)
  const [priced, setPriced] = useState<PricedState | null>(null)
  const [send, setSend] = useState<SendState | null>(null)
  const keyRef = useRef<string | null>(null)
  const orderRef = useRef(order)
  orderRef.current = order
  const pricedRef = useRef(priced)
  pricedRef.current = priced
  const dialogRef = useRef(dialog)
  dialogRef.current = dialog

  const open = useCallback((next: DepthDialog | null) => {
    setProblem(null)
    keyRef.current = next ? newIdempotencyKey() : null
    setDialog(next)
    if (!next || next.kind !== 'send') setSend(null)
    if (!next || next.kind !== 'priced') setPriced((known) => (next ? known : null))
  }, [])

  // The season picker reads the company's open seasons when it opens.
  useEffect(() => {
    if (dialog?.kind !== 'season' || !order) return
    const abort = new AbortController()
    setSeasons(null)
    listSeasons(api, order.companyId, abort.signal)
      .then(setSeasons)
      .catch(() => !abort.signal.aborted && setSeasons([]))
    return () => abort.abort()
  }, [dialog?.kind, api, order])

  // The send dialog: who it goes to (the quote's contact, else the orders contact) and the PDF it carries.
  const sendOpen = dialog?.kind === 'send'
  useEffect(() => {
    if (!sendOpen || !order) return
    let gone = false
    setSend({ recipient: undefined, pdf: confirmationPdf?.value ?? null, result: null })
    const quoteId = order.chain.quote?.id ?? null
    Promise.all([getParty(api, order.partyId), quoteId && session.permissions.includes('quotes.view') ? getQuote(api, quoteId).then((quote) => quote.contactId).catch(() => null) : Promise.resolve(null)])
      .then(([party, contactId]) => !gone && setSend((known) => (known ? { ...known, recipient: confirmationRecipient(party.contacts, contactId) } : known)))
      .catch(() => !gone && setSend((known) => (known ? { ...known, recipient: null } : known)))
    return () => {
      gone = true
    }
    // The order's id is what the recipient depends on.
  }, [sendOpen, id])

  /** One write at a time; a refusal is said in the dialog (or as a notice when none is open). */
  const write = useCallback(
    async (run: (key: string) => Promise<void>, success: Phrase | null, keep = false) => {
      if (busy) return
      setBusy(true)
      setProblem(null)
      setNotice(null)
      try {
        await run(keyRef.current ?? newIdempotencyKey())
        if (!keep) {
          setDialog(null)
          keyRef.current = null
        }
        if (success) setNotice({ tone: 'success', words: success })
      } catch (error) {
        const words = writeProblemOf(error)
        if (dialogRef.current) setProblem(words)
        else setNotice({ tone: 'danger', words })
        if (words.reload) input.onReload()
      } finally {
        setBusy(false)
      }
    },
    [busy, input],
  )

  // The priced change's preview: read again a moment after the draft changes (nothing is written).
  const pricedKey = priced ? JSON.stringify([priced.amendment, priced.draft.fee, priced.draft.deposit, priced.draft.pct, priced.draft.amount, priced.draft.kind, priced.draft.dueDate, priced.draft.labels]) : null
  useEffect(() => {
    const now = pricedRef.current
    const value = orderRef.current
    if (!now || !value) return
    const local = pricedProblems(now.draft, romeToday(), { price: can.price })
    if (Object.keys(local).length > 0) return
    const abort = new AbortController()
    const timer = setTimeout(() => {
      setPriced((known) => (known ? { ...known, preview: { ...known.preview, phase: 'reading', problem: null } } : known))
      previewPricedChange(api, value.id, { ...pricedBodyOf(now.draft, now.amendment, can.price), version: value.version }, abort.signal)
        .then((answer) => !abort.signal.aborted && setPriced((known) => (known ? { ...known, preview: { phase: 'ready', value: answer, problem: null } } : known)))
        .catch((error: unknown) => !abort.signal.aborted && setPriced((known) => (known ? { ...known, preview: { phase: 'failed', value: null, problem: writeProblemOf(error).key } } : known)))
    }, 350)
    return () => {
      clearTimeout(timer)
      abort.abort()
    }
  }, [pricedKey, api, can.price])

  const version = () => orderRef.current?.version ?? 1

  const actions: OrderDepthActions = {
    onDialog: (next) => {
      if (next?.kind === 'priced' && order) getDepositKinds(api, order.companyId).then(setDepositKinds).catch(() => setDepositKinds(null))
      open(next)
    },
    onDismissNotice: () => setNotice(null),
    onRetry: (part) => ({ depth: againDepth, approval: againApproval, freeze: againFreeze, changes: againChanges, materials: againMaterials, confirmation: againConfirmation, techPack: againTechPack, milestones: againMilestones, forecasts: againForecasts })[part](),
    onPriority: () => {
      const now = dialogRef.current
      if (now?.kind !== 'priority' || !order) return
      void write(async (key) => {
        await setPriority(api, order.id, { version: version(), ...priorityBody(now.level, now.reason) }, key)
        input.onReload()
      }, { key: 'notice.priority', params: { level: now.level } })
    },
    onSeason: () => {
      const now = dialogRef.current
      if (now?.kind !== 'season' || !order) return
      void write(async (key) => {
        await setOrderSeason(api, order.id, { version: version(), seasonId: now.seasonId || null }, key)
        input.onReload()
      }, { key: now.seasonId ? 'notice.season' : 'notice.seasonCleared' })
    },
    onAsk: () => {
      const now = dialogRef.current
      if (now?.kind !== 'ask' || !order) return
      void write(async (key) => {
        await askApproval(api, order.id, now.note.trim() || null, key)
        againApproval()
      }, { key: 'notice.asked' })
    },
    onWithdraw: () => {
      if (!order) return
      void write(async (key) => {
        await withdrawApproval(api, order.id, key)
        againApproval()
      }, { key: 'notice.withdrawn' })
    },
    onMakeConfirmation: () => {
      if (!order) return
      void write(async (key) => {
        const answer = await makeConfirmation(api, order.id, input.language, key)
        putConfirmation(answer.confirmation)
        if (!answer.made) setNotice({ tone: 'info', words: { key: 'notice.confirmationSame', params: { version: answer.version } } })
        againDepth()
      }, null)
    },
    onSend: () => {
      const now = dialogRef.current
      const recipient = send?.recipient
      if (now?.kind !== 'send' || !order || !recipient) return
      const cc = now.cc.split(/[;,\s]+/).map((part) => part.trim()).filter(Boolean)
      void write(
        async (key) => {
          const answer = await sendConfirmation(api, order.id, { to: [recipient.email], ...(cc.length > 0 ? { cc } : {}), subject: now.subject.trim() || null, message: now.message.trim() || null, language: input.language }, key)
          putConfirmation(answer.confirmation)
          setSend((known) => (known ? { ...known, result: { to: recipient.email, at: answer.confirmation.sentAt ?? new Date().toISOString() } } : known))
          againDepth()
        },
        null,
        true,
      )
    },
    onPlan: () => {
      if (!order) return
      void write(async (key) => {
        const answer = await planMaterials(api, order.id, key)
        putMaterials(answer)
        setNotice({ tone: 'success', words: { key: 'notice.planned', params: { made: answer.planned.made, changed: answer.planned.changed, removed: answer.planned.removed } } })
      }, null)
    },
    onPutBack: () => {
      const now = dialogRef.current
      if (now?.kind !== 'putBack' || !order) return
      void write(async (key) => {
        const answer = await putBack(api, order.id, now.changeId, { version: version(), ...(now.reason.trim() ? { reason: now.reason.trim() } : {}) }, key)
        input.onOrder(answer.order)
        if (answer.depositCancelled) setNotice({ tone: 'success', words: { key: 'notice.putBackDeposit', params: { revision: answer.change.revision } } })
      }, { key: 'notice.putBack' })
    },
    onPricedStart: (amendment) => {
      if (!order) return
      setPriced({ amendment, draft: { ...PRICED_EMPTY, labels: {} }, preview: { phase: 'reading', value: null, problem: null } })
      getDepositKinds(api, order.companyId).then(setDepositKinds).catch(() => setDepositKinds(null))
      open({ kind: 'priced' })
    },
    onPricedDraft: (next) => setPriced((known) => (known ? { ...known, draft: { ...known.draft, ...next } } : known)),
    onPricedApply: () => {
      const now = pricedRef.current
      if (!now || !order) return
      const local = pricedProblems(now.draft, romeToday(), { price: can.price, final: true })
      if (Object.keys(local).length > 0) {
        setProblem({ key: Object.values(local)[0]! })
        return
      }
      void write(async (key) => {
        const answer = await applyPricedChange(api, order.id, { ...pricedBodyOf(now.draft, now.amendment, can.price), version: version(), reason: now.draft.reason.trim() }, key)
        setPriced(null)
        input.onAmendDone()
        input.onOrder(answer.order)
        setNotice({ tone: 'success', words: { key: answer.change.yes.state === 'WAITING' ? 'notice.pricedWaiting' : 'notice.priced', params: { revision: answer.change.revision } } })
      }, null)
    },
    onOpenFile: (fileId) => {
      downloadLink(api, fileId)
        .then(({ download }) => window.open(storeUrl(download.url), '_blank', 'noopener,noreferrer'))
        .catch((error: unknown) => setNotice({ tone: 'danger', words: { key: readProblemOf(error) } }))
    },
  }

  // A dialog left open over another order (a reload to a new id) closes.
  useEffect(() => {
    setDialog(null)
    setPriced(null)
    setSend(null)
  }, [id])

  return {
    model: {
      can,
      depth: depth ?? LOADING,
      approval,
      freeze,
      changes,
      materials,
      confirmation,
      confirmationPdf,
      techPack,
      milestones,
      forecasts,
      seasons,
      depositKinds,
      dialog,
      busy,
      problem,
      notice,
      priced,
      send: send ? { ...send, pdf: send.pdf ?? confirmationPdf?.value ?? null } : null,
    },
    actions: { ...actions, onRetry: (part) => (part === 'confirmation' ? (againConfirmation(), againPdf()) : actions.onRetry?.(part)) },
  }
}
