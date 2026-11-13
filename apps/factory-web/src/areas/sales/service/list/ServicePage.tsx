'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { liveMatches, useLive } from '../../../quality/_shared/hooks'
import { caseCounts, caseOwners, listCases, listContacts, listCustomers, newIdempotencyKey, openCase, previewCase, type CaseCounts, type CaseRow, type Person } from '../api'
import { serialCamera } from '../camera'
import { addressOf, addressText, emptyNewDraft, HOME_ADDRESS, newBodyOf, previewBodyOf, readProblem, recordHref, refusalOf, serviceCan, todayOf, type ListAddress, type NewDraft, type Notice, type RowVerb } from '../model'
import type { NewCaseModel, ServiceListModel } from './view-model'
import { ServiceListView } from './view/ServiceListView'

const DISMISSED = 'factory:sales.service:dismissed'
const readDismissed = (): string[] => {
  try {
    const value = JSON.parse(window.localStorage.getItem(DISMISSED) ?? '[]') as unknown
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').slice(-50) : []
  } catch {
    return []
  }
}

/**
 * `/w/<company>/sales/service` (SCR-217): the saved row or tile (`?view=`), the kind, the cover, a garment's serial, the search
 * (`?q=`), New case (`?new=1`); the tiles and the notices; live `service_case.*` changes behind "N updates · Show" (the tiles
 * follow at once). A row's verb opens the case with that verb's dialog (`?do=repair|return|close`). New case reads the
 * customers, their contacts and the owners, and the preview while the person types (debounced; nothing written); Create is
 * ONE call with its own Idempotency-Key, then the case opens.
 */
export function ServicePage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  const companyId = session.company?.id ?? null
  const me = session.user.id
  const can = useMemo(() => serviceCan(session.permissions), [session.permissions])
  const address = useMemo(() => addressOf(params), [params])
  const go = useCallback((next: Partial<ListAddress>) => router.replace(`${pathname}${addressText({ ...address, ...next })}`, { scroll: false }), [router, pathname, address])
  const [opened] = useState(() => new Date().toISOString())
  const today = todayOf(opened)

  // ---- rows and tiles -------------------------------------------------------------------------------------------------------
  const [rows, setRows] = useState<ServiceListModel['rows']>({ items: null, more: false, problem: null })
  const [people, setPeople] = useState<readonly Person[] | null>(null)
  const [counts, setCounts] = useState<CaseCounts | null>(null)
  const [countsFailed, setCountsFailed] = useState(false)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dismissed, setDismissed] = useState<readonly string[]>([])
  useEffect(() => setDismissed(readDismissed()), [])
  const cursor = useRef<string | null>(null)
  const readId = useRef(0)
  const query = useMemo(() => ({ view: address.view, kind: address.kind, cover: address.cover, serial: address.serial, q: address.q }), [address.view, address.kind, address.cover, address.serial, address.q])

  const readCounts = useCallback(() => {
    caseCounts(api)
      .then((answer) => {
        setCounts(answer)
        setCountsFailed(false)
      })
      .catch(() => {
        setCounts(null)
        setCountsFailed(true)
      })
  }, [api])

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    readCounts()
    try {
      const page = await listCases(api, query, null)
      if (id !== readId.current) return
      cursor.current = page.nextCursor
      setRows({ items: page.cases, more: page.nextCursor !== null, problem: null })
      setPeople(page.people)
      setAsOf(page.asOf)
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      setRows({ items: null, more: false, problem: readProblem(error) })
    }
  }, [api, can.view, query, readCounts])

  useEffect(() => {
    setRows({ items: null, more: false, problem: null })
    void load()
  }, [load])

  const more = useCallback(async () => {
    if (!cursor.current) return
    try {
      const page = await listCases(api, query, cursor.current)
      cursor.current = page.nextCursor
      setRows((now) => ({ items: [...(now.items ?? []), ...page.cases.filter((row) => !now.items?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null, problem: null }))
      setPeople((now) => [...(now ?? []), ...page.people.filter((person) => !now?.some((seen) => seen.id === person.id))])
    } catch (error) {
      setNotice({ key: readProblem(error), tone: 'danger' })
    }
  }, [api, query])

  const later = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (later.current && clearTimeout(later.current)), [])
  const live = useLive(
    (change) => {
      if (!liveMatches(change, ['service_case.'])) return
      setUpdates((count) => count + 1)
      if (later.current) clearTimeout(later.current)
      later.current = setTimeout(readCounts, 800)
    },
    () => void load(),
  )
  const offline = live === 'offline'

  // ---- New case ---------------------------------------------------------------------------------------------------------------
  const [newCase, setNewCase] = useState<NewCaseModel | null>(null)
  const openKey = useRef<string | null>(null)
  useEffect(() => {
    if (!address.isNew || !can.view) {
      setNewCase(null)
      return
    }
    openKey.current = null
    setNewCase({ draft: emptyNewDraft(me), customers: { items: null, problem: null }, contacts: { items: null, problem: null }, owners: null, preview: { reading: false, value: null, problem: null }, busy: false, offline: false, notice: null, scanning: false })
    if (can.parties)
      listCustomers(api, companyId)
        .then((items) => setNewCase((now) => (now ? { ...now, customers: { items, problem: null } } : now)))
        .catch((error: unknown) => setNewCase((now) => (now ? { ...now, customers: { items: null, problem: readProblem(error) } } : now)))
    if (companyId)
      caseOwners(api, companyId)
        .then((owners) => setNewCase((now) => (now ? { ...now, owners } : now)))
        .catch(() => setNewCase((now) => (now ? { ...now, owners: 'failed' } : now)))
    // Once per `?new=1`.
  }, [address.isNew, can.view, can.parties, api, companyId, me])

  // The customer's contacts when the customer changes.
  const partyId = newCase?.draft.partyId ?? ''
  useEffect(() => {
    if (!partyId) return
    setNewCase((now) => (now ? { ...now, contacts: { items: null, problem: null } } : now))
    const controller = new AbortController()
    listContacts(api, partyId, controller.signal)
      .then((items) => setNewCase((now) => (now && now.draft.partyId === partyId ? { ...now, contacts: { items, problem: null } } : now)))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setNewCase((now) => (now ? { ...now, contacts: { items: null, problem: readProblem(error) } } : now))
      })
    return () => controller.abort()
  }, [api, partyId])

  // The preview while typing: what the serial, the batch and the customer give the case (debounced; nothing written).
  const previewBody = newCase ? previewBodyOf(newCase.draft, companyId) : null
  const previewKey = previewBody ? JSON.stringify(previewBody) : ''
  useEffect(() => {
    if (!previewKey) {
      setNewCase((now) => (now && (now.preview.value || now.preview.reading) ? { ...now, preview: { reading: false, value: null, problem: null } } : now))
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setNewCase((now) => (now ? { ...now, preview: { ...now.preview, reading: true, problem: null } } : now))
      previewCase(api, JSON.parse(previewKey) as Parameters<typeof previewCase>[1], controller.signal)
        .then((value) => {
          setNewCase((now) => {
            if (!now) return now
            // A serial of ours names its size: an empty size takes it. The customer it left for is offered, never set (a rider's
            // claim stays a rider's until the person names the customer).
            const draft: NewDraft = { ...now.draft, size: now.draft.size || value.draft.size || '' }
            return { ...now, draft, preview: { reading: false, value, problem: null } }
          })
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setNewCase((now) => (now ? { ...now, preview: { reading: false, value: null, problem: readProblem(error) } } : now))
        })
    }, 400)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [api, previewKey])

  const submitNew = useCallback(async () => {
    if (!newCase || newCase.busy || !companyId) return
    setNewCase({ ...newCase, busy: true, notice: null })
    openKey.current ??= newIdempotencyKey()
    try {
      const answer = await openCase(api, newBodyOf(newCase.draft, companyId), openKey.current)
      openKey.current = null
      setNewCase(null)
      router.push(recordHref(prefix, answer.case.id))
    } catch (error) {
      const refusal = refusalOf(error)
      setNewCase((now) => (now ? { ...now, busy: false, notice: { ...refusal.say, tone: 'danger', lines: refusal.lines } } : now))
    }
  }, [newCase, companyId, api, router, prefix])

  const verbTarget = (row: CaseRow, verb: RowVerb) => (verb === 'repair' ? recordHref(prefix, row.id, 'actions', 'repair') : verb === 'return' ? recordHref(prefix, row.id, 'actions', 'return') : recordHref(prefix, row.id, 'case', 'close'))

  const model: ServiceListModel = {
    prefix,
    me,
    companyId,
    today,
    can,
    address,
    rows,
    counts,
    countsFailed,
    people,
    asOf,
    live,
    updates,
    notice,
    dismissed,
    newCase: newCase ? { ...newCase, offline } : null,
  }

  return (
    <ServiceListView
      model={model}
      actions={{
        onAddress: (patch) => go(patch),
        onClearFilters: () => go(HOME_ADDRESS),
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onMore: () => void more(),
        onOpen: (id) => router.push(recordHref(prefix, id)),
        onRowVerb: (row, verb) => router.push(verbTarget(row, verb)),
        onNew: () => go({ isNew: true }),
        newCase: {
          onDraft: (patch) => setNewCase((now) => (now ? { ...now, draft: { ...now.draft, ...patch } } : now)),
          onSubmit: () => void submitNew(),
          onClose: () => {
            setNewCase(null)
            go({ isNew: false })
          },
          onScan: (open) => setNewCase((now) => (now ? { ...now, scanning: open } : now)),
          onScanned: (code) => setNewCase((now) => (now ? { ...now, scanning: false, draft: { ...now.draft, serial: code.slice(0, 100) } } : now)),
          scanner: serialCamera,
        },
        onCopy: (numbers) => {
          void navigator.clipboard
            ?.writeText(numbers.join('\n'))
            .then(() => setNotice({ key: 'list.copied', params: { count: numbers.length }, tone: 'success' }))
            .catch(() => undefined)
        },
        onDismissNotice: () => setNotice(null),
        onDismissPageNotice: (id) =>
          setDismissed((now) => {
            const next = [...now.filter((entry) => entry.split(':')[0] !== id.split(':')[0]), id]
            try {
              window.localStorage.setItem(DISMISSED, JSON.stringify(next))
            } catch {
              // A private window keeps it for this page only.
            }
            return next
          }),
      }}
    />
  )
}
