'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../lib/api/errors'
import { useT } from '../../../lib/i18n/provider'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { csvLine, downloadText, isStepUpCancelled, liveMatches, useLive, useStepUp } from '../../quality/_shared/hooks'
import { LIST_MAX, listLots, type Lot } from '../../quality/_shared/lots'
import { failedRead, problemKey, qualityCan, reading, ready, type Notice, type Read } from '../../quality/_shared/model'
import { getSettings, saveSettings, type LabSettings } from './api'
import { capped as isCapped, crViWord, hasMore, isWaitingEvidence, loosens, lotsCsvRows, tileCounts, viewFromAddress, viewQuery, viewRows, type ListDialog, type LotTile, type LotView, type RuleDraft, type TileCount } from './model'
import { LabMessages } from './view/parts'
import { lotHref, LotsView } from './view/LotsView'

/**
 * The Tests & substances container (`/w/<company>/compliance/tests`, SCR-054): reads the view's lots (`GET /quality/lots`,
 * a page of 50, then larger pages up to 200: the list has no cursor), the tiles' two reads (the lots on hold, the released
 * lots), the Cr VI evidence rule in force for the company, and listens to the live stream (lot.* and the rule's change:
 * changes wait behind "N updates · Show", rows never move under the cursor). Changing the rule saves at once when it
 * tightens; when it loosens it carries the reason and the fresh code (step-up). `?view=` keeps the view in the address.
 */
export function LotsPage() {
  return (
    <LabMessages>
      <LotsContainer />
    </LabMessages>
  )
}

const EMPTY_TILES: Record<LotTile, TileCount> = { onHold: { count: undefined, atLeast: false }, waiting: { count: undefined, atLeast: false }, failed: { count: undefined, atLeast: false }, released: { count: undefined, atLeast: false } }

function LotsContainer() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const t = useT('lab')
  const can = useMemo(() => qualityCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const companyId = session.company?.id ?? null
  const [view, setView] = useState<LotView>(() => viewFromAddress(params))
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(50)
  const [rows, setRows] = useState<Read<Lot[]>>(reading())
  const [more, setMore] = useState(false)
  const [capped, setCapped] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [tiles, setTiles] = useState<Record<LotTile, TileCount>>(EMPTY_TILES)
  const [rule, setRule] = useState<Read<LabSettings>>(reading())
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dialog, setDialog] = useState<ListDialog | null>(null)
  const [pick, setPick] = useState<Read<Lot[]>>(reading())
  const [pickQuery, setPickQuery] = useState('')
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<string | null>(null)
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)
  const request = useRef<AbortController | null>(null)

  const load = useCallback(
    async (size = limit) => {
      if (!can.lotsView) return
      request.current?.abort()
      const controller = new AbortController()
      request.current = controller
      const asked = viewQuery(view, query, size)
      try {
        const lots = await listLots(api, asked, controller.signal)
        if (controller.signal.aborted) return
        const shown = viewRows(view, lots)
        setRows(ready(shown))
        setMore(hasMore(view, lots.length, asked.limit ?? size))
        setCapped(isCapped(lots.length, asked.limit ?? size))
        setAsOf(new Date().toISOString())
        setUpdates(0)
        setSelected((current) => current.filter((id) => shown.some((row) => row.id === id)))
      } catch (error) {
        if ((error as { name?: string } | null)?.name === 'AbortError') return
        setRows(failedRead(problemKey(error)))
      } finally {
        setLoadingMore(false)
      }
    },
    [api, can.lotsView, limit, query, view],
  )

  const loadTiles = useCallback(async () => {
    if (!can.lotsView) return
    const [held, released] = await Promise.all([listLots(api, { onHold: true, limit: LIST_MAX }).catch(() => null), listLots(api, { status: 'RELEASED', limit: LIST_MAX }).catch(() => null)])
    setTiles(tileCounts(held, released))
  }, [api, can.lotsView])

  const loadRule = useCallback(async () => {
    if (!can.lotsView) return
    try {
      setRule(ready(await getSettings(api, companyId)))
    } catch (error) {
      setRule(failedRead(problemKey(error)))
    }
  }, [api, can.lotsView, companyId])

  // The search waits for a pause in typing (250 ms); a view change reads at once.
  useEffect(() => {
    const timer = setTimeout(() => void load(), query ? 250 : 0)
    return () => clearTimeout(timer)
  }, [load, query])
  useEffect(() => {
    void loadTiles()
    void loadRule()
  }, [loadTiles, loadRule])

  const live = useLive(
    (change) => {
      if (liveMatches(change, ['lot.'])) setUpdates((count) => count + 1)
      if (liveMatches(change, ['quality.settings_changed'])) void loadRule()
    },
    () => {
      void load()
      void loadTiles()
      void loadRule()
    },
  )

  const chooseView = (next: LotView) => {
    setView(next)
    setLimit(50)
    setSelected([])
    setRows(reading())
    const search = new URLSearchParams()
    if (next !== 'all') search.set('view', next)
    router.replace(`${pathname}${search.toString() ? `?${search}` : ''}`, { scroll: false })
  }

  const openDialog = (next: ListDialog | null) => {
    setDialog(next)
    setDialogProblem(null)
    if (next?.kind === 'rule') setRuleDraft(rule.value ? { rule: rule.value.crViEvidenceRule, reason: '' } : null)
    if (next?.kind === 'pick') {
      setPick(reading())
      setPickQuery('')
      listLots(api, { onHold: true, limit: LIST_MAX })
        .then((lots) => setPick(ready(lots.filter(isWaitingEvidence))))
        .catch((error) => setPick(failedRead(problemKey(error))))
    }
  }

  const saveRule = async () => {
    const current = rule.value
    if (!current || !ruleDraft || ruleDraft.rule === current.crViEvidenceRule) return
    const loosening = loosens(current.crViEvidenceRule, ruleDraft.rule)
    setBusy(true)
    setDialogProblem(null)
    try {
      const saved = await guard('stepUp.loosen', () => saveSettings(api, { companyId, rule: ruleDraft.rule, version: current.version, reason: loosening ? ruleDraft.reason.trim() : null }))
      setRule(ready(saved))
      setDialog(null)
      setNotice({ key: loosening ? 'done.ruleLoosened' : 'done.ruleTightened', tone: 'success' })
      void loadTiles()
    } catch (error) {
      if (isStepUpCancelled(error)) setDialogProblem('rule.problem.cancelled')
      else if (isApiError(error) && error.kind === 'conflict') {
        setDialogProblem('rule.problem.conflict')
        void loadRule()
      } else if (isApiError(error) && error.kind === 'forbidden') setDialogProblem('rule.problem.forbidden')
      else if (isApiError(error) && error.kind === 'invalid') setDialogProblem('rule.problem.invalid')
      else setDialogProblem('rule.problem.failed')
    } finally {
      setBusy(false)
    }
  }

  const exportRows = (lots: readonly Lot[]) => {
    const header = [t('csv.lot'), t('csv.itemCode'), t('csv.itemName'), t('csv.status'), t('csv.crVi'), t('csv.value'), t('csv.limit'), t('csv.evidence'), t('csv.tested'), t('csv.received'), t('csv.hold')]
    const lines = lotsCsvRows(lots, header, {
      status: (lot) => t(`status.${lot.qualityStatus}`),
      crVi: (lot) => t(`crVi.${crViWord(lot)}`),
      evidence: (lot) => (lot.crVi.evidence ? t(`evidence.${lot.crVi.evidence}`) : ''),
    }).map(csvLine)
    downloadText(`lots-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\r\n'))
    setNotice({ key: 'done.exported', params: { count: lots.length }, tone: 'success' })
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setNotice({ key: 'done.copied', params: { code: text }, tone: 'success' })
    } catch {
      setNotice({ key: 'done.copyFailed', tone: 'warning' })
    }
  }

  return (
    <LotsView
      model={{
        prefix,
        can,
        view,
        query,
        rows,
        limit,
        more,
        capped,
        loadingMore,
        tiles,
        rule,
        asOf,
        live,
        updates,
        selected,
        notice,
        dialog,
        pick,
        pickQuery,
        ruleDraft,
        busy,
        dialogProblem,
        stepUp,
      }}
      actions={{
        onQuery: (text) => {
          setQuery(text)
          setLimit(50)
        },
        onView: chooseView,
        onClearAll: () => {
          setQuery('')
          chooseView('all')
        },
        onMore: () => {
          const next = Math.min(LIST_MAX, limit + 50)
          setLoadingMore(true)
          setLimit(next)
        },
        onRetry: () => void load(),
        onRetryRule: () => void loadRule(),
        onShowUpdates: () => {
          void load()
          void loadTiles()
        },
        onSelect: (ids) => setSelected([...ids]),
        onOpen: (lot) => router.push(lotHref(prefix, lot.id)),
        onDialog: openDialog,
        onPickQuery: setPickQuery,
        onPick: (lot) => router.push(lotHref(prefix, lot.id, 'tab=results&act=result')),
        onRuleDraft: setRuleDraft,
        onSaveRule: () => void saveRule(),
        onExport: exportRows,
        onCopy: (text) => void copy(text),
        onDismissNotice: () => setNotice(null),
        onStepUpSubmit: (code) => void submitStepUp(code),
        onStepUpCancel: cancelStepUp,
      }}
    />
  )
}
