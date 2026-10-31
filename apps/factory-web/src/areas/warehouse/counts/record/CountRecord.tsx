'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { useCoalesced, useLive } from '../../../_shared/buying/hooks'
import { listLocations, type SiteLocations } from '../../../_shared/stock/api'
import {
  addLine,
  applyCount,
  approveCount,
  askRecounts,
  cancelCount,
  countLines,
  countReasons,
  countRecord,
  countSheets,
  editCount,
  fileLink,
  countPlaces,
  findMaterials,
  hidesOf,
  lotsOf,
  recordLines,
  removeLine,
  sendBack,
  signOffCount,
  startCount,
  submitCount,
  valuedListPreview,
  type CountLine,
  type CountPlace,
  type CountReason,
  type CountRecord as CountRecordValue,
  type LineEntry,
} from '../api'
import { countProblem, countsCan, isCountEvent, readCount, readProblem, recordTabOf, sameQuantity, TIME_ZONE, typedField, typedValue, type Phrase } from '../model'
import { openPdf, openStored, saveXlsx } from '../papers'
import { CountsMessages } from '../parts'
import type { CellSave, CountRecordModel, FoundDraft, FoundModel, LinesPart, Loaded, Notice, PlaceChoice, RecordDialog } from '../view-model'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { CountRecordView } from './view/CountRecordView'

/**
 * The count record container (`/w/<company>/warehouse/counts/<id>?tab=lines|differences|approval`, SCR-132 record):
 * reads the count (`GET /inventory/stock-counts/:id`: header, summary, approval, what the caller may do), its lines a
 * page at a time (`…/lines`, the Lines tab's filter, place and search) and the lines that differ (`…/lines?filter=
 * differs`: the Differences tab and the Apply dialog), the adjustment reasons; writes each step as one command with the
 * version it read. A typed count saves on its own (one line per request with its version: autosave per cell); ⌘Z takes
 * the last typed count back. Count events re-read the count and its lines (a floor count arrives live).
 */
export function CountRecord({ countId }: { countId: string }) {
  return (
    <CountsMessages>
      <CountRecordContainer countId={countId} />
    </CountsMessages>
  )
}

const PAGE = 200
const EMPTY_LINES: LinesPart = { filter: 'all', q: '', locationId: null, items: null, more: false, problem: null }

interface Typed {
  lineId: string
  seq: number
  previous: string | null
}

function placesOf(site: SiteLocations | undefined, under: string | null): PlaceChoice[] | null {
  if (!site) return null
  return site.locations
    .filter((location) => location.status === 'ACTIVE' && (!under || location.path.includes(under)))
    .map((location) => ({ id: location.id, code: location.code, name: location.name, depth: location.depth }))
}

const replaceLine = (items: CountLine[] | null, line: CountLine): CountLine[] | null => (items ? items.map((item) => (item.id === line.id ? line : item)) : items)

function CountRecordContainer({ countId }: { countId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const locale = useLocale()
  const params = useSearchParams()
  const can = useMemo(() => countsCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const tab = recordTabOf(params?.get('tab'))
  const language: 'it' | 'en' = locale === 'en' ? 'en' : 'it'

  const [record, setRecord] = useState<Loaded<CountRecordValue>>({ status: 'loading' })
  const [lines, setLines] = useState<LinesPart>(EMPTY_LINES)
  const [linesCursor, setLinesCursor] = useState<number | null>(null)
  const [diffs, setDiffs] = useState<CountRecordModel['diffs']>({ items: null, more: false, problem: null })
  const [diffsCursor, setDiffsCursor] = useState<number | null>(null)
  const [reasons, setReasons] = useState<CountReason[] | null>(null)
  const [cells, setCells] = useState<Record<string, CellSave>>({})
  const [typed, setTyped] = useState<Typed[]>([])
  const [asOf, setAsOf] = useState<string | null>(null)
  const [dialog, setDialog] = useState<RecordDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Phrase | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [trees, setTrees] = useState<SiteLocations[]>([])
  const value = record.status === 'ready' ? record.value : null
  const current = useRef<CountRecordValue | null>(null)
  current.current = value
  const linesRef = useRef(lines)
  linesRef.current = lines
  const diffsRef = useRef(diffs)
  diffsRef.current = diffs
  const diffsAsked = useRef(false)

  // B-W2b-15: every place of the count with its line counts (the place filter), read with the record.
  const [places, setPlaces] = useState<CountPlace[] | null>(null)
  const loadPlaces = useCallback(() => {
    if (!can.view) return
    countPlaces(api, countId)
      .then(setPlaces)
      .catch(() => setPlaces(null))
  }, [api, can.view, countId])

  const load = useCallback(async () => {
    if (!can.view) {
      setRecord({ status: 'forbidden' })
      return
    }
    try {
      setRecord({ status: 'ready', value: await countRecord(api, countId) })
      loadPlaces()
      setAsOf(new Date().toISOString())
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setRecord({ status: 'not_found' })
      else if (isApiError(error) && error.kind === 'forbidden') setRecord({ status: 'forbidden' })
      else setRecord({ status: 'error', problem: readProblem(error) })
    }
  }, [api, can.view, countId, loadPlaces])

  const loadLines = useCallback(
    async (after: number | null = null, part: Pick<LinesPart, 'filter' | 'q' | 'locationId'> = linesRef.current) => {
      if (!can.view) return
      try {
        const page = await countLines(api, countId, { filter: part.filter, q: part.q || null, locationId: part.locationId, cursor: after, limit: PAGE })
        setLines((now) => ({ ...now, items: after !== null && now.items ? [...now.items, ...page.lines] : page.lines, more: page.nextCursor !== null, problem: null }))
        setLinesCursor(page.nextCursor)
      } catch (error) {
        setLines((now) => ({ ...now, items: after !== null ? now.items : null, problem: readProblem(error) }))
      }
    },
    [api, can.view, countId],
  )

  const loadDiffs = useCallback(
    async (after: number | null = null) => {
      if (!can.view) return
      diffsAsked.current = true
      try {
        const page = await countLines(api, countId, { filter: 'differs', cursor: after, limit: 500 })
        setDiffs((now) => ({ items: after !== null && now.items ? [...now.items, ...page.lines] : page.lines, more: page.nextCursor !== null, problem: null }))
        setDiffsCursor(page.nextCursor)
      } catch (error) {
        setDiffs((now) => ({ items: after !== null ? now.items : null, more: false, problem: readProblem(error) }))
      }
    },
    [api, can.view, countId],
  )

  useEffect(() => {
    void load()
  }, [load])

  // The lines once the count is there and started (a DRAFT has none yet).
  const started = !!value && value.status !== 'DRAFT'
  useEffect(() => {
    if (started && linesRef.current.items === null && linesRef.current.problem === null) void loadLines(null)
  }, [started, loadLines])
  useEffect(() => {
    if (started && (tab === 'differences' || tab === 'approval') && !diffsAsked.current) void loadDiffs(null)
  }, [started, tab, loadDiffs])
  useEffect(() => {
    if (!can.view) return
    countReasons(api)
      .then(setReasons)
      .catch(() => setReasons([]))
  }, [api, can.view])

  const siteId = value?.site.id ?? null
  useEffect(() => {
    if (!siteId || !can.locations) return
    listLocations(api, { siteId })
      .then((answer) => setTrees(answer.sites))
      .catch(() => setTrees([]))
  }, [api, siteId, can.locations])

  // After one's own typed line: the count's figures and steps only (the line itself came back with the answer).
  const rereadRecord = useCoalesced(() => void load(), 800)
  // A change from elsewhere (a floor count, another office): the count, and its lines while they fit one page (a longer
  // list keeps the pages already read, so the cell being typed never disappears; its lines answer their own writes).
  const reread = useCoalesced(() => {
    void load()
    const loaded = linesRef.current.items
    if (loaded !== null && loaded.length <= PAGE) void loadLines(null)
    if (diffsAsked.current && (diffsRef.current.items?.length ?? 0) <= 500) void loadDiffs(null)
  }, 800)
  const live = useLive(
    (change) => {
      if (isCountEvent(change.type) && (change.fields.countId === undefined || change.fields.countId === countId)) reread()
    },
    () => reread(),
    can.view,
  )

  // ---- typing counts (autosave per cell) ------------------------------------------------------------------------------------

  const setCell = (id: string, save: CellSave | null) =>
    setCells((now) => {
      const next = { ...now }
      if (save) next[id] = save
      else delete next[id]
      return next
    })

  const saveLine = useCallback(
    async (line: CountLine, entry: LineEntry, after?: (saved: CountLine) => void) => {
      setCell(line.id, { state: 'saving' })
      try {
        const answer = await recordLines(api, countId, [entry])
        const saved = answer.lines.find((item) => item.id === line.id)
        if (saved) {
          setLines((now) => ({ ...now, items: replaceLine(now.items, saved) }))
          setDiffs((now) => ({ ...now, items: replaceLine(now.items, saved) }))
          after?.(saved)
        }
        setCell(line.id, { state: 'saved' })
        rereadRecord()
        return true
      } catch (error) {
        const words = countProblem(error)
        setCell(line.id, { state: 'failed', words })
        // A newer version of the line (someone typed it meanwhile): read the lines again, the person types again.
        if (isApiError(error) && error.kind === 'conflict' && error.code !== 'invalid_state') reread()
        return false
      }
    },
    [api, countId, reread, rereadRecord],
  )

  const type = useCallback(
    (line: CountLine, text: string) => {
      const read = readCount(text, line.hide?.area ?? null)
      if (read.problem) {
        setCell(line.id, { state: 'failed', words: { key: read.problem } })
        return
      }
      const field = typedField(line)
      const before = typedValue(line)
      if (sameQuantity(read.value, before)) {
        if (cells[line.id]?.state === 'failed') setCell(line.id, null)
        return
      }
      if (field === 'recount' && read.value === null) {
        setCell(line.id, { state: 'failed', words: { key: 'line.problem.recountBack' } })
        return
      }
      const entry: LineEntry = field === 'recount' ? { lineId: line.id, version: line.version, recount: read.value! } : { lineId: line.id, version: line.version, counted: read.value }
      void saveLine(line, entry, () => {
        if (field === 'counted') setTyped((now) => [...now.filter((item) => item.lineId !== line.id), { lineId: line.id, seq: line.seq, previous: before }].slice(-50))
      })
    },
    [cells, saveLine],
  )

  const undo = useCallback(() => {
    const last = typed[typed.length - 1]
    if (!last) return
    const line = linesRef.current.items?.find((item) => item.id === last.lineId)
    if (!line) return
    setTyped((now) => now.slice(0, -1))
    void saveLine(line, { lineId: line.id, version: line.version, counted: last.previous })
  }, [typed, saveLine])

  const reason = useCallback(
    (line: CountLine, code: string | null) => {
      const picked = reasons?.find((item) => item.code === code)
      if (picked?.needsDetail) {
        setProblem(null)
        setDialog({ kind: 'reason', lineIds: [line.id], reasonCode: code, reasonNote: line.reasonNote ?? '' })
        return
      }
      void saveLine(line, { lineId: line.id, version: line.version, reasonCode: code, reasonNote: null })
    },
    [reasons, saveLine],
  )

  const allLines = useCallback((): CountLine[] => {
    const seen = new Map<string, CountLine>()
    for (const line of [...(linesRef.current.items ?? []), ...(diffs.items ?? [])]) seen.set(line.id, line)
    return [...seen.values()]
  }, [diffs.items])

  // ---- the steps -------------------------------------------------------------------------------------------------------------

  const step = useCallback(
    async (run: () => Promise<CountRecordValue | null>, done: Notice | null, then?: () => void) => {
      if (busy) return
      setBusy(true)
      setProblem(null)
      try {
        const next = await run()
        if (next) setRecord({ status: 'ready', value: next })
        setAsOf(new Date().toISOString())
        setDialog(null)
        if (done) setNotice(done)
        then?.()
      } catch (error) {
        const words = countProblem(error)
        if (dialog) setProblem(words)
        else setNotice({ tone: 'danger', words })
        if (isApiError(error) && error.kind === 'conflict' && error.code !== 'invalid_state') void load()
      } finally {
        setBusy(false)
      }
    },
    [busy, dialog, load],
  )

  const confirm = useCallback(() => {
    const count = current.current
    if (!count || !dialog) return
    switch (dialog.kind) {
      case 'edit':
        void step(() => editCount(api, count, { countTeam: dialog.team.trim() || null, note: dialog.note.trim() || null }), { tone: 'success', words: { key: 'done.edited' } })
        return
      case 'cancel':
        void step(() => cancelCount(api, count, dialog.reason.trim()), { tone: 'info', words: { key: 'done.cancelled', params: { number: count.number } } })
        return
      case 'approve':
        void step(() => approveCount(api, count, dialog.note.trim() || null), { tone: 'success', words: { key: 'done.approved' } })
        return
      case 'sendBack': {
        const ids = dialog.recount ? (diffs.items ?? []).filter((line) => line.recountSuggested).map((line) => line.id) : []
        void step(() => sendBack(api, count, dialog.reason.trim(), ids), { tone: 'info', words: { key: 'done.sentBack', params: { count: ids.length } } }, () => {
          void loadLines(null)
          void loadDiffs(null)
        })
        return
      }
      case 'apply':
        void step(
          async () => {
            const answer = await applyCount(api, count)
            setNotice({ tone: 'success', words: { key: 'done.applied', params: { count: answer.moves.length } } })
            return answer.count
          },
          null,
          () => {
            void loadLines(null)
            void loadDiffs(null)
          },
        )
        return
      case 'signOff':
        void step(() => signOffCount(api, count, dialog.phrase, dialog.language), { tone: 'success', words: { key: 'done.signedOff', params: { number: count.number } } })
        return
      case 'reason': {
        const targets = allLines().filter((line) => dialog.lineIds.includes(line.id))
        void step(
          async () => {
            const answer = await recordLines(
              api,
              count.id,
              targets.map((line) => ({ lineId: line.id, version: line.version, reasonCode: dialog.reasonCode, reasonNote: dialog.reasonNote.trim() || null })),
            )
            for (const saved of answer.lines) {
              setLines((now) => ({ ...now, items: replaceLine(now.items, saved) }))
              setDiffs((now) => ({ ...now, items: replaceLine(now.items, saved) }))
            }
            return countRecord(api, count.id)
          },
          { tone: 'success', words: { key: 'done.reasons', params: { count: targets.length } } },
        )
        return
      }
      case 'found': {
        const draft = dialog.found.draft
        const read = readCount(draft.counted)
        if (!draft.locationId || !draft.item || read.problem || read.value === null || Number(read.value) <= 0) {
          setProblem({ key: 'found.problem.incomplete' })
          return
        }
        void step(
          async () => {
            await addLine(api, count.id, {
              locationId: draft.locationId!,
              itemId: draft.item!.id,
              ...(draft.colourId ? { itemColourId: draft.colourId } : {}),
              ...(draft.lotId ? { lotId: draft.lotId } : {}),
              ...(draft.hideId ? { hideId: draft.hideId } : {}),
              counted: read.value!,
              ...(draft.reasonCode ? { reasonCode: draft.reasonCode } : {}),
              ...(draft.reasonNote.trim() ? { reasonNote: draft.reasonNote.trim() } : {}),
            })
            return countRecord(api, count.id)
          },
          { tone: 'success', words: { key: 'done.found' } },
          () => {
            void loadLines(null)
            if (diffsAsked.current) void loadDiffs(null)
          },
        )
        return
      }
      default:
    }
  }, [api, dialog, diffs.items, step, loadLines, loadDiffs, allLines])

  const recounts = useCallback(
    (lineIds: readonly string[]) => {
      const count = current.current
      if (!count || lineIds.length === 0) return
      void step(
        async () => {
          const changed = await askRecounts(api, count.id, lineIds)
          for (const saved of changed) {
            setLines((now) => ({ ...now, items: replaceLine(now.items, saved) }))
            setDiffs((now) => ({ ...now, items: replaceLine(now.items, saved) }))
          }
          return countRecord(api, count.id)
        },
        { tone: 'info', words: { key: 'done.recounts', params: { count: lineIds.length } } },
      )
    },
    [api, step],
  )

  // ---- Found stock (an ADDED line) ------------------------------------------------------------------------------------------

  const foundDraft = dialog?.kind === 'found' ? dialog.found.draft : null
  const foundItem = foundDraft?.item ?? null
  const foundLot = foundDraft?.lotId ?? null
  const patchFound = useCallback((patch: Partial<FoundModel>) => setDialog((now) => (now?.kind === 'found' ? { kind: 'found', found: { ...now.found, ...patch } } : now)), [])
  useEffect(() => {
    if (!foundItem || !siteId) return
    const controller = new AbortController()
    // B-W2b-15: the item search answers its colours (a finished garment has none).
    patchFound({ colours: foundItem.colours })
    if (foundItem.tracking !== 'NONE' && can.stock)
      lotsOf(api, siteId, foundItem.id, controller.signal)
        .then((lots) => patchFound({ lots }))
        .catch(() => patchFound({ lots: [] }))
    return () => controller.abort()
  }, [api, foundItem, siteId, can.stock, patchFound])
  useEffect(() => {
    if (!foundLot || !siteId || foundItem?.tracking !== 'HIDE' || !can.stock) return
    const controller = new AbortController()
    hidesOf(api, siteId, foundLot, controller.signal)
      .then((hides) => patchFound({ hides }))
      .catch(() => patchFound({ hides: [] }))
    return () => controller.abort()
  }, [api, foundLot, foundItem, siteId, can.stock, patchFound])

  const findFound = useCallback(
    (text: string) => {
      if (!can.materials || !siteId || text.trim().length < 2) {
        patchFound({ found: null })
        return
      }
      patchFound({ searching: true })
      findMaterials(api, siteId, text)
        .then((found) => patchFound({ found, searching: false }))
        .catch(() => patchFound({ found: [], searching: false }))
    },
    [api, can.materials, siteId, patchFound],
  )

  const openDialog = useCallback(
    (next: RecordDialog | null) => {
      setProblem(null)
      if ((next?.kind === 'apply' || next?.kind === 'sendBack') && !diffsAsked.current) void loadDiffs(null)
      setDialog(next)
    },
    [loadDiffs],
  )
  const openFound = useCallback(() => {
    const count = current.current
    const places = placesOf(trees[0], count?.scope.location?.code ?? null)
    const draft: FoundDraft = { locationId: count?.scope.location?.id ?? null, item: null, colourId: null, lotId: null, hideId: null, counted: '', reasonCode: null, reasonNote: '' }
    setProblem(null)
    setDialog({ kind: 'found', found: { draft, places, found: null, searching: false, colours: null, lots: null, hides: null } })
  }, [trees])

  // ---- papers ---------------------------------------------------------------------------------------------------------------

  const failPaper = (error: unknown) => setNotice({ tone: 'danger', words: countProblem(error) })
  const sheets = (expected: boolean) => {
    const count = current.current
    if (!count) return
    openPdf(() => countSheets(api, count.id, expected, language), `${count.number}-${expected ? 'sheets' : 'blind'}.pdf`).catch(failPaper)
  }
  const valuedPreview = (format: 'pdf' | 'xlsx') => {
    const count = current.current
    if (!count) return
    const read = () => valuedListPreview(api, count.id, format, language)
    ;(format === 'pdf' ? openPdf(read, `${count.number}-valued-preview.pdf`) : saveXlsx(read, `${count.number}-valued-preview.xlsx`)).catch(failPaper)
  }
  const valuedFile = (fileId: string) => {
    openStored(() => fileLink(api, fileId)).catch(failPaper)
  }

  const model: CountRecordModel = {
    prefix,
    can,
    tab,
    timeZone: TIME_ZONE,
    record,
    lines,
    diffs,
    reasons,
    cells,
    undo: typed.length > 0 ? { lineId: typed[typed.length - 1]!.lineId, seq: typed[typed.length - 1]!.seq } : null,
    live,
    asOf,
    changed: null,
    dialog,
    busy,
    problem,
    notice,
    now: new Date().toISOString(),
    places,
  }
  // B-W2b-15: the count's thread, files and history (Activity), of its company and site.
  const panels = value && can.threads ? <RecordPanels record={{ type: 'StockCount', id: value.id, companyId: value.companyId, siteId: value.site.id }} title={value.number} /> : null

  return (
    <CountRecordView
      model={model}
      panels={panels}
      actions={{
        onRetry: () => void load(),
        onReload: () => reread(),
        onStart: () => {
          const count = current.current
          if (count) void step(() => startCount(api, count), { tone: 'success', words: { key: 'done.started' } }, () => void loadLines(null))
        },
        onSubmit: () => {
          const count = current.current
          if (count) void step(() => submitCount(api, count), { tone: 'success', words: { key: 'done.submitted' } }, () => void loadDiffs(null))
        },
        onDialog: openDialog,
        onConfirm: confirm,
        onSheets: sheets,
        onValuedPreview: valuedPreview,
        onValuedFile: valuedFile,
        onLines: (patch) => {
          const next = { ...linesRef.current, ...patch }
          setLines({ ...next, items: null, more: false, problem: null })
          void loadLines(null, next)
        },
        onMoreLines: () => void loadLines(linesCursor),
        onMoreDiffs: () => void loadDiffs(diffsCursor),
        onRetryLines: () => void loadLines(null),
        onRetryDiffs: () => void loadDiffs(null),
        onType: type,
        onUndo: undo,
        onReason: reason,
        onRecounts: recounts,
        onRemoveLine: (line) => {
          const count = current.current
          if (!count) return
          void step(
            async () => {
              await removeLine(api, count.id, line)
              return countRecord(api, count.id)
            },
            { tone: 'info', words: { key: 'done.removed', params: { seq: line.seq } } },
            () => void loadLines(null),
          )
        },
        onOpenFound: openFound,
        onFind: findFound,
        onFound: (patch) =>
          setDialog((now) => {
            if (now?.kind !== 'found') return now
            const draft = { ...now.found.draft, ...patch }
            // A new material clears its colour, lot and hide; a new lot its hide.
            if (patch.item !== undefined) Object.assign(draft, { colourId: null, lotId: null, hideId: null })
            if (patch.lotId !== undefined) draft.hideId = null
            return { kind: 'found', found: { ...now.found, draft, ...(patch.item !== undefined ? { colours: null, lots: null, hides: null } : patch.lotId !== undefined ? { hides: null } : {}) } }
          }),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
