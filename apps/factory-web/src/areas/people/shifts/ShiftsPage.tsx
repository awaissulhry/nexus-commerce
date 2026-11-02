'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { SHIFT_LIMITS } from '@nexus/factory-domain/people/shifts/rules'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import { useLiveBus } from '../../../shell/live/use-live'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import { whatYouSee } from '../_shared/api'
import { csvText, TIME_ZONE, todayIn } from '../_shared/model'
import type { Notice, SightState } from '../_shared/parts'
import { dayShort, datesOf, movedRange, rangeOf, rosterCsvRows, shiftsAddressOf, shiftsAddressText, shiftsCan, type ShiftsAddress, type Words } from './model'
import { useShiftDialogs } from './use-dialogs'
import { useOvertime } from './use-overtime'
import { useRoster } from './use-roster'
import type { ShiftsActions, ShiftsModel } from './view-model'
import { ShiftsView } from './view/ShiftsView'

/**
 * `/w/<company>/people/shifts` (SCR-263): the address holds the range (`?span=month`, `?from=`, `?to=`), the line and team
 * (`?line=`, `?team=`), the open overtime request (`?open=`) and `?overtime=1`; the site is the top bar's. The privacy note's
 * rules are read FIRST, then the roster and the requests. Live: `shift.assigned` and `roster.published` read the sheet again
 * (someone else's change is said in the band), overtime events the list and the "+2 h"s, a calendar change the shading.
 */
export function ShiftsPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = useMemo(() => shiftsCan(session.permissions), [session.permissions])
  const address = useMemo(() => shiftsAddressOf(params), [params])
  const today = todayIn(TIME_ZONE)
  const range = useMemo(() => rangeOf(address, today), [address, today])
  const siteId = scope.siteId

  const go = useCallback(
    (next: Partial<ShiftsAddress>) => {
      const keep = new URLSearchParams(params?.toString() ?? '')
      router.replace(`${pathname}${shiftsAddressText({ ...address, ...next }, keep)}`, { scroll: false })
    },
    [router, pathname, address, params],
  )

  const say = useCallback(
    (words: Words) => createTranslator(locale, messagesFor(locale, ['shifts']).shifts ?? {})(words.key, words.params),
    [locale],
  )
  const [notice, setNotice] = useState<Notice | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [help, setHelp] = useState(false)

  // ---- what you see here (read before any person) ---------------------------------------------------------------------------
  const sightSite = siteId ?? (scope.sites.length === 1 ? scope.sites[0]!.id : null)
  const [sight, setSight] = useState<SightState>({ status: 'loading' })
  const [sightRead, setSightRead] = useState(false)
  useEffect(() => {
    let live = true
    setSightRead(false)
    if (!sightSite) {
      setSight({ status: 'allSites' })
      setSightRead(true)
      return
    }
    setSight({ status: 'loading' })
    whatYouSee(api, sightSite)
      .then((value) => live && setSight({ status: 'ready', sight: value }))
      .catch(() => live && setSight({ status: 'failed' }))
      .finally(() => live && setSightRead(true))
    return () => {
      live = false
    }
  }, [api, sightSite])

  const enabled = can.view && sightRead
  const roster = useRoster({ api, enabled, siteId, range, lineId: address.lineId, teamId: address.teamId, say, onNotice: setNotice })
  const rereadRoster = useRef(roster.read)
  rereadRoster.current = roster.read
  const onRequestChanged = useCallback(() => void rereadRoster.current(true), [])
  const overtime = useOvertime({ api, enabled, can, siteId, lineId: address.lineId, range, openId: address.open, onNotice: setNotice, onChanged: onRequestChanged })
  const dialogs = useShiftDialogs({
    api,
    siteId,
    range,
    lineId: address.lineId,
    teamId: address.teamId,
    today,
    rows: roster.rows,
    choices: roster.choices,
    drafts: roster.drafts,
    onNotice: setNotice,
    onChanged: onRequestChanged,
    onRequests: () => {
      void overtime.readList()
      onRequestChanged()
    },
    remember: roster.remember,
    undoBatch: roster.undoBatch,
    onPicked: () => setPicked([]),
  })

  // `?overtime=1` (the palette): Request overtime, once the sheet's people are read.
  const opened = useRef(false)
  useEffect(() => {
    if (!address.isNew || opened.current || roster.state.status !== 'ready') return
    opened.current = true
    dialogs.onOvertime()
    go({ isNew: false })
  }, [address.isNew, roster.state.status, dialogs, go])

  // ---- live ------------------------------------------------------------------------------------------------------------------
  const onLive = useRef(roster.onLive)
  onLive.current = roster.onLive
  const quiet = useRef<ReturnType<typeof setTimeout> | null>(null)
  const readList = useRef(overtime.readList)
  readList.current = overtime.readList
  const readRecord = useRef(overtime.readRecord)
  readRecord.current = overtime.readRecord
  const openId = useRef(address.open)
  openId.current = address.open
  const live = useLiveBus(
    {
      onChange: (change) => {
        if (change.type === 'shift.assigned' || change.type === 'roster.published') {
          const cells = typeof change.fields.cells === 'number' ? change.fields.cells : 0
          const from = typeof change.fields.from === 'string' ? change.fields.from : null
          const to = typeof change.fields.to === 'string' ? change.fields.to : null
          if (from && to && (to < range.from || from > range.to)) return
          onLive.current(change.type === 'shift.assigned' ? cells : 0, from, to)
        } else if (change.type === 'calendar.changed' || change.type === 'attendance.day_changed') {
          onLive.current(0, null, null)
        } else if (change.type === 'overtime_request.changed' || change.type === 'overtime.asked' || change.type === 'overtime.answered') {
          if (quiet.current) return
          quiet.current = setTimeout(() => {
            quiet.current = null
            void readList.current()
            onLive.current(0, null, null)
            if (openId.current) void readRecord.current(openId.current)
          }, 700)
        }
      },
      onReconnect: () => {
        void rereadRoster.current(true)
        void readList.current()
      },
    },
    enabled,
  )

  const onExport = useCallback(() => {
    if (roster.state.status !== 'ready') return
    const dates = datesOf(range)
    const t = createTranslator(locale, messagesFor(locale, ['shifts']).shifts ?? {})
    const text = csvText([t('csv.site'), t('csv.line'), t('csv.team'), t('csv.person'), ...dates.map((date) => dayShort(date, locale))], rosterCsvRows(roster.rows, dates, t('cell.off')))
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' }))
    link.download = `roster-${range.from}-${range.to}.csv`
    link.click()
    URL.revokeObjectURL(link.href)
  }, [roster.state, roster.rows, range, locale])

  const model: ShiftsModel = {
    prefix,
    can,
    address,
    range,
    today,
    scope,
    sight,
    roster: roster.state,
    rows: roster.rows,
    dates: datesOf(range),
    choices: roster.choices,
    lines: roster.lines,
    teams: roster.teams,
    marks: roster.marks,
    save: roster.save,
    canRetry: roster.canRetry,
    canUndo: roster.canUndo,
    canRedo: roster.canRedo,
    drafts: roster.drafts,
    elsewhere: roster.elsewhere,
    notice,
    asOf: roster.asOf,
    live,
    picked,
    requests: { items: overtime.items, problem: overtime.problem },
    selectedRequests: overtime.selected,
    request: overtime.request,
    dialog: dialogs.dialog,
    help,
  }

  const actions: ShiftsActions = {
    onSpan: (span) => go({ span, from: null, to: null }),
    onMove: (step) => go(movedRange(address, range, step)),
    onToday: () => go({ from: null, to: null }),
    onRange: (from, to) => {
      const longest = rangeOf({ span: 'week', from, to }, today)
      if (longest.to !== to) setNotice({ tone: 'info', words: { key: 'notice.rangeCut', params: { days: SHIFT_LIMITS.rangeDays } } })
      go({ from, to: longest.to })
    },
    onLine: (lineId) => go({ lineId, teamId: null }),
    onTeam: (teamId) => go({ teamId }),
    onRetryRead: () => void roster.read(false),
    onEdits: roster.onEdits,
    onKey: roster.onKey,
    onSetOption: roster.onSetOption,
    onUndo: roster.onUndo,
    onRedo: roster.onRedo,
    onRetrySave: roster.onRetry,
    onShowElsewhere: () => {
      roster.clearElsewhere()
      void roster.read(true)
    },
    onPick: setPicked,
    onDismissNotice: () => setNotice(null),
    onHelp: setHelp,
    onExport,
    onAssign: dialogs.onAssign,
    onAssignDraft: dialogs.onAssignDraft,
    onAssignReview: () => void dialogs.onAssignReview(),
    onAssignBack: dialogs.onAssignBack,
    onAssignSave: () => void dialogs.onAssignSave(),
    onAssignUndo: dialogs.undoLast,
    onCopy: () => void dialogs.onCopy(),
    onCopySave: () => void dialogs.onCopySave(),
    onCopyRetry: () => void dialogs.onCopyRetry(),
    onCopyUndo: dialogs.undoLast,
    onPublish: dialogs.onPublish,
    onPublishSave: () => void dialogs.onPublishSave(),
    onOvertime: dialogs.onOvertime,
    onOvertimeDraft: dialogs.onOvertimeDraft,
    onOvertimeSave: (ask) => void dialogs.onOvertimeSave(ask),
    onOpenRequest: (open) => go({ open }),
    onSelectRequests: overtime.setSelected,
    onBulkAsk: () => void overtime.bulkAsk(),
    onBulkApprove: () => void overtime.bulkApprove(),
    onShowRequests: () => void overtime.readList(),
    onRequestAsk: () => void overtime.ask(),
    onRequestApprove: () => void overtime.approve(),
    onRequestAnswer: (agreementId, answer) => void overtime.answer(agreementId, answer),
    onRequestRemove: (employeeId) => void overtime.remove(employeeId),
    onRequestPicking: overtime.setPicking,
    onRequestAdd: () => void overtime.add(),
    onRequestCancelling: overtime.setCancelling,
    onRequestCancel: () => void overtime.cancel(),
    onCloseDialog: dialogs.close,
  }

  return <ShiftsView model={model} actions={actions} />
}
