'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../lib/api/client'
import { createOperator, editOperator, readMarkets, readOperators, searchParties, searchStyles, type OperatorsAnswer, type PartyChoice, type StyleChoice } from './api'
import { emptyOperator, operatorBodyOf, operatorCellProblem, valueOf, type Read } from './model'
import { each, useMarks, useRead, writingOf, type TabContext } from './use-settings'
import { IDLE, type OperatorPickers, type OperatorsActions, type OperatorsState, type OperatorWindowState } from './view-model'

const NO_PICKERS: OperatorPickers = Object.freeze({ styleQ: '', styles: null, brands: null, partyQ: '', parties: null })

/**
 * Operators (rm-operators): the rows with their role and market filters from the address, the printed words autosaved per cell,
 * End N today, New operator (styles, brands and parties found as typed), the row's window (`?open=<id>`).
 */
export function useOperators(context: TabContext): { state: OperatorsState; actions: OperatorsActions } {
  const { api, active, can, address, go, notify, stamp, tick, today, companyId } = context
  const [operators, loadOperators, setOperators] = useRead<OperatorsAnswer>()
  const [markets, setMarkets] = useState<string[]>([])
  const [marks, setMark, saveCell] = useMarks()
  const [selected, setSelected] = useState<string[]>([])
  const [add, setAdd] = useState<OperatorsState['add']>(null)
  const [open, setOpen] = useState<OperatorWindowState | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { role, market } = address

  const read = useCallback((quiet = false) => (can.view ? loadOperators(() => readOperators(api, { role, marketCode: market }), quiet).then((value) => value && stamp()) : Promise.resolve()), [api, can.view, role, market, loadOperators, stamp])
  useEffect(() => {
    if (active) void read()
  }, [active, read])
  useEffect(() => {
    if (active && tick > 0) void read(true)
  }, [tick])
  useEffect(() => {
    if (!active || !can.view) return
    readMarkets(api, 'ACTIVE').then(
      (answer) => setMarkets(answer.markets.map((entry) => entry.code)),
      () => setMarkets([]),
    )
  }, [active, api, can.view])
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

  const rowOf = (id: string) => valueOf(operators)?.operators.find((row) => row.id === id) ?? null
  const replace = (next: OperatorsAnswer['operators'][number]) =>
    setOperators((current) => (current.status === 'ready' ? { status: 'ready', value: { ...current.value, operators: current.value.operators.map((row) => (row.id === next.id ? next : row)) } } : current))

  /** Finds parties (and styles) as typed, a moment after the last key. */
  const find = (kind: 'styles' | 'parties', q: string, set: (read: Read<StyleChoice[]> | Read<PartyChoice[]>) => void) => {
    if (timer.current) clearTimeout(timer.current)
    if (kind === 'styles' ? !can.stylesView : !can.partiesView) return
    timer.current = setTimeout(() => {
      set({ status: 'loading' })
      const work = kind === 'styles' ? searchStyles(api, q) : searchParties(api, q)
      ;(work as Promise<StyleChoice[] | PartyChoice[]>).then(
        (value) => set({ status: 'ready', value } as Read<StyleChoice[]>),
        () => set({ status: 'error', problem: 'problem.read' }),
      )
    }, 250)
  }
  const setAddPickers = (next: Partial<OperatorPickers>) => setAdd((current) => (current ? { ...current, pickers: { ...current.pickers, ...next } } : current))
  const setOpenPickers = (next: Partial<OperatorPickers>) => setOpen((current) => (current ? { ...current, pickers: { ...current.pickers, ...next } } : current))

  useEffect(() => {
    if (!active || !address.add || !can.rulesManage) return setAdd(null)
    if (add) return
    setAdd({ draft: emptyOperator(today), pickers: NO_PICKERS, writing: IDLE })
    if (can.partiesView) {
      searchParties(api, '', 'BRAND').then(
        (value) => setAddPickers({ brands: { status: 'ready', value } }),
        () => setAddPickers({ brands: { status: 'error', problem: 'problem.read' } }),
      )
      searchParties(api, '').then(
        (value) => setAddPickers({ parties: { status: 'ready', value } }),
        () => setAddPickers({ parties: { status: 'error', problem: 'problem.read' } }),
      )
    }
    if (can.stylesView) {
      searchStyles(api, '').then(
        (value) => setAddPickers({ styles: { status: 'ready', value } }),
        () => setAddPickers({ styles: { status: 'error', problem: 'problem.read' } }),
      )
    }
  }, [active, address.add, can.rulesManage])

  const answer = valueOf(operators)
  useEffect(() => {
    if (!active || !address.open) return setOpen(null)
    const row = answer?.operators.find((entry) => entry.id === address.open)
    if (!row) return
    setOpen((current) =>
      current && current.id === row.id
        ? current
        : { id: row.id, draft: { partyId: row.party?.id ?? null, printedName: row.printedName, printedAddress: row.printedAddress, contact: row.contact ?? '', validFrom: row.validFrom, validTo: row.validTo, note: row.note ?? '' }, pickers: NO_PICKERS, writing: IDLE },
    )
  }, [active, address.open, answer])

  return {
    state: { operators, markets, marks, selected, add, open },
    actions: {
      onCell: (id, field, value) => {
        const row = rowOf(id)
        if (!row) return
        const text = value.trim()
        if (text === (row[field] ?? '')) return
        const problem = operatorCellProblem(field, text)
        if (problem) return setMark(id, field, { state: 'refused', problem })
        void saveCell(id, field, async () => {
          const next = await editOperator(api, id, { version: row.version, [field]: field === 'contact' ? text || null : text }, newIdempotencyKey())
          replace(next)
          return next
        })
      },
      onSelected: setSelected,
      onEndMany: (ids) => {
        const rows = (answer?.operators ?? []).filter((row) => ids.includes(row.id))
        void each(rows, (row) => editOperator(api, row.id, { version: row.version, validTo: today }, newIdempotencyKey())).then((result) => {
          setSelected([])
          notify(result.refused.length > 0 ? { tone: 'warning', key: 'notice.endedPartly', params: { done: result.done, refused: result.refused.length } } : { tone: 'success', key: 'notice.ended', params: { count: result.done } })
          void read(true)
        })
      },
      onAddDraft: (draft) => setAdd((current) => (current ? { ...current, draft, writing: IDLE } : current)),
      onAddSave: () => {
        if (!add) return
        setAdd({ ...add, writing: { busy: true, problem: null } })
        createOperator(api, operatorBodyOf(add.draft, companyId), newIdempotencyKey()).then(
          () => {
            notify({ tone: 'success', key: 'notice.operatorAdded' })
            setAdd(null)
            void read(true)
            go({ add: false })
          },
          (error) => setAdd((current) => (current ? { ...current, writing: writingOf(error, 'overlap') } : current)),
        )
      },
      onStyleQ: (q) => {
        setAddPickers({ styleQ: q })
        find('styles', q, (read) => setAddPickers({ styles: read as Read<StyleChoice[]> }))
      },
      onPartyQ: (q) => {
        if (open) {
          setOpenPickers({ partyQ: q })
          find('parties', q, (read) => setOpenPickers({ parties: read as Read<PartyChoice[]> }))
        } else {
          setAddPickers({ partyQ: q })
          find('parties', q, (read) => setAddPickers({ parties: read as Read<PartyChoice[]> }))
        }
      },
      onWindowDraft: (draft) => setOpen((current) => (current ? { ...current, draft, writing: IDLE } : current)),
      onWindowSave: () => {
        if (!open) return
        const row = rowOf(open.id)
        if (!row) return
        const draft = open.draft
        const body = {
          version: row.version,
          ...(draft.partyId !== (row.party?.id ?? null) ? { partyId: draft.partyId } : {}),
          ...(draft.printedName !== row.printedName ? { printedName: draft.printedName.trim() } : {}),
          ...(draft.printedAddress !== row.printedAddress ? { printedAddress: draft.printedAddress.trim() } : {}),
          ...(draft.contact !== (row.contact ?? '') ? { contact: draft.contact.trim() || null } : {}),
          ...(draft.validFrom !== row.validFrom ? { validFrom: draft.validFrom } : {}),
          ...(draft.validTo !== row.validTo ? { validTo: draft.validTo } : {}),
          ...(draft.note !== (row.note ?? '') ? { note: draft.note.trim() || null } : {}),
        }
        setOpen({ ...open, writing: { busy: true, problem: null } })
        editOperator(api, open.id, body, newIdempotencyKey()).then(
          (next) => {
            replace(next)
            notify({ tone: 'success', key: 'notice.operatorSaved' })
            go({ open: null })
          },
          (error) => setOpen((current) => (current ? { ...current, writing: writingOf(error, 'overlap') } : current)),
        )
      },
      onRetry: () => void read(),
    },
  }
}
