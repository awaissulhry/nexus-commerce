'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale } from '../../../lib/i18n/provider'
import { recordAddress } from '../../../lib/records/record-links'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { printHref } from '../../../shell/print/print-model'
import { OfficeRecordThread } from '../record-thread/OfficeRecordThread'
// ---- B-TH-272: the generic record page (PL5) — a summary and the full-page thread replace the six inner panels ----
// B-TH-280: moved here from the old record-panels folder (it is an office page); the print view prints the thread with ThreadPrint.
import { readPartyFacts, readRecordSummary, type RecordSummary } from './api'
import { namesRecord, openerOf, parentHrefOf, partyRoleOf, recordLabelOf, recordName, summaryStateOf, type SummaryState } from './model'
import { GenericRecordView } from './view/GenericRecordView'
import { useLiveChanges } from '../../../record-panels/live'
import { ThreadPrint } from '../record-thread/ThreadPrint'
// ---- end B-TH-272

/**
 * The generic record page, `/w/<company>/records/<type>/<id>` (SCR-006-generic; B-TH-272, threads plan PL5): any record whose own
 * page is not built yet (lib/records/record-links.ts sends its openers here, with `?label=` its number and `company=` / `site=` its
 * company and site ids). Its six inner panels (thread, tasks, files, approvals, partners, history) became ONE full-page thread — the
 * office's docked thread, whose Head ⋯ holds the old panels' doors (R-ACT), View › Changes the history, Files the files — and a
 * summary from GET /records/<type>/<id>/summary (B-TH-076): type, number, state and the record it belongs to, in the reader's own
 * scope. A record outside it answers 404: "You cannot see this record", no thread. The record's party comes with the summary (office
 * only; follow-up th9-web-b): "Reply to <party>" works before the first message; whom the party is to us ("Waiting on customer" /
 * "supplier") from GET /parties/<id> with parties.view, else the neutral "partner". A record with no party: office notes only. The summary is
 * read again when a live change names the record, and after the stream comes back. `/records/Project/<id>` goes to the project's
 * own page (B-TH-249).
 */
export function RecordPage() {
  const params = useParams<{ type: string; id: string }>()
  const type = decodeURIComponent(params.type ?? '')
  const id = decodeURIComponent(params.id ?? '')
  // ---- B-TH-249: `/records/Project/<id>` goes to the project's own page (one address per project; its thread is the page there).
  if (type === 'Project') return <ToProjectPage id={id} />
  // ---- end B-TH-249
  return <GenericRecord key={`${type}:${id}`} type={type} id={id} />
}

// ---- B-TH-272 ----
interface Party {
  readonly id: string
  readonly name: string
  readonly role: 'customer' | 'supplier' | 'partner'
}

function GenericRecord({ type, id }: { type: string; id: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const search = useSearchParams()
  const pathname = usePathname()
  const locale = useLocale()
  const prefix = companyPrefix(session.company?.code ?? '')
  const record = useMemo(() => ({ type, id }), [type, id])
  const opener = useMemo(() => openerOf(search), [search])
  const seesParties = session.permissions.includes('parties.view')

  // ---- the summary (B-TH-076) -----------------------------------------------------------------------------------------------
  const [state, setState] = useState<SummaryState>('loading')
  const [summary, setSummary] = useState<RecordSummary | null>(null)
  const readId = useRef(0)
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const read = ++readId.current
      try {
        const answer = await readRecordSummary(api, record, signal)
        if (read !== readId.current) return
        setSummary(answer)
        setState('ready')
      } catch (error) {
        if ((error as { name?: string } | null)?.name === 'AbortError' || read !== readId.current) return
        const next = summaryStateOf(error)
        // A read that fails after one succeeded keeps what was read (a 404 or a lost right does not: the record left the scope).
        setState((now) => (now === 'ready' && next === 'error' ? now : next))
        if (next !== 'error') setSummary(null)
      }
    },
    [api, record],
  )
  useEffect(() => {
    const abort = new AbortController()
    void load(abort.signal)
    return () => abort.abort()
  }, [load])
  useLiveChanges({ onChange: (change) => (namesRecord(change.fields, id) ? void load() : undefined), onReconnect: () => void load() }, state === 'ready' || state === 'error')

  // ---- follow-up (th9-web-b): the record's party comes with its summary (office readers only), so "Reply to <party>" is offered
  // before the first message (the thread, and so its party, exists only after one). Whom it is to us — the head's "Waiting on
  // customer" / "supplier" — from its roles (GET /parties/<id>, parties.view); unread, the neutral "partner" (never a guess).
  const summaryParty = state === 'ready' ? (summary?.party ?? null) : null
  const summaryPartyId = summaryParty?.id ?? null
  const [role, setRole] = useState<{ readonly partyId: string; readonly role: Party['role'] } | null>(null)
  useEffect(() => {
    if (!summaryPartyId || !seesParties) return
    const abort = new AbortController()
    readPartyFacts(api, summaryPartyId, abort.signal)
      .then((facts) => setRole({ partyId: facts.id, role: partyRoleOf(facts.roles) }))
      .catch(() => {
        // Only the head's word: without it the party is "partner", and Reply still works.
      })
    return () => abort.abort()
  }, [api, summaryPartyId, seesParties])
  const party: Party | null = summaryParty ? { id: summaryParty.id, name: summaryParty.name, role: role?.partyId === summaryParty.id ? role.role : 'partner' } : null
  // ---- end follow-up

  const name = recordName({ summary, opener, type, id, locale })
  const recordLabel = recordLabelOf(summary, opener, name)
  const threadRecord = useMemo(() => ({ type, id, companyId: opener.companyId, siteId: opener.siteId }), [type, id, opener.companyId, opener.siteId])
  const selfHref = `${prefix}${recordAddress({ type, id, label: summary?.label ?? opener.label ?? undefined, companyId: opener.companyId, siteId: opener.siteId }, OFFICE_PAGES)}`
  const ready = state === 'ready' && summary !== null
  const thread = ready ? (
    <OfficeRecordThread
      docked
      record={threadRecord}
      title={name}
      recordLabel={recordLabel}
      party={party ? { id: party.id, name: party.name } : null}
      {...(party ? { partyRole: party.role } : {})}
      recordHref={selfHref}
      printHref={printHref(pathname, search?.toString() ?? '')}
    />
  ) : null
  const printThread = ready ? <ThreadPrint record={threadRecord} title={name} party={party ? { id: party.id, name: party.name } : null} {...(party ? { partyRole: party.role } : {})} /> : null

  return (
    <GenericRecordView
      model={{ prefix, recordType: type, recordId: id, state, summary, opener, parentHref: parentHrefOf(summary, prefix, OFFICE_PAGES) }}
      actions={{
        onRetry: () => {
          setState('loading')
          void load()
        },
      }}
      thread={thread}
      printThread={printThread}
    />
  )
}
// ---- end B-TH-272

// ---- B-TH-249 ----
/** Replaces the address with the project's page, keeping the thread's own terms (`?message=`, `?thread=`) and the anchor. */
function ToProjectPage({ id }: { id: string }) {
  const router = useRouter()
  const session = useOfficeSession()
  const search = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  useEffect(() => {
    const kept = new URLSearchParams()
    for (const name of ['message', 'thread']) {
      const value = search.get(name)
      if (value) kept.set(name, value)
    }
    const terms = kept.toString()
    router.replace(`${prefix}/products/projects/${encodeURIComponent(id)}${terms ? `?${terms}` : ''}${window.location.hash}`)
  }, [router, prefix, id, search])
  return null
}
// ---- end B-TH-249
