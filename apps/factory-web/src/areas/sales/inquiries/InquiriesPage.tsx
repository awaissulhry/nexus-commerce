'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../lib/api/errors'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import { useLiveBus } from '../../../shell/live/use-live'
import {
  assignMany,
  createFromMail,
  createInquiry,
  declineMany,
  findStyles,
  LIST_LIMIT,
  listAssignees,
  listContacts,
  listCustomers,
  listInquiries,
  readMailDraft,
  readMailVersion,
  readStyle,
  uploadFile,
  uploadRefusal,
  type ContactOption,
  type InquiryList,
  type InquiryRow,
  type InquiryView,
  type MailDraft,
  type PartyOption,
  type StyleOption,
} from './api'
import {
  addressOf,
  addressText,
  DISMISSED_STORE,
  draftFromMail,
  emptyDecline,
  emptyNewDraft,
  fieldLines,
  fromMailBodyOf,
  HOME_ADDRESS,
  inquiriesCan,
  newBodyOf,
  nextAfter,
  queryOf,
  readProblem,
  writeProblem,
  type ListAddress,
  type Loaded,
  type NewDraft,
  type Notice,
  type RowVerb,
} from './model'
import type { RecordVerb } from './record-model'
import { useInquiry } from './use-inquiry'
import type { StyleRead } from './view/LinesEditor'
import { InquiriesView, type BulkDialog } from './view/InquiriesView'
import type { NewInquiryModel } from './view/NewInquiryDialog'

const readDismissed = (): string[] => {
  try {
    const value = JSON.parse(window.localStorage.getItem(DISMISSED_STORE) ?? '[]') as unknown
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').slice(-50) : []
  } catch {
    return []
  }
}
const keepDismissed = (keys: string[]) => {
  try {
    window.localStorage.setItem(DISMISSED_STORE, JSON.stringify(keys.slice(-50)))
  } catch {
    // A private window or blocked storage: the notice comes back next time.
  }
}

interface NewState {
  draft: NewDraft
  mail: { id: string; draft: Loaded<MailDraft> } | null
  contacts: { items: ContactOption[] | null; problem: string | null } | null
  files: Array<{ key: string; file: File }>
  busy: boolean
  notice: Notice | null
}

let fileSeq = 0

/**
 * `/w/<company>/sales/inquiries` (SCR-105): the inquiries in the shared list frame with the API's own filters in the address
 * — `?tile=` (a saved filter; the tiles), `?source=`, `?party=` / `?prospect=1`, `?q=` — the inquiry in its DetailModal
 * (`?open=<id>&tab=`, the record container `use-inquiry.tsx`; J / K walk the rows; after a decision the next one opens), New
 * inquiry (`c`, `?new=1`), "Make an inquiry" from a mail (`?mail=<inbound mail id>`), Assign to… and Decline N over a
 * selection (the API's all-or-none bulk routes). Live `inquiry.*` changes wait behind "N updates · Show".
 */
export function InquiriesPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  const companyId = session.company?.id ?? null
  const me = session.user.id
  const can = useMemo(() => inquiriesCan(session.permissions), [session.permissions])
  const address = useMemo(() => addressOf(params), [params])
  const addressRef = useRef(address)
  addressRef.current = address
  const go = useCallback((next: Partial<ListAddress>) => router.replace(`${pathname}${addressText({ ...addressRef.current, ...next })}`, { scroll: false }), [router, pathname])

  // ---- the list --------------------------------------------------------------------------------------------------------------
  const [list, setList] = useState<InquiryList | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [customers, setCustomers] = useState<PartyOption[] | null>(null)
  const [dismissed, setDismissed] = useState<string[]>([])
  useEffect(() => setDismissed(readDismissed()), [])
  const readId = useRef(0)
  const query = useMemo(() => queryOf(address), [address])
  const queryKey = JSON.stringify(query)

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    setProblem(null)
    try {
      const answer = await listInquiries(api, JSON.parse(queryKey) as ReturnType<typeof queryOf>)
      if (id !== readId.current) return
      setList(answer)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (id === readId.current) setProblem(readProblem(error))
    }
  }, [api, can.view, queryKey])

  useEffect(() => {
    setList(null)
    void load()
  }, [load])

  useEffect(() => {
    if (!can.view || !can.parties) return
    const controller = new AbortController()
    listCustomers(api, companyId, controller.signal)
      .then(setCustomers)
      .catch(() => setCustomers(null))
    return () => controller.abort()
  }, [api, can.view, can.parties, companyId])

  const live = useLiveBus(
    {
      onChange: (change) => {
        if (change.type.startsWith('inquiry.')) setUpdates((count) => count + 1)
      },
      onReconnect: () => void load(),
    },
    can.view,
  )
  const offline = live === 'offline'

  // ---- the inquiry in its DetailModal ------------------------------------------------------------------------------------------
  const [pendingVerb, setPendingVerb] = useState<RecordVerb | null>(null)
  const ids = useMemo(() => (list ? list.rows.map((row) => row.id) : []), [list])
  const idsRef = useRef(ids)
  idsRef.current = ids
  const record = useInquiry({
    inquiryId: address.open,
    tab: address.tab,
    onTab: (tab) => go({ tab }),
    onChanged: () => void load(),
    onDecided: (inquiryId) => {
      const next = nextAfter(idsRef.current, inquiryId)
      if (next && next !== inquiryId) go({ open: next, tab: 'request' })
    },
    pendingVerb,
    onPendingDone: () => setPendingVerb(null),
  })
  const detailNotice = record.model.notice
  useEffect(() => {
    // A decision's receipt stays on the page when the queue moves on to the next inquiry.
    if (detailNotice && (detailNotice.key.startsWith('done.quote') || detailNotice.key === 'done.decline' || detailNotice.key === 'done.lost')) setNotice(detailNotice)
  }, [detailNotice])

  const onRowVerb = useCallback(
    (row: InquiryRow, verb: RowVerb) => {
      setPendingVerb(verb)
      go({ open: row.id, tab: verb === 'quote' ? 'quote' : 'request' })
    },
    [go],
  )

  // ---- New inquiry, and "Make an inquiry" from a mail ---------------------------------------------------------------------------
  const [created, setCreated] = useState<NewState | null>(null)
  const newKey = useRef<string | null>(null)
  const [styles, setStyles] = useState<{ items: StyleOption[] | null; problem: string | null } | null>(null)
  const [details, setDetails] = useState<Record<string, StyleRead>>({})
  const detailsRef = useRef(details)
  detailsRef.current = details
  const dialogOpen = address.isNew || !!address.mail
  const mailId = address.mail
  const defaultCurrency = 'EUR'

  useEffect(() => {
    if (!dialogOpen || !can.view) {
      setCreated(null)
      return
    }
    newKey.current = null
    setCreated({ draft: emptyNewDraft(defaultCurrency), mail: mailId ? { id: mailId, draft: { status: 'loading' } } : null, contacts: null, files: [], busy: false, notice: null })
    if (mailId) {
      readMailDraft(api, mailId)
        .then((value) => setCreated((now) => (now ? { ...now, mail: { id: mailId, draft: { status: 'ready', value } }, draft: draftFromMail(value, defaultCurrency) } : now)))
        .catch((error: unknown) => {
          const kind = isApiError(error) ? error.kind : null
          setCreated((now) => (now ? { ...now, mail: { id: mailId, draft: kind === 'not_found' ? { status: 'notFound' } : kind === 'forbidden' ? { status: 'forbidden' } : { status: 'error', problem: readProblem(error) } } } : now))
        })
    }
  }, [dialogOpen, mailId, can.view, api])

  useEffect(() => {
    if (!dialogOpen || !can.styles || styles) return
    setStyles({ items: null, problem: null })
    findStyles(api, '')
      .then((items) => setStyles({ items, problem: null }))
      .catch((error: unknown) => setStyles({ items: [], problem: readProblem(error) }))
  }, [dialogOpen, can.styles, styles, api])

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

  const pickedParty = created?.draft.who === 'customer' ? created.draft.partyId : null
  useEffect(() => {
    if (!pickedParty || !can.parties) {
      setCreated((now) => (now && now.contacts ? { ...now, contacts: null } : now))
      return
    }
    setCreated((now) => (now ? { ...now, contacts: { items: null, problem: null } } : now))
    listContacts(api, pickedParty)
      .then((items) => setCreated((now) => (now ? { ...now, contacts: { items, problem: null } } : now)))
      .catch((error: unknown) => setCreated((now) => (now ? { ...now, contacts: { items: null, problem: readProblem(error) } } : now)))
  }, [pickedParty, can.parties, api])

  const submitNew = useCallback(async () => {
    const now = created
    if (!now || now.busy || !companyId) return
    const mail = now.mail ? (now.mail.draft.status === 'ready' ? now.mail.draft.value : null) : null
    if (now.mail && !mail) return
    setCreated({ ...now, busy: true, notice: null })
    newKey.current ??= newIdempotencyKey()
    try {
      let inquiry: InquiryView
      if (now.mail && mail) {
        const version = await readMailVersion(api, now.mail.id)
        inquiry = await createFromMail(api, now.mail.id, fromMailBodyOf(now.draft, mail, version, can, me, companyId), newKey.current)
      } else {
        inquiry = await createInquiry(api, newBodyOf(now.draft, companyId, can, me), newKey.current)
      }
      newKey.current = null
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
      setCreated(null)
      setNotice({ key: failed > 0 ? 'new.doneFiles' : 'new.done', params: { number: inquiry.number, count: failed }, tone: failed > 0 ? 'warning' : 'success' })
      go({ isNew: false, mail: null, open: inquiry.id, tab: failed > 0 ? 'files' : 'request' })
      void load()
    } catch (error) {
      const refused = writeProblem(error)
      if (!refused.stale) newKey.current = null
      setCreated((open) => (open ? { ...open, busy: false, notice: { key: refused.key, params: refused.params, tone: 'danger', lines: fieldLines(refused.paths) } } : open))
    }
  }, [created, companyId, api, can, me, go, load])

  // ---- Assign to… and Decline N over a selection -----------------------------------------------------------------------------
  const [bulk, setBulk] = useState<BulkDialog | null>(null)
  const bulkKey = useRef<string | null>(null)
  const subjectOf = (count: number) => ({ key: 'bulk.subject', params: { count } })
  const readBulkPeople = useCallback(
    (inquiryIds: readonly string[]) => {
      if (!companyId) return
      setBulk({ kind: 'assign', ids: inquiryIds, model: { subject: subjectOf(inquiryIds.length), current: null, people: { status: 'loading' }, busy: false, notice: null, offline: false } })
      listAssignees(api, companyId, null)
        .then((value) => setBulk((now) => (now?.kind === 'assign' ? { ...now, model: { ...now.model, people: { status: 'ready', value } } } : now)))
        .catch((error: unknown) => setBulk((now) => (now?.kind === 'assign' ? { ...now, model: { ...now.model, people: { status: 'error', problem: readProblem(error) } } } : now)))
    },
    [api, companyId],
  )
  const itemsOf = (inquiryIds: readonly string[]) => (list?.rows ?? []).filter((row) => inquiryIds.includes(row.id)).map((row) => ({ inquiryId: row.id, version: row.version }))
  const bulkFailed = (error: unknown) => {
    bulkKey.current = null
    const problem = writeProblem(error)
    setBulk((now) => (now ? ({ ...now, model: { ...now.model, busy: false, notice: { key: problem.key, params: problem.params, tone: 'danger' } } } as BulkDialog) : now))
    if (problem.stale) void load()
  }
  const bulkAssign = async (assigneeId: string | null) => {
    if (bulk?.kind !== 'assign' || bulk.model.busy) return
    setBulk({ ...bulk, model: { ...bulk.model, busy: true, notice: null } })
    bulkKey.current ??= newIdempotencyKey()
    try {
      const answer = await assignMany(api, itemsOf(bulk.ids), assigneeId, bulkKey.current)
      bulkKey.current = null
      const person = bulk.model.people.status === 'ready' ? bulk.model.people.value.people.find((one) => one.id === assigneeId) : undefined
      setBulk(null)
      setNotice({ key: assigneeId === null ? 'bulk.unassigned' : person?.me ? 'bulk.assignedMe' : 'bulk.assigned', params: { count: answer.inquiries.length, name: person?.name ?? '' }, tone: 'success' })
      void load()
    } catch (error) {
      bulkFailed(error)
    }
  }
  const bulkDecline = async () => {
    if (bulk?.kind !== 'decline' || bulk.model.busy || !bulk.model.draft.reason) return
    setBulk({ ...bulk, model: { ...bulk.model, busy: true, notice: null } })
    bulkKey.current ??= newIdempotencyKey()
    try {
      const note = bulk.model.draft.note.trim()
      const answer = await declineMany(api, itemsOf(bulk.ids), { reason: bulk.model.draft.reason, ...(note ? { note } : {}) }, bulkKey.current)
      bulkKey.current = null
      setBulk(null)
      setNotice({ key: 'bulk.declined', params: { count: answer.inquiries.length, reason: `decline.${bulk.model.draft.reason}` }, tone: 'success' })
      void load()
    } catch (error) {
      bulkFailed(error)
    }
  }

  return (
    <InquiriesView
      model={{
        prefix,
        me,
        companyId,
        can,
        address,
        list,
        problem,
        customers,
        asOf,
        live,
        updates,
        notice,
        dismissed,
        limit: LIST_LIMIT,
        newInquiry: created
          ? ({
              draft: created.draft,
              mail: created.mail,
              customers: can.parties ? { items: customers, problem: null } : null,
              contacts: created.contacts,
              styles: can.styles ? styles : null,
              details,
              files: created.files.map(({ key, file }) => ({ key, name: file.name, size: file.size, problem: uploadRefusal(file) })),
              busy: created.busy,
              notice: created.notice,
              offline,
            } satisfies NewInquiryModel)
          : null,
        bulk: bulk ? ({ ...bulk, model: { ...bulk.model, offline } } as BulkDialog) : null,
        detail: address.open ? record.model : null,
      }}
      slots={record.slots}
      actions={{
        onAddress: (patch) => go({ ...patch, open: patch.open ?? null }),
        onClearFilters: () => go({ ...HOME_ADDRESS }),
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onOpen: (inquiryId) => go({ open: inquiryId, tab: inquiryId === addressRef.current.open ? addressRef.current.tab : 'request' }),
        onRowVerb,
        onBulk: (kind, inquiryIds) => {
          bulkKey.current = null
          if (kind === 'assign') readBulkPeople(inquiryIds)
          else setBulk({ kind: 'decline', ids: inquiryIds, model: { subject: subjectOf(inquiryIds.length), draft: emptyDecline, message: { to: null, held: { key: 'decline.message.many' } }, busy: false, notice: null, offline: false } })
        },
        bulk: {
          onAssign: (assigneeId) => void bulkAssign(assigneeId),
          onRetryPeople: () => bulk && readBulkPeople(bulk.ids),
          onDecline: (patch) => setBulk((now) => (now?.kind === 'decline' ? { ...now, model: { ...now.model, draft: { ...now.model.draft, ...patch } } } : now)),
          onSubmit: () => void bulkDecline(),
          onClose: () => setBulk(null),
        },
        onNew: () => go({ isNew: true, open: null }),
        newInquiry: {
          onDraft: (patch) => setCreated((now) => (now ? { ...now, draft: { ...now.draft, ...patch } } : now)),
          onCustomer: (partyId) => setCreated((now) => (now ? { ...now, draft: { ...now.draft, partyId, contactId: null } } : now)),
          onStyle: readDetail,
          onFiles: (files) => setCreated((now) => (now ? { ...now, files: [...now.files, ...files.map((file) => ({ key: `f${++fileSeq}`, file }))] } : now)),
          onRemoveFile: (key) => setCreated((now) => (now ? { ...now, files: now.files.filter((one) => one.key !== key) } : now)),
          onSubmit: () => void submitNew(),
          onClose: () => go({ isNew: false, mail: null }),
        },
        record: record.actions,
        onCopy: (numbers) => {
          void navigator.clipboard
            ?.writeText(numbers.join('\n'))
            .then(() => setNotice({ key: 'list.copied', params: { count: numbers.length }, tone: 'success' }))
            .catch(() => undefined)
        },
        onDismissNotice: () => setNotice(null),
        onDismissPageNotice: (key) =>
          setDismissed((now) => {
            const next = [...now.filter((one) => one !== key), key]
            keepDismissed(next)
            return next
          }),
      }}
    />
  )
}
