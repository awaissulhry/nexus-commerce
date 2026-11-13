'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { listMaterials } from '../../../products/materials/api'
import type { PriceListDetail, PriceVersion } from '../api'
import { createMinimum, listMinimums, moveMinimum, readRules, setBreaks, setDiscountDisplay, setSurcharges, type BreakRow, type Minimum, type SurchargeRow, type VersionRules } from '../depth/api'
import { breakCellRow, breakHeld, breakRowOf, isPhrase, minimumBody, minimumHeld, movableMinimums, rulesHeld, surchargeCellRow, surchargeHeld, surchargeRowsOf } from '../depth/model'
import type { Phrase, PriceListAbilities, RecordTab } from '../model'
import { readProblem, writeProblem } from '../problems'
import type { BreaksDepthActions, BreaksDepthModel, RecordDialog } from './record-model'
import type { PriceEntry } from '../api'

export interface BreaksInput {
  api: ApiClient
  list: PriceListDetail | null
  /** The version the Prices tab shows (with its `version`: a write elsewhere moves it). */
  version: PriceVersion | null
  entries: readonly PriceEntry[]
  can: PriceListAbilities
  tab: RecordTab
  dialog: RecordDialog | null
  setDialog: (dialog: RecordDialog | null) => void
  setDialogProblem: (problem: Phrase | null) => void
  /** The list read again (its versions' `version`, its discount choice). */
  onList: () => void
}

type Read<T> = { status: 'loading' } | { status: 'error'; problem: string } | { status: 'ready'; value: T }

/** A write's refusal in this catalogue's words (`depth.` for the record's dialog problems). */
const refusal = (error: unknown, refusedKey: string): { words: Phrase; reload: boolean } => {
  const problem = writeProblem(error, refusedKey)
  return { words: problem.words, reload: problem.reload }
}

/**
 * The Breaks & surcharges tab's container (B-W2b-343): reads the version's rules (breaks, the version's and the styles'
 * own surcharges, the list's discount choice) and the list's minimums while the tab is open (and the rules for a days
 * dialog: a price's own breaks are said); writes one row at a time (a break's or a surcharge's cell, autosaved with the
 * version's `version`, both money fields), Add a break / surcharge, Remove N breaks, the discount choice, New minimum,
 * Archive / Reactivate N minimums (one after the other, each with its own version). A 409 reads the rules again.
 */
export function useBreaks(input: BreaksInput): { model: BreaksDepthModel | undefined; actions: BreaksDepthActions } {
  const { api, list, version, can, tab, dialog } = input
  const inputRef = useRef(input)
  inputRef.current = input
  const [rules, setRules] = useState<Read<VersionRules>>({ status: 'loading' })
  const rulesRef = useRef<VersionRules | null>(null)
  const [minimums, setMinimums] = useState<Read<Minimum[]>>({ status: 'loading' })
  const [selectedBreaks, setSelectedBreaks] = useState<readonly string[]>([])
  const [selectedMinimums, setSelectedMinimums] = useState<readonly string[]>([])
  const [cells, setCells] = useState<Record<string, 'saving' | 'failed'>>({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<BreaksDepthModel['notice']>(null)
  const [materials, setMaterials] = useState<BreaksDepthModel['materials']>({ query: '', results: null })
  const [tries, setTries] = useState(0)
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  const wanted = !!list && !!version && (tab === 'breaks' || dialog?.kind === 'days')
  const rulesKey = list && version ? `${list.id}:${version.id}:${version.version}:${tries}` : ''
  const loadRules = useCallback(async () => {
    const current = inputRef.current
    if (!current.list || !current.version) return
    try {
      const value = await readRules(api, current.list.id, current.version.id)
      rulesRef.current = value
      setRules({ status: 'ready', value })
      setSelectedBreaks((ids) => ids.filter((id) => value.breaks.some((row) => row.id === id)))
    } catch (error) {
      setRules({ status: 'error', problem: readProblem(error) })
    }
  }, [api])
  useEffect(() => {
    if (wanted) void loadRules()
    // The key names the list, the version and its `version`.
  }, [wanted, rulesKey, loadRules])

  const loadMinimums = useCallback(async () => {
    const current = inputRef.current
    if (!current.list) return
    try {
      const value = await listMinimums(api, current.list.id)
      setMinimums({ status: 'ready', value })
      setSelectedMinimums((ids) => ids.filter((id) => value.some((row) => row.id === id)))
    } catch (error) {
      setMinimums({ status: 'error', problem: readProblem(error) })
    }
  }, [api])
  const listId = list?.id ?? ''
  useEffect(() => {
    if (tab === 'breaks' && listId) void loadMinimums()
  }, [tab, listId, tries, loadMinimums])

  // New minimum › a material: the materials matching what is typed (only while that dialog asks for one).
  const materialSeq = useRef(0)
  const searchMaterials = (query: string) => {
    const mine = ++materialSeq.current
    setMaterials({ query, results: null })
    listMaterials(api, { q: query, limit: 20 })
      .then((page) => mine === materialSeq.current && setMaterials({ query, results: page.materials.map((row) => ({ id: row.id, code: row.code, name: row.name })) }))
      .catch(() => mine === materialSeq.current && setMaterials({ query, results: [] }))
  }
  const wantsMaterials = dialog?.kind === 'addMinimum' && dialog.draft?.subject === 'MATERIAL'
  useEffect(() => {
    if (wantsMaterials && materials.results === null && materials.query === '') searchMaterials('')
    // Once per opening of a material's choice.
  }, [wantsMaterials])

  /** ONE write of the rules, in order; true when the server took it. */
  const writeRules = (work: (current: VersionRules) => Promise<VersionRules>, cellIds: readonly string[], refusedKey: string, done: Phrase | null, inDialog: boolean) => {
    const next = queue.current.then(async () => {
      const current = rulesRef.current
      if (!current) return false
      if (cellIds.length > 0) setCells((state) => ({ ...state, ...Object.fromEntries(cellIds.map((id) => [id, 'saving' as const])) }))
      try {
        const answer = await work(current)
        rulesRef.current = answer
        setRules({ status: 'ready', value: answer })
        setCells((state) => Object.fromEntries(Object.entries(state).filter(([id]) => !cellIds.includes(id))))
        if (done) setNotice({ tone: 'success', words: done })
        inputRef.current.onList()
        return true
      } catch (error) {
        const problem = refusal(error, refusedKey)
        setCells((state) => ({ ...state, ...Object.fromEntries(cellIds.map((id) => [id, 'failed' as const])) }))
        if (inDialog) inputRef.current.setDialogProblem(problem.words.key.startsWith('problem.') ? problem.words : { ...problem.words, key: `depth.${problem.words.key}` })
        else setNotice({ tone: 'danger', words: problem.words })
        if (problem.reload) setTries((value) => value + 1)
        return false
      }
    })
    queue.current = next.catch(() => undefined)
    return next as Promise<boolean>
  }
  const breakWrite = (rows: BreakRow[], cellIds: readonly string[], done: Phrase | null, inDialog = false) => writeRules((current) => setBreaks(api, current.list.id, current.version, rows), cellIds, 'breaks.refused', done, inDialog)
  const surchargeWrite = (rows: SurchargeRow[], cellIds: readonly string[], done: Phrase | null, inDialog = false) => writeRules((current) => setSurcharges(api, current.list.id, current.version, rows), cellIds, 'surcharges.refused', done, inDialog)

  const inDialog = async (work: () => Promise<boolean>) => {
    setBusy(true)
    inputRef.current.setDialogProblem(null)
    const ok = await work()
    setBusy(false)
    if (ok) inputRef.current.setDialog(null)
    return ok
  }

  const actions: BreaksDepthActions = {
    onBreakCell: (row, field, text) => {
      const next = breakCellRow(row, field, text)
      if (isPhrase(next)) return setNotice({ tone: 'warning', words: next })
      void breakWrite([next], [`${row.id}:${field}`], null)
    },
    onSurchargeCell: (row, size, value) => {
      const next = surchargeCellRow(row, size, value)
      if (isPhrase(next)) return setNotice({ tone: 'warning', words: next })
      void surchargeWrite([next], [`${row.id}:${size}`], null)
    },
    onSurchargeRefused: (size, text) => setNotice({ tone: 'warning', words: { key: 'surcharges.notNumber', params: { size, text } } }),
    onSelectBreaks: setSelectedBreaks,
    onSelectMinimums: setSelectedMinimums,
    onShowDiscount: (show) => {
      const current = inputRef.current.list
      if (!current || busy) return
      setBusy(true)
      setDiscountDisplay(api, current, show)
        .then(() => {
          setNotice({ tone: 'success', words: { key: show ? 'discount.doneShow' : 'discount.doneNet' } })
          inputRef.current.onList()
          setTries((value) => value + 1)
        })
        .catch((error: unknown) => {
          setNotice({ tone: 'danger', words: refusal(error, 'discount.refused').words })
          inputRef.current.onList()
        })
        .finally(() => setBusy(false))
    },
    onAddBreak: (draft) => {
      const current = rulesRef.current
      if (!current || breakHeld(draft, current, inputRef.current.entries)) return
      void inDialog(() => breakWrite([breakRowOf(draft)], [], { key: 'breaks.added', params: { count: Number(draft.minQuantity) } }, true))
    },
    onRemoveBreaks: () => {
      const current = rulesRef.current
      if (!current) return
      const rows = current.breaks.filter((row) => selectedBreaks.includes(row.id)).map((row) => ({ entryId: row.entryId, minQuantity: row.minQuantity, unitPrice: null, discountPct: null }))
      if (rows.length === 0) return
      void inDialog(() => breakWrite(rows, [], { key: 'breaks.removed', params: { count: rows.length } }, true)).then((ok) => ok && setSelectedBreaks([]))
    },
    onAddSurcharge: (draft) => {
      if (surchargeHeld(draft)) return
      const rows = surchargeRowsOf(draft)
      void inDialog(() => surchargeWrite(rows, [], { key: 'surcharges.added', params: { count: rows.length } }, true))
    },
    onAddMinimum: (draft) => {
      const current = inputRef.current.list
      const known = minimums.status === 'ready' ? minimums.value : []
      if (!current || minimumHeld(draft, known)) return
      void inDialog(async () => {
        try {
          await createMinimum(api, minimumBody(draft, current))
          setNotice({ tone: 'success', words: { key: 'minimums.added' } })
          await loadMinimums()
          return true
        } catch (error) {
          const refused = isApiError(error) && error.kind === 'conflict' && error.code !== 'version_conflict' ? { key: 'minimums.refusedTwin' } : refusal(error, 'minimums.refused').words
          inputRef.current.setDialogProblem(refused.key.startsWith('problem.') ? refused : { ...refused, key: `depth.${refused.key}` })
          return false
        }
      })
    },
    onMoveMinimums: (move) => {
      const known = minimums.status === 'ready' ? minimums.value : []
      const reach = movableMinimums(known, selectedMinimums, move)
      if (reach.length === 0 || busy) return
      setBusy(true)
      void (async () => {
        let moved = 0
        for (const rule of reach) {
          try {
            await moveMinimum(api, rule, move)
            moved++
          } catch {
            // Said below in one line; the list is read again.
          }
        }
        setBusy(false)
        setSelectedMinimums([])
        setNotice({ tone: moved === reach.length ? 'success' : 'warning', words: { key: moved === reach.length ? `minimums.${move}d` : 'minimums.movedPartly', params: { count: moved, left: reach.length - moved } } })
        await loadMinimums()
      })()
    },
    onMaterialQuery: searchMaterials,
    onRetry: () => setTries((value) => value + 1),
    onDismissNotice: () => setNotice(null),
  }

  if (!list) return { model: undefined, actions }
  const ready = rules.status === 'ready' && rules.value.version.id === version?.id ? rules.value : null
  return {
    model: {
      can,
      version,
      rules: rules.status === 'error' ? rules : ready ? { status: 'ready', value: ready } : { status: 'loading' },
      minimums,
      held: rulesHeld(list, version, can),
      showDiscount: ready?.list.showDiscount ?? list.showDiscount ?? false,
      selectedBreaks,
      selectedMinimums,
      cells,
      extraSizes: [],
      busy,
      notice,
      materials,
    },
    actions,
  }
}
