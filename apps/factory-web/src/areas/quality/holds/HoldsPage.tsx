'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { RecordPanels } from '../../../record-panels/RecordPanels'
import { csvLine, downloadText, isStepUpCancelled, liveMatches, useLive, useStepUp } from '../_shared/hooks'
import { failedRead, newNcrAddress, problemKey, qualityCan, ready, reading, type Notice, type Read } from '../_shared/model'
import { editHold, getHold, holdCounts, holdPeople, holdReasons, listHolds, releaseHold, type EditBody, type Hold, type HoldCounts, type HoldDetail, type Person } from './api'
import {
  bulkNotice,
  CSV_HEAD,
  csvRow,
  holdsAddress,
  LIVE_EVENTS,
  nextLimit,
  kindKey,
  PAGE,
  prefillFromAddress,
  queryOf,
  reasonText,
  RELEASE_DRAFT,
  scopeFromAddress,
  tabFromAddress,
  viewFromAddress,
  type CellMark,
  type HoldsDialog,
  type PlaceHoldPrefill,
  type RecordTab,
  type ReleaseDraft,
  type View,
} from './model'
import { officeToday, PlaceHold } from './place/PlaceHold'
import { HoldsMessages } from './view/parts'
import { HoldsView } from './view/HoldsView'

/** The most selected holds whose release checks are read for "Release N" (one read each). */
const DETAILS_MAX = 50

/**
 * The Holds container (`/w/<company>/quality/holds`, SCR-078): reads the view's holds (the API's own filters; at most 200,
 * shown 50 at a time), the tiles' counts, the HOLD reasons' words and the hold open in its DetailModal (`?open=`, `?tab=`);
 * saves the owner, the expected release and the note as they change (the version read; a newer change is said), releases
 * one hold or several (the office's fresh code asked once, one release each: the API has no bulk route), gives several
 * holds an owner, exports the selection as CSV, opens Place hold (`?new=1`, prefilled by `?kind=&ids=&source=`), sends
 * "Decide in NCR" to B-W2a-68's New NCR (`/quality/ncr?new=1&from=QualityHold&id=`), and listens to the live stream: changes wait behind "N updates · Show" (rows never move under the cursor).
 */
export function HoldsPage() {
  return (
    <HoldsMessages>
      <HoldsContainer />
    </HoldsMessages>
  )
}

function HoldsContainer() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const t = useT('holds')
  const q = useT('quality')
  const locale = useLocale()
  const can = useMemo(() => qualityCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const me = session.user.id
  const view: View = viewFromAddress(params)
  const scope = scopeFromAddress(params)
  const openId = params?.get('open') ?? null
  const tab: RecordTab = tabFromAddress(params)
  const [rows, setRows] = useState<Read<readonly Hold[]>>(reading())
  const [truncated, setTruncated] = useState(false)
  const [limit, setLimit] = useState(PAGE)
  const [counts, setCounts] = useState<Read<HoldCounts>>(reading())
  const [reasons, setReasons] = useState<ReadonlyMap<string, { labelIt: string; labelEn: string }>>(new Map())
  const [people, setPeople] = useState<Record<string, Read<readonly Person[]>>>({})
  const [cells, setCells] = useState<Record<string, CellMark>>({})
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [details, setDetails] = useState<Record<string, HoldDetail>>({})
  const [detail, setDetail] = useState<Read<HoldDetail>>(reading())
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dialog, setDialog] = useState<HoldsDialog | null>(null)
  const [releaseDraft, setReleaseDraft] = useState<ReleaseDraft>(RELEASE_DRAFT)
  const [assignTo, setAssignTo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<string | null>(null)
  const [dialogLines, setDialogLines] = useState<readonly string[]>([])
  const [place, setPlace] = useState<{ prefill: PlaceHoldPrefill | null } | null>(() => {
    const asked = prefillFromAddress(params)
    return asked ? { prefill: asked.subjectIds?.length || asked.codes?.length ? asked : null } : null
  })
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)
  const request = useRef<AbortController | null>(null)
  const releaseKeys = useRef<Map<string, string>>(new Map())
  const justPlaced = useRef(false)
  const today = officeToday()

  /** The address keeps the view, the record the list is narrowed to, the open hold and its tab (Back closes it). */
  const go = useCallback(
    (next: { view?: View; open?: string | null; tab?: RecordTab | null; scope?: { subjectType: Hold['subjectType'] | null; subjectId: string | null } }) => {
      const nextScope = next.scope ?? scope
      router.replace(`${pathname}${holdsAddress({ view: next.view ?? view, subjectType: nextScope.subjectType, subjectId: nextScope.subjectId, open: next.open === undefined ? openId : next.open, tab: next.tab === undefined ? tab : next.tab })}`, { scroll: false })
    },
    [openId, pathname, router, scope, tab, view],
  )

  const queryKey = JSON.stringify(queryOf(view, scope))
  const load = useCallback(async () => {
    if (!can.holdsView) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    try {
      const answer = await listHolds(api, JSON.parse(queryKey), controller.signal)
      if (controller.signal.aborted) return
      setRows(ready(answer.holds))
      setTruncated(answer.truncated)
      setSelected((current) => current.filter((id) => answer.holds.some((hold) => hold.id === id)))
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'AbortError') return
      setRows(failedRead(problemKey(error)))
    }
  }, [api, can.holdsView, queryKey])

  const loadCounts = useCallback(async () => {
    if (!can.holdsView) return
    try {
      setCounts(ready(await holdCounts(api)))
    } catch (error) {
      setCounts(failedRead(problemKey(error)))
    }
  }, [api, can.holdsView])

  const loadDetail = useCallback(async () => {
    if (!openId || !can.holdsView) return
    setDetail((current) => (current.value?.hold.id === openId ? current : reading()))
    try {
      const answer = await getHold(api, openId)
      setDetail(ready(answer))
      setDetails((current) => (current[openId] ? { ...current, [openId]: answer } : current))
    } catch (error) {
      setDetail(failedRead(problemKey(error)))
    }
  }, [api, can.holdsView, openId])

  useEffect(() => {
    setRows(reading())
    setLimit(PAGE)
    void load()
  }, [load])
  useEffect(() => {
    void loadCounts()
  }, [loadCounts])
  useEffect(() => {
    void loadDetail()
  }, [loadDetail])
  useEffect(() => {
    if (!can.holdsView) return
    holdReasons(api)
      .then((list) => setReasons(new Map(list.map((entry) => [entry.code, { labelIt: entry.labelIt, labelEn: entry.labelEn }]))))
      .catch(() => setReasons(new Map()))
  }, [api, can.holdsView])

  // The selected holds' release checks, for "Release N" held before the click.
  const selectedKey = selected.slice(0, DETAILS_MAX).join(',')
  useEffect(() => {
    if (!can.holdsRelease) return
    const missing = selectedKey.split(',').filter((id) => id && !details[id])
    let live = true
    ;(async () => {
      for (const id of missing) {
        try {
          const answer = await getHold(api, id)
          if (live) setDetails((current) => ({ ...current, [id]: answer }))
        } catch {
          // Unknown: "Release N" stays held while its checks are not read (the dialog reads them again).
        }
      }
    })()
    return () => {
      live = false
    }
  }, [api, can.holdsRelease, selectedKey])

  const live = useLive(
    (change) => {
      if (liveMatches(change, LIVE_EVENTS)) {
        setUpdates((count) => count + 1)
        void loadCounts()
        if (openId && change.fields.holdId === openId) void loadDetail()
      }
    },
    () => {
      void load()
      void loadCounts()
      void loadDetail()
    },
  )

  const needPeople = useCallback(
    (siteId: string) => {
      if (!can.holdsPlace || people[siteId]) return
      setPeople((current) => ({ ...current, [siteId]: reading() }))
      holdPeople(api, siteId)
        .then((list) => setPeople((current) => ({ ...current, [siteId]: ready(list) })))
        .catch((error: unknown) => setPeople((current) => ({ ...current, [siteId]: failedRead(problemKey(error)) })))
    },
    [api, can.holdsPlace, people],
  )

  /** A hold as it is now (the list's row, else the open record's), and every copy replaced after a change. */
  const current = (id: string): Hold | null => rows.value?.find((row) => row.id === id) ?? (detail.value?.hold.id === id ? detail.value.hold : null)
  const replace = (hold: Hold) => {
    setRows((read) => (read.value ? ready(read.value.map((row) => (row.id === hold.id ? hold : row))) : read))
    setDetail((read) => (read.value?.hold.id === hold.id ? ready({ ...read.value, hold }) : read))
    setDetails((map) => (map[hold.id] ? { ...map, [hold.id]: { ...map[hold.id]!, hold } } : map))
  }

  const edit = useCallback(
    async (hold: Hold, field: 'owner' | 'expected' | 'note', change: Omit<EditBody, 'version'>) => {
      const cell = `${hold.id}:${field}`
      const latest = current(hold.id) ?? hold
      setCells((marks) => ({ ...marks, [cell]: { state: 'saving' } }))
      try {
        const answer = await editHold(api, hold.id, { version: latest.version, ...change })
        replace(answer.hold)
        setCells((marks) => ({ ...marks, [cell]: { state: 'saved' } }))
      } catch (error) {
        const problem = isApiError(error) ? (error.kind === 'conflict' ? 'cell.conflict' : error.kind === 'invalid' ? 'cell.invalid' : 'cell.failed') : 'cell.failed'
        setCells((marks) => ({ ...marks, [cell]: { state: 'refused', problem } }))
        if (isApiError(error) && error.kind === 'conflict') {
          void load()
          void loadDetail()
        }
      }
    },
    [api, load, loadDetail, rows.value, detail.value],
  )

  const label = (hold: Hold) => `${t(kindKey(hold.subjectType))} ${hold.subjects[0]?.label ?? '—'}`

  // ---- release: one hold, or several (one release each; the code is asked once) ----
  const release = useCallback(async () => {
    if (dialog?.kind !== 'release') return
    const ids = dialog.ids
    setBusy(true)
    setDialogProblem(null)
    setDialogLines([])
    const refused: { code: string; words: string }[] = []
    let done = 0
    let lifted = 0
    try {
      for (const id of ids) {
        const hold = current(id)
        if (!hold) continue
        let key = releaseKeys.current.get(id)
        if (!key) {
          key = newIdempotencyKey()
          releaseKeys.current.set(id, key)
        }
        try {
          const answer = await guard('release.stepUpSentence', () => releaseHold(api, id, { version: hold.version, note: releaseDraft.note.trim() || null, notMakerStatement: releaseDraft.statement }, key!))
          releaseKeys.current.delete(id)
          replace(answer.hold)
          done += 1
          lifted += answer.workOrdersLifted.length
        } catch (error) {
          if (isStepUpCancelled(error)) throw error
          releaseKeys.current.delete(id)
          const words = isApiError(error) ? error.issues.map((issue) => issue.message ?? '').filter(Boolean).join(' ') || error.message : q(problemKey(error))
          refused.push({ code: label(hold), words })
        }
      }
      if (ids.length === 1 && refused.length === 1) {
        setDialogProblem('release.refused')
        setDialogLines(refused.map((entry) => entry.words))
        void loadDetail()
        return
      }
      setDialog(null)
      setReleaseDraft(RELEASE_DRAFT)
      const result = bulkNotice(done, refused, ids.length === 1 ? 'notice.released' : 'notice.releasedMany')
      setNotice(lifted > 0 && refused.length === 0 ? { ...result, key: ids.length === 1 ? 'notice.releasedLifted' : 'notice.releasedManyLifted', params: { count: done, lifted } } : result)
      setSelected([])
      void load()
      void loadCounts()
      void loadDetail()
    } catch (error) {
      if (isStepUpCancelled(error)) setDialogProblem('release.cancelled')
      else setDialogProblem('release.failed')
    } finally {
      setBusy(false)
    }
  }, [api, dialog, guard, load, loadCounts, loadDetail, releaseDraft, rows.value, detail.value])

  // ---- assign owner (one change each) ----
  const assign = useCallback(async () => {
    if (dialog?.kind !== 'assign' || assignTo === null) return
    const owner = assignTo === '__nobody__' ? null : assignTo
    setBusy(true)
    setDialogProblem(null)
    const refused: { code: string; words: string }[] = []
    let done = 0
    for (const id of dialog.ids) {
      const hold = current(id)
      if (!hold) continue
      try {
        replace((await editHold(api, id, { version: hold.version, ownerId: owner })).hold)
        done += 1
      } catch (error) {
        refused.push({ code: label(hold), words: isApiError(error) ? error.message : q(problemKey(error)) })
      }
    }
    setBusy(false)
    setDialog(null)
    setAssignTo(null)
    setNotice(bulkNotice(done, refused, 'notice.assigned'))
    void loadCounts()
  }, [api, assignTo, dialog, loadCounts, rows.value, detail.value])

  const exportRows = useCallback(
    (ids: readonly string[]) => {
      const pick = new Set(ids)
      const lines = [csvLine(CSV_HEAD.map((key) => t(key))), ...(rows.value ?? []).filter((hold) => pick.has(hold.id)).map((hold) => csvLine(csvRow(hold, t, reasonText(hold, reasons, locale), me)))]
      downloadText(`holds-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n'))
    },
    [locale, me, reasons, rows.value, t],
  )

  const openDialog = (next: HoldsDialog | null) => {
    setDialogProblem(null)
    setDialogLines([])
    if (next?.kind === 'release') {
      setReleaseDraft(RELEASE_DRAFT)
      // The checks of each hold are read again now: they change with time (a result recorded, an inspection signed).
      for (const id of next.ids.slice(0, DETAILS_MAX)) {
        getHold(api, id)
          .then((answer) => {
            setDetails((map) => ({ ...map, [id]: answer }))
            if (openId === id) setDetail(ready(answer))
          })
          .catch(() => undefined)
      }
    }
    if (next?.kind === 'assign') {
      setAssignTo(null)
      const first = (rows.value ?? []).find((hold) => next.ids.includes(hold.id))
      if (first) needPeople(first.siteId)
    }
    setDialog(next)
  }

  const openHold = detail.value?.hold ?? null
  const panels =
    openHold && can.threadsRead ? (
      <RecordPanels record={{ type: 'QualityHold', id: openHold.id, companyId: openHold.companyId, siteId: openHold.siteId }} title={label(openHold)} />
    ) : null

  return (
    <>
      <HoldsView
        model={{
          prefix,
          me,
          locale,
          can,
          today,
          view,
          subjectType: scope.subjectType,
          subjectId: scope.subjectId,
          rows,
          truncated,
          limit,
          counts,
          reasons,
          people,
          cells,
          asOf,
          live,
          updates,
          selected,
          details,
          notice,
          open: openId ? { id: openId, detail, tab } : null,
          dialog,
          releaseDraft,
          assignTo,
          busy,
          dialogProblem,
          dialogLines,
        }}
        stepUp={stepUp}
        panels={panels}
        actions={{
          onView: (next) => {
            setSelected([])
            go({ view: next, open: null })
          },
          onClearScope: () => go({ scope: { subjectType: null, subjectId: null }, open: null }),
          onMore: () => setLimit((now) => nextLimit(now)),
          onRetry: () => void load(),
          onShowUpdates: () => {
            void load()
            void loadCounts()
          },
          onSelect: (ids) => setSelected([...ids]),
          onOpen: (id) => go({ open: id, tab: id ? tab : null }),
          onTab: (next) => go({ tab: next }),
          onRetryDetail: () => void loadDetail(),
          onDialog: openDialog,
          onPlace: () => {
            justPlaced.current = false
            setPlace({ prefill: null })
          },
          onRaiseNcr: (hold) => router.push(newNcrAddress(prefix, 'QualityHold', hold.id)),
          onOwner: (hold, ownerId) => void edit(hold, 'owner', { ownerId }),
          onExpected: (hold, day) => void edit(hold, 'expected', { expectedReleaseOn: day }),
          onNote: (hold, note) => void edit(hold, 'note', { note }),
          onNeedPeople: needPeople,
          onReleaseDraft: setReleaseDraft,
          onRelease: () => void release(),
          onAssignTo: setAssignTo,
          onAssign: () => void assign(),
          onExport: exportRows,
          onDismissNotice: () => setNotice(null),
          onStepUpSubmit: (code) => void submitStepUp(code),
          onStepUpCancel: cancelStepUp,
        }}
      />
      <PlaceHold
        open={place !== null}
        prefill={place?.prefill ?? null}
        onClose={() => {
          setPlace(null)
          if (params?.get('new') === '1' && !justPlaced.current) go({})
        }}
        onPlaced={(hold) => {
          justPlaced.current = true
          setNotice({ key: hold.workOrdersHeld > 0 ? 'notice.placedWorkOrders' : 'notice.placed', params: { count: hold.workOrdersHeld }, tone: 'success' })
          void load()
          void loadCounts()
          go({ open: hold.id, tab: 'hold' })
        }}
      />
    </>
  )
}
