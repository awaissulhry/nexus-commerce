'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { WithMessages } from '../../../record-panels/i18n'
import { usePortalApi, usePortalBand, usePortalFrame, usePortalLive, usePortalUnsaved } from '../../shell/frame'
import { fetchCases, fetchComplaints, fetchReturnable, isCaseChip, reportComplaint, requestReturn, type CaseChip, type CaseItem, type CasesRead, type ReturnableRead } from './api'
import { listBandOf } from './band'
import { saveText, useOffline } from './hooks'
import { caseHref, casesCsv, complaintBodyOf, EMPTY_START, listQuery, nextStep, NS, refusalKey, returnBodyOf, sendHeld, startDirty, startHeld, type StartDraft } from './model'
import { fetchRepairs, requestRepair } from './repair/api'
import { NS as REPAIR_NS, repairBodyOf, repairHref, repairRefusalKey } from './repair/model'
import type { RepairsSectionModel } from './repair/RepairsSection'
import { NotInAccess } from './view/parts'
import { ReturnsListView, type ReturnsListViewModel } from './view/ReturnsListView'
import type { StartDialogModel } from './view/StartDialog'
import { useReturnWords } from './words'

/**
 * `/p/<party>/returns` for a customer (B-W2b-197; design portal.customer.returns, SCR-187): reads the cases (GET
 * /portal/returns with the address's chip and search) and — for the Quality role — the complaints (GET /portal/complaints),
 * fills the band (Updated, Start a return or claim), keeps the selection (Export N), tells of changes on the live channel
 * without moving the rows ("N updates · Show"), keeps what was loaded when the connection is gone, and runs "Start a
 * return or claim" (GET …/returnable, then POST /portal/returns or /portal/complaints with one Idempotency-Key per body).
 * `?start=RETURN|COMPLAINT&order=<sales order id>` opens the start (an order's line can link here).
 */
export function CustomerReturnsPage() {
  return (
    <WithMessages namespaces={[NS, REPAIR_NS, 'ds-words', 'lists']}>
      <Suspense fallback={null}>
        <ReturnsRoute />
      </Suspense>
    </WithMessages>
  )
}

/** The page is a customer's with the Returns & claims permission; anyone else reads "not part of your access". */
export const readsReturns = (frame: Pick<ReturnType<typeof usePortalFrame>, 'kinds' | 'me'>): boolean => frame.kinds.includes('CUSTOMER') && frame.me.permissions.includes('portal.returns.view')

function ReturnsRoute() {
  const frame = usePortalFrame()
  const { t } = useReturnWords()
  if (!readsReturns(frame)) return <Closed title={t('list.title')} />
  return <ListContainer />
}

export function Closed({ title }: { title: string }) {
  const frame = usePortalFrame()
  usePortalBand({ title })
  return <NotInAccess admins={(frame.access?.admins ?? []).map((admin) => admin.displayName)} homeHref={frame.prefix} />
}

type StartState = { draft: StartDraft; read: { state: 'loading' | 'error' | 'ready'; read: ReturnableRead | null }; problems: Record<string, string>; busy: boolean; problem: string | null; discard: boolean; order: string | null; sent: StartDialogModel['sent'] }

function ListContainer() {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const search = useSearchParams()
  const words = useReturnWords()
  const { t, locale, at } = words
  const offline = useOffline()
  const chipParam = search?.get('chip') ?? null
  const chip: CaseChip | null = isCaseChip(chipParam) ? chipParam : null
  const q = search?.get('q') ?? ''
  const can = (permission: string) => frame.me.permissions.includes(permission)
  const readsComplaints = can('portal.complaints.view')
  const who = { preview: frame.me.preview, mayRequest: can('portal.returns.request'), offline }
  const whoNow = useRef(who)
  whoNow.current = who

  const [read, setRead] = useState<CasesRead | null>(null)
  const [state, setState] = useState<'loading' | 'error' | 'ready' | 'forbidden'>('loading')
  const [selected, setSelected] = useState<string[]>([])
  const [updates, setUpdates] = useState(0)
  const [complaints, setComplaints] = useState<ReturnsListViewModel['complaints']>({ state: readsComplaints ? 'loading' : 'hidden', read: null })
  const [start, setStart] = useState<StartState | null>(null)
  // B-W2b-342: the customer's repairs (their own section, read beside the cases).
  const [repairs, setRepairs] = useState<RepairsSectionModel>({ state: 'loading', read: null })
  const [loadedAt, setLoadedAt] = useState<string | null>(null)
  const reading = useRef<AbortController | null>(null)
  const writeKey = useRef<{ body: string; key: string } | null>(null)
  const keyFor = (body: unknown) => {
    const text = JSON.stringify(body)
    if (writeKey.current?.body !== text) writeKey.current = { body: text, key: newIdempotencyKey() }
    return writeKey.current.key
  }

  const load = useCallback(async () => {
    reading.current?.abort()
    const control = new AbortController()
    reading.current = control
    try {
      const next = await fetchCases(api, { chip, q }, control.signal)
      if (control.signal.aborted) return
      setRead(next)
      setLoadedAt(next.asOf)
      setState('ready')
      setUpdates(0)
      setSelected((current) => current.filter((key) => next.items.some((row) => `${row.type}:${row.id}` === key)))
    } catch (error) {
      if (control.signal.aborted) return
      setState(isApiError(error) && error.kind === 'forbidden' ? 'forbidden' : 'error')
    }
  }, [api, chip, q])

  const loadComplaints = useCallback(async () => {
    if (!readsComplaints) return
    try {
      setComplaints({ state: 'ready', read: await fetchComplaints(api) })
    } catch (error) {
      setComplaints((current) => (isApiError(error) && error.kind === 'forbidden' ? { state: 'hidden', read: null } : { state: 'error', read: current.read }))
    }
  }, [api, readsComplaints])

  useEffect(() => {
    setState((current) => (current === 'ready' ? current : 'loading'))
    void load()
    return () => reading.current?.abort()
  }, [load])
  useEffect(() => {
    void loadComplaints()
  }, [loadComplaints])
  const loadRepairs = useCallback(async () => {
    try {
      setRepairs({ state: 'ready', read: await fetchRepairs(api) })
    } catch {
      setRepairs((current) => ({ state: 'error', read: current.read }))
    }
  }, [api])
  useEffect(() => {
    void loadRepairs()
  }, [loadRepairs])

  // A hint on the live channel (the bell's news of a decision, a parcel received, an answer; a question from us): the rows
  // never move under the pointer — "N updates · Show".
  usePortalLive({
    onChange: (change) => {
      if (change.type === 'partner_notification.created' || change.type.startsWith('partner_task.')) setUpdates((count) => count + 1)
    },
    onReconnect: () => setUpdates((count) => count + 1),
  })

  // ── Start a return or claim ────────────────────────────────────────────────────────────────────────────────────────
  const loadReturnable = useCallback(
    async (order: string | null) => {
      setStart((current) => (current ? { ...current, read: { state: 'loading', read: current.read.read } } : current))
      try {
        const next = await fetchReturnable(api, order)
        setStart((current) => (current ? { ...current, read: { state: 'ready', read: next } } : current))
      } catch {
        setStart((current) => (current ? { ...current, read: { state: 'error', read: current.read.read } } : current))
      }
    },
    [api],
  )

  const openStart = useCallback(
    (type: 'RETURN' | 'COMPLAINT' | 'REPAIR' | null = null, order: string | null = null) => {
      if (startHeld(whoNow.current)) return
      writeKey.current = null
      setStart({ draft: { ...EMPTY_START, type, step: type ? 'details' : 'type' }, read: { state: 'loading', read: null }, problems: {}, busy: false, problem: null, discard: false, order, sent: null })
      void loadReturnable(order)
    },
    [loadReturnable],
  )

  // `?start=RETURN|COMPLAINT&order=<id>`: open once, then leave the address clean.
  const startParam = search?.get('start') ?? null
  const orderParam = search?.get('order') ?? null
  useEffect(() => {
    if (!startParam) return
    openStart(startParam === 'RETURN' || startParam === 'COMPLAINT' || startParam === 'REPAIR' ? startParam : null, orderParam)
    router.replace(`${pathname}${listQuery(chip, q)}`, { scroll: false })
  }, [startParam, orderParam, openStart, router, pathname, chip, q])

  const dirty = start !== null && !start.sent && startDirty(start.draft)
  usePortalUnsaved('returns-start', { dirty, what: t('unsaved.start') })

  const patchDraft = (patch: Partial<StartDraft>) => setStart((current) => (current ? { ...current, problem: null, discard: false, draft: { ...current.draft, ...patch } } : current))

  const send = () => {
    if (!start || start.busy || !start.read.read) return
    const held = sendHeld(start.draft, start.read.read, { ...who, busy: start.busy })
    if (held) return
    const draft = start.draft
    const returnable = start.read.read
    setStart({ ...start, busy: true, problem: null })
    const call: Promise<{ id: string; sent: { number: string; answerBy: string | null } }> =
      draft.type === 'REPAIR'
        ? (() => {
            const body = repairBodyOf(draft, returnable)
            return requestRepair(api, body, keyFor(body))
          })()
        : draft.type === 'RETURN'
          ? (() => {
              const body = returnBodyOf(draft, returnable)
              return requestReturn(api, body, keyFor(body))
            })()
          : (() => {
              const body = complaintBodyOf(draft, returnable)
              return reportComplaint(api, body, keyFor(body))
            })()
    call
      .then((answer) => {
        writeKey.current = null
        const href = draft.type === 'REPAIR' ? repairHref(frame.prefix, answer.id, 'request') : caseHref(frame.prefix, draft.type ?? 'RETURN', answer.id, 'request')
        setStart((current) => (current ? { ...current, busy: false, sent: { type: draft.type ?? 'RETURN', number: answer.sent.number, answerBy: answer.sent.answerBy, href } } : current))
        void load()
        void loadComplaints()
        void loadRepairs()
        frame.refreshTasks()
      })
      .catch((error: unknown) => {
        const key = draft.type === 'REPAIR' ? `${REPAIR_NS}:${repairRefusalKey(error)}` : refusalKey(error)
        setStart((current) => (current ? { ...current, busy: false, problem: key } : current))
        if (key === 'start.problem.tooManyNow') void loadReturnable(start.order)
      })
  }

  const exportRows = (keys: readonly string[]) => {
    const rows = (read?.items ?? []).filter((row) => keys.includes(`${row.type}:${row.id}`))
    saveText(`${t('list.fileName')}.csv`, casesCsv(rows, t, locale, at))
  }

  const go = (nextChip: CaseChip | null, nextQ: string) => router.replace(`${pathname}${listQuery(nextChip, nextQ)}`, { scroll: false })
  const startHeldKey = startHeld(who)
  usePortalBand(state === 'forbidden' ? { title: t('list.title') } : listBandOf({ words, asOf: read?.asOf ?? null, startHeld: startHeldKey ? t(startHeldKey) : null, onStart: () => openStart() }))

  if (state === 'forbidden') return <NotInAccess admins={(frame.access?.admins ?? []).map((admin) => admin.displayName)} homeHref={frame.prefix} />

  const startModel: StartDialogModel | null = start
    ? {
        state: start.read.state,
        read: start.read.read,
        draft: start.draft,
        problems: start.draft.tried ? start.problems : {},
        held: sendHeld(start.draft, start.read.read, { ...who, busy: start.busy }),
        busy: start.busy,
        problem: start.problem,
        discard: start.discard,
        sent: start.sent,
      }
    : null

  return (
    <ReturnsListView
      model={{
        state: state === 'loading' && !read ? 'loading' : state === 'error' ? 'error' : 'ready',
        read,
        chip,
        q,
        prefix: frame.prefix,
        selected,
        updates,
        offlineSince: offline ? loadedAt : null,
        complaints,
        repairs,
        startHeld: startHeldKey ? t(startHeldKey) : null,
        start: startModel,
      }}
      actions={{
        onChip: (next) => go(next, q),
        onSearch: (next) => go(chip, next),
        onClear: () => go(null, ''),
        onSelect: setSelected,
        onOpen: (row: CaseItem) => router.push(caseHref(frame.prefix, row.type, row.id)),
        onOpenComplaint: (id) => router.push(caseHref(frame.prefix, 'COMPLAINT', id)),
        onOpenRepair: (id) => router.push(repairHref(frame.prefix, id)),
        onRetryRepairs: () => {
          setRepairs({ state: 'loading', read: null })
          void loadRepairs()
        },
        onRetry: () => {
          setState('loading')
          void load()
        },
        onRetryComplaints: () => {
          setComplaints({ state: 'loading', read: null })
          void loadComplaints()
        },
        onShowUpdates: () => {
          void load()
          void loadComplaints()
          void loadRepairs()
        },
        onExport: exportRows,
        onStart: () => openStart(),
        start: {
          onType: (type) => patchDraft({ type }),
          onLine: (key, patch) =>
            setStart((current) => {
              if (!current) return current
              const line = current.draft.lines[key] ?? { picked: false, quantity: '1', reasonCode: '', reasonNote: '', serial: '' }
              return { ...current, problem: null, draft: { ...current.draft, lines: { ...current.draft.lines, [key]: { ...line, ...patch } } } }
            }),
          onDraft: patchDraft,
          onNext: () =>
            setStart((current) => {
              if (!current || current.busy) return current
              const next = nextStep(current.draft, current.read.read)
              if ('step' in next) return { ...current, problems: {}, draft: { ...current.draft, step: next.step, tried: false } }
              return { ...current, problems: next.problems, draft: { ...current.draft, tried: true } }
            }),
          onBack: () => setStart((current) => (current && !current.busy ? { ...current, problem: null, draft: { ...current.draft, step: current.draft.step === 'review' ? 'details' : 'type' } } : current)),
          onSend: send,
          onClose: () => setStart((current) => (!current || current.busy ? current : !current.sent && startDirty(current.draft) ? { ...current, discard: true } : null)),
          onDiscard: () => setStart(null),
          onStay: () => setStart((current) => (current ? { ...current, discard: false } : current)),
          onRetry: () => void loadReturnable(start?.order ?? null),
        },
      }}
    />
  )
}
