'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { downloadText, useLive } from '../../_shared/hooks'
import {
  defectPicker,
  editNcr,
  listNcrs,
  listPeople,
  listSites,
  moveNcr,
  ncrBoard,
  ncrCounts,
  ncrPrefill,
  NCR_FROM_TYPES,
  newIdempotencyKey,
  raiseNcr,
  uploadPhoto,
  type NcrCard,
  type NcrCounts,
  type NcrFromType,
  type NcrLane,
  type NcrSummary,
  type Person,
  type RaiseBody,
  type SiteChoice,
} from '../api'
import { useCloseFlow } from '../close'
import { checkSay, csvText, factsOfSummary, nameOf, ncrAddressOf, ncrAddressText, ncrCan, ncrQueryOf, quantityText, readProblem, refusalOf, type NcrAddress } from '../model'
import { NCR_NAMESPACE, NcrMessages, sayWith, type NcrNotice } from '../parts'
import { draftOf, EMPTY_DRAFT, type ListDialog, type NcrListModel } from './view-model'
import { NcrListView } from './view/NcrListView'

/**
 * `/w/<company>/quality/ncr` (SCR-144): the saved row (`?view=`), the search (`?q=`), the site (`?site=`), list or board
 * (`?mode=board`), New NCR (`?new=1`, raised from a record with `&from=<type>&id=<id>`); the tiles; live NCR changes
 * behind "N updates · Show" on the list (the tiles follow at once; the board reads its lanes again). A board move is the
 * NCR's own stage command with the version read; a drop on Closed opens the closing signature (the close flow).
 */
export function NcrPage() {
  return (
    <NcrMessages>
      <Container />
    </NcrMessages>
  )
}

const QUANTITY = (value: string) => value.trim().replace(',', '.')

function Container() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const lang = useLocale()
  const t = useT(NCR_NAMESPACE)
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = useMemo(() => ncrCan(session.permissions), [session.permissions])
  const address = useMemo(() => ncrAddressOf(params), [params])
  const { view, q, siteId, mode } = address
  const go = useCallback((next: Partial<NcrAddress>) => router.replace(`${pathname}${ncrAddressText({ ...address, ...next })}`, { scroll: false }), [router, pathname, address])

  const [sites, setSites] = useState<SiteChoice[] | null>(null)
  useEffect(() => {
    if (!can.view) return
    if (!can.locationsView) {
      setSites([])
      return
    }
    listSites(api, session.company?.id ?? null)
      .then(setSites)
      .catch(() => setSites([]))
  }, [api, can.view, can.locationsView, session.company?.id])

  const [people, setPeople] = useState<Person[] | null>(null)
  useEffect(() => {
    if (!can.view || !can.people) return
    listPeople(api, null)
      .then(setPeople)
      .catch(() => setPeople(null))
  }, [api, can.view, can.people])

  // ---- rows, lanes and tiles ------------------------------------------------------------------------------------------------
  const [rows, setRows] = useState<NcrListModel['rows']>({ items: null, truncated: false, problem: null })
  const [lanes, setLanes] = useState<NcrListModel['lanes']>({ items: null, problem: null })
  const [counts, setCounts] = useState<NcrCounts | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [opened] = useState(() => new Date().toISOString())
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<NcrNotice | null>(null)
  const readId = useRef(0)
  const query = useMemo(() => ncrQueryOf({ view, q, siteId }), [view, q, siteId])

  const readCounts = useCallback(() => {
    ncrCounts(api, siteId)
      .then(setCounts)
      .catch(() => setCounts(null))
  }, [api, siteId])

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    readCounts()
    try {
      if (mode === 'board') {
        const found = await ncrBoard(api, query)
        if (id !== readId.current) return
        setLanes({ items: found, problem: null })
      } else {
        const found = await listNcrs(api, query)
        if (id !== readId.current) return
        setRows({ items: found.items, truncated: found.truncated, problem: null })
      }
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      if (mode === 'board') setLanes({ items: null, problem: readProblem(error) })
      else setRows({ items: null, truncated: false, problem: readProblem(error) })
    }
  }, [api, can.view, mode, query, readCounts])

  useEffect(() => {
    setRows({ items: null, truncated: false, problem: null })
    setLanes({ items: null, problem: null })
    void load()
  }, [load])

  const later = useRef<ReturnType<typeof setTimeout> | null>(null)
  const soon = useCallback((work: () => void) => {
    if (later.current) clearTimeout(later.current)
    later.current = setTimeout(work, 800)
  }, [])
  useEffect(() => () => void (later.current && clearTimeout(later.current)), [])
  const live = useLive(
    (change) => {
      if (!change.type.startsWith('ncr.')) return
      if (mode === 'board') soon(() => void load())
      else {
        setUpdates((count) => count + 1)
        soon(readCounts)
      }
    },
    () => void load(),
  )

  // ---- board moves ---------------------------------------------------------------------------------------------------------
  const [moving, setMoving] = useState<string | null>(null)
  const close = useCloseFlow(api, (record, holds) => {
    setNotice({ say: holds > 0 ? { key: 'close.doneHolds', params: { number: record.ncr.number, count: holds } } : { key: 'close.done', params: { number: record.ncr.number } }, tone: 'success' })
    void load()
  })

  const boardMove = useCallback(
    async (card: NcrCard, to: 'CONTAINED' | 'DECIDED' | 'CLOSED'): Promise<boolean> => {
      if (to === 'CLOSED') return close.open(card, can.close ? null : { key: 'held.noClose' })
      setMoving(card.id)
      try {
        const record = await moveNcr(api, card.id, { version: card.version, to })
        setNotice({ say: { key: 'board.moved', params: { number: record.ncr.number, stage: record.ncr.stage } }, tone: 'success' })
        void load()
        return true
      } catch (error) {
        const refusal = refusalOf(error)
        const facts = factsOfSummary(card)
        const detail = refusal.checks.map((key) => sayWith(t, INTL_LOCALE[lang], checkSay(key, false, facts, to)) ?? '')
        setNotice({ say: refusal.checks.length > 0 ? { key: 'board.notMoved', params: { number: card.number } } : refusal.say, tone: 'danger', detail: [...detail, ...refusal.detail] })
        if (refusal.stale) void load()
        return false
      } finally {
        setMoving(null)
      }
    },
    [api, can.close, close, load, t, lang],
  )

  // ---- New NCR (from anywhere) ----------------------------------------------------------------------------------------------
  const [dialog, setDialog] = useState<ListDialog | null>(null)
  const photos = useRef<File[]>([])
  const raiseKey = useRef<string | null>(null)
  const fromKey = address.isNew && address.from ? `${address.from.recordType}:${address.from.recordId}` : null
  useEffect(() => {
    if (!address.isNew || !can.view) {
      setDialog((current) => (current?.kind === 'new' ? null : current))
      return
    }
    photos.current = []
    raiseKey.current = null
    const from = address.from && (NCR_FROM_TYPES as readonly string[]).includes(address.from.recordType) ? (address.from as { recordType: NcrFromType; recordId: string }) : null
    setDialog({ kind: 'new', draft: { ...EMPTY_DRAFT, siteId: siteId ?? '' }, from: from ? { ...from, prefill: null, problem: null } : null, defects: null, busy: false, notice: null })
    defectPicker(api)
      .then((defects) => setDialog((current) => (current?.kind === 'new' ? { ...current, defects } : current)))
      .catch(() => setDialog((current) => (current?.kind === 'new' ? { ...current, defects: 'failed' } : current)))
    if (from && can.raise)
      ncrPrefill(api, from)
        .then((prefill) => setDialog((current) => (current?.kind === 'new' && current.from ? { ...current, from: { ...current.from, prefill }, draft: draftOf(prefill, current.draft) } : current)))
        .catch((error: unknown) => setDialog((current) => (current?.kind === 'new' && current.from ? { ...current, from: { ...current.from, problem: readProblem(error) } } : current)))
    // The dialog opens once per address (`?new=1` and its record).
  }, [address.isNew, fromKey, can.view, can.raise, api])

  const submitNew = useCallback(async () => {
    if (dialog?.kind !== 'new' || dialog.busy) return
    const { draft, from } = dialog
    setDialog({ ...dialog, busy: true, notice: null })
    raiseKey.current ??= newIdempotencyKey()
    const body: RaiseBody = {
      title: draft.title.trim(),
      description: draft.description.trim() || null,
      quantityAffected: QUANTITY(draft.quantityAffected),
      quantitySuspect: draft.quantitySuspect.trim() ? QUANTITY(draft.quantitySuspect) : null,
      uom: draft.uom,
      ...(draft.severity ? { severity: draft.severity } : {}),
      defectCodeId: draft.defectCodeId || null,
      zone: draft.zone || null,
      source: draft.source,
      foundAt: draft.foundAt,
      ownerId: draft.ownerId || null,
      ...(from?.prefill ? { from: { recordType: from.prefill.fromType, recordId: from.prefill.fromId } } : {}),
      ...(!from?.prefill?.siteId && draft.siteId ? { siteId: draft.siteId } : {}),
    }
    try {
      const record = await raiseNcr(api, body, raiseKey.current)
      raiseKey.current = null
      let photosFailed = false
      for (const file of photos.current) {
        try {
          await uploadPhoto(api, { companyId: record.ncr.companyId, siteId: record.ncr.siteId, record: { type: 'Nonconformance', id: record.ncr.id } }, file, file.name)
        } catch {
          photosFailed = true
        }
      }
      photos.current = []
      setDialog(null)
      setNotice({ say: { key: photosFailed ? 'new.createdPhotosFailed' : 'new.created', params: { number: record.ncr.number } }, tone: photosFailed ? 'warning' : 'success' })
      router.push(`${prefix}/quality/ncr/${encodeURIComponent(record.ncr.id)}`)
    } catch (error) {
      const refusal = refusalOf(error)
      setDialog((current) => (current?.kind === 'new' ? { ...current, busy: false, notice: { say: refusal.say.key === 'problem.invalid' || refusal.say.key === 'problem.refused' ? { key: 'new.refused' } : refusal.say, tone: 'danger', detail: refusal.detail } } : current))
    }
  }, [dialog, api, router, prefix])

  // ---- Assign owner --------------------------------------------------------------------------------------------------------
  const submitAssign = useCallback(async () => {
    if (dialog?.kind !== 'assign' || dialog.busy || !dialog.ownerId) return
    setDialog({ ...dialog, busy: true, notice: null })
    const byId = new Map((rows.items ?? []).map((row) => [row.id, row]))
    let done = 0
    const detail: string[] = []
    for (const id of dialog.ids) {
      const row = byId.get(id)
      if (!row) continue
      try {
        await editNcr(api, id, { version: row.version, ownerId: dialog.ownerId })
        done += 1
      } catch (error) {
        detail.push(`${row.number}: ${sayWith(t, INTL_LOCALE[lang], refusalOf(error).say) ?? ''}`)
      }
    }
    setDialog(null)
    setNotice(done === dialog.ids.length ? { say: { key: 'list.assigned', params: { count: done } }, tone: 'success' } : { say: { key: 'list.assignedSome', params: { done, count: dialog.ids.length } }, tone: 'warning', detail })
    void load()
  }, [dialog, rows.items, api, t, lang, load])

  // ---- export -----------------------------------------------------------------------------------------------------------------
  const exportRows = useCallback(
    (ids: readonly string[]) => {
      const picked = (rows.items ?? []).filter((row) => ids.includes(row.id))
      const intl = INTL_LOCALE[lang]
      const header = ['number', 'title', 'stage', 'severity', 'source', 'defect', 'style', 'size', 'lot', 'serial', 'supplier', 'affected', 'suspect', 'decided', 'unit', 'owner', 'due', 'found', 'site'].map((column) => t(`csv.${column}`))
      const lines = picked.map((row: NcrSummary) => [
        row.number,
        row.title,
        t(`stage.${row.stage}`),
        t(`severity.${row.severity}`),
        t(`source.${row.source}`),
        row.defect?.code ?? '',
        row.style?.code ?? '',
        row.size ?? '',
        row.lot?.code ?? '',
        row.serial ?? '',
        row.supplier?.name ?? '',
        quantityText(row.quantityAffected, intl),
        row.quantitySuspect ? quantityText(row.quantitySuspect, intl) : '',
        quantityText(row.decided.decided, intl),
        t(`uom.${row.uom}`),
        nameOf(people, row.ownerId) ?? '',
        row.containmentDueAt ? formatDateTime(row.containmentDueAt, { locale: lang }) : '',
        formatDateTime(row.foundOn, { locale: lang }),
        sites?.find((site) => site.id === row.siteId)?.code ?? '',
      ])
      downloadText(`nonconformances-${new Date().toISOString().slice(0, 10)}.csv`, csvText(header, lines))
    },
    [rows.items, t, lang, people, sites],
  )

  const model: NcrListModel = {
    prefix,
    can,
    address: { view, q, siteId, mode },
    sites,
    rows,
    lanes: lanes as { items: NcrLane[] | null; problem: string | null },
    counts,
    people,
    asOf,
    now: asOf ?? opened,
    live,
    updates,
    notice,
    moving,
    dialog,
    close: close.dialog,
    stepUp: close.stepUp,
  }

  return (
    <NcrListView
      model={model}
      actions={{
        onView: (next) => go({ view: next }),
        onSearch: (next) => go({ q: next }),
        onSite: (next) => go({ siteId: next }),
        onMode: (next) => go({ mode: next }),
        onClearFilters: () => go({ view: 'open', q: '', siteId: null }),
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onOpen: (id) => router.push(`${prefix}/quality/ncr/${encodeURIComponent(id)}`),
        onNew: () => go({ isNew: true, from: null }),
        onNewDraft: (patch) => setDialog((current) => (current?.kind === 'new' ? { ...current, draft: { ...current.draft, ...patch } } : current)),
        onPhotos: (files) => {
          photos.current = [...photos.current, ...files]
          setDialog((current) => (current?.kind === 'new' ? { ...current, draft: { ...current.draft, photos: photos.current.map((file) => file.name) } } : current))
        },
        onSubmitNew: () => void submitNew(),
        onAssign: (ids) => setDialog({ kind: 'assign', ids, ownerId: '', busy: false, notice: null }),
        onAssignOwner: (ownerId) => setDialog((current) => (current?.kind === 'assign' ? { ...current, ownerId } : current)),
        onSubmitAssign: () => void submitAssign(),
        onDialogClose: () => {
          if (dialog?.kind === 'new') go({ isNew: false, from: null })
          setDialog(null)
        },
        onExport: exportRows,
        onCopy: (number) => {
          void navigator.clipboard
            ?.writeText(number)
            .then(() => setNotice({ say: { key: 'common.copied', params: { number } }, tone: 'success' }))
            .catch(() => undefined)
        },
        onPrint: () => window.print(),
        onBoardMove: boardMove,
        onDismissNotice: () => setNotice(null),
        close: close.actions,
        onStepUpSubmit: (code) => void close.submitStepUp(code),
        onStepUpCancel: close.cancelStepUp,
      }}
    />
  )
}
