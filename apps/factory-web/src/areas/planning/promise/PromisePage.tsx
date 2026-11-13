'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { downloadText, useCoalesced, useLive } from '../../_shared/buying/hooks'
import { listPlanningSites } from '../board/api'
import {
  acceptRepromise,
  availableToPromise,
  calculatePromise,
  declineRepromise,
  findStyles,
  getRepromise,
  listPromises,
  promiseHistory,
  promiseOnQuote,
  proposeRepromise,
  quoteSuggestion,
  readStyle,
  repromiseDraft,
  stockStyles,
  withdrawRepromise,
  type Atp,
  type PromiseList,
  type StockStyle,
} from './api'
import { calcBodyOf, calcHeld, controlsOf, csvOfLines, EMPTY_CALC, formOf, NAMESPACE, promiseCan, proposeBodyOf, queryOf, readProblemOf, refusalOf, type CalcForm, type PromiseControls, type Words } from './model'
import type { CalculatorDialog, HistoryPopover, Loaded, PromiseModel, PromiseNotice, PromiseSite, RepromiseDialog } from './view-model'
import { PromiseView } from './view/PromiseView'

/** What moves a promise, a planned finish or a re-promise: read the lines again ("N updates · Show"). */
const PROMISE_EVENTS = ['order_promise.', 'backlog.ranked', 'supply_late.checked', 'planning.schedule_changed', 'planning.capacity_changed', 'workorder.', 'sales_order.', 'purchase_order.', 'certificate.']
const isPromiseChange = (type: string) => PROMISE_EVENTS.some((prefix) => type.startsWith(prefix))

/**
 * `/w/<company>/planning/promise` (SCR-109; Planning › Dates › Promise dates, planning.promise.view): the sites (the planning
 * sites; without planning.view — sales — the person's own sites), then per site: GET /planning/promises (the tiles and the
 * open order lines, `?tile=` `?risk=` `?q=`), the stock styles and, for the style picked (`?style=` `?weeks=` `?week=`),
 * Available to promise. A line's history is read when its popover opens; the Re-promise modal (`?repromise=<line>`) reads the
 * draft and sends the planner's proposal, or sales' word on one that waits (`?proposal=<id>` from its task opens its line);
 * the Promise calculator (`?calc=1`, `&quote=<id>` from a quote's "Suggest date") asks the engine and writes nothing but
 * "Use on quote". Every write carries one Idempotency-Key per dialog. Live: what moves a promise waits behind "N updates · Show".
 */
export function PromisePage() {
  return (
    <WithMessages namespaces={[NAMESPACE, 'lists']}>
      <PromiseContainer />
    </WithMessages>
  )
}

function PromiseContainer() {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const words: Words = useMemo(() => ({ t, locale }), [t, locale])
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const params = useSearchParams()
  const query = params?.toString() ?? ''
  const controls = useMemo(() => controlsOf(new URLSearchParams(query)), [query])
  const prefix = pathname.replace(/\/planning\/promise\/?$/, '')
  const can = useMemo(() => promiseCan(session.permissions), [session.permissions])
  const me = session.user.id

  const [sites, setSites] = useState<Loaded<PromiseSite[]>>({ status: 'loading' })
  const [list, setList] = useState<Loaded<PromiseList>>({ status: 'loading' })
  const [styles, setStyles] = useState<Loaded<StockStyle[]>>({ status: 'loading' })
  const [atp, setAtp] = useState<Loaded<Atp> | null>(null)
  const [history, setHistory] = useState<HistoryPopover | null>(null)
  const [repromise, setRepromise] = useState<RepromiseDialog | null>(null)
  const [calculator, setCalculator] = useState<CalculatorDialog | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<PromiseNotice | null>(null)
  const [dialog, setDialog] = useState<{ kind: 'keys' } | null>(null)
  const [siteTry, setSiteTry] = useState(0)
  const controlsRef = useRef(controls)
  controlsRef.current = controls
  const reads = useRef({ list: 0, atp: 0, history: 0, draft: 0, calc: 0 })
  /** One Idempotency-Key per dialog and write (a retry after a lost answer is the same write). */
  const keys = useRef<Record<string, string>>({})
  const keyOf = (name: string) => (keys.current[name] ??= newIdempotencyKey())

  const site = sites.status === 'ready' ? (sites.value.find((entry) => entry.id === controls.site) ?? sites.value[0] ?? null) : null
  const siteId = site?.id ?? null

  const setControls = useCallback(
    (next: Partial<PromiseControls>) => {
      const qs = queryOf({ ...controlsRef.current, ...next })
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
    },
    [router, pathname],
  )

  // The sites: the planning sites (planning.view), else the person's own sites of the company (sales asks promises too).
  useEffect(() => {
    if (!can.view) return
    let gone = false
    setSites({ status: 'loading' })
    if (!can.planning) {
      setSites({ status: 'ready', value: [...session.sites].sort((a, b) => (a.code ?? '').localeCompare(b.code ?? '')).map((entry) => ({ id: entry.id, code: entry.code ?? '', name: entry.name })) })
      return
    }
    listPlanningSites(api, session.company?.id ?? null)
      .then((value) => !gone && setSites({ status: 'ready', value: value.map((entry) => ({ id: entry.id, code: entry.code, name: entry.name })) }))
      .catch((error: unknown) => {
        if (gone) return
        const problem = readProblemOf(error)
        setSites({ status: 'error', problem })
        setList({ status: 'error', problem })
        setStyles({ status: 'error', problem })
      })
    return () => {
      gone = true
    }
  }, [api, can.view, can.planning, session.company?.id, session.sites, siteTry])

  const loadList = useCallback(async () => {
    if (!siteId) return
    const id = ++reads.current.list
    try {
      const value = await listPromises(api, { siteId, tile: controls.tile, risk: controls.risk, q: controls.q })
      if (id === reads.current.list) {
        setList({ status: 'ready', value })
        setUpdates(0)
      }
    } catch (error) {
      if (id === reads.current.list) setList({ status: 'error', problem: readProblemOf(error) })
    }
  }, [api, siteId, controls.tile, controls.risk, controls.q])

  const loadStyles = useCallback(async () => {
    if (!siteId) return
    try {
      setStyles({ status: 'ready', value: await stockStyles(api, siteId) })
    } catch (error) {
      setStyles({ status: 'error', problem: readProblemOf(error) })
    }
  }, [api, siteId])

  const loadAtp = useCallback(async () => {
    if (!siteId || !controls.style) {
      setAtp(null)
      return
    }
    const id = ++reads.current.atp
    setAtp({ status: 'loading' })
    try {
      const value = await availableToPromise(api, siteId, controls.style, controls.weeks)
      if (id === reads.current.atp) setAtp({ status: 'ready', value })
    } catch (error) {
      if (id === reads.current.atp) setAtp({ status: 'error', problem: readProblemOf(error) })
    }
  }, [api, siteId, controls.style, controls.weeks])

  useEffect(() => {
    if (sites.status !== 'ready') return
    if (!siteId) {
      setList({ status: 'error', problem: 'error.noSite' })
      setStyles({ status: 'error', problem: 'error.noSite' })
      return
    }
    setList({ status: 'loading' })
    void loadList()
  }, [sites.status, siteId, loadList])

  useEffect(() => {
    if (sites.status !== 'ready' || !siteId) return
    setStyles({ status: 'loading' })
    void loadStyles()
  }, [sites.status, siteId, loadStyles])

  useEffect(() => {
    if (sites.status !== 'ready') return
    void loadAtp()
  }, [sites.status, loadAtp])

  // ---- the history popover -----------------------------------------------------------------------------------------------
  const loadHistory = useCallback(
    async (lineId: string) => {
      const id = ++reads.current.history
      setHistory({ lineId, history: { status: 'loading' } })
      try {
        const value = await promiseHistory(api, lineId)
        if (id === reads.current.history) setHistory({ lineId, history: { status: 'ready', value } })
      } catch (error) {
        if (id === reads.current.history) setHistory({ lineId, history: { status: 'error', problem: readProblemOf(error) } })
      }
    },
    [api],
  )

  // ---- the re-promise ------------------------------------------------------------------------------------------------------
  const loadDraft = useCallback(
    async (lineId: string) => {
      const id = ++reads.current.draft
      setRepromise((current) => ({ lineId, draft: { status: 'loading' }, form: current?.lineId === lineId ? current.form : null, tell: false, declining: false, declineReason: '', busy: null, problem: null, done: current?.lineId === lineId ? current.done : null }))
      try {
        const draft = await repromiseDraft(api, lineId)
        if (id !== reads.current.draft) return
        setRepromise((current) =>
          current && current.lineId === lineId
            ? { ...current, draft: { status: 'ready', value: draft }, form: current.form ?? formOf(draft), tell: !!draft.waiting && draft.waiting.may.tell && draft.waiting.recipients.length > 0 }
            : current,
        )
      } catch (error) {
        if (id === reads.current.draft) setRepromise((current) => (current && current.lineId === lineId ? { ...current, draft: { status: 'error', problem: readProblemOf(error) } } : current))
      }
    },
    [api],
  )

  useEffect(() => {
    const lineId = controls.repromise
    if (!lineId) {
      reads.current.draft += 1
      setRepromise(null)
      keys.current = {}
      return
    }
    void loadDraft(lineId)
  }, [controls.repromise, loadDraft])

  // A proposal opened from its task on the order: its line's re-promise.
  useEffect(() => {
    const proposalId = controls.proposal
    if (!proposalId || !can.view) return
    let gone = false
    getRepromise(api, proposalId)
      .then((proposal) => !gone && setControls({ proposal: null, repromise: proposal.line.id, site: proposal.siteId, tile: proposal.state === 'WAITING' ? 'REPROMISE_WAITING' : controlsRef.current.tile }))
      .catch((error: unknown) => {
        if (gone) return
        setNotice({ tone: 'danger', key: readProblemOf(error) === 'error.gone' ? 'notice.proposalGone' : readProblemOf(error) })
        setControls({ proposal: null })
      })
    return () => {
      gone = true
    }
  }, [api, can.view, controls.proposal, setControls])

  const write = useCallback(
    async (kind: 'propose' | 'accept' | 'decline' | 'withdraw') => {
      const dialogNow = repromise
      if (!dialogNow || dialogNow.busy || dialogNow.draft.status !== 'ready') return
      if (kind === 'propose' && !dialogNow.form) return
      const draft = dialogNow.draft.value
      setRepromise({ ...dialogNow, busy: kind, problem: null })
      try {
        if (kind === 'propose' && dialogNow.form) {
          const proposal = await proposeRepromise(api, dialogNow.lineId, proposeBodyOf(draft, dialogNow.form), keyOf('propose'))
          setRepromise((current) => (current ? { ...current, busy: null, done: { kind: 'proposed', proposal } } : current))
          setNotice({ tone: 'success', key: 'notice.proposed', params: { order: draft.order.number, line: draft.line.seq } })
        } else if (draft.waiting) {
          const proposalId = draft.waiting.id
          if (kind === 'accept') {
            const answer = await acceptRepromise(api, proposalId, { tell: dialogNow.tell }, keyOf(`accept:${proposalId}`))
            setRepromise((current) => (current ? { ...current, busy: null, done: { kind: 'accepted', proposal: answer.proposal, answer } } : current))
            setNotice({ tone: 'success', key: answer.told ? 'notice.acceptedTold' : 'notice.accepted', params: { order: draft.order.number, line: draft.line.seq } })
          } else if (kind === 'decline') {
            const proposal = await declineRepromise(api, proposalId, dialogNow.declineReason, keyOf(`decline:${proposalId}`))
            setRepromise((current) => (current ? { ...current, busy: null, done: { kind: 'declined', proposal } } : current))
            setNotice({ tone: 'success', key: 'notice.declined', params: { order: draft.order.number, line: draft.line.seq } })
          } else {
            const proposal = await withdrawRepromise(api, proposalId, keyOf(`withdraw:${proposalId}`))
            setRepromise((current) => (current ? { ...current, busy: null, done: { kind: 'withdrawn', proposal } } : current))
            setNotice({ tone: 'success', key: 'notice.withdrawn', params: { order: draft.order.number, line: draft.line.seq } })
          }
        }
        keys.current = {}
        void loadList()
      } catch (error) {
        const refusal = refusalOf(error)
        setRepromise((current) => (current ? { ...current, busy: null, problem: { key: refusal.key, sizes: refusal.sizes } } : current))
        // A refusal that means "the line moved on": the draft read again (the form is kept).
        if (['refusal.WAITING_EXISTS', 'refusal.NOT_WAITING', 'refusal.STALE', 'refusal.changed'].includes(refusal.key)) {
          keys.current = {}
          void loadDraft(dialogNow.lineId)
          void loadList()
        }
      }
    },
    [api, repromise, loadList, loadDraft],
  )

  // ---- the calculator ------------------------------------------------------------------------------------------------------
  const openCalculator = useCallback(
    (form: CalcForm = EMPTY_CALC) => {
      setCalculator({ styles: can.styles ? { status: 'loading' } : { status: 'error', problem: 'error.noStyles' }, style: null, form, answer: null, quote: null, using: false, used: null, problem: null })
      if (can.styles) {
        findStyles(api)
          .then((value) => setCalculator((current) => (current ? { ...current, styles: { status: 'ready', value } } : current)))
          .catch((error: unknown) => setCalculator((current) => (current ? { ...current, styles: { status: 'error', problem: readProblemOf(error) } } : current)))
      }
      if (form.styleId && can.styles) {
        setCalculator((current) => (current ? { ...current, style: { status: 'loading' } } : current))
        readStyle(api, form.styleId)
          .then((value) => setCalculator((current) => (current ? { ...current, style: { status: 'ready', value } } : current)))
          .catch((error: unknown) => setCalculator((current) => (current ? { ...current, style: { status: 'error', problem: readProblemOf(error) } } : current)))
      }
    },
    [api, can.styles],
  )
  const pendingForm = useRef<CalcForm | undefined>(undefined)

  useEffect(() => {
    if (!controls.calc) {
      setCalculator(null)
      return
    }
    openCalculator(pendingForm.current)
    pendingForm.current = undefined
    // Opened once per `?calc=1`; the quote is read below.
  }, [controls.calc, openCalculator])

  useEffect(() => {
    if (!controls.calc || !controls.quote || sites.status !== 'ready') return
    let gone = false
    setCalculator((current) => (current ? { ...current, quote: { status: 'loading' } } : current))
    quoteSuggestion(api, controls.quote, siteId)
      .then((value) => !gone && setCalculator((current) => (current ? { ...current, quote: { status: 'ready', value } } : current)))
      .catch((error: unknown) => !gone && setCalculator((current) => (current ? { ...current, quote: { status: 'error', problem: readProblemOf(error) } } : current)))
    return () => {
      gone = true
    }
  }, [api, controls.calc, controls.quote, siteId, sites.status])

  const calculate = useCallback(async () => {
    const now = calculator
    if (!now || !siteId || calcHeld(now.form, siteId) || now.style?.status !== 'ready') return
    const sizeOrder = now.style.value.sizes
    const id = ++reads.current.calc
    setCalculator({ ...now, answer: { status: 'loading' }, problem: null })
    try {
      const value = await calculatePromise(api, calcBodyOf(now.form, siteId, sizeOrder))
      if (id === reads.current.calc) setCalculator((current) => (current ? { ...current, answer: { status: 'ready', value } } : current))
    } catch (error) {
      if (id === reads.current.calc) setCalculator((current) => (current ? { ...current, answer: { status: 'error', problem: refusalOf(error).key } } : current))
    }
  }, [api, calculator, siteId])

  const applyOnQuote = useCallback(async () => {
    const now = calculator
    if (!now || now.using || now.quote?.status !== 'ready' || !now.quote.value.mayUse || !now.quote.value.promiseDate) return
    const suggestion = now.quote.value
    setCalculator({ ...now, using: true, problem: null })
    try {
      const quote = await promiseOnQuote(api, suggestion.quote, suggestion.promiseDate!, keyOf(`quote:${suggestion.quote.id}`))
      setCalculator((current) => (current ? { ...current, using: false, used: { promiseDate: quote.promiseDate ?? suggestion.promiseDate! } } : current))
      setNotice({ tone: 'success', key: 'notice.usedOnQuote', params: { quote: suggestion.quote.number } })
      keys.current = {}
    } catch (error) {
      setCalculator((current) => (current ? { ...current, using: false, problem: refusalOf(error).key } : current))
    }
  }, [api, calculator])

  // ---- live ----------------------------------------------------------------------------------------------------------------
  const rereadDraft = useCoalesced(() => {
    const lineId = controlsRef.current.repromise
    if (lineId) void loadDraft(lineId)
  }, 800)
  const live = useLive(
    (change) => {
      if (!isPromiseChange(change.type)) return
      const own = change.fields.siteId === undefined || change.fields.siteId === null || change.fields.siteId === siteId
      if (!own) return
      setUpdates((count) => count + 1)
      // A decision on the line whose re-promise is open (by someone else): its modal reads again.
      if (change.type.startsWith('order_promise.') && change.fields.orderLineId === controlsRef.current.repromise) rereadDraft()
    },
    () => {
      void loadList()
      void loadAtp()
    },
    can.view,
  )

  const model: PromiseModel = { prefix, can, me, sites, siteId, controls, list, history, styles, atp, repromise, calculator, live, updates, notice, dialog, built: OFFICE_PAGES }

  return (
    <PromiseView
      model={model}
      actions={{
        onSite: (next) => setControls({ site: next, style: null, week: null, repromise: null }),
        onTile: (tile) => setControls({ tile, risk: null }),
        onRisk: (risk) => setControls({ risk }),
        onSearch: (q) => setControls({ q }),
        onRetry: (section) => {
          if (sites.status === 'error') setSiteTry((count) => count + 1)
          else if (section === 'list') void loadList()
          else if (section === 'atp') void loadAtp()
          else void loadStyles()
        },
        onShowUpdates: () => {
          void loadList()
          void loadAtp()
        },
        onHistory: (lineId) => {
          if (lineId === null) {
            reads.current.history += 1
            setHistory(null)
          } else void loadHistory(lineId)
        },
        onRetryHistory: () => history && void loadHistory(history.lineId),
        onRepromise: (lineId) => setControls({ repromise: lineId }),
        onRetryDraft: () => repromise && void loadDraft(repromise.lineId),
        onForm: (next) => setRepromise((current) => (current?.form ? { ...current, form: { ...current.form, ...next }, problem: null } : current)),
        onDate: (key, date) => setRepromise((current) => (current?.form ? { ...current, form: { ...current.form, dates: { ...current.form.dates, [key]: date } }, problem: null } : current)),
        onPropose: () => void write('propose'),
        onTell: (tell) => setRepromise((current) => (current ? { ...current, tell } : current)),
        onAccept: () => void write('accept'),
        onDeclining: (declining) => setRepromise((current) => (current ? { ...current, declining, problem: null } : current)),
        onDeclineReason: (reason) => setRepromise((current) => (current ? { ...current, declineReason: reason, problem: null } : current)),
        onDecline: () => void write('decline'),
        onWithdraw: () => void write('withdraw'),
        onStyle: (styleId) => setControls({ style: styleId, week: null }),
        onWeeks: (weeks) => setControls({ weeks, week: null }),
        onWeek: (week) => setControls({ week }),
        onCalculator: (open, form) => {
          if (open) {
            if (controlsRef.current.calc) openCalculator(form)
            else pendingForm.current = form
            setControls({ calc: true })
          } else setControls({ calc: false, quote: null })
        },
        onCalcStyle: (styleId) => {
          setCalculator((current) => (current ? { ...current, form: { ...current.form, styleId, colourwayId: '', quantities: {} }, style: styleId ? { status: 'loading' } : null, answer: null } : current))
          if (!styleId) return
          readStyle(api, styleId)
            .then((value) => setCalculator((current) => (current && current.form.styleId === styleId ? { ...current, style: { status: 'ready', value }, form: { ...current.form, colourwayId: value.colourways.filter((entry) => entry.status === 'ACTIVE').length === 1 ? value.colourways.find((entry) => entry.status === 'ACTIVE')!.id : current.form.colourwayId } } : current)))
            .catch((error: unknown) => setCalculator((current) => (current && current.form.styleId === styleId ? { ...current, style: { status: 'error', problem: readProblemOf(error) } } : current)))
        },
        onCalcForm: (next) => setCalculator((current) => (current ? { ...current, form: { ...current.form, ...next }, answer: current.answer?.status === 'loading' ? current.answer : null } : current)),
        onCalculate: () => void calculate(),
        onUseOnQuote: () => void applyOnQuote(),
        onOpenOrder: (href) => router.push(href),
        onExport: (ids) => {
          if (list.status !== 'ready') return
          const lines = list.value.lines.filter((line) => ids.length === 0 || ids.includes(line.id))
          downloadText(`promises-${list.value.site.code}-${list.value.today}.csv`, csvOfLines(lines, words))
        },
        onKeys: () => setDialog({ kind: 'keys' }),
        onCloseDialog: () => setDialog(null),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
