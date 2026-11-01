'use client'

import { useMemo, useState } from 'react'
import { Archive, MoreHorizontal, Plus, RotateCcw } from 'lucide-react'
import { Banner, EmptyState, Field, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { useT } from '../../../../../lib/i18n/provider'
import { refusedField } from '../../../library/model'
import type { MaterialColour, MaterialView } from '../../api'
import { STATUS_TONE } from '../../model'
import type { MaterialRecordActions, MaterialRecordViewModel } from '../record-model'

const COLOUR_CODE = /^[A-Z0-9](?:[A-Z0-9._/-]{0,38}[A-Z0-9])?$/

/**
 * SCR-048 Colours: the material in each colour, as purchase orders need it (PRD-032) — our code, name, the library
 * colour it matches (with its swatch), the supplier's colour code, its state. On the shared list frame: Archive N /
 * Restore N for the selected colours (a colour is never deleted once used), each row's ⋯ edits or archives it, and New
 * colour (`n`) adds one. Archived colours stay listed, marked.
 */
export function ColoursTab({ material, model, actions }: { material: MaterialView; model: MaterialRecordViewModel; actions?: MaterialRecordActions }) {
  const t = useT('library')
  const [selected, setSelected] = useState<readonly string[]>([])
  const manage = model.can.materialsManage && material.status === 'ACTIVE'
  const library = useMemo(() => new Map((model.libraryColours ?? []).map((colour) => [colour.id, colour])), [model.libraryColours])
  const rows = useMemo(() => [...material.colours].sort((a, b) => (a.status === b.status ? a.code.localeCompare(b.code) : a.status === 'ACTIVE' ? -1 : 1)), [material.colours])
  const picked = rows.filter((row) => selected.includes(row.id))

  const columns = useMemo<ColDef<MaterialColour>[]>(() => {
    const CodeCell = ({ data }: ICellRendererParams<MaterialColour>) =>
      data ? (
        <span className="fw-lib-cell">
          <b>{data.code}</b>
          <span className="fw-lib-sub">{data.name}</span>
        </span>
      ) : null
    const LibraryCell = ({ data }: ICellRendererParams<MaterialColour>) => {
      if (!data) return null
      const colour = data.colourId ? library.get(data.colourId) : null
      if (!data.colourId) return <span className="fw-lib-hint">—</span>
      return (
        <span className="fw-lib-inline">
          {/* The swatch's colour is the library's own hex (inline): the DS has no Swatch part yet. */}
          <span className="fw-lib-swatch" style={colour?.hex ? { background: colour.hex } : undefined} aria-hidden />
          {colour ? `${colour.code} · ${colour.name}` : t('material.colours.libraryUnknown')}
        </span>
      )
    }
    const StatusCell = ({ data }: ICellRendererParams<MaterialColour>) => (data ? <Pill tone={STATUS_TONE[data.status]}>{t(`status.${data.status}`)}</Pill> : null)
    const MoreCell = ({ data }: ICellRendererParams<MaterialColour>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { code: data.code }) }}
          items={[
            { id: 'edit', label: t('material.colours.edit'), disabled: !manage, description: manage ? undefined : t('held.noManage'), onSelect: () => actions?.onDialog?.({ kind: 'colour', colourId: data.id }) },
            data.status === 'ACTIVE'
              ? { id: 'archive', label: t('material.colours.archive'), tone: 'danger', disabled: !manage, description: manage ? undefined : t('held.noManage'), onSelect: () => void actions?.onUpdateColour?.(data, { status: 'ARCHIVED' }) }
              : { id: 'restore', label: t('material.colours.restore'), disabled: !manage, description: manage ? undefined : t('held.noManage'), onSelect: () => void actions?.onUpdateColour?.(data, { status: 'ACTIVE' }) },
          ]}
        />
      ) : null
    return [
      { colId: 'code', headerName: t('material.colours.col.colour'), field: 'code', minWidth: 180, flex: 1.5, cellRenderer: CodeCell },
      { colId: 'library', headerName: t('material.colours.col.library'), field: 'colourId', cellDataType: false, minWidth: 180, flex: 1.5, cellRenderer: LibraryCell },
      { colId: 'supplier', headerName: t('material.colours.col.supplierCode'), field: 'supplierColourCode', minWidth: 150, flex: 1, valueFormatter: (params) => (params.value as string | null) ?? '—' },
      { colId: 'status', headerName: t('material.colours.col.status'), field: 'status', minWidth: 110, maxWidth: 140, cellRenderer: StatusCell },
      { colId: 'more', headerName: t('list.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, library, manage, actions])

  const archiveHeld = !manage ? t('held.noManage') : picked.some((row) => row.status === 'ARCHIVED') ? t('material.colours.held.archived') : model.busy ? t('held.busy') : null
  const restoreHeld = !manage ? t('held.noManage') : picked.some((row) => row.status === 'ACTIVE') ? t('material.colours.held.active') : model.busy ? t('held.busy') : null
  const done = () => setSelected([])

  return (
    <div className="fw-lib-stack">
      <p className="fw-lib-hint">{t('material.colours.intro')}</p>
      <ListFrame<MaterialColour>
        label={t('material.tab.colours')}
        rows={rows.length === 0 ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={t('material.colours.count', { count: rows.filter((row) => row.status === 'ACTIVE').length })}
        right={
          <Button size="sm" heldReason={manage ? null : material.status !== 'ACTIVE' ? t('material.held.archived') : t('held.noManage')} onClick={() => actions?.onDialog?.({ kind: 'colour', colourId: null })}>
            <Plus size={13} aria-hidden /> {t('material.action.newColour')}
          </Button>
        }
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <>
              <Button size="sm" variant="danger-outline" aria-label={t('material.colours.archiveN', { count: picked.length })} heldReason={archiveHeld} onClick={() => void actions?.onColoursStatus?.(picked.map((row) => row.id), 'ARCHIVED').then(done)}>
                <Archive size={13} aria-hidden /> <SelectionLabel>{t('material.colours.archiveN', { count: picked.length })}</SelectionLabel>
              </Button>
              <Button size="sm" aria-label={t('material.colours.restoreN', { count: picked.length })} heldReason={restoreHeld} onClick={() => void actions?.onColoursStatus?.(picked.map((row) => row.id), 'ACTIVE').then(done)}>
                <RotateCcw size={13} aria-hidden /> <SelectionLabel>{t('material.colours.restoreN', { count: picked.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        keys={[{ keys: ['n'], does: t('keys.newColour') }]}
        onOpen={(row) => manage && actions?.onDialog?.({ kind: 'colour', colourId: row.id })}
        state={rows.length === 0 ? <EmptyState title={t('material.colours.empty.title')} description={t('material.colours.empty.body')} /> : undefined}
      />
    </div>
  )
}

/** Add a colour or change one: our code (fixed once the colour exists), name, the library colour, the supplier's code. */
export function ColourDialog({ material, colourId, model, actions }: { material: MaterialView; colourId: string | null; model: MaterialRecordViewModel; actions?: MaterialRecordActions }) {
  const t = useT('library')
  const colour = colourId ? (material.colours.find((entry) => entry.id === colourId) ?? null) : null
  const [code, setCode] = useState(colour?.code ?? '')
  const [name, setName] = useState(colour?.name ?? '')
  const [supplierCode, setSupplierCode] = useState(colour?.supplierColourCode ?? '')
  const [libraryId, setLibraryId] = useState(colour?.colourId ?? '')
  const close = () => actions?.onDialog?.(null)
  const taken = !colour && material.colours.some((entry) => entry.code === code.trim().toUpperCase())
  const held = !colour && !COLOUR_CODE.test(code.trim().toUpperCase()) ? t('material.colours.held.code') : taken ? t('material.colours.held.taken') : name.trim() === '' ? t('material.colours.held.name') : model.busy ? t('held.busy') : null
  const refused = (field: string) => (model.refused && refusedField(model.refused.paths, field) ? t('newMaterial.refused') : undefined)
  const go = () => {
    if (held) return
    const input = { code: code.trim().toUpperCase(), name: name.trim(), supplierColourCode: supplierCode.trim() || null, colourId: libraryId || null }
    const run = colour ? actions?.onUpdateColour?.(colour, { name: input.name, supplierColourCode: input.supplierColourCode, colourId: input.colourId }) : actions?.onAddColour?.(input)
    void run?.then((done) => done && close())
  }
  return (
    <Modal
      open
      onClose={close}
      title={colour ? t('material.colours.editTitle', { code: colour.code }) : t('material.colours.addTitle', { code: material.code })}
      size="md"
      footer={
        <>
          <Button onClick={close}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={go} aria-keyshortcuts="Meta+Enter Control+Enter">
            {colour ? t('material.colours.save') : t('material.colours.add')}
          </Button>
        </>
      }
    >
      <div
        className="fw-lib-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            go()
          }
        }}
      >
        <div className="fw-lib-form-grid">
          <Field label={t('material.colours.code')} required hint={colour ? t('material.colours.codeFixed') : t('material.codeHint')} error={refused('code')}>
            <Input value={code} maxLength={40} autoFocus={!colour} disabled={!!colour} onChange={(event) => setCode(event.target.value.toUpperCase())} />
          </Field>
          <Field label={t('material.colours.name')} required error={refused('name')}>
            <Input value={name} maxLength={120} autoFocus={!!colour} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label={t('material.colours.supplierCode')} hint={t('material.colours.supplierCodeHint')} error={refused('supplierColourCode')}>
            <Input value={supplierCode} maxLength={64} onChange={(event) => setSupplierCode(event.target.value)} />
          </Field>
          <Field label={t('material.colours.library')} hint={t('material.colours.libraryHint')} error={refused('colourId')}>
            <Select value={libraryId} onChange={(event) => setLibraryId(event.target.value)}>
              <option value="">{t('material.colours.noLibrary')}</option>
              {(model.libraryColours ?? [])
                .filter((entry) => entry.status === 'ACTIVE' || entry.id === libraryId)
                .map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.code} · {entry.name}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        {model.libraryColours === null && model.can.styles && <p className="fw-lib-hint">{t('material.colours.libraryLoading')}</p>}
        {model.notice?.tone === 'danger' && <Banner tone="danger" title={t(model.notice.key, model.notice.params)} />}
      </div>
    </Modal>
  )
}

