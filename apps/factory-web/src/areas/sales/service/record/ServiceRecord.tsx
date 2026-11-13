'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { formatTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { useLive, useRecordTab } from '../../../quality/_shared/hooks'
import {
  caseOwners,
  changeCase,
  decideCover,
  findLinkable,
  getCase,
  linkRecord,
  listContacts,
  listCustomers,
  listReturnReasons,
  makeRepair,
  makeReturn,
  moveCase,
  newIdempotencyKey,
  unlinkRecord,
  type CaseRecord,
  type LinkRecordType,
  type Person,
} from '../api'
import {
  caseChangesOf,
  caseDraftOf,
  coverDraftOf,
  doOf,
  emptyReturnDraft,
  MOVE_TO,
  moveAsks,
  moveBodyOf,
  movedNotice,
  moveNeeds,
  readProblem,
  RECORD_TABS,
  refusalOf,
  repairDraftOf,
  serviceCan,
  todayOf,
  warningPhrase,
  type CaseDraft,
  type MoveAction,
  type Notice,
} from '../model'
import { ServiceMessages } from '../parts'
import type { Loaded, RecordDialog, ServiceRecordModel } from './view-model'
import { ServiceRecordView } from './view/ServiceRecordView'

/**
 * `/w/<company>/sales/service/<id>` (SCR-413; `?tab=`, `&do=repair|return|close|decide|link` from a row's verb): the case read
 * once and again on its live changes (a `service_case.` event that names it, or a repair's or return's event naming a record
 * it links; while a dialog or the Case draft holds work, a banner says it changed instead); the owners; the customers and the
 * draft customer's contacts for the Case form. Every write is ONE call with its own Idempotency-Key and the version read; the
 * answer is the case as it is now. A stale version reads the case again and says so.
 */
export function ServiceRecord({ caseId }: { caseId: string }) {
  return (
    <ServiceMessages>
      <Container caseId={caseId} />
    </ServiceMessages>
  )
}

function Container({ caseId }: { caseId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const locale = useLocale()
  const prefix = companyPrefix(session.company?.code ?? '')
  const me = session.user.id
  const can = useMemo(() => serviceCan(session.permissions), [session.permissions])
  const tab = useRecordTab(RECORD_TABS)
  const [opened] = useState(() => new Date().toISOString())
  const today = todayOf(opened)

  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [asOf, setAsOf] = useState<string | null>(null)
  const [owners, setOwners] = useState<readonly Person[] | null>(null)
  const [customers, setCustomers] = useState<ServiceRecordModel['customers']>({ items: null, problem: null })
  const [contacts, setContacts] = useState<ServiceRecordModel['contacts']>({ items: null, problem: null })
  const [draft, setDraft] = useState<CaseDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [dialog, setDialog] = useState<RecordDialog | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [stale, setStale] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const record = loaded.status === 'ready' ? loaded.record : null
  const current = useRef<CaseRecord | null>(null)
  current.current = record
  const holding = useRef(false)
  holding.current = !!dialog || (draft !== null && record !== null && Object.keys(caseChangesOf(record, draft)).length > 0)
  const keys = useRef<Record<string, string>>({})
  const keyOf = (name: string) => (keys.current[name] ??= newIdempotencyKey())
  const dropKey = (name: string) => void delete keys.current[name]

  const take = useCallback((next: CaseRecord) => {
    setLoaded({ status: 'ready', record: next })
    setAsOf(new Date().toISOString())
    setStale(null)
  }, [])

  const load = useCallback(async () => {
    try {
      take(await getCase(api, caseId))
    } catch (error) {
      setLoaded(isApiError(error) && error.kind === 'not_found' ? { status: 'notFound' } : isApiError(error) && error.kind === 'forbidden' ? { status: 'forbidden' } : { status: 'error', problem: readProblem(error) })
    }
  }, [api, caseId, take])

  useEffect(() => {
    if (!can.view) {
      setLoaded({ status: 'forbidden' })
      return
    }
    void load()
  }, [load, can.view])

  const companyId = record?.companyId ?? null
  useEffect(() => {
    if (!companyId || !can.manage) return
    caseOwners(api, companyId)
      .then(setOwners)
      .catch(() => setOwners(null))
  }, [api, companyId, can.manage])

  // The Case form's pickers: the customers once, the chosen customer's contacts.
  const editable = record?.actions.find((entry) => entry.action === 'edit')?.allowed ?? false
  useEffect(() => {
    if (tab !== 'case' || !editable || !can.parties || customers.items || customers.problem) return
    listCustomers(api, companyId)
      .then((items) => setCustomers({ items, problem: null }))
      .catch((error: unknown) => setCustomers({ items: null, problem: readProblem(error) }))
  }, [tab, editable, can.parties, api, companyId, customers.items, customers.problem])
  const partyId = draft ? draft.partyId : (record?.party?.id ?? '')
  useEffect(() => {
    if (!partyId || !editable || !can.parties) {
      setContacts({ items: partyId ? null : [], problem: null })
      return
    }
    const controller = new AbortController()
    listContacts(api, partyId, controller.signal)
      .then((items) => setContacts({ items, problem: null }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setContacts({ items: null, problem: readProblem(error) })
      })
    return () => controller.abort()
  }, [api, partyId, editable, can.parties])

  const live = useLive(
    (change) => {
      const now = current.current
      const mine = change.type.startsWith('service_case.') && change.fields.caseId === caseId
      const linkedRecord = !!now && (change.type.startsWith('repair.') || change.type.startsWith('return.')) && Object.values(change.fields).some((value) => typeof value === 'string' && now.links.some((link) => link.recordId === value))
      if (!mine && !linkedRecord) return
      if (holding.current) setStale(formatTime(new Date(), { locale }))
      else void load()
    },
    () => void load(),
  )
  const offline = live === 'offline'

  // ---- a row's verb by address (`&do=`), once after the first read ---------------------------------------------------------------
  const asked = useRef(false)
  useEffect(() => {
    if (asked.current || !record) return
    asked.current = true
    const todo = doOf(params)
    if (todo === 'repair') setDialog({ kind: 'repair', draft: repairDraftOf(record), busy: false, notice: null })
    else if (todo === 'return') setDialog({ kind: 'return', draft: emptyReturnDraft('RETURN'), reasons: { items: null, problem: null }, busy: false, notice: null })
    else if (todo === 'decide') setDialog({ kind: 'decide', draft: coverDraftOf(record), busy: false, notice: null })
    else if (todo === 'link') setDialog({ kind: 'link', recordType: 'SalesOrder', q: '', found: { items: null, reading: false, problem: null }, picked: null, note: '', busy: false, notice: null })
    else if (todo === 'close') setDialog({ kind: 'move', draft: { action: 'close', resolution: '', reason: '', message: '' }, busy: false, notice: null })
    // Once, after the first read.
  }, [record])

  // The return reasons, when a return dialog opens.
  const returnOpen = dialog?.kind === 'return'
  useEffect(() => {
    if (!returnOpen) return
    listReturnReasons(api)
      .then((items) => setDialog((now) => (now?.kind === 'return' ? { ...now, reasons: { items, problem: null } } : now)))
      .catch((error: unknown) => setDialog((now) => (now?.kind === 'return' ? { ...now, reasons: { items: null, problem: readProblem(error) } } : now)))
  }, [returnOpen, api])

  // ---- writes ---------------------------------------------------------------------------------------------------------------
  const refused = useCallback(
    (error: unknown, linking = false): Notice => {
      const refusal = refusalOf(error, linking)
      if (refusal.stale) void load()
      return { ...refusal.say, tone: 'danger', lines: refusal.lines }
    },
    [load],
  )

  const runMove = useCallback(
    async (action: MoveAction, words: { resolution: string; reason: string; message: string }, inDialog: boolean) => {
      const now = current.current
      if (!now) return
      const needs = moveNeeds(now.status, MOVE_TO[action], now.notifyCustomer)
      const name = `move:${action}`
      if (inDialog) setDialog((open) => (open ? { ...open, busy: true, notice: null } : open))
      else setBusy(true)
      try {
        const answer = await moveCase(api, now.id, moveBodyOf({ action, ...words }, now.version, needs), keyOf(name))
        dropKey(name)
        take(answer.case)
        setDraft(null)
        setDialog(null)
        setNotice(movedNotice(answer))
      } catch (error) {
        dropKey(name)
        const said = refused(error)
        if (inDialog) setDialog((open) => (open ? { ...open, busy: false, notice: said } : open))
        else setNotice(said)
      } finally {
        setBusy(false)
      }
    },
    [api, take, refused],
  )

  const onMove = useCallback(
    (action: MoveAction) => {
      const now = current.current
      if (!now) return
      const needs = moveNeeds(now.status, MOVE_TO[action], now.notifyCustomer)
      if (moveAsks(needs)) setDialog({ kind: 'move', draft: { action, resolution: '', reason: '', message: '' }, busy: false, notice: null })
      else void runMove(action, { resolution: '', reason: '', message: '' }, false)
    },
    [runMove],
  )

  const save = useCallback(async () => {
    const now = current.current
    if (!now || !draft || saving) return
    const changes = caseChangesOf(now, draft)
    if (Object.keys(changes).length === 0) return
    setSaving(true)
    try {
      const answer = await changeCase(api, now.id, { version: now.version, ...changes }, keyOf('save'))
      dropKey('save')
      take(answer.case)
      setDraft(null)
      setNotice({ key: 'form.saved', tone: answer.warnings.length > 0 ? 'warning' : 'success', lines: answer.warnings.map((warning) => warningPhrase(warning.path)) })
    } catch (error) {
      dropKey('save')
      setNotice(refused(error))
    } finally {
      setSaving(false)
    }
  }, [api, draft, saving, take, refused])

  const submitDialog = useCallback(async () => {
    const now = current.current
    if (!now || !dialog || dialog.busy) return
    if (dialog.kind === 'move') {
      await runMove(dialog.draft.action, dialog.draft, true)
      return
    }
    setDialog({ ...dialog, busy: true, notice: null } as RecordDialog)
    const fail = (error: unknown, name: string) => {
      dropKey(name)
      const said = refused(error, name === 'link')
      setDialog((open) => (open ? ({ ...open, busy: false, notice: said } as RecordDialog) : open))
    }
    if (dialog.kind === 'decide') {
      try {
        const answer = await decideCover(api, now.id, { version: now.version, cover: dialog.draft.cover, decision: dialog.draft.decision, note: dialog.draft.note.trim() }, keyOf('decide'))
        dropKey('decide')
        take(answer.case)
        setDialog(null)
        setNotice({ key: 'decide.done', params: { decision: `decision.${dialog.draft.decision}` }, tone: answer.warnings.length > 0 ? 'warning' : 'success', lines: answer.warnings.map((warning) => warningPhrase(warning.path)) })
      } catch (error) {
        fail(error, 'decide')
      }
    } else if (dialog.kind === 'link') {
      if (!dialog.picked) return
      try {
        const next = await linkRecord(api, now.id, { version: now.version, recordType: dialog.picked.recordType, recordId: dialog.picked.recordId, note: dialog.note.trim() || null }, keyOf('link'))
        dropKey('link')
        take(next)
        setDialog(null)
        setNotice({ key: 'link.done', params: { number: dialog.picked.number }, tone: 'success' })
      } catch (error) {
        fail(error, 'link')
      }
    } else if (dialog.kind === 'unlink') {
      try {
        take(await unlinkRecord(api, now.id, dialog.linkId, now.version))
        setDialog(null)
        setNotice({ key: 'unlink.done', tone: 'success' })
      } catch (error) {
        fail(error, 'unlink')
      }
    } else if (dialog.kind === 'repair') {
      try {
        const answer = await makeRepair(api, now.id, { version: now.version, kind: dialog.draft.kind, problem: dialog.draft.problem.trim(), workWanted: dialog.draft.workWanted.trim() || null, ...(dialog.draft.received ? { received: {} } : {}) }, keyOf('repair'))
        dropKey('repair')
        take(answer.case)
        setDialog(null)
        setNotice({ key: 'repair.done', params: { number: answer.repair.number }, tone: 'success', link: { href: `${prefix}/sales/returns/repairs/${encodeURIComponent(answer.repair.id)}`, label: { key: 'repair.open', params: { number: answer.repair.number } } }, lines: answer.warnings.map((warning) => warningPhrase(warning.path)) })
      } catch (error) {
        fail(error, 'repair')
      }
    } else if (dialog.kind === 'return') {
      const draftNow = dialog.draft
      try {
        const answer = await makeReturn(
          api,
          now.id,
          { version: now.version, purpose: draftNow.purpose, reasonCode: draftNow.reasonCode, ...(draftNow.purpose === 'REMAKE' ? { fit: draftNow.fit.trim() } : {}), customerRef: draftNow.customerRef.trim() || null, goodsDueBy: draftNow.goodsDueBy || null },
          keyOf('return'),
        )
        dropKey('return')
        take(answer.case)
        setDialog(null)
        setNotice({ key: `return.done.${draftNow.purpose}`, params: { number: answer.return.number }, tone: 'success', link: { href: `${prefix}/sales/returns/${encodeURIComponent(answer.return.id)}`, label: { key: 'return.open', params: { number: answer.return.number } } }, lines: [{ key: `return.next.${draftNow.purpose}` }, ...answer.warnings.map((warning) => warningPhrase(warning.path))] })
      } catch (error) {
        fail(error, 'return')
      }
    }
  }, [api, dialog, take, refused, runMove, prefix])

  const findTimer = useRef<AbortController | null>(null)
  const onFindLinkable = useCallback(
    (recordType: LinkRecordType, q: string) => {
      findTimer.current?.abort()
      const controller = new AbortController()
      findTimer.current = controller
      setDialog((now) => (now?.kind === 'link' ? { ...now, q, found: { items: now.found.items, reading: true, problem: null } } : now))
      findLinkable(api, recordType, q, current.current?.party?.id ?? null, controller.signal)
        .then((items) => setDialog((now) => (now?.kind === 'link' && now.recordType === recordType ? { ...now, found: { items, reading: false, problem: null } } : now)))
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setDialog((now) => (now?.kind === 'link' ? { ...now, found: { items: null, reading: false, problem: readProblem(error) } } : now))
        })
    },
    [api],
  )

  const model: ServiceRecordModel = { prefix, me, today, can, tab, loaded, live, asOf, owners, customers, contacts, draft, saving, dialog, notice, stale, busy, copied }
  const panels = record && can.threads ? <RecordPanels record={{ type: 'ServiceCase', id: record.id, companyId: record.companyId, siteId: null }} title={record.number} party={record.party ? { id: record.party.id, name: record.party.legalName, emails: record.contact?.email ? [record.contact.email] : [] } : null} /> : undefined

  return (
    <ServiceRecordView
      model={{ ...model, live: offline ? 'offline' : live }}
      panels={panels}
      actions={{
        onRetry: () => void load(),
        onReload: () => {
          setDraft(null)
          void load()
        },
        onDraft: (patch) => setDraft((now) => ({ ...(now ?? (current.current ? caseDraftOf(current.current) : ({} as CaseDraft))), ...patch })),
        onDiscard: () => setDraft(null),
        onSave: () => void save(),
        onMove,
        onDialog: (next) => setDialog(next),
        onDialogChange: (patch) => setDialog((now) => (now ? ({ ...now, ...patch } as RecordDialog) : now)),
        onSubmitDialog: () => void submitDialog(),
        onFindLinkable,
        onCopy: () => {
          const now = current.current
          if (!now) return
          void navigator.clipboard
            ?.writeText(now.number)
            .then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            })
            .catch(() => undefined)
        },
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
