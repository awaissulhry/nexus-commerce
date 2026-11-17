'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { DEFAULT_TIME_ZONE, formatDateTime, formatTime } from '../../../lib/i18n/format'
import { useT } from '../../../lib/i18n/provider'
import {
  composeDraftKey,
  COMPOSE_NS,
  EMPTY_COMPOSE,
  fieldOfIssue,
  fingerprintOf,
  lastSentKey,
  problemsOf,
  readKeptCompose,
  readLastSent,
  sameAsLast,
  sendBodyOf,
  sendHeld,
  typedIn,
  writeKeptCompose,
  writeLastSent,
  type ComposeDraft,
  type ComposeField,
  type LastSent,
  type ShipToChoice,
} from '../../../lib/request-compose/model'
import type { RequestComposeModel } from '../../../lib/request-compose/view/RequestCompose'
import { WithMessages } from '../../../record-panels/i18n'
import { usePortalApi, usePortalBand, usePortalFrame, usePortalLive, usePortalUnsaved } from '../../shell/frame'
import { pageBuilt } from '../../shell/nav/portal-nav'
import { fetchAddresses } from '../account/api'
import { fetchStyle } from '../catalogue/api'
import { fetchOrder } from '../orders/api'
import { useOffline } from '../orders/hooks'
import { fetchRequests, fetchRequestsOpen, sendRequest, type RequestRow, type SendAnswer } from '../requests/api'
import { requestBandOf } from './band'
import { NS, stylesOf, todayIn } from './model'
import { closedRefusal, failedKey, goesToOf, openItems, receiptOf, reorderText, shipToChoices, stylesText, withCarried } from './request-model'
// B-TH-304
import { catalogueDoorOf } from './request-model'
import { RequestPageView, type RequestPageModel } from './view/RequestPageView'
// B-TH-282: the customer's files go right after Send, onto the new request (B-TH-085).
import { filesOutcome } from '../../../lib/request-compose/files'
import { useRequestFiles } from '../requests/use-request-files'
import { requestHref } from '../requests/model'
import { useOrderingWords } from './words'

/**
 * `/p/<party>/orders/new` for a customer — New order as an e-mail (B-TH-220, B-TH-303; threads plan P-CUS-NEW; Owner ask "send
 * orders exactly like an email"). Reads whether the company takes requests (GET /portal/inquiries/open: held BEFORE typing,
 * the API's own words), the person's delivery addresses (with portal.addresses.view) and its open requests (the side column),
 * keeps the draft on THIS device while it is typed (until drafts live on the server, N6), carries a catalogue style or a past
 * order into the message when the address names one (`styles=`, `reorder=&line=`), and sends POST /portal/inquiries with ONE
 * Idempotency-Key per content (a double click, a retry after a lost answer: one request). The body names no party and no
 * company: the session's (W11). Same words twice within ten minutes asks first. The receipt says the customer's own number.
 */
export function CustomerRequestPage() {
  return (
    <WithMessages namespaces={[NS, COMPOSE_NS, 'ds-words']}>
      <ComposeContainer />
    </WithMessages>
  )
}

type Async<T> = { state: 'loading' | 'error' | 'ready' | 'none'; value: T }

const storageOf = (): Storage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function ComposeContainer() {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const router = useRouter()
  const search = useSearchParams()
  const words = useOrderingWords()
  const { t, locale } = words
  const tc = useT(COMPOSE_NS)
  const offline = useOffline()
  const can = useCallback((permission: string) => frame.me.permissions.includes(permission), [frame.me.permissions])
  const preview = frame.me.preview
  const mayOrder = can('portal.orderRequests.manage')
  const today = todayIn()
  const keepKey = composeDraftKey(frame.me.user.id, frame.me.party.code)
  const sentKey = lastSentKey(frame.me.user.id, frame.me.party.code)

  const [open, setOpen] = useState<{ state: 'loading' | 'error' | 'ready'; open: boolean; reason: string | null; files: { open: boolean; words: string | null } }>({ state: 'loading', open: true, reason: null, files: { open: false, words: null } })
  // ---- B-TH-282: the files held in the page until Send (a file cannot exist before its request).
  const fileWords = useMemo(() => ({ network: tc('files.failed.network'), store: tc('files.failed.store'), refused: tc('files.failed.refused') }), [tc])
  const files = useRequestFiles(api, fileWords)
  // ---- end B-TH-282
  const [addresses, setAddresses] = useState<Async<ShipToChoice[]>>({ state: can('portal.addresses.view') ? 'loading' : 'none', value: [] })
  const [requests, setRequests] = useState<Async<RequestRow[]>>({ state: can('portal.salesOrders.view') ? 'loading' : 'none', value: [] })
  const [draft, setDraft] = useState<ComposeDraft>(EMPTY_COMPOSE)
  const [loaded, setLoaded] = useState(false)
  const [kept, setKept] = useState<RequestComposeModel['kept']>({ state: 'none' })
  const [shown, setShown] = useState<Partial<Record<ComposeField, true>>>({})
  const [refused, setRefused] = useState<Partial<Record<ComposeField, string>>>({})
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [same, setSame] = useState<LastSent | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [answer, setAnswer] = useState<{ answer: SendAnswer; draft: ComposeDraft } | null>(null)
  const [discardOpen, setDiscardOpen] = useState(false)
  const key = useRef<string | null>(null)
  const keepTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const carried = useRef(false)

  // ── reads ──
  const readOpen = useCallback(async () => {
    if (!mayOrder) return
    try {
      const answer = await fetchRequestsOpen(api)
      // B-TH-282: the files' own gate (the scanner's sentence while uploads from outside are closed); unknown = closed.
      setOpen({ state: 'ready', open: answer.open, reason: answer.reason ? answer.reason[locale] : null, files: answer.files ?? { open: false, words: null } })
    } catch {
      setOpen((current) => ({ ...current, state: 'error' }))
    }
  }, [api, mayOrder, locale])
  const readAddresses = useCallback(async () => {
    if (!can('portal.addresses.view')) return
    try {
      setAddresses({ state: 'ready', value: shipToChoices((await fetchAddresses(api)).addresses) })
    } catch {
      setAddresses((current) => ({ ...current, state: 'error' }))
    }
  }, [api, can])
  const readRequests = useCallback(async () => {
    if (!can('portal.salesOrders.view')) return
    try {
      setRequests({ state: 'ready', value: (await fetchRequests(api, { state: 'OPEN', limit: 20 })).rows })
    } catch {
      setRequests((current) => ({ ...current, state: 'error' }))
    }
  }, [api, can])
  useEffect(() => {
    void readOpen()
    void readAddresses()
    void readRequests()
  }, [readOpen, readAddresses, readRequests])
  usePortalLive({ onChange: (change) => (change.type.startsWith('inquiry.') ? void readRequests() : undefined), onReconnect: () => void readRequests() })

  // The draft kept on this device (read after mounting: the server and the first client render agree on an empty compose).
  useEffect(() => {
    const found = readKeptCompose(storageOf(), keepKey, Date.now())
    if (found) {
      setDraft(found.draft)
      setKept({ state: 'kept', at: formatTime(new Date(found.savedAt).toISOString(), { locale, timeZone: DEFAULT_TIME_ZONE }) })
      if (found.draft.customerRef || found.draft.wantedDate || found.draft.shipToAddressId) setDetailsOpen(true)
    }
    setLoaded(true)
    // Read once per person and portal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keepKey])

  const keep = useCallback(
    (next: ComposeDraft) => {
      const result = writeKeptCompose(storageOf(), keepKey, next, Date.now())
      if (result === 'failed') setKept({ state: 'failed' })
      else if (result === null) setKept({ state: 'none' })
      else setKept({ state: 'kept', at: formatTime(new Date(result.savedAt).toISOString(), { locale, timeZone: DEFAULT_TIME_ZONE }) })
    },
    [keepKey, locale],
  )
  useEffect(() => () => {
    if (keepTimer.current) clearTimeout(keepTimer.current)
  }, [])

  const change = useCallback(
    (field: ComposeField, value: string) => {
      setDraft((current) => {
        const next = { ...current, [field]: value }
        if (keepTimer.current) clearTimeout(keepTimer.current)
        keepTimer.current = setTimeout(() => keep(next), 600)
        return next
      })
      // New words are a new request: a new key; the "same words" question and a refusal at the field go.
      key.current = null
      setSame(null)
      setFailed(null)
      setRefused((current) => {
        if (!current[field]) return current
        const rest = { ...current }
        delete rest[field]
        return rest
      })
    },
    [keep],
  )

  // A style from the catalogue or a past order, carried into the message once (then the address forgets it).
  useEffect(() => {
    if (!loaded || carried.current || !mayOrder) return
    const styles = stylesOf(search?.get('styles'))
    const reorder = search?.get('reorder') ?? null
    const line = search?.get('line') ?? null
    if (styles.length === 0 && !reorder) return
    carried.current = true
    void (async () => {
      try {
        if (styles.length > 0) {
          const details = await Promise.all(styles.slice(0, 5).map((id) => fetchStyle(api, id).then((detail) => detail.style).catch(() => null)))
          const found = details.filter((style): style is NonNullable<typeof style> => style !== null)
          const text = stylesText(found, locale, t)
          if (text) {
            setDraft((current) => {
              const next = withCarried(current, text)
              keep(next)
              return next
            })
            setNotice(t('request.styleNotice', { count: found.length }))
          }
        } else if (reorder && /^[0-9a-f-]{36}$/i.test(reorder)) {
          const record = await fetchOrder(api, reorder)
          const text = reorderText(record, line, locale, t)
          setDraft((current) => {
            const next = withCarried(current, text)
            keep(next)
            return next
          })
          setNotice(t('request.reorderNotice', { yours: text.yours }))
        }
      } catch {
        // Nothing carried: the compose is as it was (a style or an order no longer theirs reads as none).
      } finally {
        router.replace(`${frame.prefix}/orders/new`, { scroll: false })
      }
    })()
  }, [loaded, mayOrder, search, api, locale, t, keep, router, frame.prefix])

  // ── send ──
  const closed = open.state === 'ready' && !open.open
  const held = sendHeld(draft, today, { preview, offline, sending, closed })
  const problems = useMemo(() => {
    const all = problemsOf(draft, today)
    const out: Partial<Record<ComposeField, string>> = { ...refused }
    for (const [field, problem] of Object.entries(all) as [ComposeField, string][]) if (shown[field]) out[field] = problem
    return out
  }, [draft, today, shown, refused])

  const send = useCallback(
    async (anyway = false): Promise<boolean> => {
      if (held) {
        setShown({ message: true, customerRef: true, wantedDate: true })
        if (problemsOf(draft, today).customerRef || problemsOf(draft, today).wantedDate) setDetailsOpen(true)
        return false
      }
      const previous = sameAsLast(draft, readLastSent(storageOf(), sentKey), Date.now())
      if (previous && !anyway) {
        setSame(previous)
        return false
      }
      key.current ??= newIdempotencyKey()
      setSending(true)
      setFailed(null)
      setSame(null)
      try {
        const result = await sendRequest(api, sendBodyOf(draft), key.current)
        writeLastSent(storageOf(), sentKey, { fingerprint: fingerprintOf(draft), at: Date.now(), yours: result.receipt.yourNumber?.words ?? null })
        writeKeptCompose(storageOf(), keepKey, EMPTY_COMPOSE, Date.now())
        if (keepTimer.current) clearTimeout(keepTimer.current)
        key.current = null
        setAnswer({ answer: result, draft })
        // B-TH-282: the held files go now, onto the new request (sent, held for the virus scan, or Retry on the receipt).
        if (files.held.some((file) => file.problem === null)) void files.send(result.request.id, 'request')
        setDraft(EMPTY_COMPOSE)
        setKept({ state: 'none' })
        setShown({})
        setRefused({})
        setNotice(null)
        frame.refreshTasks()
        void readRequests()
        return true
      } catch (error) {
        const kind = isApiError(error) ? error.kind : null
        if (isApiError(error) && kind === 'conflict' && closedRefusal(error.issues)) void readOpen()
        if (isApiError(error) && kind === 'invalid') {
          const at: Partial<Record<ComposeField, string>> = {}
          for (const issue of error.issues) {
            const field = fieldOfIssue(issuePath(issue).replace(/\./g, '/'))
            if (field === 'shipToAddressId') at.shipToAddressId = 'problem.shipTo'
            else if (field === 'wantedDate') at.wantedDate = 'problem.datePast'
            else if (field === 'message') at.message = 'problem.tooLong'
            else if (field === 'customerRef') at.customerRef = 'problem.refLong'
          }
          setRefused(at)
          if (at.shipToAddressId || at.wantedDate || at.customerRef) setDetailsOpen(true)
        }
        // A refusal is final for these words; a lost answer keeps the key, so sending again sends once.
        if (kind !== 'unavailable') key.current = null
        setFailed(t(failedKey(kind)))
        return false
      } finally {
        setSending(false)
      }
    },
    [held, draft, today, sentKey, api, keepKey, frame, readRequests, readOpen, t, files],
  )

  // Leaving loses nothing while the draft is kept here; without storage (a private window) it asks first.
  // B-TH-282: files held in the page are not kept on this device: leaving with them asks first too.
  const filesWaiting = !answer && files.held.some((file) => file.problem === null && file.state === 'held')
  usePortalUnsaved('portal:new-request', { dirty: (!answer && typedIn(draft) && kept.state !== 'kept') || filesWaiting, what: t('request.unsaved'), save: () => send() })

  const discard = () => {
    if (keepTimer.current) clearTimeout(keepTimer.current)
    writeKeptCompose(storageOf(), keepKey, EMPTY_COMPOSE, Date.now())
    setDraft(EMPTY_COMPOSE)
    setKept({ state: 'none' })
    setShown({})
    setRefused({})
    setFailed(null)
    setSame(null)
    setNotice(null)
    setDetailsOpen(false)
    setDiscardOpen(false)
    files.clear() // B-TH-282
    key.current = null
  }

  // ── the band and the page ──
  const phase: RequestPageModel['phase'] = !mayOrder ? 'noRight' : answer ? 'sent' : open.state === 'loading' || !loaded ? 'loading' : closed ? 'closed' : 'compose'
  usePortalBand(
    requestBandOf({
      words,
      phase,
      state: answer ? { label: answer.answer.request.state.words[locale], code: answer.answer.request.state.code } : null,
      customerRef: answer?.answer.request.customerRef ?? null,
    }),
  )
  const at = (iso: string) => formatDateTime(iso, { locale, timeZone: DEFAULT_TIME_ZONE })
  const choices = addresses.value
  const admins = (frame.access?.admins ?? []).map((admin) => admin.displayName)
  const returnsHref = can('portal.returns.view') && pageBuilt('returns') ? `${frame.prefix}/returns` : null

  return (
    <RequestPageView
      day={words.day}
      model={{
        phase,
        prefix: frame.prefix,
        closedWords: open.reason,
        admins,
        openCheckFailed: open.state === 'error',
        compose:
          phase === 'compose'
            ? {
                goesTo: goesToOf(frame.me.company.name, t),
                draft,
                today,
                problems,
                shipTo: { state: addresses.state, choices },
                detailsOpen,
                kept,
                offline,
                readOnly: preview,
                sending,
                sendHeld: held ? tc(held) : null,
                failed,
                same: same ? { at: formatTime(new Date(same.at).toISOString(), { locale, timeZone: DEFAULT_TIME_ZONE }), yours: same.yours ? same.yours[locale] : null } : null,
                filesHeld: open.files.words ?? tc('files.closed'),
                notice,
              }
            : null,
        // B-TH-282: the files area — open, or the API's sentence while uploads from outside are closed.
        files:
          phase === 'compose'
            ? { open: open.files.open, closedWords: open.files.words, held: files.held, leftOut: files.leftOut, when: 'hold', readOnly: preview, heldReason: preview ? tc('held.preview') : null }
            : null,
        receiptFiles: answer && files.held.length > 0 ? { held: files.held, openHref: requestHref(frame.prefix, answer.answer.request.id) } : null,
        aside: {
          open: { state: requests.state, items: openItems(requests.value, frame.prefix, locale, at) },
          allHref: pageBuilt('orders.list') ? `${frame.prefix}/orders?chip=REQUESTED` : null,
          returnsHref,
          // B-TH-304: the catalogue door, open again (catalogue orders land in Sales › Incoming; no answer-time promise).
          catalogue: catalogueDoorOf(frame.prefix),
        },
        receipt: answer ? receiptOf(answer.answer, answer.draft, choices, frame.prefix, at) : null,
        discardOpen,
      }}
      actions={{
        compose: {
          onChange: change,
          onLeave: (field) => setShown((current) => (current[field] ? current : { ...current, [field]: true })),
          onDetails: setDetailsOpen,
          onSend: () => void send(),
          onSendAnyway: () => void send(true),
          onDiscard: () => (typedIn(draft) ? setDiscardOpen(true) : discard()),
          onRetryKeep: () => keep(draft),
          onRetryShipTo: () => {
            setAddresses({ state: 'loading', value: [] })
            void readAddresses()
          },
          onDismissNotice: () => setNotice(null),
        },
        onRetryOpen: () => {
          setOpen((current) => ({ ...current, state: 'loading' }))
          void readOpen()
        },
        onRetryList: () => {
          setRequests({ state: 'loading', value: [] })
          void readRequests()
        },
        onAsk: () => frame.ask(null),
        onNewOrder: () => {
          setAnswer(null)
          setDetailsOpen(false)
          files.clear() // B-TH-282
        },
        onDiscardConfirm: discard,
        onDiscardCancel: () => setDiscardOpen(false),
        // ---- B-TH-282
        files: {
          onDrop: files.add,
          onSheet: files.sheet,
          onRemove: files.remove,
        },
        onRetryFiles: () => {
          if (answer && filesOutcome(files.held).failed > 0) void files.send(answer.answer.request.id, 'request')
        },
        // ---- end B-TH-282
      }}
    />
  )
}
