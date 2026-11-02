'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import { useLiveBus } from '../../../shell/live/use-live'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import { isStepUpCancelled, useStepUp } from '../../quality/_shared/hooks'
import { linesFromFloor, linesFromTree, whatYouSee } from '../_shared/api'
import { TIME_ZONE, todayIn } from '../_shared/model'
import type { Notice, SightState } from '../_shared/parts'
import * as call from './api'
import {
  bodyOfRate,
  bodyOfScheme,
  blankRate,
  blankScheme,
  draftOfRate,
  draftOfScheme,
  everOn,
  everOnRow,
  hasRight,
  missingOf,
  monthText,
  pieceAddressOf,
  pieceAddressText,
  pieceCan,
  problemWords,
  runTarget,
  schemeHeld,
  startDayFloor,
  tableCodeOf,
  versionHeld,
  versionsOfRows,
  minorOfTyped,
  type PieceAddress,
  type RateDraft,
  type RateTile,
  type VersionDraft,
  type Words,
} from './model'
import type { PieceActions, PieceDialog, PieceModel, PreconditionsDraft, Read } from './view-model'

const LOADING = { status: 'loading' } as const

/** One read of the page: quiet when it runs again (the rows stay), a failure in our words, the last answer wins. */
function useRead<T>(enabled: boolean, load: () => Promise<T>, deps: readonly unknown[]): [Read<T>, () => Promise<void>] {
  const [read, setRead] = useState<Read<T>>(LOADING)
  const turn = useRef(0)
  const loader = useRef(load)
  loader.current = load
  const run = useCallback(async () => {
    const mine = ++turn.current
    try {
      const value = await loader.current()
      if (mine === turn.current) setRead({ status: 'ready', value })
    } catch (error) {
      if (mine === turn.current) setRead({ status: 'failed', problem: problemWords(error) })
    }
  }, [])
  useEffect(() => {
    if (!enabled) return
    setRead(LOADING)
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, run, ...deps])
  return [read, run]
}

const valueOf = <T,>(read: Read<T> | null | undefined): T | null => (read?.status === 'ready' ? read.value : null)
const PRECONDITION_EVENTS = new Set(['piece_pay.switched', 'incentive_scheme.changed', 'legal_gate.changed', 'payroll_code.changed'])
const RATE_EVENTS = new Set(['piece_rate_table.changed', 'piece_rate_version.changed', 'rate_publication.changed', 'rate.read'])
const PAY_EVENTS = new Set(['earnings.recorded', 'held_scan.changed', 'pay_period.changed', 'worker_statement.changed', 'attendance.day_changed', 'labour_dispute.raised', 'labour_dispute.answered', 'labour_dispute.withdrawn'])

/**
 * Everything People › Piece rates reads and writes (B-W2b-62). The privacy note's rules are read FIRST; then the overview and
 * the gate; the sections about people only once piece pay has been on here (the switch comes first). Live: `rate.read` and
 * the rate events re-read the rates, the pay events the periods, the held list and the tiles, each coalesced. A statement is
 * opened only on the person's choice, never in advance: each opening is recorded.
 */
export function usePieceRates(): { model: PieceModel; actions: PieceActions } {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const prefix = companyPrefix(session.company?.code ?? '')
  const companyId = session.company?.id ?? null
  const can = useMemo(() => pieceCan(session.permissions), [session.permissions])
  const address = useMemo(() => pieceAddressOf(params), [params])
  const today = todayIn(TIME_ZONE)
  const siteId = scope.siteId ?? (scope.sites.length === 1 ? scope.sites[0]!.id : null)

  const go = useCallback(
    (next: Partial<PieceAddress>) => {
      const keep = new URLSearchParams(params?.toString() ?? '')
      router.replace(`${pathname}${pieceAddressText({ ...pieceAddressOf(params), ...next }, keep)}`, { scroll: false })
    },
    [router, pathname, params],
  )

  const [notice, setNotice] = useState<Notice | null>(null)
  const [dialog, setDialog] = useState<PieceDialog | null>(null)
  const [help, setHelp] = useState(false)
  const [selectedRates, setSelectedRates] = useState<string[]>([])
  const [selectedHeld, setSelectedHeld] = useState<string[]>([])
  const [asOf, setAsOf] = useState<string | null>(null)
  const [busyRun, setBusyRun] = useState(false)
  const patchDialog = useCallback(<K extends PieceDialog['kind']>(kind: K, patch: Partial<Extract<PieceDialog, { kind: K }>>) => setDialog((current) => (current?.kind === kind ? ({ ...current, ...patch } as PieceDialog) : current)), [])
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)

  // ---- what you see here (read before any person) ---------------------------------------------------------------------------
  const [sight, setSight] = useState<SightState>({ status: 'loading' })
  const [sightRead, setSightRead] = useState(false)
  useEffect(() => {
    let live = true
    setSightRead(false)
    if (!siteId) {
      setSight({ status: 'allSites' })
      setSightRead(true)
      return
    }
    setSight({ status: 'loading' })
    whatYouSee(api, siteId)
      .then((value) => live && setSight({ status: 'ready', sight: value }))
      .catch(() => live && setSight({ status: 'failed' }))
      .finally(() => live && setSightRead(true))
    return () => {
      live = false
    }
  }, [api, siteId])

  // The ledger's export reads the address: the top bar's site is written there.
  useEffect(() => {
    if ((scope.siteId ?? null) !== address.site) go({ site: scope.siteId ?? null })
  }, [scope.siteId, address.site, go])

  const ready = can.view && sightRead
  const [overview, readOverviewAgain] = useRead(ready, () => call.readOverview(api, companyId), [companyId])
  const [gate, readGateAgain] = useRead(ready && !!siteId, () => call.readSwitch(api, siteId!), [siteId])
  const gateValue = valueOf(gate)
  const ever = useMemo(() => {
    if (siteId) return gateValue ? everOn(gateValue) : false
    return (valueOf(overview)?.sites ?? []).some(everOnRow)
  }, [siteId, gateValue, overview])

  const [rates, readRatesAgain] = useRead(ready && !!siteId, () => call.readRates(api, siteId!, address.allVersions ? 'ALL' : 'CURRENT', address.q), [siteId, address.allVersions, address.q])
  const [tablesRead, readTablesAgain] = useRead(ready && !!siteId, () => call.readTables(api, siteId!), [siteId])
  const [schemes, readSchemesAgain] = useRead(ready && !!companyId, () => call.readSchemes(api, companyId!), [companyId])
  const [schemePicked, setSchemePicked] = useState<string | null>(null)
  const schemeList = valueOf(schemes)
  const schemeId = schemePicked ?? schemeList?.applies.find((row) => row.line === null)?.scheme?.id ?? schemeList?.schemes[0]?.id ?? null
  const [scheme, readSchemeAgain] = useRead(ready && !!schemeId, () => call.readScheme(api, schemeId!), [schemeId])
  const [schemeEdit, setSchemeEdit] = useState<PieceModel['schemeEdit']>(null)

  const people = ready && ever
  const right = hasRight(can)
  const [periods, readPeriodsAgain] = useRead(people && can.earnings && !!companyId, () => call.readPeriods(api, companyId!).then((answer) => answer.periods), [companyId])
  const [held, readHeldAgain] = useRead(people && can.earnings, () => call.readHeld(api, { siteId, status: address.heldAll ? null : 'OPEN' }), [siteId, address.heldAll])
  const [countsRead, readCountsAgain] = useRead(people && can.earnings, () => call.readCounts(api, companyId, siteId), [companyId, siteId])
  const [reviewRead] = useRead(ready && can.efficiency && !!siteId, () => call.reviewQueueCount(api, siteId!), [siteId])

  const [ledger, setLedger] = useState<PieceModel['ledger']>(null)
  const ledgerTurn = useRef(0)
  const readLedger = useCallback(
    async (cursor: string | null = null) => {
      const mine = ++ledgerTurn.current
      setLedger((current) => (cursor ? { ...(current ?? { entries: [], problem: null, more: false, loadingMore: false }), loadingMore: true } : (current ?? { entries: null, problem: null, more: false, loadingMore: false })))
      try {
        const page = await call.readLedger(api, { siteId, periodId: address.ledgerPeriod, lineId: address.ledgerLine, kind: address.ledgerKind, cursor })
        if (mine !== ledgerTurn.current) return
        ledgerCursor.current = page.nextCursor
        setLedger((current) => ({ entries: cursor ? [...(current?.entries ?? []), ...page.entries] : page.entries, problem: null, more: page.nextCursor !== null, loadingMore: false }))
      } catch (error) {
        if (mine === ledgerTurn.current) setLedger({ entries: null, problem: problemWords(error), more: false, loadingMore: false })
      }
    },
    [api, siteId, address.ledgerPeriod, address.ledgerLine, address.ledgerKind],
  )
  const ledgerCursor = useRef<string | null>(null)
  useEffect(() => {
    if (people && right) void readLedger()
    else setLedger(null)
  }, [people, right, readLedger])

  const [lines, setLines] = useState<call.Ref[]>([])
  useEffect(() => {
    let live = true
    if (!ready || !(can.sites || can.floorLines)) return
    ;(can.sites ? linesFromTree(api, siteId) : linesFromFloor(api, siteId))
      .then((rows) => live && setLines(rows.map((row) => ({ id: row.id, code: row.code, name: row.name }))))
      .catch(() => live && setLines([]))
    return () => {
      live = false
    }
  }, [api, ready, siteId, can.sites, can.floorLines])

  const readRatesSide = useCallback(() => {
    void readRatesAgain()
    void readTablesAgain()
    void readOverviewAgain()
    void readGateAgain()
  }, [readRatesAgain, readTablesAgain, readOverviewAgain, readGateAgain])
  const readPaySide = useCallback(() => {
    void readPeriodsAgain()
    void readHeldAgain()
    void readCountsAgain()
    if (people && right) void readLedger()
  }, [readPeriodsAgain, readHeldAgain, readCountsAgain, readLedger, people, right])

  useEffect(() => {
    if (overview.status === 'ready') setAsOf(new Date().toISOString())
  }, [overview])

  // ---- the records in their modals (address-held, so a reload comes back to them) ------------------------------------------
  const [version, readVersionAgain] = useRead(ready && !!address.open, () => call.readVersion(api, address.open!), [address.open])
  const [periodRead, readPeriodAgain] = useRead(ready && can.earnings && !!address.period, () => call.readPeriod(api, address.period!), [address.period])
  const [statements, readStatementsAgain] = useRead(ready && can.earnings && !!address.period, () => call.readStatements(api, address.period!), [address.period])
  const [periodBusy, setPeriodBusy] = useState<{ busy: boolean; problem: Words | null }>({ busy: false, problem: null })
  const [statement, setStatement] = useState<PieceModel['statement']>(null)
  const [heldRecordRead] = useRead(ready && can.earnings && !!address.resolve, () => call.readHeldRecord(api, address.resolve!), [address.resolve])
  const [heldForm, setHeldForm] = useState<{ note: string; busy: boolean; problem: Words | null }>({ note: '', busy: false, problem: null })
  const [entry, readEntryAgain] = useRead(ready && right && !!address.entry, () => call.readEntry(api, address.entry!), [address.entry])

  // ---- live ---------------------------------------------------------------------------------------------------------------------
  const timers = useRef<{ rates: ReturnType<typeof setTimeout> | null; pay: ReturnType<typeof setTimeout> | null }>({ rates: null, pay: null })
  const refresh = useRef({ rates: readRatesSide, pay: readPaySide, version: readVersionAgain, period: readPeriodAgain, open: address.open, periodId: address.period })
  refresh.current = { rates: readRatesSide, pay: readPaySide, version: readVersionAgain, period: readPeriodAgain, open: address.open, periodId: address.period }
  const live = useLiveBus(
    {
      onChange: (change) => {
        if (RATE_EVENTS.has(change.type) || PRECONDITION_EVENTS.has(change.type)) {
          if (timers.current.rates) return
          timers.current.rates = setTimeout(() => {
            timers.current.rates = null
            refresh.current.rates()
            void readSchemesAgain()
            if (refresh.current.open) void refresh.current.version()
          }, 800)
        } else if (PAY_EVENTS.has(change.type)) {
          if (timers.current.pay) return
          timers.current.pay = setTimeout(() => {
            timers.current.pay = null
            refresh.current.pay()
            if (refresh.current.periodId) void refresh.current.period()
          }, 1500)
        }
      },
      onReconnect: () => {
        refresh.current.rates()
        refresh.current.pay()
      },
    },
    ready,
  )

  // ---- actions ------------------------------------------------------------------------------------------------------------------
  const tellDone = useCallback((key: string, params?: Words['params'], tone: Notice['tone'] = 'success') => setNotice({ tone, words: { key, ...(params ? { params } : {}) } }), [])
  const close = useCallback(() => setDialog(null), [])
  const fail = useCallback(<K extends PieceDialog['kind']>(kind: K, error: unknown) => patchDialog(kind, { busy: false, problem: problemWords(error) } as never), [patchDialog])
  const rateKey = useRef(0)
  const nextKey = () => `r${++rateKey.current}`

  const actions: PieceActions = {
    onAddress: go,
    onTile: (tile: RateTile | null) => {
      go({ tile })
      setSelectedRates([])
    },
    onSelectSite: (id) => scope.setSite(id),
    onDismissNotice: () => setNotice(null),
    onHelp: setHelp,
    onRetry: () => {
      readRatesSide()
      readPaySide()
      void readSchemesAgain()
    },
    // the gate
    onPreconditions: () => {
      if (!gateValue) return
      const { recorded } = gateValue
      setDialog({ kind: 'preconditions', busy: false, problem: null, draft: { ccnlName: recorded.ccnlName ?? '', ccnlArticle: recorded.ccnlArticle ?? '', workerNoticeId: recorded.workerNotice?.id ?? '', dpiaId: recorded.dpia?.id ?? '', consultantName: recorded.consultantName ?? '', consultantAgreedOn: recorded.consultantAgreedOn ?? '', schemeId: recorded.scheme?.id ?? '', note: recorded.preconditionsNote ?? '' } })
    },
    onPreconditionsDraft: (patch: Partial<PreconditionsDraft>) => setDialog((current) => (current?.kind === 'preconditions' ? { ...current, draft: { ...current.draft, ...patch } } : current)),
    onPreconditionsSave: () => {
      if (dialog?.kind !== 'preconditions' || !gateValue || !siteId) return
      const { draft } = dialog
      patchDialog('preconditions', { busy: true, problem: null })
      const body = gateValue.state === 'ON' ? { version: gateValue.version ?? undefined, preconditionsNote: draft.note.trim() || null } : { ...(gateValue.version ? { version: gateValue.version } : {}), ccnlName: draft.ccnlName.trim() || null, ccnlArticle: draft.ccnlArticle.trim() || null, workerNoticeId: draft.workerNoticeId || null, dpiaId: draft.dpiaId || null, consultantName: draft.consultantName.trim() || null, consultantAgreedOn: draft.consultantAgreedOn || null, schemeId: draft.schemeId || null, preconditionsNote: draft.note.trim() || null }
      call.recordPreconditions(api, siteId, body as call.PreconditionsBody).then(
        () => {
          close()
          void readGateAgain()
          tellDone('gate.saved')
        },
        (error) => fail('preconditions', error),
      )
    },
    onStart: () => gateValue && setDialog({ kind: 'start', onFrom: startDayFloor(gateValue), reason: '', busy: false, problem: null, missing: [] }),
    onStartDraft: (patch) => patchDialog('start', patch),
    onStartSave: () => {
      if (dialog?.kind !== 'start' || !gateValue || !siteId || gateValue.version === null) return
      const body = { version: gateValue.version, onFrom: dialog.onFrom, reason: dialog.reason.trim() }
      const idempotencyKey = newIdempotencyKey()
      patchDialog('start', { busy: true, problem: null, missing: [] })
      guard('stepUp.start', () => call.startPiecePay(api, siteId, body, idempotencyKey)).then(
        () => {
          close()
          readRatesSide()
          tellDone('gate.started', { day: dialog.onFrom })
        },
        (error) => {
          if (isStepUpCancelled(error)) return patchDialog('start', { busy: false })
          patchDialog('start', { busy: false, problem: problemWords(error), missing: missingOf(error) })
        },
      )
    },
    onStop: () => setDialog({ kind: 'stop', reason: '', busy: false, problem: null }),
    onStopSave: () => {
      if (dialog?.kind !== 'stop' || !gateValue || !siteId || gateValue.version === null) return
      patchDialog('stop', { busy: true, problem: null })
      call.stopPiecePay(api, siteId, { version: gateValue.version, reason: dialog.reason.trim() }).then(
        (answer) => {
          close()
          readRatesSide()
          tellDone('gate.stopped', { day: answer.offFrom ?? today }, 'info')
        },
        (error) => fail('stop', error),
      )
    },
    onDialogReason: (reason) => setDialog((current) => (current && 'reason' in current ? ({ ...current, reason } as PieceDialog) : current)),
    onStepUpSubmit: (code) => void submitStepUp(code),
    onStepUpCancel: cancelStepUp,
    onCloseDialog: close,
    // rates
    onSelectRates: setSelectedRates,
    onNewVersion: (from) => {
      const tables = valueOf(tablesRead) ?? []
      const fromTable = typeof from === 'object' ? tables.find((row) => row.table.id === from.tableId) : undefined
      const table = fromTable ?? (tables.length === 1 ? tables[0] : undefined)
      const draft: VersionDraft = { tableId: table?.table.id ?? '', changeReason: table ? '' : 'NEW', changeNote: '', effectiveFrom: today, provisional: false, trialEndsOn: '', rates: [] }
      setDialog({ kind: 'version', draft, table: tables.length === 0 ? { name: '', code: '', styleId: '', lineId: '' } : null, editing: null, operations: null, styles: [], lines, rateForAll: '', busy: false, problem: null })
      void readOperationsFor().then((rows) => {
        patchDialog('version', { operations: rows })
        if (from === 'library') addLibrary(rows)
      })
      if (can.styles) void call.readStyles(api).then((rows) => patchDialog('version', { styles: rows }), () => undefined)
      if (table) copyLatest(table.table.id)
    },
    onEditRates: (detail) => {
      setDialog({ kind: 'version', draft: { tableId: detail.table.id, changeReason: detail.version.changeReason, changeNote: detail.version.changeNote ?? '', effectiveFrom: detail.version.effectiveFrom, provisional: detail.version.provisional, trialEndsOn: detail.version.trialEndsOn ?? '', rates: detail.rates.map((rate) => draftOfRate(rate, nextKey())) }, table: null, editing: { id: detail.version.id, version: detail.version.version }, operations: null, styles: [], lines, rateForAll: '', busy: false, problem: null })
      void readOperationsFor().then((rows) => patchDialog('version', { operations: rows }))
    },
    onVersionDraft: (patch) => {
      setDialog((current) => (current?.kind === 'version' ? { ...current, draft: { ...current.draft, ...patch, ...(patch.tableId !== undefined && patch.tableId !== current.draft.tableId ? { rates: [] } : {}) } } : current))
      if (patch.tableId) copyLatest(patch.tableId)
    },
    onTableDraft: (patch) => setDialog((current) => (current?.kind === 'version' ? { ...current, table: patch === null ? null : (() => { const merged = { ...(current.table ?? { name: '', code: '', styleId: '', lineId: '' }), ...patch }; return patch.name !== undefined && patch.code === undefined ? { ...merged, code: tableCodeOf(patch.name) } : merged })(), draft: patch === null ? current.draft : { ...current.draft, tableId: '' } } : current)),
    onRateDraft: (key, patch) => setDialog((current) => (current?.kind === 'version' ? { ...current, draft: { ...current.draft, rates: current.draft.rates.map((rate) => (rate.key === key ? { ...rate, ...patch } : rate)) } } : current)),
    onAddRate: () => setDialog((current) => (current?.kind === 'version' ? { ...current, draft: { ...current.draft, rates: [...current.draft.rates, blankRate(nextKey())] } } : current)),
    onRemoveRate: (key) => setDialog((current) => (current?.kind === 'version' ? { ...current, draft: { ...current.draft, rates: current.draft.rates.filter((rate) => rate.key !== key) } } : current)),
    onLibrary: () => dialog?.kind === 'version' && addLibrary(dialog.operations ?? []),
    onRateForAll: (value) => setDialog((current) => (current?.kind === 'version' ? { ...current, rateForAll: value, draft: { ...current.draft, rates: current.draft.rates.map((rate): RateDraft => (rate.basis === 'SMV_RATE' ? { ...rate, ratePerMinute: value } : rate)) } } : current)),
    onVersionSave: () => {
      if (dialog?.kind !== 'version') return
      const { draft, editing, table } = dialog
      const held = versionHeld(table ? { ...draft, tableId: 'new' } : draft, today)
      if (held || !siteId) return patchDialog('version', { problem: held })
      patchDialog('version', { busy: true, problem: null })
      const rates = draft.rates.map(bodyOfRate)
      const save = async () => {
        if (editing) return call.setRates(api, editing.id, editing.version, rates)
        const tableId = table ? (await call.createTable(api, { siteId, code: table.code || tableCodeOf(table.name), name: table.name.trim(), styleId: table.styleId || null, lineId: table.lineId || null })).table.id : draft.tableId
        return call.createVersion(api, tableId, { changeReason: draft.changeReason as call.ChangeReason, changeNote: draft.changeNote.trim() || null, effectiveFrom: draft.effectiveFrom, provisional: draft.provisional, trialEndsOn: draft.provisional ? draft.trialEndsOn : null, copy: 'NONE', rates })
      }
      save().then(
        (detail) => {
          close()
          readRatesSide()
          go({ open: detail.version.id })
          void readVersionAgain()
          tellDone(editing ? 'version.savedRates' : 'version.created', { version: detail.version.versionNo })
        },
        (error) => fail('version', error),
      )
    },
    onOpenVersion: (id) => go({ open: id }),
    onPublish: (versionId) => {
      const tables = valueOf(tablesRead) ?? []
      const target = versionId ?? valueOf(version)?.version.id ?? tables.flatMap((row) => [row.next, row.current]).find((row) => row !== null)?.id ?? ''
      setDialog({ kind: 'publish', versionId: target, version: null, lineId: '', lines, preview: target ? LOADING : { status: 'failed', problem: { key: 'publish.noVersion' } }, onFloor: true, printed: true, busy: false, problem: null })
      if (target) readPublishPreview(target, '')
    },
    onPublishDraft: (patch) => {
      setDialog((current) => (current?.kind === 'publish' ? { ...current, ...patch, ...(patch.versionId !== undefined || patch.lineId !== undefined ? { preview: LOADING as Read<call.PublishPreview> } : {}) } : current))
      if (dialog?.kind === 'publish' && (patch.versionId !== undefined || patch.lineId !== undefined)) readPublishPreview(patch.versionId ?? dialog.versionId, patch.lineId ?? dialog.lineId)
    },
    onPublishSave: () => {
      if (dialog?.kind !== 'publish' || dialog.preview.status !== 'ready') return
      const { versionId, lineId, onFloor, printed } = dialog
      const count = dialog.preview.value.newCount
      patchDialog('publish', { busy: true, problem: null })
      void (async () => {
        const current = await call.readVersion(api, versionId)
        return call.publishVersion(api, versionId, { version: current.version.version, ...(lineId ? { lineId } : {}), onFloor, printed, putInForce: current.version.status === 'DRAFT' })
      })().then(
        (detail) => {
          close()
          readRatesSide()
          go({ open: detail.version.id })
          void readVersionAgain()
          tellDone('publish.done', { count })
        },
        (error) => fail('publish', error),
      )
    },
    onPutInForce: () => versionStep((detail) => call.putInForce(api, detail.version.id, detail.version.version), 'version.inForce'),
    onConfirmVersion: () => versionStep((detail) => call.confirmVersion(api, detail.version.id, detail.version.version), 'version.confirmed'),
    onCancelVersion: () => setDialog({ kind: 'cancelVersion', reason: '', busy: false, problem: null }),
    onCancelVersionSave: () => {
      const detail = valueOf(version)
      if (dialog?.kind !== 'cancelVersion' || !detail) return
      patchDialog('cancelVersion', { busy: true, problem: null })
      call.cancelVersion(api, detail.version.id, detail.version.version, dialog.reason.trim()).then(
        () => {
          close()
          void readVersionAgain()
          readRatesSide()
        },
        (error) => fail('cancelVersion', error),
      )
    },
    onWithdraw: (publication) => setDialog({ kind: 'withdraw', publication, reason: '', busy: false, problem: null }),
    onWithdrawSave: () => {
      if (dialog?.kind !== 'withdraw') return
      patchDialog('withdraw', { busy: true, problem: null })
      call.withdrawPublication(api, dialog.publication.id, dialog.publication.version, dialog.reason.trim()).then(
        () => {
          close()
          void readVersionAgain()
          readRatesSide()
        },
        (error) => fail('withdraw', error),
      )
    },
    onPaper: (publication) => setDialog({ kind: 'paper', publication, picked: [], busy: false, problem: null }),
    onPaperPick: (workerId, picked) => setDialog((current) => (current?.kind === 'paper' ? { ...current, picked: picked ? [...current.picked, workerId] : current.picked.filter((id) => id !== workerId) } : current)),
    onPaperSave: () => {
      if (dialog?.kind !== 'paper') return
      patchDialog('paper', { busy: true, problem: null })
      call.paperReceipts(api, dialog.publication.id, dialog.picked).then(
        (answer) => {
          close()
          void readVersionAgain()
          readRatesSide()
          tellDone('paper.done', { count: answer.recorded })
        },
        (error) => fail('paper', error),
      )
    },
    onConfirmRates: () => {
      const page = valueOf(rates)
      if (!page) return
      const { ids, rates: count } = versionsOfRows(page.rows, selectedRates)
      setDialog({ kind: 'confirm', ids, rates: count, rows: null, review: { phase: 'reading' } })
      call.confirmPreview(api, ids).then(
        (preview) =>
          patchDialog('confirm', {
            rows: preview.rows.map((row) => ({ id: row.id, label: `${row.table?.code ?? ''} · ${row.versionNo ?? ''}`, from: row.from ?? '', trial: row.trialEndsOn ?? '', refused: row.refusal ? { key: `refusal.${row.refusal.code}` } : null, version: row.version })),
            review: { phase: 'ready' },
          }),
        (error) => patchDialog('confirm', { review: { phase: 'failed', error: problemWords(error).key } }),
      )
    },
    onConfirmRatesSave: () => {
      if (dialog?.kind !== 'confirm' || !dialog.rows) return
      const items = dialog.rows.flatMap((row) => (row.version !== null && !row.refused ? [{ id: row.id, version: row.version }] : []))
      patchDialog('confirm', { review: { phase: 'saving' } })
      call.confirmVersions(api, items).then(
        (answer) => {
          patchDialog('confirm', { review: { phase: 'done', results: Object.fromEntries(items.map((item) => [item.id, { ok: answer.confirmed.some((row) => row.id === item.id), words: 'ok' }])) } })
          setSelectedRates([])
          readRatesSide()
        },
        (error) => patchDialog('confirm', { review: { phase: 'failed', error: problemWords(error).key } }),
      )
    },
    // schemes
    onPickScheme: (id) => {
      setSchemePicked(id)
      setSchemeEdit(null)
    },
    onNewScheme: (fromCurrent) => {
      const current = valueOf(scheme)
      setSchemeEdit({ id: null, version: null, draft: fromCurrent && current ? draftOfScheme(current, today, true) : blankScheme(today), busy: false, problem: null })
    },
    onEditScheme: () => {
      const current = valueOf(scheme)
      if (current) setSchemeEdit({ id: current.scheme.id, version: current.scheme.version, draft: draftOfScheme(current, today, false), busy: false, problem: null })
    },
    onSchemeDraft: (patch) => setSchemeEdit((current) => (current ? { ...current, problem: null, draft: { ...current.draft, ...patch } } : current)),
    onSchemeDiscard: () => setSchemeEdit(null),
    onSchemeSave: () => {
      if (!schemeEdit || !companyId) return
      const held = schemeHeld(schemeEdit.draft, today)
      if (held) return setSchemeEdit({ ...schemeEdit, problem: held })
      setSchemeEdit({ ...schemeEdit, busy: true, problem: null })
      const body = bodyOfScheme(schemeEdit.draft)
      const save = schemeEdit.id ? call.updateScheme(api, schemeEdit.id, schemeEdit.version!, body) : call.createScheme(api, companyId, schemeEdit.draft.lineId, body)
      save.then(
        (detail) => {
          setSchemeEdit(null)
          setSchemePicked(detail.scheme.id)
          void readSchemesAgain()
          void readSchemeAgain()
          tellDone('scheme.saved')
        },
        (error) => setSchemeEdit((current) => (current ? { ...current, busy: false, problem: problemWords(error) } : current)),
      )
    },
    onActivateScheme: () => {
      const current = valueOf(scheme)
      if (!current) return
      call.activateScheme(api, current.scheme.id, current.scheme.version).then(
        () => {
          void readSchemesAgain()
          void readSchemeAgain()
          void readGateAgain()
          tellDone('scheme.activated', { name: current.scheme.name })
        },
        (error) => setNotice({ tone: 'danger', words: problemWords(error) }),
      )
    },
    onEndScheme: () => setDialog({ kind: 'endScheme', lastDay: today, reason: '', busy: false, problem: null }),
    onEndSchemeDraft: (patch) => patchDialog('endScheme', patch),
    onEndSchemeSave: () => {
      const current = valueOf(scheme)
      if (dialog?.kind !== 'endScheme' || !current) return
      patchDialog('endScheme', { busy: true, problem: null })
      call.endScheme(api, current.scheme.id, current.scheme.version, dialog.lastDay, dialog.reason.trim()).then(
        () => {
          close()
          void readSchemesAgain()
          void readSchemeAgain()
        },
        (error) => fail('endScheme', error),
      )
    },
    onDeleteScheme: () => setDialog({ kind: 'deleteScheme', busy: false, problem: null }),
    onDeleteSchemeSave: () => {
      const current = valueOf(scheme)
      if (dialog?.kind !== 'deleteScheme' || !current) return
      patchDialog('deleteScheme', { busy: true, problem: null })
      call.deleteScheme(api, current.scheme.id, current.scheme.version).then(
        () => {
          close()
          setSchemePicked(null)
          void readSchemesAgain()
        },
        (error) => fail('deleteScheme', error),
      )
    },
    // periods
    onRunBand: () => {
      const rows = valueOf(periods)
      if (!rows || !companyId || busyRun) return
      const target = runTarget(rows, today)
      setBusyRun(true)
      void (async () => {
        const made = target.period ? null : await call.createPeriod(api, companyId, target.month)
        const id = target.period?.id ?? made!.period.id
        const version = target.period?.version ?? made!.period.version
        await call.runPeriod(api, id, version)
        return id
      })()
        .then(
          (id) => {
            tellDone('period.ran', { month: monthText(target.month, locale) })
            go({ period: id })
            readPaySide()
            void readPeriodAgain()
            void readStatementsAgain()
          },
          (error) => setNotice({ tone: 'danger', words: problemWords(error) }),
        )
        .finally(() => setBusyRun(false))
    },
    onOpenPeriod: (id) => {
      setPeriodBusy({ busy: false, problem: null })
      go({ period: id })
    },
    onPeriodStep: (step) => {
      const detail = valueOf(periodRead)
      if (!detail || periodBusy.busy) return
      const { id, version: at } = detail.period
      setPeriodBusy({ busy: true, problem: null })
      const work = step === 'run' ? call.runPeriod(api, id, at) : step === 'reopen' ? call.reopenPeriod(api, id, at) : call.startReview(api, id, at)
      work.then(
        () => {
          setPeriodBusy({ busy: false, problem: null })
          void readPeriodAgain()
          void readStatementsAgain()
          readPaySide()
        },
        (error) => setPeriodBusy({ busy: false, problem: problemWords(error) }),
      )
    },
    onLock: () => setDialog({ kind: 'lock', busy: false, problem: null }),
    onLockSave: () => {
      const detail = valueOf(periodRead)
      if (dialog?.kind !== 'lock' || !detail) return
      patchDialog('lock', { busy: true, problem: null })
      // The DS typed confirm holds the button until the phrase is typed exactly.
      call.lockPeriod(api, detail.period.id, detail.period.version, detail.lockPhrase).then(
        () => {
          close()
          void readPeriodAgain()
          void readStatementsAgain()
          readPaySide()
          tellDone('period.locked', { month: monthText(detail.period.month, locale) })
        },
        (error) => fail('lock', error),
      )
    },
    onBack: () => setDialog({ kind: 'backToPreview', reason: '', busy: false, problem: null }),
    onBackSave: () => {
      const detail = valueOf(periodRead)
      if (dialog?.kind !== 'backToPreview' || !detail) return
      patchDialog('backToPreview', { busy: true, problem: null })
      call.backToPreview(api, detail.period.id, detail.period.version, dialog.reason.trim()).then(
        () => {
          close()
          void readPeriodAgain()
          void readStatementsAgain()
          readPaySide()
        },
        (error) => fail('backToPreview', error),
      )
    },
    onOpenStatement: (id) => {
      if (!id) return setStatement(null)
      openOne(id)
    },
    onApprove: () => {
      const current = valueOf(statement?.read ?? null)
      if (!current || statement?.busy) return
      setStatement((state) => (state ? { ...state, busy: true, problem: null } : state))
      call.approveStatement(api, current.id, current.version).then(
        (value) => {
          setStatement({ read: { status: 'ready', value }, busy: false, problem: null })
          void readStatementsAgain()
          void readPeriodAgain()
          readPaySide()
        },
        (error) => setStatement((state) => (state ? { ...state, busy: false, problem: problemWords(error) } : state)),
      )
    },
    onLeadOpen: (statementId) => setDialog({ kind: 'leadOpen', statementId, reason: '', busy: false, problem: null }),
    onLeadReason: (reason) => patchDialog('leadOpen', { reason }),
    onLeadOpenSave: () => {
      if (dialog?.kind !== 'leadOpen' || !dialog.reason) return
      const { statementId, reason } = dialog
      patchDialog('leadOpen', { busy: true, problem: null })
      call.openStatement(api, statementId, reason).then(
        (value) => {
          close()
          setStatement({ read: { status: 'ready', value }, busy: false, problem: null })
        },
        (error) => fail('leadOpen', error),
      )
    },
    onLeadReview: () => {
      const current = valueOf(statement?.read ?? null)
      if (!current || statement?.busy) return
      setStatement((state) => (state ? { ...state, busy: true, problem: null } : state))
      call.leadReview(api, current.id, current.version).then(
        () => {
          setStatement((state) => (state?.read.status === 'ready' ? { read: { status: 'ready', value: { ...state.read.value, leadReview: { at: new Date().toISOString(), byName: null, note: null } } }, busy: false, problem: null } : state))
          void readStatementsAgain()
          tellDone('statement.leadDone')
        },
        (error) => setStatement((state) => (state ? { ...state, busy: false, problem: problemWords(error) } : state)),
      )
    },
    // ledger
    onLedgerMore: () => ledgerCursor.current && void readLedger(ledgerCursor.current),
    onOpenEntry: (id) => go({ entry: id }),
    onCorrect: () => setDialog({ kind: 'correct', amount: '', reason: '', busy: false, problem: null }),
    onCorrectDraft: (patch) => patchDialog('correct', patch),
    onCorrectSave: () => {
      const current = valueOf(entry)
      if (dialog?.kind !== 'correct' || !current) return
      const amount = dialog.amount.trim() ? minorOfTyped(dialog.amount) : null
      if (dialog.amount.trim() && amount === null) return patchDialog('correct', { problem: { key: 'correct.amountHeld' } })
      patchDialog('correct', { busy: true, problem: null })
      call.correctEntry(api, current.id, dialog.reason.trim(), amount).then(
        () => {
          close()
          void readEntryAgain()
          readPaySide()
          tellDone('correct.done')
        },
        (error) => fail('correct', error),
      )
    },
    // held
    onSelectHeld: setSelectedHeld,
    onOpenHeld: (id) => {
      setHeldForm({ note: '', busy: false, problem: null })
      go({ resolve: id })
    },
    onHeldNote: (note) => setHeldForm((form) => ({ ...form, note })),
    onCountHeld: (ids) => {
      const rows = valueOf(held) ?? []
      const one = valueOf(heldRecordRead)
      const chosen = ids ? rows.filter((row) => ids.includes(row.id)) : one ? [one] : []
      if (chosen.length === 0) return
      if (!ids) setHeldForm((form) => ({ ...form, busy: true, problem: null }))
      void Promise.allSettled(chosen.map((row) => call.countHeld(api, row.id, row.version, ids ? undefined : heldForm.note.trim() || undefined))).then((results) => {
        const failed = results.flatMap((result) => (result.status === 'rejected' ? [result.reason as unknown] : []))
        const counted = results.length - failed.length
        readPaySide()
        void readGateAgain()
        if (!ids && failed.length > 0) return setHeldForm((form) => ({ ...form, busy: false, problem: problemWords(failed[0]) }))
        if (!ids) {
          setHeldForm({ note: '', busy: false, problem: null })
          go({ resolve: null })
        } else setSelectedHeld([])
        setNotice({ tone: failed.length > 0 ? 'warning' : 'success', words: { key: 'held.counted', params: { count: counted } }, ...(failed.length > 0 ? { detail: { key: 'held.refused', params: { count: failed.length } } } : {}) })
      })
    },
    onNotPaid: (ids) => setDialog({ kind: 'notPaid', ids: ids ?? (address.resolve ? [address.resolve] : []), reason: '', busy: false, problem: null }),
    onNotPaidSave: () => {
      if (dialog?.kind !== 'notPaid') return
      const rows = valueOf(held) ?? []
      const one = valueOf(heldRecordRead)
      const chosen = dialog.ids.map((id) => rows.find((row) => row.id === id) ?? (one?.id === id ? one : null)).filter((row): row is call.HeldRow => row !== null)
      patchDialog('notPaid', { busy: true, problem: null })
      void Promise.allSettled(chosen.map((row) => call.notPaidHeld(api, row.id, row.version, dialog.reason.trim()))).then((results) => {
        const failed = results.flatMap((result) => (result.status === 'rejected' ? [result.reason as unknown] : []))
        if (failed.length === results.length && results.length > 0) return fail('notPaid', failed[0])
        close()
        setSelectedHeld([])
        go({ resolve: null })
        readPaySide()
        setNotice({ tone: failed.length > 0 ? 'warning' : 'info', words: { key: 'held.notPaidDone', params: { count: results.length - failed.length } }, ...(failed.length > 0 ? { detail: { key: 'held.refused', params: { count: failed.length } } } : {}) })
      })
    },
  }

  const readOperationsFor = () => (can.operations ? call.readOperations(api).catch(() => [] as call.OperationOption[]) : Promise.resolve([] as call.OperationOption[]))

  /** A new version starts from the rates of its table's latest version: one rate changes, the others stay as they are. */
  function copyLatest(tableId: string) {
    const row = (valueOf(tablesRead) ?? []).find((entry) => entry.table.id === tableId)
    const latest = row?.next ?? row?.current
    if (!latest) return
    void call.readVersion(api, latest.id).then((detail) =>
      setDialog((current) => (current?.kind === 'version' && current.draft.tableId === tableId && current.draft.rates.length === 0 ? { ...current, draft: { ...current.draft, rates: detail.rates.map((rate) => draftOfRate(rate, nextKey())) } } : current)),
    )
  }

  function addLibrary(operations: readonly call.OperationOption[]) {
    setDialog((current) => {
      if (current?.kind !== 'version') return current
      const have = new Set(current.draft.rates.map((rate) => rate.operationId))
      const added = operations.filter((row) => !have.has(row.id)).map((row): RateDraft => ({ ...blankRate(nextKey()), operationId: row.id, operationLabel: `${row.code} · ${row.name}`, standardMinutes: row.standardMinutes ?? '', ratePerMinute: current.rateForAll }))
      return { ...current, draft: { ...current.draft, rates: [...current.draft.rates, ...added] } }
    })
  }

  function readPublishPreview(versionId: string, lineId: string) {
    call.publishPreview(api, versionId, lineId || null).then(
      (preview) => setDialog((current) => (current?.kind === 'publish' && current.versionId === versionId && current.lineId === lineId ? { ...current, preview: { status: 'ready', value: preview } } : current)),
      (error) => setDialog((current) => (current?.kind === 'publish' && current.versionId === versionId ? { ...current, preview: { status: 'failed', problem: problemWords(error) } } : current)),
    )
  }

  function versionStep(work: (detail: call.VersionDetail) => Promise<call.VersionDetail>, done: string) {
    const detail = valueOf(version)
    if (!detail) return
    work(detail).then(
      () => {
        void readVersionAgain()
        readRatesSide()
        tellDone(done, { version: detail.version.versionNo })
      },
      (error) => setNotice({ tone: 'danger', words: problemWords(error) }),
    )
  }

  /** One statement, on the person's choice: the opening is written down by the same command that answers it. */
  function openOne(id: string) {
    setStatement({ read: LOADING, busy: false, problem: null })
    call.openStatement(api, id).then(
      (value) => setStatement({ read: { status: 'ready', value }, busy: false, problem: null }),
      (error) => setStatement({ read: { status: 'failed', problem: problemWords(error) }, busy: false, problem: null }),
    )
  }

  const model: PieceModel = {
    prefix,
    can,
    address,
    today,
    scope,
    sight,
    siteId,
    overview,
    gate: siteId ? gate : null,
    ever,
    counts: valueOf(countsRead),
    reviewCount: valueOf(reviewRead),
    rates: siteId ? rates : null,
    selectedRates,
    tables: valueOf(tablesRead) ?? [],
    schemes,
    schemeId,
    scheme: schemeId ? scheme : null,
    schemeEdit,
    periods: people && can.earnings ? periods : null,
    ledger,
    lines,
    held: people && can.earnings ? held : null,
    selectedHeld,
    version: address.open ? version : null,
    period: address.period ? { detail: periodRead, statements: valueOf(statements), ...periodBusy } : null,
    statement,
    heldRecord: address.resolve ? { read: heldRecordRead, ...heldForm } : null,
    entry: address.entry ? entry : null,
    dialog,
    stepUp,
    notice,
    built: { efficiency: OFFICE_PAGES.has('/people/efficiency') ? `${prefix}/people/efficiency` : null, attendance: OFFICE_PAGES.has('/people/attendance') ? `${prefix}/people/attendance` : null },
    asOf,
    live,
    help,
    busyRun,
  }
  return { model, actions }
}
