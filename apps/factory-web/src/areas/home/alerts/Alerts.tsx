'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { recordAddress } from '../../../lib/records/record-links'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import type { PanelRead } from '../../../record-panels/model'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { getRule, type AlertRule } from '../../_shared/rules/api'
import { readProblemOf as ruleReadProblem } from '../../_shared/rules/model'
import { useRules } from '../../_shared/rules/use-rules'
import { useTodayLive } from '../today/live'
import { acknowledgeAlert, alertAssignees, assignAlert, bulkAcknowledge, getAlert, listAlerts, resolveAlert, snoozeAlert, type AlertDetail, type AlertItem, type AlertList } from './api'
import { alertsAddress, alertsCan, bulkRows, controlsOf, readProblemOf, refusalOf, updatesBetween, type AlertRow, type AlertsControls, type AlertsDialog, type AlertsNotice, type AlertsViewModel, type AlertView } from './model'
import { AlertsView, type AlertsDialogRequest } from './view/AlertsView'

interface ListState {
  readonly answer: AlertList
  readonly items: readonly AlertItem[]
  readonly cursor: string | null
  readonly loadingMore: boolean
  /** A fresher first page a live change brought, shown when the person asks ("N updates · Show"). */
  readonly pending: AlertList | null
}

const ALERT_EVENTS = ['alert.raised', 'alert.acknowledged', 'alert.assigned', 'alert.snoozed', 'alert.resolved', 'alert.rule_changed']

/**
 * `/w/<company>/home/alerts` (SCR-234): Home › Alerts through the API client — GET /alerts (`?tile=` `?severity=` `?kind=`
 * `?q=`; the tiles over the company), the popup (`?open=<id>`: GET /alerts/:id for its history and similar alerts, its rule
 * from the rules list or GET /alerts/rules/:id), who it may be given to (GET /alerts/:id/assignees), and every change with
 * the alert's version as read and an Idempotency-Key: Acknowledge (one, or the selection: all or none), Assign, Snooze,
 * Resolve with a note. The Rules (GET /alerts/rules): the switch and the number in the list (PUT with the rule's version),
 * the rule dialog (`?rule=<id>`, `?rule=new`: the roles and places from GET /alerts/rules/choices, a dry run, a date rule's
 * timers). A refusal says why and the list is read again. Live: alert.* → "N updates · Show"; a rule change reads the rules.
 */
export function Alerts() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const search = useSearchParams()
  const can = useMemo(() => alertsCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const controls = controlsOf(search)
  const { tile, severity, kind, q: addressQ, open: openId, rule: ruleParam } = controls

  const [list, setList] = useState<PanelRead<ListState>>({ status: 'loading' })
  const [q, setQ] = useState(addressQ)
  const [selected, setSelected] = useState<string[]>([])
  const [openRead, setOpenRead] = useState<{ readonly id: string; readonly read: PanelRead<AlertDetail> } | null>(null)
  const [openRule, setOpenRule] = useState<{ readonly id: string; readonly read: PanelRead<AlertRule> } | null>(null)
  const [dialog, setDialog] = useState<AlertsDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<AlertsNotice | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const seq = useRef(0)
  const query = useRef(controls)
  query.current = controls

  const go = useCallback(
    (next: Partial<AlertsControls>) => {
      router.replace(`${pathname}${alertsAddress({ ...query.current, ...next })}`, { scroll: false })
    },
    [router, pathname],
  )

  // ---- reads -------------------------------------------------------------------------------------------------------
  const read = useCallback(() => listAlerts(api, { tile: query.current.tile, severity: query.current.severity, ruleKind: query.current.kind, q: query.current.q }), [api])
  const load = useCallback(async () => {
    const mine = ++seq.current
    try {
      const answer = await read()
      if (mine !== seq.current) return
      setNow(Date.now())
      setList({ status: 'ready', data: { answer, items: answer.items, cursor: answer.nextCursor, loadingMore: false, pending: null } })
    } catch (error) {
      if (mine === seq.current) setList({ status: 'error', problem: readProblemOf(error) })
    }
  }, [read])
  const refresh = useCallback(async () => {
    const mine = ++seq.current
    try {
      const answer = await read()
      if (mine !== seq.current) return
      setList((current) => {
        if (current.status !== 'ready') return { status: 'ready', data: { answer, items: answer.items, cursor: answer.nextCursor, loadingMore: false, pending: null } }
        const changed = updatesBetween(current.data.items.slice(0, answer.items.length), answer.items)
        if (changed === 0) return { status: 'ready', data: { ...current.data, answer: { ...current.data.answer, tiles: answer.tiles, total: answer.total, asOf: answer.asOf }, pending: null } }
        return { status: 'ready', data: { ...current.data, pending: answer } }
      })
    } catch {
      // A failed refresh keeps what is shown; the next change or a reconnect reads again.
    }
  }, [read])
  const ruling = useRules({ api, enabled: can.view, manage: can.manageRules, ruleParam, onClose: () => go({ rule: null }), onNotice: setNotice })
  const rules = ruling.rules

  useEffect(() => {
    if (!can.view) return
    setList({ status: 'loading' })
    setSelected([])
    void load()
  }, [can.view, tile, severity, kind, addressQ, load])

  // The search field writes the address after a short pause (the list reads it from there).
  useEffect(() => setQ(addressQ), [addressQ])
  useEffect(() => {
    if (q === addressQ) return
    const timer = setTimeout(() => go({ q, open: null }), 300)
    return () => clearTimeout(timer)
  }, [q, addressQ, go])

  const items = list.status === 'ready' ? list.data.items : []
  const rulesList = rules.status === 'ready' ? rules.data.rules : []

  // The popup: the alert read alone (history, similar), and its rule (from the list when there, else read).
  const readOpen = useCallback(
    async (id: string) => {
      setOpenRead({ id, read: { status: 'loading' } })
      try {
        const detail = await getAlert(api, id)
        setOpenRead((current) => (current?.id === id ? { id, read: { status: 'ready', data: detail } } : current))
      } catch (error) {
        setOpenRead((current) => (current?.id === id ? { id, read: { status: 'error', problem: readProblemOf(error) } } : current))
      }
    },
    [api],
  )
  useEffect(() => {
    if (!openId || !can.view) {
      setOpenRead(null)
      return
    }
    void readOpen(openId)
  }, [openId, can.view, readOpen])
  const openRuleId = openRead?.read.status === 'ready' ? openRead.read.data.alert.ruleId : null
  const ruleInList = openRuleId ? (rulesList.find((rule) => rule.id === openRuleId) ?? null) : null
  useEffect(() => {
    if (!openRuleId || ruleInList || rules.status === 'loading' || openRule?.id === openRuleId) return
    setOpenRule({ id: openRuleId, read: { status: 'loading' } })
    getRule(api, openRuleId)
      .then((rule) => setOpenRule((current) => (current?.id === openRuleId ? { id: openRuleId, read: { status: 'ready', data: rule } } : current)))
      .catch((error: unknown) => setOpenRule((current) => (current?.id === openRuleId ? { id: openRuleId, read: { status: 'error', problem: ruleReadProblem(error) } } : current)))
  }, [api, openRuleId, ruleInList, rules.status, openRule])

  // ---- live ----------------------------------------------------------------------------------------------------------
  const pendingRead = useRef<ReturnType<typeof setTimeout> | null>(null)
  const readSoon = useCallback(
    (rulesToo: boolean) => {
      if (pendingRead.current) clearTimeout(pendingRead.current)
      pendingRead.current = setTimeout(() => {
        pendingRead.current = null
        void refresh()
        if (rulesToo) ruling.refresh()
      }, 500)
    },
    // The rules' read is the hook's own, stable for the page's client.
    [refresh, ruling.refresh],
  )
  useEffect(() => () => (pendingRead.current ? clearTimeout(pendingRead.current) : undefined), [])
  const live = useTodayLive({ onChange: (type) => ALERT_EVENTS.includes(type) && readSoon(type === 'alert.rule_changed' || type === 'alert.raised'), onReconnect: () => readSoon(true) }, can.view)

  // ---- writes --------------------------------------------------------------------------------------------------------
  const alertOf = (id: string): AlertItem | null => items.find((item) => item.id === id) ?? (openRead?.id === id && openRead.read.status === 'ready' ? openRead.read.data.alert : null)
  const failed = (error: unknown) => {
    const problem = refusalOf(error)
    setNotice({ key: problem.key, tone: 'danger' })
    if (problem.reload) {
      void load()
      if (query.current.open) void readOpen(query.current.open)
    }
  }
  /** One change: busy, the API, the popup read again, the list read again. */
  const change = async (run: () => Promise<unknown>, done: AlertsNotice): Promise<boolean> => {
    setBusy(true)
    setNotice(null)
    try {
      await run()
      setNotice(done)
      await load()
      if (query.current.open) void readOpen(query.current.open)
      return true
    } catch (error) {
      failed(error)
      return false
    } finally {
      setBusy(false)
    }
  }
  const openDialog = useCallback(
    (request: AlertsDialogRequest | null) => {
      if (request === null) return setDialog(null)
      setNotice(null)
      if (request.kind === 'assign') {
        setDialog({ kind: 'assign', id: request.id, people: { status: 'loading' } })
        alertAssignees(api, request.id)
          .then((people) => setDialog((current) => (current?.kind === 'assign' && current.id === request.id ? { ...current, people: { status: 'ready', data: people } } : current)))
          .catch((error: unknown) => setDialog((current) => (current?.kind === 'assign' && current.id === request.id ? { ...current, people: { status: 'error', problem: readProblemOf(error) } } : current)))
      } else setDialog(request)
    },
    [api],
  )
  // ---- the view model ------------------------------------------------------------------------------------------------
  const rowOf = useCallback(
    (alert: AlertItem): AlertRow => ({
      ...alert,
      href: `${prefix}/home/alerts${alertsAddress({ ...query.current, open: alert.id, rule: null })}`,
      recordHref: `${prefix}${recordAddress({ type: alert.record.type, id: alert.record.id, label: alert.record.label, companyId: alert.companyId, siteId: alert.siteId }, OFFICE_PAGES)}`,
    }),
    // The address terms are read through the ref; the prefix is the one input.
    [prefix],
  )
  const detailView = (detail: AlertDetail): AlertView => ({
    ...detail,
    alert: rowOf(detail.alert),
    similar: detail.similar.map((other) => ({ ...other, href: `${prefix}/home/alerts${alertsAddress({ ...query.current, open: other.id, rule: null })}` })),
  })
  const ruleRead: PanelRead<AlertRule> | null = openRuleId ? (ruleInList ? { status: 'ready', data: ruleInList } : openRule?.id === openRuleId ? openRule.read : { status: 'loading' }) : null
  const model: AlertsViewModel = {
    access: can.view ? 'open' : 'refused',
    now,
    prefix,
    can,
    live,
    controls: { ...controls, q },
    list:
      list.status === 'ready'
        ? {
            status: 'ready',
            data: { asOf: list.data.answer.asOf, tiles: list.data.answer.tiles, total: list.data.answer.total, complete: list.data.answer.complete, rows: list.data.items.map(rowOf), more: list.data.cursor !== null, loadingMore: list.data.loadingMore },
          }
        : list,
    updates: list.status === 'ready' && list.data.pending ? Math.max(1, updatesBetween(list.data.items, list.data.pending.items)) : 0,
    selected,
    open: openId ? { id: openId, detail: openRead?.id === openId ? (openRead.read.status === 'ready' ? { status: 'ready', data: detailView(openRead.read.data) } : openRead.read) : { status: 'loading' }, rule: ruleRead } : null,
    dialog,
    busy: busy || ruling.busy,
    notice: notice ?? (ruling.dialogProblem ? { key: `rules:${ruling.dialogProblem}`, tone: 'danger' } : null),
    rules,
    ruleDialog: ruling.dialog,
    savingRules: ruling.saving,
  }

  return (
    <AlertsView
      model={model}
      actions={{
        onControls: (next) => go(next),
        onSearch: setQ,
        onMore: async () => {
          if (list.status !== 'ready' || list.data.cursor === null) return
          const cursor = list.data.cursor
          setList({ status: 'ready', data: { ...list.data, loadingMore: true } })
          try {
            const page = await listAlerts(api, { tile, severity, ruleKind: kind, q: addressQ, cursor })
            setList((current) => (current.status === 'ready' ? { status: 'ready', data: { ...current.data, items: [...current.data.items, ...page.items], cursor: page.nextCursor, loadingMore: false } } : current))
          } catch (error) {
            setList((current) => (current.status === 'ready' ? { status: 'ready', data: { ...current.data, loadingMore: false } } : current))
            setNotice({ key: readProblemOf(error), tone: 'danger' })
          }
        },
        onShowUpdates: () => {
          if (list.status !== 'ready' || !list.data.pending) return
          const answer = list.data.pending
          setList({ status: 'ready', data: { answer, items: answer.items, cursor: answer.nextCursor, loadingMore: false, pending: null } })
        },
        onSelect: setSelected,
        onOpen: (id) => {
          setNotice(null)
          go({ open: id, rule: null })
        },
        onRetry: () => {
          setList({ status: 'loading' })
          void load()
        },
        onRetryOpen: () => openId && void readOpen(openId),
        onRetryPeople: () => dialog?.kind === 'assign' && openDialog({ kind: 'assign', id: dialog.id }),
        onDialog: openDialog,
        onDismissNotice: () => setNotice(null),
        onAcknowledge: (id) => {
          const alert = alertOf(id)
          if (alert) void change(() => acknowledgeAlert(api, alert), { key: 'notice.acknowledged', tone: 'success', params: { record: alert.record.label } })
        },
        onBulkAcknowledge: async () => {
          const rows = bulkRows(items, selected)
          if (rows.length === 0) return
          const ok = await change(() => bulkAcknowledge(api, rows), { key: 'notice.bulkAcknowledged', tone: 'success', params: { count: rows.length } })
          if (ok) setSelected([])
        },
        onAssign: async (id, assigneeId) => {
          const alert = alertOf(id)
          if (!alert) return false
          const ok = await change(() => assignAlert(api, alert, assigneeId), { key: assigneeId === null ? 'notice.unassigned' : 'notice.assigned', tone: 'success', params: { record: alert.record.label } })
          if (ok) setDialog(null)
          return ok
        },
        onSnooze: async (id, until) => {
          const alert = alertOf(id)
          if (!alert) return false
          const ok = await change(() => snoozeAlert(api, alert, until), { key: 'notice.snoozed', tone: 'success', params: { record: alert.record.label } })
          // A snoozed alert leaves the list until then: the popup closes with it.
          if (ok) {
            setDialog(null)
            go({ open: null })
          }
          return ok
        },
        onResolve: async (id, note) => {
          const alert = alertOf(id)
          if (!alert) return false
          const ok = await change(() => resolveAlert(api, alert, note), { key: 'notice.resolved', tone: 'success', params: { record: alert.record.label } })
          if (ok) setDialog(null)
          return ok
        },
        onRule: (id) => {
          setNotice(null)
          go({ rule: id, open: null })
        },
        onRetryRules: ruling.reload,
        onRuleSwitch: ruling.switchRule,
        onRuleNumber: ruling.numberRule,
        onRuleSave: ruling.save,
        onRuleTest: (draft, ruleId) => void ruling.test(draft, ruleId),
        onRetryChoices: ruling.retryChoices,
        onRetryTimers: ruling.retryTimers,
      }}
    />
  )
}
