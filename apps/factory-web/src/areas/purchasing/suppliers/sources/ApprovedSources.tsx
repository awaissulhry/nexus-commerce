'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useT } from '../../../../lib/i18n/provider'
import { companyPrefix } from '../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { useLiveChanges } from '../../../../record-panels/live'
import { findMaterials, getMaterial } from '../../../_shared/buying/api'
import { downloadText } from '../../../_shared/buying/hooks'
import { readProblem } from '../../../_shared/buying/model'
import type { Party } from '../../../parties/_shared/api'
import { partyName } from '../../../parties/_shared/model'
import { archiveSource, createSource, getSource, listSources, restoreSource, updateSource, type Source } from './api'
import {
  addBody,
  addRefusal,
  bulkRefusal,
  cellChange,
  cellKey,
  cellRefusal,
  say,
  sourcesCan,
  sourcesCsv,
  viewStatus,
  type AddDraft,
  type ApprovedSourcesModel,
  type BulkOutcome,
  type CellField,
  type CellMark,
  type SourcesDialog,
  type SourcesRead,
  type SourceView,
} from './model'
import { ApprovedSourcesView } from './view/ApprovedSourcesView'

const SAVED_SHOWN_MS = 2500

/**
 * The supplier's Items & prices tab (SCR-057 `?tab=items`): reads the supplier's approved sources (`GET
 * /purchasing/supplier-items?partyId=`, 200 a page with Show more), writes ONE field per cell left (`PATCH …/:id` with the
 * row's version; a 409 reads the row again and says so; a PRIMARY that demotes another source says which), adds a source
 * (`POST`, one Idempotency-Key per dialog), archives or restores the picked rows one call each (outcomes in words), and
 * exports the picked rows (CSV). Live supplier_item.* of this supplier from someone else wait behind "N updates · Show".
 */
export function ApprovedSources({ party }: { party: Party }) {
  return (
    <WithMessages namespaces={['purchasing-sources', 'lists']}>
      <Container party={party} />
    </WithMessages>
  )
}

function Container({ party }: { party: Party }) {
  const t = useT('purchasing-sources')
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => sourcesCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const [view, setView] = useState<SourceView>('active')
  const [q, setQ] = useState('')
  const [read, setRead] = useState<SourcesRead>({ status: 'loading' })
  const [cursor, setCursor] = useState<string | null>(null)
  const [cells, setCells] = useState<Record<string, CellMark>>({})
  const [selected, setSelected] = useState<readonly string[]>([])
  const [dialog, setDialog] = useState<SourcesDialog | null>(null)
  const [notice, setNotice] = useState<ApprovedSourcesModel['notice']>(null)
  const [bulk, setBulk] = useState<BulkOutcome | null>(null)
  const [updates, setUpdates] = useState(0)
  const readId = useRef(0)
  const own = useRef(new Set<string>())
  const addKey = useRef<string | null>(null)

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    try {
      const page = await listSources(api, { partyId: party.id, status: viewStatus(view), limit: 200 })
      if (id !== readId.current) return
      setRead({ status: 'ready', rows: page.items, more: page.nextCursor !== null })
      setCursor(page.nextCursor)
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      setRead({ status: 'error', problem: readProblem(error) })
    }
  }, [api, can.view, party.id, view])

  useEffect(() => {
    setRead({ status: 'loading' })
    setSelected([])
    void load()
  }, [load])

  const more = useCallback(async () => {
    if (!cursor) return
    try {
      const page = await listSources(api, { partyId: party.id, status: viewStatus(view), cursor, limit: 200 })
      setRead((current) => (current.status === 'ready' ? { status: 'ready', rows: [...current.rows, ...page.items.filter((row) => !current.rows.some((seen) => seen.id === row.id))], more: page.nextCursor !== null } : current))
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ tone: 'danger', words: say(readProblem(error)) })
    }
  }, [api, cursor, party.id, view])

  useLiveChanges(
    {
      onChange: (change) => {
        if (!change.type.startsWith('supplier_item.') || change.fields.partyId !== party.id) return
        const subject = typeof change.fields.supplierItemId === 'string' ? change.fields.supplierItemId : null
        if (subject && own.current.has(subject)) return
        setUpdates((count) => count + 1)
      },
      onReconnect: () => void load(),
    },
    can.view,
  )

  /** Remembers a row this page wrote, so its own live echo is not counted as someone else's change. */
  const wrote = (id: string) => {
    own.current.add(id)
    setTimeout(() => own.current.delete(id), 15_000)
  }
  const replaceRow = (row: Source) =>
    setRead((current) => (current.status === 'ready' ? { ...current, rows: current.rows.some((seen) => seen.id === row.id) ? current.rows.map((seen) => (seen.id === row.id ? row : seen)) : [...current.rows, row] } : current))
  const mark = (key: string, value: CellMark | null) =>
    setCells((current) => {
      const next = { ...current }
      if (value) next[key] = value
      else delete next[key]
      return next
    })

  const onCell = async (row: Source, field: CellField, typed: string) => {
    const key = cellKey(row.id, field)
    const change = cellChange(row, field, typed)
    if ('nothing' in change) return
    if ('problem' in change) {
      mark(key, { state: 'refused', words: change.problem })
      return
    }
    mark(key, { state: 'saving' })
    wrote(row.id)
    try {
      const answer = await updateSource(api, row.id, row.version, change.fields)
      replaceRow(answer.item)
      mark(key, { state: 'saved' })
      setTimeout(() => setCells((current) => (current[key]?.state === 'saved' ? (({ [key]: _gone, ...rest }) => rest)(current) : current)), SAVED_SHOWN_MS)
      if (answer.demoted) {
        setNotice({ tone: 'info', words: say('notice.demoted', { supplier: answer.demoted.supplierName, material: answer.item.item.code }) })
        // The demoted source may be one of this supplier's own (another scope): read it again.
        if (answer.demoted.partyId === party.id) {
          wrote(answer.demoted.id)
          getSource(api, answer.demoted.id)
            .then(replaceRow)
            .catch(() => undefined)
        }
      }
    } catch (error) {
      const refusal = cellRefusal(error, field)
      mark(key, { state: 'refused', words: refusal.words })
      if (refusal.reload) {
        setNotice({ tone: 'warning', words: say('notice.changed', { material: row.item.code }) })
        getSource(api, row.id)
          .then(replaceRow)
          .catch(() => void load())
      }
    }
  }

  // ---- Add a source -----------------------------------------------------------------------------------------------------
  const setDraft = (draft: AddDraft) => setDialog((current) => (current?.kind === 'add' ? { kind: 'add', draft } : current))
  const patchDraft = (patch: Partial<AddDraft>, when?: (draft: AddDraft) => boolean) =>
    setDialog((current) => (current?.kind === 'add' && (!when || when(current.draft)) ? { kind: 'add', draft: { ...current.draft, ...patch } } : current))
  const searchMaterials = (text: string) => {
    patchDraft({ materialQuery: text, materials: null, materialsProblem: null })
    findMaterials(api, text)
      .then((materials) => patchDraft({ materials }, (draft) => draft.materialQuery === text))
      .catch((error: unknown) => patchDraft({ materials: [], materialsProblem: readProblem(error) }, (draft) => draft.materialQuery === text))
  }
  const pickMaterial = (id: string | null) => {
    if (!id) {
      patchDraft({ material: null, materialProblem: null, itemColourId: '', purchaseUom: '' })
      return
    }
    getMaterial(api, id)
      .then((material) => patchDraft({ material, materialProblem: null, itemColourId: '', purchaseUom: '' }))
      .catch((error: unknown) => patchDraft({ materialProblem: readProblem(error) }))
  }
  const add = async () => {
    if (dialog?.kind !== 'add' || !dialog.draft.material || dialog.draft.busy) return
    const draft = dialog.draft
    patchDraft({ busy: true, problem: null })
    addKey.current ??= newIdempotencyKey()
    try {
      const answer = await createSource(api, addBody(draft, party.id, session.company?.id ?? null), addKey.current)
      wrote(answer.item.id)
      addKey.current = null
      setDialog(null)
      if (view !== 'archived') replaceRow(answer.item)
      setNotice({
        tone: 'success',
        words: answer.demoted ? say('notice.addedDemoted', { material: answer.item.item.code, supplier: answer.demoted.supplierName }) : say('notice.added', { material: answer.item.item.code }),
      })
    } catch (error) {
      patchDraft({ busy: false, problem: addRefusal(error, draft.scope) })
    }
  }

  // ---- Archive N / Restore N ------------------------------------------------------------------------------------------------
  const runBulk = async (verb: 'archive' | 'restore') => {
    if (dialog?.kind !== verb || dialog.busy || read.status !== 'ready') return
    const reason = dialog.kind === 'archive' ? dialog.reason : ''
    setDialog({ ...dialog, busy: true })
    const outcome: BulkOutcome = { verb, done: 0, refused: [] }
    for (const id of dialog.ids) {
      const row = read.rows.find((entry) => entry.id === id)
      if (!row) continue
      wrote(row.id)
      try {
        verb === 'archive' ? await archiveSource(api, row.id, row.version, reason, newIdempotencyKey()) : await restoreSource(api, row.id, row.version, newIdempotencyKey())
        outcome.done++
      } catch (error) {
        outcome.refused.push({ label: `${row.item.code} · ${row.colour?.code ?? t('everyColour')}`, words: bulkRefusal(error, verb) })
      }
    }
    setDialog(null)
    setSelected([])
    setBulk(outcome)
    void load()
  }

  const exportRows = (ids: string[]) => {
    if (read.status !== 'ready') return
    const picked = read.rows.filter((row) => ids.includes(row.id))
    downloadText(`approved-sources-${party.code}-${new Date().toISOString().slice(0, 10)}.csv`, sourcesCsv(picked, can.cost, (key, params) => t(key, params)))
  }

  const company = session.company ? { id: session.company.id, code: session.company.code } : null
  const model: ApprovedSourcesModel = {
    prefix,
    can,
    supplier: { id: party.id, name: partyName(party), companyId: party.companyId, currency: party.currency, status: party.status },
    company,
    view,
    q,
    read,
    cells,
    selected,
    dialog,
    notice,
    bulk,
    updates,
    live: 'live',
  }

  return (
    <ApprovedSourcesView
      model={model}
      actions={{
        onView: setView,
        onSearch: setQ,
        onRetry: () => {
          setRead({ status: 'loading' })
          void load()
        },
        onShowUpdates: () => void load(),
        onMore: () => void more(),
        onSelect: setSelected,
        onCell: (row, field, typed) => void onCell(row, field, typed),
        onDialog: (next) => {
          if (next?.kind === 'add') {
            addKey.current = null
            setDialog(next)
            if (can.materials) searchMaterials('')
            return
          }
          setDialog(next)
        },
        onDismissNotice: () => {
          setNotice(null)
          setBulk(null)
        },
        onExport: exportRows,
        add: { onChange: setDraft, onMaterialQuery: searchMaterials, onMaterial: pickMaterial, onAdd: () => void add() },
        onArchive: () => void runBulk('archive'),
        onRestore: () => void runBulk('restore'),
      }}
    />
  )
}
