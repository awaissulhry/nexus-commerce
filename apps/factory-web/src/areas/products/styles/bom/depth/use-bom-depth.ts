'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { isApiError } from '../../../../../lib/api/errors'
import { useOffline } from '../../../operations/depth/online'
import { findMaterials, getStyle, listStyles } from '../../api'
import { readProblem, writeProblem } from '../../problems'
import type { StyleNotice } from '../../record/record-model'
import {
  addAlternate,
  changeStructure,
  changeSupply,
  findCustomers,
  getDepth,
  getStructure,
  getStyleOptions,
  getUsedIn,
  orderAlternates,
  removeAlternate,
  setLineOption,
  setLineStructure,
  setSupply,
  updateAlternate,
  type BomDepthView,
  type BomStructureView,
  type RevisionRef,
  type StyleOptionsView,
  type UsedInView,
} from './api'
import { markKey, movedOrder, NO_BOM_DEPTH, type BomDepthActions, type BomDepthDialog, type BomDepthModel, type CellMark, type DepthNotice, type Part, type SubStyle } from './model'

/**
 * The BOM in depth, its container hook (B-W2b-241 on B-W2b-223's, B-W2b-228's and B-W2b-229's API): reads the revision's
 * structure (sections, group rows, the sub-assembly tree and THE check) with the BOM's read — the tab's problem mark needs
 * it on every tab — and, while the Materials (BOM) tab is open, its lines in depth and the options the style offers (again
 * when the revision in view or a revision's state changes, and on `reload`: the studio's live and reconnect re-read and
 * every W1 BOM write). It does what the tab asks through the studio's ONE write queue (`write`: one write at a time, the
 * band's save words, a 409 reads the style again); every write moves the revision's version by one, which the BOM, the
 * routing and the pieces share (`versionOf` / `onVersion`); `onChanged` lets the studio read W1's BOM and the cost again
 * (a customer's line has no cost). A size quantity is W1's write (`sizes`); typed offline it waits on this page and is sent
 * when the browser is back online.
 */
export function useBomDepth({
  api,
  styleId,
  revisionId,
  loadKey,
  enabled,
  tabOpen,
  canManage,
  companyId,
  write,
  versionOf,
  onVersion,
  onChanged,
  sizes,
}: {
  api: ApiClient
  styleId: string
  revisionId: string | null
  loadKey: string | null
  /** The BOM's read (product.bom.view): the structure and its check. */
  enabled: boolean
  /** The Materials (BOM) tab is open: the lines in depth and the options too. */
  tabOpen: boolean
  canManage: boolean
  /** The company the material and customer searches are read for. */
  companyId: string | null
  write: (work: () => Promise<void>, done?: StyleNotice) => Promise<boolean>
  versionOf: (revisionId: string) => RevisionRef | null
  onVersion: (revision: RevisionRef) => void
  onChanged: () => void
  /** W1's size quantities of one line (PUT …/lines/:lineId/sizes through the studio's BOM write). */
  sizes: (lineId: string, values: Array<{ size: string; qty: string | null }>) => Promise<boolean>
}): { model: BomDepthModel; actions: BomDepthActions; reload: () => void } {
  const [structure, setStructure] = useState<Part<BomStructureView>>({ status: 'idle' })
  const [depth, setDepth] = useState<Part<BomDepthView>>({ status: 'idle' })
  const [options, setOptions] = useState<Part<StyleOptionsView>>({ status: 'idle' })
  const [usedIn, setUsedIn] = useState<Part<UsedInView>>({ status: 'idle' })
  const [dialog, setDialog] = useState<BomDepthDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [marks, setMarks] = useState<Record<string, CellMark>>({})
  const [notice, setNotice] = useState<DepthNotice | null>(null)
  const [customers, setCustomers] = useState<BomDepthModel['customers']>(NO_BOM_DEPTH.customers)
  const [styles, setStyles] = useState<BomDepthModel['styles']>(NO_BOM_DEPTH.styles)
  const [subStyle, setSubStyle] = useState<Part<SubStyle> | null>(null)
  const [materials, setMaterials] = useState<BomDepthModel['materials']>(NO_BOM_DEPTH.materials)
  const [focus, setFocus] = useState<BomDepthModel['focus']>(null)
  const [refusal, setRefusal] = useState<BomDepthModel['refusal']>(null)
  const changed = useRef(onChanged)
  changed.current = onChanged
  const seq = useRef(0)
  const searchSeq = useRef({ customers: 0, styles: 0, materials: 0, sub: 0 })
  const offline = useOffline()
  /** Size cells typed offline, by `${lineId}:${size}`: sent in the order typed when the browser is back online. */
  const waiting = useRef(new Map<string, { lineId: string; size: string; value: string | null }>())

  const loadStructure = useCallback(
    (id: string, mine: number) => {
      setStructure((current) => (current.status === 'ready' && current.value.revision.id === id ? current : { status: 'loading' }))
      getStructure(api, styleId, id)
        .then((value) => mine === seq.current && setStructure({ status: 'ready', value }))
        .catch((error: unknown) => mine === seq.current && setStructure({ status: 'error', problem: readProblem(error) }))
    },
    [api, styleId],
  )
  const loadDepth = useCallback(
    (id: string, mine: number) => {
      setDepth((current) => (current.status === 'ready' && current.value.revision.id === id ? current : { status: 'loading' }))
      getDepth(api, styleId, id)
        .then((value) => mine === seq.current && setDepth({ status: 'ready', value }))
        .catch((error: unknown) => mine === seq.current && setDepth({ status: 'error', problem: readProblem(error) }))
    },
    [api, styleId],
  )
  const loadOptions = useCallback(() => {
    setOptions((current) => (current.status === 'ready' ? current : { status: 'loading' }))
    getStyleOptions(api, styleId)
      .then((value) => setOptions({ status: 'ready', value }))
      .catch((error: unknown) => setOptions({ status: 'error', problem: readProblem(error) }))
  }, [api, styleId])

  const load = useCallback(
    (id: string) => {
      const mine = ++seq.current
      loadStructure(id, mine)
      if (tabOpen) {
        loadDepth(id, mine)
        loadOptions()
      }
    },
    [loadStructure, loadDepth, loadOptions, tabOpen],
  )

  useEffect(() => {
    if (!enabled || !revisionId) {
      setStructure({ status: 'idle' })
      setDepth({ status: 'idle' })
      return
    }
    setSelected([])
    setMarks({})
    load(revisionId)
    // The key holds the revision in view and every revision's state.
  }, [loadKey, enabled])

  // The tab opening reads the lines in depth and the options (once per revision; live changes read them again).
  useEffect(() => {
    if (!enabled || !revisionId || !tabOpen) return
    if (depth.status === 'ready' && depth.value.revision.id === revisionId) return
    loadDepth(revisionId, seq.current)
    loadOptions()
  }, [tabOpen])

  const reload = useCallback(() => {
    if (enabled && revisionId) load(revisionId)
    if (usedIn.status !== 'idle') getUsedIn(api, styleId).then((value) => setUsedIn({ status: 'ready', value })).catch(() => undefined)
  }, [enabled, revisionId, load, api, styleId, usedIn.status])

  const markOf = (key: string, mark: CellMark | null) =>
    setMarks((current) => {
      const next = { ...current }
      if (mark) next[key] = mark
      else delete next[key]
      return next
    })

  /**
   * One write through the studio's queue at the revision's version; its answer is kept, the other part read again (the
   * check follows every change), the version moved, and the studio told (W1's BOM and the cost read again).
   */
  const run = async (work: (target: RevisionRef) => Promise<void>, done?: DepthNotice, mark?: string): Promise<boolean> => {
    setBusy(true)
    setRefusal(null)
    if (mark) markOf(mark, { state: 'saving' })
    let failure: unknown = null
    const ok = await write(async () => {
      const target = revisionId ? versionOf(revisionId) : null
      if (!target) return
      try {
        await work(target)
      } catch (error) {
        failure = error
        throw error
      }
    })
    setBusy(false)
    // A refusal is said in the pop-up too (our words, the API's sentence as its detail): the studio's notice sits behind it.
    if (!ok && failure !== null)
      setRefusal({ key: writeProblem(failure).key, detail: isApiError(failure) ? [...new Set(failure.issues.map((issue) => issue.message ?? '').filter(Boolean))].join(' ') || failure.message || null : null })
    if (mark) markOf(mark, ok ? null : { state: 'refused', problem: 'mark.refused' })
    // The studio's notice speaks its own catalogue (the refusal's words); a success is this tab's own notice.
    setNotice(ok ? (done ?? null) : null)
    if (ok) changed.current()
    return ok
  }
  const keepStructure = (next: BomStructureView) => {
    onVersion({ id: next.revision.id, version: next.revision.version })
    setStructure({ status: 'ready', value: next })
    if (tabOpen) loadDepth(next.revision.id, seq.current)
  }
  const keepDepth = (next: BomDepthView) => {
    onVersion({ id: next.revision.id, version: next.revision.version })
    setDepth({ status: 'ready', value: next })
    loadStructure(next.revision.id, seq.current)
  }

  const actions: BomDepthActions = {
    onRetry: reload,
    onDialog: (next) => {
      setRefusal(null)
      if (next?.kind === 'line' && next.part === 'alternates') setMaterials(NO_BOM_DEPTH.materials)
      if (next === null) setSubStyle(null)
      setDialog(next)
    },
    onSelect: setSelected,
    onDismissNotice: () => setNotice(null),
    onStructure: (lineId, body, field) => run(async (target) => keepStructure(await setLineStructure(api, styleId, target, lineId, body)), { key: 'done.saved', tone: 'success' }, markKey(lineId, field)),
    onChangeStructure: async (lineIds, body) => {
      const ok = await run(async (target) => keepStructure(await changeStructure(api, styleId, target, lineIds, body)), {
        key: body.section !== undefined ? 'done.filed' : body.parentLineId === null ? 'done.ungrouped' : 'done.grouped',
        tone: 'success',
        params: { count: lineIds.length },
      })
      if (ok) {
        setSelected([])
        setDialog(null)
      }
      return ok
    },
    onSupply: (lineId, body, field) => run(async (target) => keepDepth(await setSupply(api, styleId, target, lineId, body)), { key: 'done.saved', tone: 'success' }, markKey(lineId, field)),
    onChangeSupply: async (lineIds, body) => {
      const ok = await run(async (target) => keepDepth(await changeSupply(api, styleId, target, lineIds, body)), { key: 'done.supply', tone: 'success', params: { count: lineIds.length } })
      if (ok) {
        setSelected([])
        setDialog(null)
      }
      return ok
    },
    onOption: (lineId, optionValueId) =>
      run(
        async (target) => {
          const answer = await setLineOption(api, styleId, target, lineId, optionValueId)
          onVersion({ id: answer.revision.id, version: answer.revision.version })
          loadStructure(answer.revision.id, seq.current)
          loadOptions()
        },
        { key: optionValueId ? 'done.option' : 'done.optionOff', tone: 'success' },
        markKey(lineId, 'option'),
      ),
    onAddAlternate: async (lineId, body) => {
      const ok = await run(async (target) => keepDepth(await addAlternate(api, styleId, target, lineId, body)), { key: 'done.alternateAdded', tone: 'success' })
      if (ok) setMaterials(NO_BOM_DEPTH.materials)
      return ok
    },
    onAlternate: (lineId, alternateId, body, field) => run(async (target) => keepDepth(await updateAlternate(api, styleId, target, lineId, alternateId, body)), { key: 'done.saved', tone: 'success' }, markKey(alternateId, field)),
    onRemoveAlternate: async (lineId, alternateId) => {
      const ok = await run(async (target) => keepDepth(await removeAlternate(api, styleId, target, lineId, alternateId)), { key: 'done.alternateRemoved', tone: 'success' })
      if (ok) setDialog({ kind: 'line', lineId, part: 'alternates' })
      return ok
    },
    onMoveAlternate: async (lineId, alternateId, delta) => {
      const line = depth.status === 'ready' ? depth.value.lines.find((entry) => entry.id === lineId) : undefined
      const order = line ? movedOrder(line.alternates, alternateId, delta) : null
      if (!order) return false
      return run(async (target) => keepDepth(await orderAlternates(api, styleId, target, lineId, order)), { key: 'done.alternateMoved', tone: 'success' })
    },
    onSizeCell: (lineId, size, value) => {
      const key = markKey(lineId, size)
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        waiting.current.set(key, { lineId, size, value })
        markOf(key, { state: 'waiting', value })
        return
      }
      markOf(key, { state: 'saving', value })
      // A refusal is said by the studio's notice (its words); the cell keeps its stored value with "!".
      void sizes(lineId, [{ size, qty: value }]).then((ok) => markOf(key, ok ? null : { state: 'refused', problem: 'mark.refused' }))
    },
    onFill: async (lineId, values) => {
      setRefusal(null)
      const ok = await sizes(
        lineId,
        values.map((entry) => ({ size: entry.size, qty: entry.qty })),
      )
      setNotice(ok ? { key: 'done.filled', tone: 'success', params: { count: values.length } } : null)
      // The studio's notice says why; the sheet stays open and says that it was refused.
      if (ok) setDialog(null)
      else setRefusal({ key: 'problem.write.invalid', detail: null })
      return ok
    },
    onFindCustomers: (query) => {
      const mine = ++searchSeq.current.customers
      setCustomers({ query, results: null, problem: null })
      findCustomers(api, query)
        .then((results) => mine === searchSeq.current.customers && setCustomers({ query, results, problem: null }))
        .catch((error: unknown) => mine === searchSeq.current.customers && setCustomers({ query, results: null, problem: readProblem(error) }))
    },
    onFindStyles: (query) => {
      const mine = ++searchSeq.current.styles
      setStyles({ query, results: null, problem: null })
      listStyles(api, { q: query, status: 'OPEN', limit: 20 })
        .then((page) => mine === searchSeq.current.styles && setStyles({ query, results: page.styles.filter((row) => row.id !== styleId), problem: null }))
        .catch((error: unknown) => mine === searchSeq.current.styles && setStyles({ query, results: null, problem: readProblem(error) }))
    },
    onPickStyle: (id) => {
      const mine = ++searchSeq.current.sub
      if (id === null) {
        setSubStyle(null)
        return
      }
      setSubStyle({ status: 'loading' })
      getStyle(api, id)
        .then((style) => mine === searchSeq.current.sub && setSubStyle({ status: 'ready', value: { id: style.id, code: style.code, name: style.name, status: style.status, revisions: style.revisions } }))
        .catch((error: unknown) => mine === searchSeq.current.sub && setSubStyle({ status: 'error', problem: readProblem(error) }))
    },
    onFindMaterials: (query) => {
      const mine = ++searchSeq.current.materials
      setMaterials({ query, results: null, problem: null })
      findMaterials(api, query, companyId)
        .then((results) => mine === searchSeq.current.materials && setMaterials({ query, results, problem: null }))
        .catch((error: unknown) => mine === searchSeq.current.materials && setMaterials({ query, results: null, problem: readProblem(error) }))
    },
    onLoadUsedIn: () => {
      if (usedIn.status === 'ready' || usedIn.status === 'loading') return
      setUsedIn({ status: 'loading' })
      getUsedIn(api, styleId)
        .then((value) => setUsedIn({ status: 'ready', value }))
        .catch((error: unknown) => setUsedIn({ status: 'error', problem: readProblem(error) }))
    },
    onShowSize: (lineId, size) => setFocus({ lineId, size }),
    onFocused: () => setFocus(null),
  }

  // Back online: what waits is sent, in the order typed.
  const onSizeCell = useRef(actions.onSizeCell)
  onSizeCell.current = actions.onSizeCell
  useEffect(() => {
    if (offline) return
    const entries = [...waiting.current.values()]
    waiting.current.clear()
    for (const entry of entries) onSizeCell.current?.(entry.lineId, entry.size, entry.value)
  }, [offline])

  const model = useMemo<BomDepthModel>(
    () => ({ structure, depth, options, usedIn, dialog, busy, selected, marks, notice, refusal, offline, canManage, customers, styles, subStyle, materials, focus }),
    [structure, depth, options, usedIn, dialog, busy, selected, marks, notice, refusal, offline, canManage, customers, styles, subStyle, materials, focus],
  )
  return { model, actions, reload }
}
