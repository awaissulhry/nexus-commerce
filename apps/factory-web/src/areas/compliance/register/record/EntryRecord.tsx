'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { useT } from '../../../../lib/i18n/provider'
import { companyPrefix } from '../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { liveMatches, useLive, useRecordTab } from '../../../quality/_shared/hooks'
import { problemKey, qualityCan, refusalLines, type Notice } from '../../../quality/_shared/model'
import { RecordProblem, RecordSkeleton } from '../../../quality/_shared/parts'
import { closeEntry, completeAction, getEntry, informDistributors, listReporters, listReversedReleases, notifyAuthority, updateEntry, type EntryDetail, type PartyOption, type ReversedRelease } from '../api'
import { dayInstant, RECORD_TABS, romeToday, type EntryAction } from '../model'
import { RegisterMessages } from '../view/parts'
import { EntryRecordView } from './view/EntryRecordView'

/**
 * A PPE register entry's container (`/w/<company>/compliance/register/<id>?tab=…`, SCR-113): reads the entry (with its
 * trace, duties and what still stops it from closing), the reversed releases when the entry was opened by a reversal
 * (to link its release; needs quality.inspections.view), and the reporters when the event is edited; runs ONE write at
 * a time with the version read (a 409 version → read again + a notice; a 409 `problem/<CODE>` → our title with the
 * API's lines); live register events read the entry again — or, while a dialog is open, say it changed with Reload.
 * The thread dock (O1, ⌘J, 1280 px and wider) and the Activity tab mount the record panels.
 */
export function EntryRecord({ entryId }: { entryId: string }) {
  return (
    <RegisterMessages>
      <EntryContainer entryId={entryId} />
    </RegisterMessages>
  )
}

const WIDE = '(min-width: 1280px)'
const DOCK_KEY = 'fw.register.dock'

function EntryContainer({ entryId }: { entryId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const t = useT('register')
  const can = useMemo(() => qualityCan(session.permissions), [session.permissions])
  const threads = session.permissions.includes('threads.read')
  const prefix = companyPrefix(session.company?.code ?? '')
  const tab = useRecordTab(RECORD_TABS)
  const [entry, setEntry] = useState<EntryDetail | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [releases, setReleases] = useState<readonly ReversedRelease[] | null>(null)
  const [parties, setParties] = useState<readonly PartyOption[] | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(params?.get('created') === '1' ? { key: 'done.created', tone: 'success' } : null)
  const [dialog, setDialog] = useState<EntryAction | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<{ key: string; lines: readonly string[] } | null>(null)
  const [changedAt, setChangedAt] = useState<string | null>(null)
  const [dockOpen, setDockOpen] = useState(false)
  const dialogRef = useRef(dialog)
  dialogRef.current = dialog

  const load = useCallback(async () => {
    try {
      const next = await getEntry(api, entryId)
      setEntry(next)
      setProblem(null)
      setAsOf(new Date().toISOString())
      setChangedAt(null)
      setNotice((current) => (current?.key === 'record.reloadFailed' ? null : current))
    } catch (error) {
      setProblem(problemKey(error))
      // A later read that fails keeps the entry on screen with its time, and says so.
      setNotice((current) => current ?? { key: 'record.reloadFailed', tone: 'warning' })
    }
  }, [api, entryId])

  useEffect(() => {
    void load()
  }, [load])

  // The release an entry opened by a reversal links to (read once; a missing right leaves the words without a link).
  const sourceType = entry?.source?.type ?? null
  useEffect(() => {
    if (releases !== null || !can.inspectionsView || (sourceType !== 'QualityReleaseReversal' && sourceType !== 'QualityRelease')) return
    listReversedReleases(api)
      .then(setReleases)
      .catch(() => setReleases([]))
  }, [api, can.inspectionsView, releases, sourceType])

  // The reporters, once, when the event is edited (only with parties.view).
  useEffect(() => {
    if (dialog !== 'edit' || parties !== null || !can.partiesView) return
    listReporters(api)
      .then(setParties)
      .catch(() => setParties([]))
  }, [api, can.partiesView, dialog, parties])

  useEffect(() => {
    try {
      setDockOpen(window.localStorage.getItem(DOCK_KEY) === '1' && window.matchMedia(WIDE).matches)
    } catch {
      setDockOpen(false)
    }
  }, [])

  const live = useLive(
    (change) => {
      if (!liveMatches(change, ['compliance.register_entry_']) || change.fields.entryId !== entryId) return
      if (dialogRef.current) setChangedAt(new Date().toISOString())
      else void load()
    },
    () => void load(),
  )

  // Remove the one-off `?created=1` from the address once the notice shows.
  useEffect(() => {
    if (params?.get('created') !== '1') return
    const search = new URLSearchParams(params.toString())
    search.delete('created')
    const qs = search.toString()
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
  }, [params, pathname, router])

  const write = async (work: (current: EntryDetail) => Promise<EntryDetail>, done: string) => {
    if (!entry) return
    setBusy(true)
    setDialogProblem(null)
    try {
      const next = await work(entry)
      setEntry(next)
      setAsOf(new Date().toISOString())
      setDialog(null)
      setChangedAt(null)
      setNotice({ key: done, tone: 'success', params: { reference: next.reference } })
    } catch (error) {
      const lines = refusalLines(error, 'problem').map((line) => line.message)
      if (isApiError(error) && error.kind === 'conflict' && lines.length === 0) {
        // Someone changed it in the meantime: read it again, keep the dialog so the person can confirm on the new version.
        await load()
        setDialogProblem({ key: 'dialog.conflict', lines: [] })
      } else {
        setDialogProblem({ key: lines.length > 0 ? `dialog.refused.${dialog ?? 'edit'}` : `quality:${problemKey(error)}`, lines })
      }
    } finally {
      setBusy(false)
    }
  }

  const today = romeToday()
  const instant = (day: string) => dayInstant(day, today)

  if (problem && !entry)
    return (
      <RecordProblem
        problem={problem}
        back={
          <Link className="fw-q-link" href={`${prefix}/compliance/register`}>
            {t('record.back')}
          </Link>
        }
        onRetry={() => void load()}
      />
    )
  if (!entry) return <RecordSkeleton />

  const panels = threads ? <RecordPanels record={{ type: 'PpeRegisterEntry', id: entry.id, companyId: entry.companyId, siteId: null }} title={entry.reference} party={entry.party ? { id: entry.party.id, name: entry.party.name, emails: [] } : null} /> : undefined

  return (
    <EntryRecordView
      model={{ prefix, can, tab, entry, releases, asOf, live, notice, dialog, busy, dialogProblem, changedAt, dockOpen, today }}
      panels={panels}
      parties={can.partiesView ? (parties ?? []) : null}
      actions={{
        onDialog: (next) => {
          setDialog(next)
          setDialogProblem(null)
        },
        onCloseDialog: () => {
          setDialog(null)
          setDialogProblem(null)
        },
        onCopy: (text) => {
          void navigator.clipboard?.writeText(text).then(
            () => setNotice({ key: 'done.copied', tone: 'success', params: { reference: text } }),
            () => undefined,
          )
        },
        onReload: () => void load(),
        onDismissNotice: () => setNotice(null),
        onDock: () => {
          let wide = false
          try {
            wide = window.matchMedia(WIDE).matches
          } catch {
            wide = false
          }
          if (!wide) {
            router.push(`${pathname}?tab=activity`)
            return
          }
          setDockOpen((current) => {
            const next = !current
            try {
              window.localStorage.setItem(DOCK_KEY, next ? '1' : '0')
            } catch {
              // Not kept on this device; the dock still toggles.
            }
            return next
          })
        },
        onEditEvent: (patch) => void write((current) => updateEntry(api, current.id, current.version, patch), 'done.saved'),
        onAssess: (patch) => void write((current) => updateEntry(api, current.id, current.version, patch), 'done.assessed'),
        onAction: (input) =>
          void write(
            (current) =>
              input.done
                ? completeAction(api, current.id, current.version, { actionTaken: input.actionTaken, ...(instant(input.doneOn) ? { completedAt: instant(input.doneOn) } : {}) })
                : updateEntry(api, current.id, current.version, { actionTaken: input.actionTaken }),
            input.done ? 'done.actionDone' : 'done.actionSaved',
          ),
        onInform: (input) => void write((current) => informDistributors(api, current.id, current.version, { ...(instant(input.day) ? { informedAt: instant(input.day) } : {}), note: input.note }), 'done.informed'),
        onNotify: (input) =>
          void write((current) => notifyAuthority(api, current.id, current.version, { ...(instant(input.day) ? { notifiedAt: instant(input.day) } : {}), reference: input.reference, note: input.note }), 'done.notified'),
        onCloseEntry: (reason) => void write((current) => closeEntry(api, current.id, current.version, reason), 'done.closed'),
      }}
    />
  )
}
