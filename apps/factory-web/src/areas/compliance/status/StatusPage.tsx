'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { defaultSectionLayout, readSectionLayout, writeSectionLayout, type SectionLayoutValue, type SectionSpec } from '@nexus/ui/patterns'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useCoalesced, useLive } from '../../_shared/buying/hooks'
import { downloadText, isStepUpCancelled, liveMatches, useStepUp } from '../../quality/_shared/hooks'
import { problemKey } from '../../quality/_shared/model'
import { getActions, getBoard, getCell, getExpiries, getFeed, postOverride, type Actions, type Board, type CellDetail, type Expiries, type Feed, type GateEvent } from './api'
import { boardQueryOf, csvName, csvText, defaultOverrideDay, overrideRefusalKey, romeDay, statusAddressOf, statusAddressText, statusCan, untilOf, type CellRef, type OverrideDraft, type StatusAddress } from './model'
import { STATUS_SECTIONS, type OverrideState, type Read } from './view/types'
import { StatusView } from './view/StatusView'

/**
 * What changes the board (design live: "certificate.* / compliance_document.* / label.* / lot.cr6_recorded → matrix cells,
 * tiles and Needs action, debounced; AsOf updates"): a requirement or a market, a certificate and its depth, a DoC or user
 * information issued, a label, a lot's test, a supplier declaration decided, a gate refusal or override (the shipments-held
 * tile). Each event comes only to whoever may see its record; the page reads again (never from the message).
 */
const BOARD_LIVE = [
  'compliance_gates.',
  'compliance_rules.market_changed',
  'compliance_rules.operator_changed',
  'compliance.certificate_',
  'compliance.renewal_applied',
  'certificates_depth.',
  'compliance_declarations.',
  'compliance_user_information.',
  'compliance.label_',
  'lot.',
  'compliance_material_tests.declaration_decided',
]
/** "gate.refused / gate.overridden → Gate refusals feed". */
const FEED_LIVE = ['compliance_gates.refused', 'compliance_gates.overridden']
const LAYOUT_KEY = 'compliance.status.layout'
const sectionSpecs = (): SectionSpec[] => STATUS_SECTIONS.map((id) => ({ id, label: id, defaultWidth: 'full' as const }))

/**
 * `/w/<company>/compliance/status?markets=&brand=&gap=&status=&q=&gate=&feed=&days=` (SCR-119): the board (tiles, Needs action
 * and the matrix in one read), the gate refusals and what expires next, each read on its own; the cell checklist, "See all",
 * the override (step-up when the API asks), live re-reads, Arrange saved per person on this device, the files, the print
 * window (SCR-314) in a new tab.
 */
export function StatusPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/compliance\/status\/?$/, '')
  const can = useMemo(() => statusCan(session.permissions), [session.permissions])
  const address = useMemo(() => statusAddressOf(params), [params])
  const enabled = can.view
  const query = useMemo(() => boardQueryOf(address), [address])
  const queryKey = JSON.stringify(query)

  const [board, setBoard] = useState<Read<Board>>({ status: 'idle' })
  const [feed, setFeed] = useState<Read<Feed>>({ status: 'idle' })
  const [expiries, setExpiries] = useState<Read<Expiries>>({ status: 'idle' })
  const [asOf, setAsOf] = useState<string | null>(null)
  const [knownMarkets, setKnownMarkets] = useState<{ code: string; name: string }[]>([])
  const [brands, setBrands] = useState<{ id: string; code: string; name: string }[]>([])
  const [arranging, setArranging] = useState(false)
  const specs = useMemo(() => sectionSpecs(), [])
  const [layout, setLayout] = useState<SectionLayoutValue>(() => defaultSectionLayout(specs))
  useEffect(() => setLayout(readSectionLayout(LAYOUT_KEY, specs)), [specs])
  const [selectedStyles, setSelectedStyles] = useState<string[]>([])
  const [selectedEvents, setSelectedEvents] = useState<string[]>([])
  const [cell, setCell] = useState<{ at: CellRef; read: Read<CellDetail> } | null>(null)
  const [allActions, setAllActions] = useState<Read<Actions> | null>(null)
  const [override, setOverride] = useState<OverrideState | null>(null)
  const [notice, setNotice] = useState<{ key: string; params?: Record<string, string | number> } | null>(null)
  const [finder, setFinder] = useState(false)
  const [now, setNow] = useState(() => new Date().toISOString())
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)
  const overrideKey = useRef<string | null>(null)

  const readBoard = useCallback(async () => {
    if (!enabled) return
    try {
      const value = await getBoard(api, query)
      setBoard({ status: 'ready', value })
      setAsOf(value.asOf)
      if (query.markets.length === 0) setKnownMarkets(value.markets.map((market) => ({ code: market.code, name: market.name })))
      else setKnownMarkets((known) => [...known, ...value.markets.filter((market) => !known.some((entry) => entry.code === market.code))])
      setBrands((known) => {
        const next = new Map(known.map((brand) => [brand.id, brand]))
        for (const row of value.rows) if (row.style.brand) next.set(row.style.brand.id, row.style.brand)
        return [...next.values()].sort((a, b) => a.code.localeCompare(b.code))
      })
    } catch (error) {
      setBoard({ status: 'error', problem: problemKey(error) })
    }
    // queryKey stands for the query (a new object per address, the same words).
  }, [api, enabled, queryKey])
  const readFeed = useCallback(async () => {
    if (!enabled) return
    try {
      setFeed({ status: 'ready', value: await getFeed(api, { days: address.days, gate: address.gate }) })
    } catch (error) {
      setFeed({ status: 'error', problem: problemKey(error) })
    }
  }, [api, enabled, address.days, address.gate])
  const readExpiries = useCallback(async () => {
    if (!enabled) return
    try {
      setExpiries({ status: 'ready', value: await getExpiries(api, 12) })
    } catch (error) {
      setExpiries({ status: 'error', problem: problemKey(error) })
    }
  }, [api, enabled])

  useEffect(() => {
    if (!enabled) return
    setBoard({ status: 'loading' })
    void readBoard()
  }, [enabled, readBoard])
  useEffect(() => {
    if (!enabled) return
    setFeed({ status: 'loading' })
    void readFeed()
  }, [enabled, readFeed])
  useEffect(() => {
    if (!enabled) return
    setExpiries({ status: 'loading' })
    void readExpiries()
  }, [enabled, readExpiries])

  const readCell = useCallback(
    async (at: CellRef) => {
      try {
        const value = await getCell(api, at.styleId, at.market)
        setCell((current) => (current && current.at.styleId === at.styleId && current.at.market === at.market ? { at, read: { status: 'ready', value } } : current))
      } catch (error) {
        setCell((current) => (current && current.at.styleId === at.styleId && current.at.market === at.market ? { at, read: { status: 'error', problem: problemKey(error) } } : current))
      }
    },
    [api],
  )
  const readAllActions = useCallback(async () => {
    try {
      setAllActions({ status: 'ready', value: await getActions(api, query) })
    } catch (error) {
      setAllActions({ status: 'error', problem: problemKey(error) })
    }
  }, [api, queryKey])

  const latestCell = useRef(cell)
  latestCell.current = cell
  const refreshBoard = useCoalesced(() => {
    void readBoard()
    if (latestCell.current) void readCell(latestCell.current.at)
  }, 1500)
  const refreshFeed = useCoalesced(() => void readFeed(), 1500)
  const live = useLive(
    (change) => {
      if (liveMatches(change, FEED_LIVE)) refreshFeed()
      if (liveMatches(change, BOARD_LIVE)) refreshBoard()
    },
    () => {
      void readBoard()
      void readFeed()
      void readExpiries()
    },
    enabled,
  )

  const go = (change: Partial<StatusAddress>) => router.replace(`${pathname}${statusAddressText({ ...address, ...change })}`, { scroll: false })

  const sendOverride = async () => {
    if (!override) return
    const { event, draft } = override
    const key = overrideKey.current ?? newIdempotencyKey()
    overrideKey.current = key
    setOverride({ ...override, busy: true, problem: null })
    try {
      const until = untilOf(draft.day, new Date(), event.requirement.overrideMaxDays)
      const answer = await guard('', () => postOverride(api, event.id, { reason: draft.reason.trim(), until: until.toISOString() }, key))
      overrideKey.current = null
      setOverride(null)
      setNotice({ key: 'override.done', params: { number: event.subject.number ?? answer.override.requirementCode, code: answer.override.requirementCode } })
      void readFeed()
      void readBoard()
    } catch (error) {
      if (isStepUpCancelled(error)) {
        setOverride((current) => (current ? { ...current, busy: false } : current))
        return
      }
      setOverride((current) => (current ? { ...current, busy: false, problem: overrideRefusalKey(isApiError(error) ? error.kind : 'unavailable') } : current))
      if (isApiError(error) && (error.kind === 'conflict' || error.kind === 'not_found')) void readFeed()
    }
  }

  const today = romeDay(new Date(now))
  return (
    <StatusView
      model={{
        prefix,
        can,
        address,
        today,
        now,
        board,
        feed,
        expiries,
        knownMarkets,
        brands,
        live,
        asOf,
        layout,
        specs,
        arranging,
        selectedStyles,
        selectedEvents,
        cell,
        allActions,
        override,
        stepUp: { open: stepUp.open, busy: stepUp.busy, problem: stepUp.problem },
        notice,
        finder,
      }}
      actions={{
        onAddress: go,
        onRetry: (part) => {
          if (part === 'board') {
            setBoard({ status: 'loading' })
            void readBoard()
          } else if (part === 'feed') {
            setFeed({ status: 'loading' })
            void readFeed()
          } else if (part === 'expiry') {
            setExpiries({ status: 'loading' })
            void readExpiries()
          } else if (part === 'cell' && cell) {
            setCell({ at: cell.at, read: { status: 'loading' } })
            void readCell(cell.at)
          } else if (part === 'allActions') {
            setAllActions({ status: 'loading' })
            void readAllActions()
          }
        },
        onArrange: setArranging,
        onArranged: (next) => {
          setLayout(next)
          writeSectionLayout(LAYOUT_KEY, next)
          setArranging(false)
        },
        onSelectStyles: setSelectedStyles,
        onSelectEvents: setSelectedEvents,
        onCell: (at) => {
          if (!at) {
            setCell(null)
            return
          }
          setAllActions(null)
          setCell({ at, read: { status: 'loading' } })
          void readCell(at)
        },
        onAllActions: (open) => {
          if (!open) {
            setAllActions(null)
            return
          }
          setAllActions({ status: 'loading' })
          void readAllActions()
        },
        onOverride: (event: GateEvent | null) => {
          overrideKey.current = null
          if (!event) {
            setOverride(null)
            return
          }
          const at = new Date()
          setNow(at.toISOString())
          setOverride({ event, draft: { reason: '', day: defaultOverrideDay(at, event.requirement.overrideMaxDays) }, touched: [], busy: false, problem: null })
        },
        onOverrideDraft: (change: Partial<OverrideDraft>) => {
          // A changed draft is another request: a new idempotency key.
          overrideKey.current = null
          setOverride((current) => (current ? { ...current, draft: { ...current.draft, ...change }, problem: null } : current))
        },
        onOverrideTouch: (field) => setOverride((current) => (current && !current.touched.includes(field) ? { ...current, touched: [...current.touched, field] } : current)),
        onOverrideSend: () => void sendOverride(),
        onStepUpCode: (code) => void submitStepUp(code),
        onStepUpCancel: cancelStepUp,
        onDismissNotice: () => setNotice(null),
        onExport: (part, header, rows) => downloadText(csvName(part, today), csvText(header, rows)),
        onFinder: setFinder,
        onGo: (href) => router.push(href),
      }}
    />
  )
}
