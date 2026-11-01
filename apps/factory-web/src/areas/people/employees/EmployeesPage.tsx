'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import { useLiveBus } from '../../../shell/live/use-live'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import {
  applyMoves,
  archiveTeam,
  employeeCounts,
  linesFromFloor,
  linesFromTree,
  listEmployees,
  listLeavers,
  listTeams,
  myTeams,
  setTeamLead,
  unlinkedWorkers,
  updateEmployee,
  whatYouSee,
  type Employee,
  type EmployeeCounts,
  type Leaver,
  type SiteLine,
  type Team,
  type UnlinkedWorker,
} from '../_shared/api'
import { csvRowOf, csvText, CSV_COLUMNS, employeesAddressOf, employeesAddressText, employeesQuery, ORDER_KEY, peopleCan, problemOf, readProblem, TIME_ZONE, todayIn, type EmployeesAddress } from '../_shared/model'
import type { Notice, SightState } from '../_shared/parts'
import { EmployeesImport } from './import/EmployeesImport'
import { useEmployeeDialogs } from './use-dialogs'
import type { CellState, EmployeesListModel, Rows, TeamOnly } from './view-model'
import { EmployeesView } from './view/EmployeesView'

/**
 * `/w/<company>/people/employees` (SCR-084): the address holds the list's state (`?tile=`, `?rows=`, `?q=`,
 * `?view=teams`, `?line=`, `?team=`, `?new=1`, `?import=1`); the site is the top bar's. The privacy note's rules are read
 * FIRST (`GET /people/privacy/what-you-see`), then the register (pages of 100 with "Show more"), its tiles and problems,
 * the teams with today's loans, the leavers in progress; live changes wait behind "N updates · Show". Team and home line
 * save inline; every pop-up goes through use-dialogs.ts.
 */
export function EmployeesPage() {
  return <EmployeesContainer />
}

const PAGE = 100
const NOTICES_KEY = 'people.employees.notices'

function readDismissed(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(NOTICES_KEY) ?? '[]') as unknown
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

function EmployeesContainer() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = useMemo(() => peopleCan(session.permissions), [session.permissions])
  const address = useMemo(() => ({ ...employeesAddressOf(params), teamId: params?.get('team') || null }), [params])
  const siteId = scope.siteId
  const go = useCallback(
    (next: Partial<EmployeesAddress & { teamId: string | null }>) => {
      const merged = { ...address, ...next }
      const keep = new URLSearchParams(params?.toString() ?? '')
      keep.delete('team')
      const text = employeesAddressText(merged, keep)
      const team = merged.teamId ? `${text ? '&' : '?'}team=${encodeURIComponent(merged.teamId)}` : ''
      router.replace(`${pathname}${text}${team}`, { scroll: false })
    },
    [router, pathname, address, params],
  )
  const [origin, setOrigin] = useState('')
  useEffect(() => setOrigin(window.location.origin), [])
  const today = todayIn(TIME_ZONE)

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

  // ---- My team (people.team.view) -------------------------------------------------------------------------------------------
  const [teamOnly, setTeamOnly] = useState<TeamOnly | null>(null)
  useEffect(() => {
    if (!can.team) return
    myTeams(api)
      .then((answer) => setTeamOnly({ employeeId: answer.employeeId, teams: answer.teams }))
      .catch(() => setTeamOnly(null))
  }, [api, can.team])
  const myTeam = teamOnly?.teams.find((team) => team.mine === 'LEAD') ?? teamOnly?.teams[0] ?? null

  // ---- the lines (home line, loans, Add team) -------------------------------------------------------------------------------
  const [lines, setLines] = useState<SiteLine[]>([])
  const [teams, setTeams] = useState<Rows<Team>>({ items: null, problem: null })
  const loadTeams = useCallback(async () => {
    if (!can.view) return
    try {
      const answer = await listTeams(api, siteId)
      setTeams({ items: answer.teams, problem: null })
    } catch (error) {
      setTeams({ items: null, problem: readProblem(error) })
    }
  }, [api, can.view, siteId])
  useEffect(() => {
    if (!can.view || !sightRead) return
    void loadTeams()
    const read = can.sites ? linesFromTree(api, siteId) : can.floorLines ? linesFromFloor(api, siteId) : Promise.resolve([] as SiteLine[])
    read.then(setLines).catch(() => setLines([]))
  }, [api, can.view, can.sites, can.floorLines, siteId, sightRead, loadTeams])
  // Without either source the lines teams are on are the ones known.
  const knownLines = useMemo<SiteLine[]>(() => {
    if (lines.length > 0) return lines
    const seen = new Map<string, SiteLine>()
    for (const team of teams.items ?? []) if (team.line && !seen.has(team.line.id)) seen.set(team.line.id, { ...team.line, siteId: team.site.id, teams: [] })
    return [...seen.values()]
  }, [lines, teams.items])

  // ---- the register ---------------------------------------------------------------------------------------------------------
  const [rows, setRows] = useState<Rows<Employee>>({ items: null, more: false, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [counts, setCounts] = useState<EmployeeCounts | null>(null)
  const [leavers, setLeavers] = useState<Rows<Leaver>>({ items: null, problem: null })
  const [unlinked, setUnlinked] = useState<Rows<UnlinkedWorker> & { complete: boolean }>({ items: null, problem: null, complete: true })
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  const readId = useRef(0)
  const query = useMemo(() => employeesQuery(address, address.rows === 'MY_TEAM' ? (myTeam?.id ?? null) : null), [address, myTeam?.id])

  const load = useCallback(async () => {
    if (!can.view || !sightRead) return
    const id = ++readId.current
    try {
      const page = await listEmployees(api, { ...query, siteId, limit: PAGE })
      if (id !== readId.current) return
      setRows({ items: page.employees, more: page.nextCursor !== null, problem: null })
      setCursor(page.nextCursor)
      setAsOf(new Date().toISOString())
      setUpdates(0)
      try {
        window.sessionStorage.setItem(ORDER_KEY, JSON.stringify(page.employees.map((row) => row.id)))
      } catch {
        // The order is a convenience (J / K on the record).
      }
    } catch (error) {
      if (id !== readId.current) return
      setRows({ items: null, more: false, problem: readProblem(error) })
    }
    employeeCounts(api, siteId)
      .then((value) => id === readId.current && setCounts(value))
      .catch(() => id === readId.current && setCounts(null))
    listLeavers(api, siteId)
      .then((answer) => id === readId.current && setLeavers({ items: answer.leavers, problem: null }))
      .catch((error: unknown) => id === readId.current && setLeavers({ items: null, problem: readProblem(error) }))
  }, [api, can.view, sightRead, query, siteId])

  useEffect(() => {
    setRows({ items: null, more: false, problem: null })
    void load()
  }, [load])

  const loadUnlinked = useCallback(async () => {
    if (!can.view || !sightRead || address.tile !== 'UNLINKED_WORKERS') return
    setUnlinked({ items: null, problem: null, complete: true })
    try {
      const answer = await unlinkedWorkers(api, siteId)
      setUnlinked({ items: answer.workers, problem: null, complete: answer.complete })
    } catch (error) {
      setUnlinked({ items: null, problem: readProblem(error), complete: true })
    }
  }, [api, can.view, sightRead, address.tile, siteId])
  useEffect(() => void loadUnlinked(), [loadUnlinked])

  const more = useCallback(async () => {
    if (!cursor) return
    try {
      const page = await listEmployees(api, { ...query, siteId, cursor, limit: PAGE })
      setRows((current) => ({ items: [...(current.items ?? []), ...page.employees.filter((row) => !current.items?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null, problem: null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ tone: 'danger', words: problemOf(error) })
    }
  }, [api, cursor, query, siteId])

  const reloadAll = useCallback(() => {
    void load()
    void loadTeams()
    void loadUnlinked()
  }, [load, loadTeams, loadUnlinked])

  // ---- live: the register waits behind "N updates · Show"; tiles, teams and leavers follow --------------------------------------
  const quiet = useRef<ReturnType<typeof setTimeout> | null>(null)
  const live = useLiveBus(
    {
      onChange: (change) => {
        if (change.type.startsWith('employee.')) setUpdates((count) => count + 1)
        if (!/^(employee|team|line_loan|leaver)\./.test(change.type)) return
        if (quiet.current) return
        quiet.current = setTimeout(() => {
          quiet.current = null
          employeeCounts(api, siteId).then(setCounts).catch(() => undefined)
          listLeavers(api, siteId)
            .then((answer) => setLeavers({ items: answer.leavers, problem: null }))
            .catch(() => undefined)
          void loadTeams()
        }, 1000)
      },
      onReconnect: reloadAll,
    },
    can.view,
  )

  // ---- inline: team (a move today) and home line ----------------------------------------------------------------------------
  const [cells, setCells] = useState<Record<string, CellState>>({})
  const onCell = useCallback(
    async (row: Employee, change: { teamId: string | null } | { homeLineId: string | null }) => {
      const field = 'teamId' in change ? 'teamId' : 'homeLineId'
      const key = `${row.id}:${field}`
      setCells((current) => ({ ...current, [key]: { state: 'saving' } }))
      try {
        if ('teamId' in change) {
          await applyMoves(api, [{ employeeId: row.id, teamId: change.teamId }], newIdempotencyKey())
          void load()
          void loadTeams()
        } else {
          const saved = await updateEmployee(api, row.id, { version: row.version, homeLineId: change.homeLineId })
          setRows((current) => ({ ...current, items: current.items?.map((entry) => (entry.id === saved.id ? saved : entry)) ?? null }))
        }
        setCells((current) => ({ ...current, [key]: { state: 'saved' } }))
      } catch (error) {
        setCells((current) => ({ ...current, [key]: { state: 'failed', words: problemOf(error) } }))
        setNotice({ tone: 'danger', words: { key: 'notice.cellRefused', params: { name: row.name } }, detail: problemOf(error) })
      }
    },
    [api, load, loadTeams],
  )

  // ---- the data notice ------------------------------------------------------------------------------------------------------
  const [dismissed, setDismissed] = useState<string[]>([])
  useEffect(() => setDismissed(readDismissed()), [])
  const [noticeIndex, setNoticeIndex] = useState(0)

  // ---- pop-ups --------------------------------------------------------------------------------------------------------------
  const dialogs = useEmployeeDialogs({
    api,
    can,
    timeZone: TIME_ZONE,
    onChanged: reloadAll,
    onCreated: (id) => router.push(`${prefix}/people/employees/${encodeURIComponent(id)}`),
    onNotice: setNotice,
    onClosed: (kind) => {
      if (kind === 'new') go({ isNew: false })
    },
  })
  const { openNew, setDialog } = dialogs
  useEffect(() => {
    if (address.isNew && can.view) openNew(siteId ?? (scope.sites.length === 1 ? scope.sites[0]!.id : null))
    else setDialog((current) => (current?.kind === 'new' ? null : current))
  }, [address.isNew, can.view, siteId, scope.sites, openNew, setDialog])

  const setLead = useCallback(
    async (team: Team, employeeId: string | null) => {
      try {
        await setTeamLead(api, team.id, { version: team.version, employeeId })
        void loadTeams()
        void load()
      } catch (error) {
        setNotice({ tone: 'danger', words: { key: 'notice.leadRefused', params: { team: team.code } }, detail: problemOf(error) })
      }
    },
    [api, load, loadTeams],
  )
  const archive = useCallback(
    async (team: Team) => {
      try {
        await archiveTeam(api, team.id, { version: team.version })
        setNotice({ tone: 'success', words: { key: 'notice.teamArchived', params: { team: team.code } } })
        void loadTeams()
      } catch (error) {
        setNotice({ tone: 'danger', words: { key: 'notice.teamRefused', params: { team: team.code } }, detail: problemOf(error) })
      }
    },
    [api, loadTeams],
  )

  // The CSV's words (the container draws nothing, but the file speaks the person's language).
  const locale = useLocale()
  const words = useMemo(() => createTranslator(locale, messagesFor(locale, ['people']).people ?? {}), [locale])
  const exportRows = useCallback(
    (ids: readonly string[]) => {
      const picked = (rows.items ?? []).filter((row) => ids.includes(row.id))
      const header = CSV_COLUMNS.map((column) => words(`csv.${column}`))
      const lines = picked.map((row) =>
        csvRowOf(
          row,
          {
            kind: words(`kind.${row.kind}`),
            contract: row.contract ? words(`contract.${row.contract}`) : '',
            badge: row.floor.signIns === 0 ? words('badge.noSignIn') : words(`badgeState.${row.floor.badge}`),
            notice: row.floor.notice ? words(`noticeState.${row.floor.notice}`) : '',
            status: words(`lifecycle.${row.lifecycle}`),
          },
          locale,
        ),
      )
      const blob = new Blob([`﻿${csvText(header, lines)}`], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `employees-${today}.csv`
      link.click()
      URL.revokeObjectURL(url)
    },
    [rows.items, words, locale, today],
  )

  const model: EmployeesListModel = {
    prefix,
    origin,
    can,
    address,
    scope,
    sight,
    rows,
    counts,
    myTeam: myTeam ? { id: myTeam.id, code: myTeam.code, name: myTeam.name } : null,
    teamOnly,
    unlinked,
    teams,
    leavers,
    lines: knownLines,
    sites: scope.sites.map((site) => ({ id: site.id, code: site.code ?? site.name, name: site.name })),
    asOf,
    live,
    updates,
    cells,
    dismissed,
    noticeIndex,
    dialog: dialogs.dialog,
    notice,
    today,
    timeZone: TIME_ZONE,
  }

  return (
    <EmployeesView
        model={model}
        extra={<EmployeesImport open={address.isImport && can.view} companyId={session.company?.id ?? null} prefix={prefix} can={can} onClose={() => go({ isImport: false })} onApplied={reloadAll} />}
        actions={{
          onTile: (tile) => go({ tile, rows: 'ACTIVE' }),
          onRows: (next) => go({ rows: next, tile: null }),
          onSearch: (q) => go({ q }),
          onView: (view) => go({ view, lineId: null, teamId: null, tile: null }),
          onRetry: reloadAll,
          onMore: () => void more(),
          onShowUpdates: () => void load(),
          onOpen: (id) => router.push(`${prefix}/people/employees/${encodeURIComponent(id)}`),
          onCell: (row, change) => void onCell(row, change),
          onNew: () => go({ isNew: true }),
          onImport: () => go({ isImport: true }),
          onNoticeDismiss: (key) => {
            const next = [...new Set([...dismissed, key])]
            setDismissed(next)
            try {
              window.localStorage.setItem(NOTICES_KEY, JSON.stringify(next))
            } catch {
              // A dismissal is a convenience for this browser.
            }
          },
          onNoticeNext: () => setNoticeIndex((index) => index + 1),
          onLoan: dialogs.openLoan,
          onLeaver: dialogs.openLeaver,
          onBadges: dialogs.openBadges,
          onTeamChange: dialogs.openTeamChange,
          onLink: dialogs.openLink,
          onAddTeam: () => dialogs.openAddTeam(siteId ?? (scope.sites.length === 1 ? scope.sites[0]!.id : null)),
          onSetLead: (team, employeeId) => void setLead(team, employeeId),
          onArchiveTeam: (team) => void archive(team),
          onStepDone: (leaver, step) => void dialogs.markStepDone(leaver, step),
          onStepSkip: dialogs.openSkip,
          onCancelLeaving: dialogs.openCancelLeaving,
          onExport: exportRows,
          onDismissNotice: () => setNotice(null),
          dialog: dialogs.actions,
        }}
      />
  )
}
