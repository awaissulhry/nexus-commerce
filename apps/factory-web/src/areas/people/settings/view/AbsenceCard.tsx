'use client'

import { useId, useMemo, useState } from 'react'
import { Archive, MoreHorizontal, Plus, RotateCcw } from 'lucide-react'
import { Banner, Card, EmptyState, Field, Menu } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Toggle } from '@nexus/ui/primitives'
import { Modal, useDsWords } from '../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { AbsenceCategory, AbsenceCode } from '../api'
import { ABSENCE_CATEGORIES, codeHeld, SENSITIVE_CATEGORIES, type CodeDraft } from '../model'
import { CardHead, SectionState, useSaid, useSettingsWords, type Section, type SettingsModel, type SettingsProblem } from './SettingsView'

export interface AbsenceState {
  read: Section<{ codes: AbsenceCode[]; standardMissing: string[] }>
  showArchived: boolean
  dialog: { draft: CodeDraft; busy: boolean; problem: SettingsProblem | null } | null
  busy: boolean
  problem: SettingsProblem | null
}

export interface CodesActions {
  onNew?: () => void
  onEdit?: (row: AbsenceCode) => void
  onDraft?: (patch: Partial<CodeDraft>) => void
  onSave?: () => void
  onClose?: () => void
  onState?: (rows: readonly AbsenceCode[], to: 'archive' | 'restore') => void
  onStandard?: () => void
  onShowArchived?: (next: boolean) => void
}

/** Absence codes (MES-228): on the shared list frame; a row opens the Absence code dialog; archived codes stay readable on their days. */
export function AbsenceCard({ model, actions, onRetry }: { model: SettingsModel; actions?: CodesActions; onRetry?: () => void }) {
  const t = useSettingsWords()
  const say = useSaid()
  const { read, showArchived, busy, problem } = model.absence
  const manage = model.can.manageAttendance
  const held = manage ? null : t('held.noAttendance')
  const [selected, setSelected] = useState<string[]>([])
  const value = read.status === 'ready' ? read.value : null
  const rows = useMemo(() => (value?.codes ?? []).filter((row) => showArchived || row.status === 'ACTIVE'), [value, showArchived])
  const picked = rows.filter((row) => selected.includes(row.id))
  const columns = useMemo<ColDef<AbsenceCode>[]>(
    () => [
      { colId: 'code', headerName: t('code.code'), minWidth: 90, width: 100, valueGetter: (params) => params.data?.code ?? '' },
      { colId: 'nameIt', headerName: t('code.nameIt'), minWidth: 170, flex: 1, valueGetter: (params) => params.data?.labelI18n.it ?? '' },
      { colId: 'nameEn', headerName: t('code.nameEn'), minWidth: 170, flex: 1, valueGetter: (params) => params.data?.labelI18n.en ?? '' },
      { colId: 'category', headerName: t('code.category'), minWidth: 150, valueGetter: (params) => (params.data ? t(`category.${params.data.category}`) : '') },
      { colId: 'paid', headerName: t('code.paid'), minWidth: 110, width: 120, valueGetter: (params) => (params.data ? t(params.data.paid ? 'code.isPaid' : 'code.isUnpaid') : '') },
      { colId: 'lul', headerName: t('code.lul'), minWidth: 120, width: 130, valueGetter: (params) => params.data?.lulCode ?? '' },
      { colId: 'document', headerName: t('code.document'), minWidth: 130, valueGetter: (params) => (params.data ? t(params.data.documentRequired ? 'code.documentYes' : 'code.documentNo') : '') },
      { colId: 'reach', headerName: t('code.reach'), minWidth: 120, valueGetter: (params) => (params.data ? t(params.data.companyId === null ? 'code.reachGroup' : 'code.reachCompany') : '') },
      { colId: 'inUse', headerName: t('code.inUse'), minWidth: 100, width: 110, valueGetter: (params) => params.data?.inUse ?? 0 },
      {
        colId: 'status',
        headerName: t('code.status'),
        minWidth: 110,
        width: 120,
        valueGetter: (params) => (params.data ? t(`code.state.${params.data.status}`) : ''),
        cellRenderer: (params: ICellRendererParams<AbsenceCode>) => (params.data ? <Pill tone={params.data.status === 'ACTIVE' ? 'success' : 'neutral'}>{t(`code.state.${params.data.status}`)}</Pill> : null),
      },
      {
        colId: 'actions',
        headerName: '',
        width: 56,
        pinned: 'right',
        sortable: false,
        cellRenderer: (params: ICellRendererParams<AbsenceCode>) => {
          const row = params.data
          if (!row) return null
          return (
            <Menu
              label={<MoreHorizontal size={16} aria-hidden />}
              align="right"
              triggerProps={{ 'aria-label': t('code.rowMenu', { code: row.code }) }}
              items={[
                { id: 'edit', label: t('code.edit'), disabled: Boolean(held), description: held ?? undefined, onSelect: () => actions?.onEdit?.(row) },
                row.status === 'ACTIVE'
                  ? { id: 'archive', label: t('code.archive'), disabled: Boolean(held), description: held ?? undefined, onSelect: () => actions?.onState?.([row], 'archive') }
                  : { id: 'restore', label: t('code.restore'), disabled: Boolean(held), description: held ?? undefined, onSelect: () => actions?.onState?.([row], 'restore') },
              ]}
            />
          )
        },
      },
    ],
    [t, held, actions],
  )
  const missing = value?.standardMissing.length ?? 0
  return (
    <Card padded>
      <div className="fw-ps-stack">
        <CardHead
          title={t('code.title')}
          purpose={t('code.purpose')}
          side={
            <span className="fw-ps-row">
              {missing > 0 && (
                <Button size="sm" heldReason={held} disabled={busy} onClick={() => actions?.onStandard?.()}>
                  {t('code.standard', { count: missing })}
                </Button>
              )}
              <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onNew?.()}>
                <Plus size={14} aria-hidden /> {t('code.add')}
              </Button>
            </span>
          }
        />
        {problem && <Banner tone="danger" title={say(problem) ?? ''} />}
        <SectionState read={read} title={t('code.title')} onRetry={onRetry}>
          {() => (
            <ListFrame<AbsenceCode>
              label={t('code.title')}
              rows={rows}
              rowId={(row) => row.id}
              columns={columns}
              rowKind="text"
              count={t('code.count', { count: rows.length })}
              tools={
                <span className="fw-ps-row">
                  <Toggle size="sm" checked={showArchived} aria-label={t('code.showArchived')} onChange={(next) => actions?.onShowArchived?.(next)} />
                  <span>{t('code.showArchived')}</span>
                </span>
              }
              selection={{
                selected,
                onChange: setSelected,
                actions: (
                  <>
                    <Button size="sm" aria-label={t('code.archiveCount', { count: picked.length })} heldReason={held ?? (picked.every((row) => row.status === 'ARCHIVED') ? t('held.allArchived') : null)} onClick={() => actions?.onState?.(picked.filter((row) => row.status === 'ACTIVE'), 'archive')}>
                      <Archive size={13} aria-hidden /> <SelectionLabel>{t('code.archiveCount', { count: picked.length })}</SelectionLabel>
                    </Button>
                    {showArchived && (
                      <Button size="sm" aria-label={t('code.restoreCount', { count: picked.length })} heldReason={held ?? (picked.every((row) => row.status === 'ACTIVE') ? t('held.noneArchived') : null)} onClick={() => actions?.onState?.(picked.filter((row) => row.status === 'ARCHIVED'), 'restore')}>
                        <RotateCcw size={13} aria-hidden /> <SelectionLabel>{t('code.restoreCount', { count: picked.length })}</SelectionLabel>
                      </Button>
                    )}
                  </>
                ),
              }}
              onOpen={(row) => (held ? undefined : actions?.onEdit?.(row))}
              state={
                rows.length === 0 ? (
                  <EmptyState
                    title={t('code.empty')}
                    action={
                      <Button size="sm" heldReason={held} onClick={() => actions?.onStandard?.()}>
                        {t('code.standardAll')}
                      </Button>
                    }
                  />
                ) : null
              }
              cards={{ fields: { code: { role: 'title' } } }}
            />
          )}
        </SectionState>
        <p className="fw-ps-hint">{t('code.foot')}</p>
      </div>
    </Card>
  )
}

/** The Absence code dialog (pop:code): explicit save; a sensitive category keeps a certificate's number, never what it says. */
export function CodeDialog({ model, actions }: { model: SettingsModel; actions?: CodesActions }) {
  const t = useSettingsWords()
  const say = useSaid()
  const ds = useDsWords()
  const id = useId()
  const dialog = model.absence.dialog
  if (!dialog) return null
  const { draft, busy, problem } = dialog
  const set = (patch: Partial<CodeDraft>) => actions?.onDraft?.(patch)
  const held = codeHeld(draft)
  const creating = draft.id === null
  const sensitive = SENSITIVE_CATEGORIES.has(draft.category)
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={creating ? t('code.titleNew') : t('code.titleEdit', { code: draft.code })}
      size="md"
      footer={
        <>
          <Button variant="quiet" onClick={() => actions?.onClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={busy} heldReason={held ? t(held) : null} onClick={() => actions?.onSave?.()}>
            {t('code.save')}
          </Button>
        </>
      }
    >
      <div className="fw-ps-stack">
        {problem && <Banner tone="danger" title={say(problem) ?? ''} />}
        <div className="fw-ps-fields">
          <Field label={t('code.code')} required={creating} htmlFor={`${id}-code`} hint={creating ? t('code.codeHint') : t('code.codeFixed')}>
            <Input id={`${id}-code`} value={draft.code} disabled={!creating} maxLength={8} onChange={(event) => set({ code: event.target.value.toUpperCase() })} />
          </Field>
          <Field label={t('code.category')} required htmlFor={`${id}-category`}>
            <Select id={`${id}-category`} value={draft.category} onChange={(event) => set({ category: event.target.value as AbsenceCategory })}>
              {ABSENCE_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {t(`category.${category}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('code.nameIt')} required htmlFor={`${id}-it`}>
            <Input id={`${id}-it`} value={draft.nameIt} maxLength={80} onChange={(event) => set({ nameIt: event.target.value })} />
          </Field>
          <Field label={t('code.nameEn')} htmlFor={`${id}-en`}>
            <Input id={`${id}-en`} value={draft.nameEn} maxLength={80} onChange={(event) => set({ nameEn: event.target.value })} />
          </Field>
          <Field label={t('code.lul')} htmlFor={`${id}-lul`} hint={t('code.lulHint')}>
            <Input id={`${id}-lul`} value={draft.lulCode} maxLength={16} onChange={(event) => set({ lulCode: event.target.value })} />
          </Field>
          <Field label={t('code.paid')}>
            <Toggle checked={draft.paid} aria-label={t('code.paid')} onChange={(next) => set({ paid: next })} />
          </Field>
          <Field label={t('code.document')} hint={t('code.documentHint')}>
            <Toggle checked={draft.documentRequired} aria-label={t('code.document')} onChange={(next) => set({ documentRequired: next })} />
          </Field>
          {creating && (
            <Field label={t('code.reachGroup')} hint={t('code.reachHint')}>
              <Toggle checked={draft.group} aria-label={t('code.reachGroup')} onChange={(next) => set({ group: next })} />
            </Field>
          )}
        </div>
        {sensitive && (
          <p className="fw-ps-hint">
            {t('code.sensitive')} <LawRef law={t('code.law')} plain={t('code.lawPlain')} labels={ds.lawRef} />
          </p>
        )}
      </div>
    </Modal>
  )
}
