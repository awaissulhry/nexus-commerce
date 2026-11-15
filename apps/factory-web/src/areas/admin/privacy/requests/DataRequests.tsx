'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { companyPrefix } from '../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { downloadText, useCoalesced, useLive } from '../../../_shared/buying/hooks'
import { isStepUpCancelled } from '../../shared/step-up'
import { useFreshCode } from '../../security/step-up/fresh'
import { erasePerson, erasurePreview } from '../erase/api'
import type { EraseModel } from '../erase/model'
import { LOADING, todayIn, type Read } from '../model'
import {
  checkIdentity,
  collectPackage,
  contactsOf,
  createRequest,
  extendRequest,
  findCustomers,
  findEmployees,
  findProspects,
  findReports,
  findUsers,
  finishRequest,
  getRequest,
  listRequests,
  packageLink,
  refuseRequest,
  withdrawRequest,
  type DataRequest,
  type PersonOption,
  type RequestList,
} from './api'
import {
  emptyDraft,
  formHeld,
  isRequestEvent,
  newRequestHeld,
  problemOf,
  requestsAddressOf,
  requestsCan,
  requestsCsv,
  withRequestsAddress,
  type NewRequestModel,
  type RequestDialogModel,
  type RequestsAddress,
  type RequestsViewModel,
} from './model'
import { RequestsView } from './view/RequestsView'

const TIME_ZONE = 'Europe/Rome'
/** While a package is being collected and the live stream is away, the open request is read again this often. */
const COLLECT_POLL_MS = 5000

/**
 * Admin › Privacy › Data requests, live (B-W2b-414 on B-W2b-405's API): the list of the page's company in the address
 * (`?view=requests&requests=&kind=`), the request open in its dialog (`&request=<id>`), New data request (`&new=1`, the page
 * head's primary button), the erasure behind a fresh code asked FIRST (it always asks one), every write a command with its
 * version and Idempotency-Key. Live privacy.request_changed reads the open request again and puts the list's changes behind
 * "N updates · Show".
 */
export function DataRequests({ companyId, companies }: { companyId: string | null; companies: readonly { id: string; name: string }[] }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const can = useMemo(() => requestsCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const address = requestsAddressOf(params)
  const fresh = useFreshCode(api)

  const [list, setList] = useState<Read<RequestList>>(LOADING)
  const [now, setNow] = useState(() => Date.now())
  const [selected, setSelected] = useState<readonly string[]>([])
  const [updates, setUpdates] = useState(0)
  const [dialog, setDialog] = useState<RequestDialogModel | null>(null)
  const [creating, setCreating] = useState<NewRequestModel | null>(null)
  const [erase, setErase] = useState<EraseModel | null>(null)
  const [notice, setNotice] = useState<RequestsViewModel['notice']>(null)
  /** Requests this page just changed: their live echo reads the list again instead of counting as someone else's update. */
  const mine = useRef<Map<string, number>>(new Map())
  const keys = useRef<Record<string, string>>({})
  const keyFor = (name: string) => (keys.current[name] ??= newIdempotencyKey())
  const forget = (name: string) => delete keys.current[name]

  const go = useCallback(
    (change: Partial<RequestsAddress>) => router.replace(`${pathname}?${withRequestsAddress(params?.toString() ?? '', change)}`, { scroll: false }),
    [params, pathname, router],
  )

  // ---- the list ----
  const load = useCallback(async () => {
    if (!can.view) return
    try {
      const value = await listRequests(api, { companyId, view: address.view, kind: address.kind })
      setList({ value, problem: null })
      setNow(Date.now())
      setUpdates(0)
    } catch (error) {
      setList({ value: null, problem: problemOf(error) })
    }
  }, [api, can.view, companyId, address.view, address.kind])
  useEffect(() => {
    setList(LOADING)
    void load()
  }, [load])

  // ---- the request open in its dialog ----
  const readRequest = useCallback(
    async (requestId: string) => {
      try {
        const found = await getRequest(api, requestId)
        // A package that became ready (or failed) ends the "collecting" notice.
        setDialog((current) => (current?.requestId === requestId ? { ...current, read: { value: found, problem: null }, done: current.done === 'dp.done.collecting' && found.collect?.state !== 'RUNNING' ? null : current.done } : current))
      } catch (error) {
        setDialog((current) => (current?.requestId === requestId ? { ...current, read: { value: null, problem: problemOf(error) } } : current))
      }
    },
    [api],
  )
  useEffect(() => {
    if (!address.request) return setDialog(null)
    setDialog((current) => (current?.requestId === address.request ? current : { requestId: address.request!, read: LOADING, form: null, busy: false, problem: null, done: null }))
    void readRequest(address.request)
  }, [address.request, readRequest])

  const collecting = dialog?.read.value?.collect?.state === 'RUNNING' ? dialog.requestId : null

  // ---- live ----
  const refresh = useCoalesced(() => void load(), 800)
  const live = useLive(
    (change) => {
      if (!isRequestEvent(change.type)) return
      const requestId = typeof change.fields.requestId === 'string' ? change.fields.requestId : ''
      if (dialog && requestId === dialog.requestId) void readRequest(dialog.requestId)
      if ((dialog && requestId === dialog.requestId) || Date.now() - (mine.current.get(requestId) ?? 0) < 15_000) refresh()
      else setUpdates((count) => count + 1)
    },
    () => void load(),
    can.view,
  )
  useEffect(() => {
    if (!collecting || live === 'live') return
    const timer = setInterval(() => void readRequest(collecting), COLLECT_POLL_MS)
    return () => clearInterval(timer)
  }, [collecting, live, readRequest])

  // ---- writes on the open request ----
  const patchDialog = (change: Partial<RequestDialogModel>) => setDialog((current) => (current ? { ...current, ...change } : current))
  const settle = (found: DataRequest, done: string | null) => {
    setDialog((current) => (current?.requestId === found.id ? { ...current, read: { value: found, problem: null }, form: null, busy: false, problem: null, done } : current))
    void load()
  }
  const run = async (name: string, work: (key: string) => Promise<DataRequest>, done: string) => {
    patchDialog({ busy: true, problem: null, done: null })
    if (dialog) mine.current.set(dialog.requestId, Date.now())
    try {
      const found = await work(keyFor(name))
      forget(name)
      settle(found, done)
    } catch (error) {
      patchDialog({ busy: false, problem: problemOf(error) })
      if (dialog) void readRequest(dialog.requestId)
    }
  }

  const submitForm = () => {
    const request = dialog?.read.value
    const form = dialog?.form
    if (!request || !form || formHeld(form)) return
    if (form.name === 'identity') return void run(`identity:${request.id}`, (key) => checkIdentity(api, request, form.how.trim(), key), 'dp.done.identity')
    if (form.name === 'extend') return void run(`extend:${request.id}`, (key) => extendRequest(api, request, form.months, form.reason.trim(), key), 'dp.done.extended')
    if (form.name === 'refuse') return void run(`refuse:${request.id}`, (key) => refuseRequest(api, request, form.reason.trim(), key), 'dp.done.refused')
    return void run(`withdraw:${request.id}`, (key) => withdrawRequest(api, request, form.reason.trim(), key), 'dp.done.withdrawn')
  }

  const collect = () => {
    const request = dialog?.read.value
    if (request) void run(`collect:${request.id}`, (key) => collectPackage(api, request.id, key), 'dp.done.collecting')
  }
  const finish = () => {
    const request = dialog?.read.value
    if (request) void run(`done:${request.id}`, (key) => finishRequest(api, request, key), 'dp.done.finished')
  }
  const download = async () => {
    const request = dialog?.read.value
    if (!request) return
    try {
      window.open(await packageLink(api, request.id), '_blank', 'noopener')
    } catch (error) {
      patchDialog({ problem: problemOf(error) })
    }
  }

  // ---- Anonymise …? ----
  const readPreview = useCallback(
    async (requestId: string) => {
      try {
        const preview = await erasurePreview(api, requestId)
        setErase((current) => (current?.requestId === requestId ? { ...current, preview: { value: preview, problem: null } } : current))
      } catch (error) {
        setErase((current) => (current?.requestId === requestId ? { ...current, preview: { value: null, problem: problemOf(error) } } : current))
      }
    },
    [api],
  )
  const openErase = () => {
    const request = dialog?.read.value
    if (!request) return
    setErase({ requestId: request.id, version: request.version, preview: LOADING, reason: '', typed: '', busy: false, problem: null, done: null })
    void readPreview(request.id)
  }
  const confirmErase = async () => {
    if (!erase?.preview.value) return
    const current = erase
    setErase({ ...current, busy: true, problem: null })
    const name = `erase:${current.requestId}`
    try {
      await fresh.ensureFresh('dp.stepUp.erase')
      const answer = await fresh.guard('dp.stepUp.erase', () => erasePerson(api, current.requestId, { version: dialog?.read.value?.version ?? current.version, reason: current.reason.trim(), confirmName: current.typed }, keyFor(name)))
      forget(name)
      setErase((now) => (now ? { ...now, busy: false, done: answer.erased } : now))
      settle(answer.request, 'dp.done.erased')
    } catch (error) {
      setErase((now) => (now ? { ...now, busy: false, problem: isStepUpCancelled(error) ? 'dp.problem.stepUpClosed' : problemOf(error) } : now))
      void readPreview(current.requestId)
    }
  }

  // ---- New data request ----
  useEffect(() => {
    if (!address.creating) return setCreating(null)
    setCreating((current) => current ?? { draft: emptyDraft(companyId ?? companies[0]?.id ?? '', new Date().toISOString()), found: null, contacts: null, busy: false, problem: null })
  }, [address.creating, companyId, companies])
  const patchCreating = (change: Partial<NewRequestModel>) => setCreating((current) => (current ? { ...current, ...change } : current))
  const find = async () => {
    if (!creating) return
    const { personKind, search } = creating.draft
    patchCreating({ found: LOADING, contacts: null, draft: { ...creating.draft, partyId: '', person: null } })
    const finder: Record<typeof personKind, (text: string) => Promise<PersonOption[]>> = {
      CONTACT: (text) => findCustomers(api, text),
      PROSPECT: (text) => findProspects(api, text),
      REPORTER: (text) => findReports(api, text),
      USER: (text) => findUsers(api, text),
      WORKER: (text) => findEmployees(api, text),
    }
    try {
      const value = await finder[personKind](search)
      setCreating((current) => (current?.draft.personKind === personKind ? { ...current, found: { value, problem: null } } : current))
    } catch (error) {
      setCreating((current) => (current?.draft.personKind === personKind ? { ...current, found: { value: null, problem: problemOf(error) } } : current))
    }
  }
  const pickCustomer = async (partyId: string) => {
    if (!creating) return
    patchCreating({ draft: { ...creating.draft, partyId, person: null }, contacts: partyId ? LOADING : null })
    if (!partyId) return
    try {
      const value = await contactsOf(api, partyId)
      setCreating((current) => (current?.draft.partyId === partyId ? { ...current, contacts: { value, problem: null } } : current))
    } catch (error) {
      setCreating((current) => (current?.draft.partyId === partyId ? { ...current, contacts: { value: null, problem: problemOf(error) } } : current))
    }
  }
  const create = async () => {
    if (!creating || newRequestHeld(creating.draft, can, new Date().toISOString())) return
    const { draft } = creating
    patchCreating({ busy: true, problem: null })
    try {
      const created = await createRequest(
        api,
        { companyId: draft.companyId, personKind: draft.personKind, personRecordType: draft.person!.recordType, personRecordId: draft.person!.recordId, kind: draft.kind, receivedAt: draft.receivedAt, note: draft.note.trim() || null },
        keyFor('new'),
      )
      forget('new')
      mine.current.set(created.id, Date.now())
      setCreating(null)
      setNotice({ tone: 'success', key: 'dp.done.created', params: { due: formatDate(created.dueAt, { locale, timeZone: TIME_ZONE }) } })
      go({ creating: false, request: created.id, view: 'open', kind: null })
      void load()
    } catch (error) {
      patchCreating({ busy: false, problem: problemOf(error) })
    }
  }

  if (!can.view) return null

  const model: RequestsViewModel = {
    prefix,
    can,
    address,
    companyId,
    companies,
    list,
    selected,
    updates,
    now,
    timeZone: TIME_ZONE,
    dialog,
    creating,
    erase,
    stepUp: fresh.stepUp,
    notice,
  }

  return (
    <RequestsView
      model={model}
      actions={{
        onView: (view) => go({ view }),
        onKind: (kind) => go({ kind: kind as RequestsAddress['kind'] }),
        onOpen: (requestId) => go({ request: requestId }),
        onSelect: setSelected,
        onExport: (ids) => downloadText(`data-requests-${todayIn(TIME_ZONE)}.csv`, requestsCsv((list.value?.requests ?? []).filter((row) => ids.includes(row.id)))),
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onDismissNotice: () => setNotice(null),
        onCloseRequest: () => go({ request: null }),
        onRetryRequest: () => dialog && void readRequest(dialog.requestId),
        onForm: (form) => patchDialog({ form, problem: null, done: null }),
        onSubmitForm: submitForm,
        onCollect: collect,
        onDownload: () => void download(),
        onFinish: finish,
        onErase: openErase,
        erase: {
          onReason: (reason) => setErase((current) => (current ? { ...current, reason, problem: null } : current)),
          onTyped: (typed) => setErase((current) => (current ? { ...current, typed, problem: null } : current)),
          onConfirm: () => void confirmErase(),
          onRetry: () => erase && void readPreview(erase.requestId),
          onClose: () => setErase(null),
        },
        onDraft: (change) => setCreating((current) => (current ? { ...current, draft: { ...current.draft, ...change }, problem: null, ...(change.personKind ? { found: null, contacts: null } : {}) } : current)),
        onFind: () => void find(),
        onCustomer: (partyId) => void pickCustomer(partyId),
        onCreate: () => void create(),
        onCloseNew: () => go({ creating: false }),
        onStepUpSubmit: (code) => void fresh.submit(code),
        onStepUpClose: fresh.cancel,
      }}
    />
  )
}
