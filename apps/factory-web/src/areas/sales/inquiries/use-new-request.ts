'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { businessDate } from '@nexus/factory-domain/core/time'
import { isApiError } from '../../../lib/api/errors'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import type { ComposeField } from '../../../lib/request-compose/model'
import {
  createFromMail,
  createInquiry,
  findStyles,
  listRequestCustomers,
  readCustomerFacts,
  readMailDraft,
  readMailVersion,
  readStyle,
  uploadFile,
  uploadRefusal,
  type ContactOption,
  type InquiryView,
  type MailDraft,
  type RequestCustomers,
  type StyleOption,
} from './api'
import { fieldLines, readProblem, writeProblem, type InquiriesCan, type Loaded, type Notice } from './model'
import { composeRefusals, emptyNewRequest, fromMailRequestBody, newRequestBody, newRequestFromMail, newRequestHeld, newRequestTyped, shipToOf, withWho, type NewRequestDraft, type Who } from './new-request'
import type { StyleRead } from './view/LinesEditor'
import type { NewRequestActions, NewRequestModel } from './view/NewRequestDialog'

/**
 * New request's container (B-TH-221; SCR-105-new): open while the address says `?new=1` (or `?mail=<id>` for "Make incoming
 * request" from Mail to sort). It reads the customers this person may make a request for (GET /sales/inquiries/customers, wall
 * W23: never another customer's name), the picked customer's contacts and delivery addresses, the styles of the lines and, for
 * a mail, what the API made of it; it keeps the draft while the window is open (closing with typed text asks first), sends ONE
 * Idempotency-Key per attempt (a double click is one request; a stale mail keeps it for the retry), then adds the files picked
 * (office only) and hands the made request back. The words it shows are phrases of the dialog's catalogues.
 */

interface State {
  draft: NewRequestDraft
  mail: { id: string; draft: Loaded<MailDraft> } | null
  contacts: { items: ContactOption[] | null; problem: string | null } | null
  shipTo: NewRequestModel['shipTo']
  files: Array<{ key: string; file: File }>
  detailsOpen: boolean
  shown: Partial<Record<ComposeField, true>>
  tried: boolean
  refused: Partial<Record<ComposeField, string>>
  busy: boolean
  notice: Notice | null
  leaving: boolean
}

let fileSeq = 0
const DEFAULT_CURRENCY = 'EUR'

export interface NewRequestFacts {
  readonly open: boolean
  readonly mailId: string | null
  readonly api: ApiClient
  readonly companyId: string | null
  readonly can: InquiriesCan
  readonly me: string
  readonly offline: boolean
  /** The company numbers no request yet (read for who may read the numbering). */
  readonly unnumbered: boolean
  /** The made request (and how many files could not be added). */
  readonly onDone: (inquiry: InquiryView, failedFiles: number) => void
  /** The window closes (the address loses `?new=1` / `?mail=`). */
  readonly onClose: () => void
}

export function useNewRequest(facts: NewRequestFacts): { model: NewRequestModel | null; actions: NewRequestActions } {
  const { open, mailId, api, companyId, can, offline, unnumbered } = facts
  const latest = useRef(facts)
  latest.current = facts
  const [state, setState] = useState<State | null>(null)
  const [customers, setCustomers] = useState<NewRequestModel['customers']>({ state: 'loading', items: [], total: 0, limited: false })
  const [customersTick, setCustomersTick] = useState(0)
  const [shipToTick, setShipToTick] = useState(0)
  const [styles, setStyles] = useState<{ items: StyleOption[] | null; problem: string | null } | null>(null)
  const [details, setDetails] = useState<Record<string, StyleRead>>({})
  const detailsRef = useRef(details)
  detailsRef.current = details
  const key = useRef<string | null>(null)
  const update = useCallback((patch: (now: State) => Partial<State>) => setState((now) => (now ? { ...now, ...patch(now) } : now)), [])

  // ── the window opens: a fresh draft, or the mail's ──
  useEffect(() => {
    if (!open || !can.view) {
      setState(null)
      return
    }
    key.current = null
    setState({ draft: emptyNewRequest(DEFAULT_CURRENCY), mail: mailId ? { id: mailId, draft: { status: 'loading' } } : null, contacts: null, shipTo: { state: 'none', choices: [] }, files: [], detailsOpen: false, shown: {}, tried: false, refused: {}, busy: false, notice: null, leaving: false })
    if (!mailId) return
    readMailDraft(api, mailId)
      .then((value) => setState((now) => (now ? { ...now, mail: { id: mailId, draft: { status: 'ready', value } }, draft: newRequestFromMail(value, DEFAULT_CURRENCY) } : now)))
      .catch((error: unknown) => {
        const kind = isApiError(error) ? error.kind : null
        setState((now) => (now ? { ...now, mail: { id: mailId, draft: kind === 'not_found' ? { status: 'notFound' } : kind === 'forbidden' ? { status: 'forbidden' } : { status: 'error', problem: readProblem(error) } } } : now))
      })
  }, [open, mailId, can.view, api])

  // ── the customers this person may make a request for (W23) ──
  useEffect(() => {
    if (!open || !companyId) return
    if (!can.parties || !can.manage) {
      setCustomers({ state: 'none', items: [], total: 0, limited: false })
      return
    }
    const controller = new AbortController()
    setCustomers((now) => ({ ...now, state: 'loading' }))
    listRequestCustomers(api, companyId, controller.signal)
      .then((answer: RequestCustomers) => setCustomers({ state: 'ready', items: answer.customers, total: answer.total, limited: answer.limited }))
      .catch(() => !controller.signal.aborted && setCustomers({ state: 'error', items: [], total: 0, limited: false }))
    return () => controller.abort()
  }, [open, companyId, can.parties, can.manage, api, customersTick])

  // ── the styles of the lines ──
  useEffect(() => {
    if (!open || !can.styles || styles) return
    setStyles({ items: null, problem: null })
    findStyles(api, '')
      .then((items) => setStyles({ items, problem: null }))
      .catch((error: unknown) => setStyles({ items: [], problem: readProblem(error) }))
  }, [open, can.styles, styles, api])
  const readDetail = useCallback(
    (styleId: string) => {
      if (!can.styles || detailsRef.current[styleId]) return
      setDetails((now) => ({ ...now, [styleId]: { status: 'loading' } }))
      readStyle(api, styleId)
        .then((value) => setDetails((now) => ({ ...now, [styleId]: { status: 'ready', value } })))
        .catch(() => setDetails((now) => ({ ...now, [styleId]: { status: 'error' } })))
    },
    [api, can.styles],
  )

  // ── the picked customer's contacts and delivery addresses ──
  const party = state?.draft.who === 'customer' ? state.draft.partyId : null
  useEffect(() => {
    if (!party || !can.parties) {
      setState((now) => (now && (now.contacts || now.shipTo.state !== 'none') ? { ...now, contacts: null, shipTo: { state: 'none', choices: [] } } : now))
      return
    }
    const controller = new AbortController()
    setState((now) => (now ? { ...now, contacts: { items: null, problem: null }, shipTo: { state: 'loading', choices: [] } } : now))
    readCustomerFacts(api, party, controller.signal)
      .then((read) => setState((now) => (now ? { ...now, contacts: { items: read.contacts, problem: null }, shipTo: { state: 'ready', choices: shipToOf(read.addresses) } } : now)))
      .catch((error: unknown) => !controller.signal.aborted && setState((now) => (now ? { ...now, contacts: { items: null, problem: readProblem(error) }, shipTo: { state: 'error', choices: [] } } : now)))
    return () => controller.abort()
  }, [party, can.parties, api, shipToTick])

  const today = businessDate(new Date())

  const submit = useCallback(async () => {
    const now = state
    const { companyId: company, can: rights, me: person, offline: away, unnumbered: closed } = latest.current
    if (!now || now.busy || !company) return
    const mail = now.mail ? (now.mail.draft.status === 'ready' ? now.mail.draft.value : null) : null
    if (now.mail && !mail) return
    if (newRequestHeld(now.draft, { can: rights, offline: away, busy: false, fromMail: !!now.mail, unnumbered: closed, today })) {
      update(() => ({ tried: true }))
      return
    }
    update(() => ({ busy: true, notice: null, tried: true, refused: {} }))
    key.current ??= newIdempotencyKey()
    try {
      let inquiry: InquiryView
      if (now.mail && mail) {
        const version = await readMailVersion(api, now.mail.id)
        inquiry = await createFromMail(api, now.mail.id, fromMailRequestBody(now.draft, mail, version, rights, person, company), key.current)
      } else {
        inquiry = await createInquiry(api, newRequestBody(now.draft, company, rights, person), key.current)
      }
      key.current = null
      let failed = 0
      for (const { file } of now.files) {
        if (uploadRefusal(file)) {
          failed += 1
          continue
        }
        try {
          await uploadFile(api, inquiry, file)
        } catch {
          failed += 1
        }
      }
      setState(null)
      latest.current.onDone(inquiry, failed)
    } catch (error) {
      const refused = writeProblem(error)
      if (!refused.stale) key.current = null
      const atFields = composeRefusals(refused.paths)
      const others = refused.paths.filter((path) => Object.keys(composeRefusals([path])).length === 0)
      update(() => ({ busy: false, refused: atFields, detailsOpen: now.detailsOpen || 'customerRef' in atFields || 'wantedDate' in atFields || 'shipToAddressId' in atFields, notice: { key: refused.key, params: refused.params, tone: 'danger', lines: fieldLines(others) } }))
    }
  }, [state, api, today, update])

  const actions = useMemo<NewRequestActions>(
    () => ({
      onDraft: (patch) => update((now) => ({ draft: { ...now.draft, ...patch }, leaving: false })),
      onCompose: (field, value) => update((now) => ({ draft: { ...now.draft, compose: { ...now.draft.compose, [field]: value } }, refused: { ...now.refused, [field]: undefined }, leaving: false })),
      onLeaveField: (field) => update((now) => ({ shown: { ...now.shown, [field]: true } })),
      onDetails: (detailsOpen) => update(() => ({ detailsOpen })),
      onWho: (who: Who) => update((now) => ({ draft: withWho(now.draft, who, who === 'customer' ? now.draft.partyId : null) })),
      onCustomer: (partyId) => update((now) => ({ draft: withWho(now.draft, 'customer', partyId), refused: { ...now.refused, shipToAddressId: undefined } })),
      onRetryCustomers: () => setCustomersTick((tick) => tick + 1),
      onRetryShipTo: () => setShipToTick((tick) => tick + 1),
      onStyle: readDetail,
      onFiles: (files) => update((now) => ({ files: [...now.files, ...files.map((file) => ({ key: `f${++fileSeq}`, file }))] })),
      onRemoveFile: (fileKey) => update((now) => ({ files: now.files.filter((one) => one.key !== fileKey) })),
      onSubmit: () => void submit(),
      onClose: () => {
        const now = state
        if (now && !now.busy && (newRequestTyped(now.draft) || now.files.length > 0) && !now.leaving) update(() => ({ leaving: true }))
        else if (!now?.busy) latest.current.onClose()
      },
      onDiscard: () => latest.current.onClose(),
      onKeepWriting: () => update(() => ({ leaving: false })),
    }),
    [update, readDetail, submit, state],
  )

  const model: NewRequestModel | null = state
    ? {
        draft: state.draft,
        mail: state.mail,
        customers,
        contacts: state.contacts,
        shipTo: state.shipTo,
        styles: can.styles ? styles : null,
        details,
        files: state.files.map(({ key: fileKey, file }) => ({ key: fileKey, name: file.name, size: file.size, problem: uploadRefusal(file) })),
        detailsOpen: state.detailsOpen,
        shown: state.shown,
        tried: state.tried,
        refused: Object.fromEntries(Object.entries(state.refused).filter(([, value]) => value !== undefined)) as NewRequestModel['refused'],
        busy: state.busy,
        notice: state.notice,
        offline,
        unnumbered,
        today,
        leaving: state.leaving,
      }
    : null
  return { model, actions }
}
