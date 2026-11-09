'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { WithMessages } from '../../../record-panels/i18n'
import { usePortalApi, usePortalBand, usePortalFrame, usePortalLive } from '../../shell/frame'
import { NotInAccessHere, saveText, useOffline } from '../orders/parts'
import { fetchJob, fetchJobs, isJobChip, sendJobAct, type JobChip, type JobRow, type JobsRead } from './api'
import { listBandOf } from './band'
import { ACCEPT_DRAFT, acceptBody, acceptHeld, DECLINE_DRAFT, declineBody, declineHeld, jobHref, jobsCsv, kitDayOf, listQuery, NS, personHeld, writeProblem, type PersonFacts, type Words } from './model'
import { useJobWords } from './words'
import { usePortalCapabilities, useToday } from './parts'
import type { AcceptModel, BulkAcceptModel, DeclineModel } from './view/Dialogs'
import { JobsListView } from './view/JobsListView'

/**
 * `/p/<party>/jobs` for a workshop (B-W2b-181, SCR-192; design portal.supplier.jobs): reads GET /portal/jobs with the chip
 * and the search of the address, fills the band (Accept new jobs, Export this view), keeps the selection, answers a New
 * job from its card (the pop-up reads the job: its pieces per size and dates), accepts the selected New jobs as asked (one
 * command per job, each its own Idempotency-Key and version), and tells of changes on the live channel without moving the
 * rows. A failed read is never drawn as an empty list; without a connection the last read stays with its time.
 */
export function SupplierJobsPage() {
  return (
    <WithMessages namespaces={[NS, 'ds-words']}>
      <JobsContainer />
    </WithMessages>
  )
}

function JobsContainer() {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const search = useSearchParams()
  const words = useJobWords()
  const { t, locale } = words
  const offline = useOffline()
  const today = useToday()
  const mayAct = usePortalCapabilities()
  const chipParam = search?.get('chip') ?? null
  const chip: JobChip | null = isJobChip(chipParam) ? chipParam : null
  const q = search?.get('q') ?? ''
  const allowed = frame.me.permissions.includes('portal.jobs.view')

  const [read, setRead] = useState<JobsRead | null>(null)
  const [readAt, setReadAt] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'error' | 'ready' | 'forbidden'>('loading')
  const [selected, setSelected] = useState<string[]>([])
  const [updates, setUpdates] = useState(0)
  const [busy, setBusy] = useState(false)
  const [accept, setAccept] = useState<AcceptModel | null>(null)
  const [decline, setDecline] = useState<DeclineModel | null>(null)
  const [bulk, setBulk] = useState<BulkAcceptModel | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning' | 'danger'; words: Words } | null>(null)
  const target = useRef<JobRow | null>(null)
  const actKey = useRef<{ body: string; key: string } | null>(null)
  const keyFor = (body: unknown) => {
    const text = JSON.stringify(body)
    if (actKey.current?.body !== text) actKey.current = { body: text, key: newIdempotencyKey() }
    return actKey.current.key
  }
  const reading = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    reading.current?.abort()
    const control = new AbortController()
    reading.current = control
    try {
      const next = await fetchJobs(api, { chip, q }, control.signal)
      if (control.signal.aborted) return
      setRead(next)
      setReadAt(next.asOf)
      setState('ready')
      setUpdates(0)
      setSelected((current) => current.filter((id) => next.items.some((row) => row.id === id)))
    } catch (error) {
      if (control.signal.aborted) return
      // A read that failed with rows on the page keeps them (offline: shown with the time they were read).
      setState((current) => (isApiError(error) && error.kind === 'forbidden' ? 'forbidden' : current === 'ready' ? 'ready' : 'error'))
    }
  }, [api, chip, q])

  useEffect(() => {
    if (!allowed) return
    setState((current) => (current === 'ready' ? current : 'loading'))
    void load()
    return () => reading.current?.abort()
  }, [load, allowed])

  usePortalLive({ onChange: (change) => (read?.live.events.includes(change.type) ? setUpdates((count) => count + 1) : undefined), onReconnect: () => setUpdates((count) => count + 1) }, allowed)

  const facts: PersonFacts = { preview: frame.me.preview, offline, busy, mayAct }
  const go = (nextChip: JobChip | null, nextQ: string) => router.replace(`${pathname}${listQuery(nextChip, nextQ)}`, { scroll: false })
  const rows = read?.items ?? []

  // ── one job's answer from its card ────────────────────────────────────────────────────────────────────────────────
  const openAccept = (row: JobRow) => {
    target.current = row
    actKey.current = null
    setDecline(null)
    setAccept({ number: row.number, job: null, loading: true, draft: ACCEPT_DRAFT, today, person: frame.me.user.displayName, busy: false, heldReason: null, problem: null })
    fetchJob(api, row.id)
      .then((page) => setAccept((current) => (current && target.current?.id === row.id ? { ...current, job: page.job, loading: false } : current)))
      .catch(() => setAccept((current) => (current ? { ...current, loading: false, problem: { key: 'problem.read' } } : current)))
  }
  const openDecline = (row: JobRow) => {
    target.current = row
    actKey.current = null
    setAccept(null)
    setDecline({ number: row.number, draft: DECLINE_DRAFT, tried: false, busy: false, heldReason: null, problem: null })
  }
  const answered = (end: Words) => {
    actKey.current = null
    setBusy(false)
    setAccept(null)
    setDecline(null)
    setNotice({ tone: 'success', words: end })
    frame.refreshTasks()
    void load()
  }
  const sendAccept = async () => {
    const row = target.current
    if (!row || !accept || busy) return
    const held = personHeld(facts, 'accept') ?? (accept.job ? acceptHeld(accept.draft, accept.job, today) : { key: 'state.loading' })
    if (held) return setAccept({ ...accept, heldReason: held })
    const body = acceptBody(accept.draft)
    setBusy(true)
    setAccept({ ...accept, busy: true, problem: null })
    try {
      const page = await sendJobAct(api, row.id, accept.job?.version ?? row.version, { act: 'accept', body }, keyFor({ id: row.id, accept: body }))
      answered(body.proposedDate ? { key: 'end.acceptedMoved', params: { number: row.number, date: body.proposedDate } } : kitDayOf(page.job) ? { key: 'end.acceptedKitOf', params: { number: row.number, date: kitDayOf(page.job)! } } : { key: 'end.acceptedOf', params: { number: row.number } })
    } catch (error) {
      setBusy(false)
      setAccept((current) => (current ? { ...current, busy: false, problem: writeProblem(error) } : current))
      if (isApiError(error) && error.kind === 'conflict') void load()
    }
  }
  const sendDecline = async () => {
    const row = target.current
    if (!row || !decline || busy) return
    const held = personHeld(facts, 'decline') ?? declineHeld(decline.draft)
    if (held) return setDecline({ ...decline, tried: true, heldReason: held })
    const body = declineBody(decline.draft)
    setBusy(true)
    setDecline({ ...decline, busy: true, problem: null })
    try {
      await sendJobAct(api, row.id, row.version, { act: 'decline', body }, keyFor({ id: row.id, decline: body }))
      answered({ key: 'end.declinedOf', params: { number: row.number } })
    } catch (error) {
      setBusy(false)
      setDecline((current) => (current ? { ...current, busy: false, problem: writeProblem(error) } : current))
      if (isApiError(error) && error.kind === 'conflict') void load()
    }
  }

  // ── many New jobs, as asked ───────────────────────────────────────────────────────────────────────────────────────
  const openBulk = (ids: readonly string[]) => {
    const picked = rows.filter((row) => ids.includes(row.id) && row.nextStep === 'ACCEPT')
    if (picked.length === 0) return
    setBulk({ jobs: picked, person: frame.me.user.displayName, busy: false, heldReason: null, result: null })
  }
  const sendBulk = async () => {
    if (!bulk || busy) return
    const held = personHeld(facts, 'accept')
    if (held) return setBulk({ ...bulk, heldReason: held })
    setBusy(true)
    setBulk({ ...bulk, busy: true, heldReason: { key: 'held.busy' } })
    let accepted = 0
    let refused = 0
    for (const job of bulk.jobs) {
      const row = rows.find((entry) => entry.id === job.id)
      if (!row) continue
      try {
        await sendJobAct(api, row.id, row.version, { act: 'accept', body: {} }, newIdempotencyKey())
        accepted++
      } catch {
        refused++
      }
    }
    setBusy(false)
    setBulk((current) => (current ? { ...current, busy: false, heldReason: null, result: { accepted, refused } } : current))
    setSelected([])
    frame.refreshTasks()
    void load()
  }

  const exportRows = (ids: readonly string[] | null) => {
    const shown = ids ? rows.filter((row) => ids.includes(row.id)) : rows
    saveText(`${t('list.fileName')}.csv`, jobsCsv(shown, t))
  }

  const onNewChip = chip === 'NEW' || (chip === null && read?.chip === 'NEW')
  const accepting = rows.filter((row) => row.nextStep === 'ACCEPT')
  usePortalBand(
    allowed && state !== 'forbidden'
      ? listBandOf({
          t,
          locale,
          asOf: read?.asOf ?? null,
          toAccept: read?.counts.toAccept ?? 0,
          onNewChip,
          acceptHeld: words.say(personHeld(facts, 'accept')),
          rows: rows.length,
          onAccept: () => (accepting.length === 1 ? openAccept(accepting[0]!) : openBulk(accepting.map((row) => row.id))),
          onNewJobs: () => go('NEW', ''),
          onExport: () => exportRows(null),
        })
      : { title: t('list.title') },
  )

  if (!allowed || state === 'forbidden') return <NotInAccessHere />

  return (
    <JobsListView
      model={{
        state: state === 'loading' && !read ? 'loading' : state === 'error' ? 'error' : 'ready',
        read,
        chip,
        q,
        prefix: frame.prefix,
        today,
        selected,
        facts,
        updates,
        accept: accept ? { ...accept, heldReason: accept.busy ? { key: 'held.busy' } : (personHeld(facts, 'accept') ?? (accept.job ? acceptHeld(accept.draft, accept.job, today) : { key: 'held.reading' })) } : null,
        decline: decline ? { ...decline, heldReason: decline.busy ? { key: 'held.busy' } : (personHeld(facts, 'decline') ?? declineHeld(decline.draft)) } : null,
        bulk: bulk && !bulk.result ? { ...bulk, heldReason: bulk.busy ? { key: 'held.busy' } : personHeld(facts, 'accept') } : bulk,
        notice,
        offlineSince: offline && read ? readAt : null,
      }}
      actions={{
        onChip: (next) => go(next, q),
        onSearch: (next) => go(chip, next),
        onSelect: setSelected,
        onOpen: (row) => router.push(jobHref(frame.prefix, row.id)),
        onRetry: () => {
          setState('loading')
          void load()
        },
        onShowUpdates: () => void load(),
        onAccept: openAccept,
        onDecline: openDecline,
        onBulkAccept: openBulk,
        onExport: exportRows,
        onDismissNotice: () => setNotice(null),
        accept: {
          onDraft: (draft) => setAccept((current) => (current ? { ...current, draft, problem: null } : current)),
          onSend: () => void sendAccept(),
          onDecline: () => target.current && openDecline(target.current),
          onClose: () => (busy ? undefined : setAccept(null)),
        },
        decline: {
          onDraft: (draft) => setDecline((current) => (current ? { ...current, draft, problem: null } : current)),
          onSend: () => void sendDecline(),
          onClose: () => (busy ? undefined : setDecline(null)),
        },
        bulk: { onSend: () => void sendBulk(), onClose: () => (busy ? undefined : setBulk(null)) },
      }}
    />
  )
}
