'use client'

import { useEffect, useMemo, type MouseEvent } from 'react'
import { FileCheck2, Power, PowerOff } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Checkbox, SegmentedControl, Select, Tag, Toggle } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import { WithMessages } from '../../../../../record-panels/i18n'
import { useKeysHelp, useLatest, useSelection } from '../../../kit/list'
import { BulkButton, FrameState, PageHead } from '../../../shared/view/parts'
import type { Rule } from '../api'
import { draftHeld, hiddenOff, newHeld, PARTY_ROLE_CHOICES, rowHeld, rowsOf, statusesOf, switchReach, type RequiredDraft, type RequiredModel } from '../model'
import '../../documents.css'
import '../required.css'

/**
 * SCR-014 › Required documents (B-W2b-177; design admin.documents/sec:required): the company's rules as one list frame
 * (Owner rule 2026-10-29: select-all, shift range, bulk Switch on / off; key hints only in the footer icon), Blocks and On
 * switched in place, New rule. Draws one view model; RequiredSection.tsx reads and writes.
 */

export interface RequiredActions {
  onView?: (view: 'numbers' | 'documents' | 'branding' | 'required') => void
  onCompany?: (companyId: string | null) => void
  onShowOff?: (show: boolean) => void
  onSelect?: (ids: string[]) => void
  onRetry?: () => void
  onDismissNotice?: () => void
  onLevel?: (rule: Rule, level: 'BLOCK' | 'WARN') => void
  onActive?: (rule: Rule, active: boolean) => void
  onSwitchMany?: (rules: readonly Rule[], active: boolean) => void
  onNew?: (open: boolean) => void
  onDraft?: (change: Partial<RequiredDraft>) => void
  onCreate?: () => void
}

export const REQUIRED_NAMESPACES = ['admin', 'records', 'admin-documents', 'admin-required', 'record-files'] as const

export function RequiredView({ model, actions }: { model: RequiredModel; actions?: RequiredActions }) {
  return (
    <WithMessages namespaces={REQUIRED_NAMESPACES}>
      <Required model={model} actions={actions} />
    </WithMessages>
  )
}

function useSectionKeys(model: RequiredModel, actions?: RequiredActions) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || model.dialog) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.closest('[role="dialog"]'))) return
      if (event.key === '1') actions?.onView?.('numbers')
      else if (event.key === '2') actions?.onView?.('documents')
      else if (event.key === '5') actions?.onView?.('branding')
      else if (event.key === 'c' && !newHeld(model)) actions?.onNew?.(true)
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model, actions])
}

/** A record type, status or document in words (the shared `record-files` words). */
function useCodeWords() {
  const t = useT('record-files')
  return useMemo(
    () => ({
      type: (code: string) => t(`recordType.${code}`),
      status: (code: string) => t(`status.${code}`),
      category: (code: string) => t(`category.${code}`),
      role: (code: string | null) => t(`role.${code ?? 'ANY'}`),
    }),
    [t],
  )
}

function Required({ model, actions }: { model: RequiredModel; actions?: RequiredActions }) {
  const t = useT('admin-required')
  const td = useT('admin-documents')
  const locale = useLocale()
  const words = useCodeWords()
  useSectionKeys(model, actions)
  const rows = useMemo(() => rowsOf(model), [model])
  const { selected, onChange } = useSelection(model.selected, actions?.onSelect, rows.map((rule) => rule.id))
  const latest = useLatest({ model, actions })
  const companyName = (id: string) => model.companies.find((company) => company.id === id)?.name ?? '—'
  const columns = useMemo<ColDef<Rule>[]>(() => {
    const stop = (event: MouseEvent) => event.stopPropagation()
    const switchCell = (field: 'level' | 'active') =>
      function SwitchCell({ data }: ICellRendererParams<Rule>) {
        if (!data) return null
        const { model: now, actions: act } = latest.current
        const held = rowHeld(now, data)
        const on = field === 'level' ? data.level === 'BLOCK' : data.active
        const word = field === 'level' ? t(on ? 'req.level.BLOCK' : 'req.level.WARN') : t(on ? 'req.on' : 'req.off')
        if (held === 'req.held.noRight') return <span>{word}</span>
        return (
          <span className="fw-req-switch" onClick={stop}>
            <Toggle
              size="sm"
              checked={on}
              aria-label={t(field === 'level' ? 'req.switch.level' : 'req.switch.active', { what: words.category(data.category), status: words.status(data.beforeStatus) })}
              aria-description={held ? t(held) : undefined}
              title={held ? t(held) : undefined}
              onChange={(next) => {
                if (held) return
                if (field === 'level') act?.onLevel?.(data, next ? 'BLOCK' : 'WARN')
                else act?.onActive?.(data, next)
              }}
            />
            <span>{word}</span>
          </span>
        )
      }
    return [
      { colId: 'recordType', headerName: t('req.col.recordType'), flex: 1.2, minWidth: 150, valueGetter: ({ data }) => (data ? words.type(data.recordType) : '') },
      { colId: 'category', headerName: t('req.col.category'), flex: 1.4, minWidth: 170, valueGetter: ({ data }) => (data ? words.category(data.category) : '') },
      { colId: 'beforeStatus', headerName: t('req.col.beforeStatus'), flex: 1, minWidth: 140, valueGetter: ({ data }) => (data ? words.status(data.beforeStatus) : '') },
      { colId: 'partyRole', headerName: t('req.col.partyRole'), flex: 1, minWidth: 140, valueGetter: ({ data }) => (data ? words.role(data.partyRole) : '') },
      { colId: 'level', headerName: t('req.col.level'), flex: 1, minWidth: 150, cellRenderer: switchCell('level') },
      { colId: 'active', headerName: t('req.col.active'), flex: 0.8, minWidth: 120, cellRenderer: switchCell('active') },
      ...(model.companyId === null ? [{ colId: 'company', headerName: td('docs.company.label'), flex: 1.2, minWidth: 150, valueGetter: ({ data }: { data?: Rule }) => (data ? companyName(data.companyId) : '') } satisfies ColDef<Rule>] : []),
      { colId: 'changed', headerName: t('req.col.changed'), flex: 0.8, minWidth: 120, valueGetter: ({ data }) => (data ? formatDate(data.updatedAt, { locale }) : '') },
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, td, words, locale, model.companyId, model.companies])
  const keys: ListKey[] = [
    { keys: ['1'], does: td('docs.keys.numbers') },
    { keys: ['2'], does: td('docs.keys.documents') },
    { keys: ['5'], does: td('docs.keys.branding') },
    { keys: ['6'], does: td('docs.keys.required') },
    { keys: ['c'], does: t('req.keys.new') },
  ]
  const { onHelp, help } = useKeysHelp(keys, true)
  const off = switchReach(model, rows, selected, false)
  const on = switchReach(model, rows, selected, true)
  const held = newHeld(model)
  const hidden = hiddenOff(model)
  const read = model.read
  const state = read.status === 'failed' ? (
    <FrameState problem={read.problem} onRetry={actions?.onRetry} />
  ) : read.status === 'ready' && rows.length === 0 ? (
    <FrameState
      empty={{
        icon: <FileCheck2 size={24} aria-hidden />,
        title: t('req.empty.title'),
        body: t(hidden > 0 ? 'req.empty.bodyOff' : 'req.empty.body', { count: hidden }),
        action: (
          <Button size="sm" variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onNew?.(true)}>
            {t('req.new')}
          </Button>
        ),
      }}
    />
  ) : undefined
  return (
    <div className="fw-adm fw-adm-docs fw-req">
      <PageHead
        intro={t('req.intro')}
        asOf={model.asOf}
        actions={
          <Button size="sm" variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onNew?.(true)}>
            {t('req.new')}
          </Button>
        }
      />
      {model.notice && <Banner tone={model.notice.tone} title={t(model.notice.key, model.notice.params)} onDismiss={actions?.onDismissNotice} />}
      <ListFrame<Rule>
        label={t('req.table.label')}
        rows={read.status === 'loading' ? null : read.status === 'failed' ? [] : rows}
        rowId={(rule) => rule.id}
        columns={columns}
        count={read.status === 'ready' ? t('req.count', { count: rows.length }) : '—'}
        tools={
          <>
            <SegmentedControl
              ariaLabel={td('docs.views.label')}
              size="sm"
              value="required"
              onChange={(value) => actions?.onView?.(value as 'numbers' | 'documents' | 'branding' | 'required')}
              options={[
                { value: 'numbers', label: td('docs.views.numbers') },
                { value: 'documents', label: td('docs.views.documents') },
                { value: 'branding', label: td('docs.views.branding') },
                { value: 'required', label: td('docs.views.required') },
              ]}
            />
            {model.companies.length > 1 && (
              <Select size="sm" aria-label={td('docs.company.label')} value={model.companyId ?? 'all'} onChange={(event) => actions?.onCompany?.(event.target.value === 'all' ? null : event.target.value)}>
                <option value="all">{td('docs.company.all')}</option>
                {model.companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </Select>
            )}
            <Checkbox label={t('req.showOff', { count: hidden })} checked={model.showOff} onChange={(event) => actions?.onShowOff?.(event.target.checked)} />
          </>
        }
        selection={{
          selected,
          onChange,
          actions: (
            <>
              <BulkButton icon={<PowerOff size={13} aria-hidden />} label={t('req.bulk.off', { count: off.applies.length })} held={off.held ? t(off.held) : null} onClick={() => actions?.onSwitchMany?.(off.applies, false)} />
              <BulkButton icon={<Power size={13} aria-hidden />} label={t('req.bulk.on', { count: on.applies.length })} held={on.held ? t(on.held) : null} onClick={() => actions?.onSwitchMany?.(on.applies, true)} />
            </>
          ),
        }}
        keys={keys}
        onHelp={onHelp}
        state={state}
      />
      <p className="fw-adm-hint">{t('req.feeds')}</p>
      <NewRuleDialog model={model} actions={actions} />
      {help}
    </div>
  )
}

function NewRuleDialog({ model, actions }: { model: RequiredModel; actions?: RequiredActions }) {
  const t = useT('admin-required')
  const words = useCodeWords()
  const dialog = model.dialog
  if (!dialog) return null
  const answer = model.read.status === 'ready' ? model.read.answer : null
  const held = dialog.busy ? 'req.held.saving' : draftHeld(model, dialog.draft)
  const company = model.companies.find((item) => item.id === model.companyId)?.name ?? ''
  return (
    <Modal
      open
      onClose={() => actions?.onNew?.(false)}
      title={t('req.dialog.title')}
      subtitle={company}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onNew?.(false)}>{t('req.dialog.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onCreate?.()}>
            {t('req.dialog.add')}
          </Button>
        </>
      }
    >
      <div className="fw-req-form">
        <p className="fw-adm-hint">{t('req.dialog.intro')}</p>
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
        <Field label={t('req.col.recordType')}>
          <Select value={dialog.draft.recordType} onChange={(event) => actions?.onDraft?.({ recordType: event.target.value })}>
            {(answer?.recordTypes ?? []).map((type) => (
              <option key={type.recordType} value={type.recordType}>
                {words.type(type.recordType)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('req.col.beforeStatus')} hint={t('req.dialog.statusHint')}>
          <Select value={dialog.draft.beforeStatus} onChange={(event) => actions?.onDraft?.({ beforeStatus: event.target.value })}>
            {statusesOf(answer, dialog.draft.recordType).map((status) => (
              <option key={status} value={status}>
                {words.status(status)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('req.col.category')}>
          <Select value={dialog.draft.category} onChange={(event) => actions?.onDraft?.({ category: event.target.value })}>
            {(answer?.categories ?? []).map((category) => (
              <option key={category} value={category}>
                {words.category(category)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('req.col.partyRole')} hint={t('req.dialog.roleHint')}>
          <Select value={dialog.draft.partyRole} onChange={(event) => actions?.onDraft?.({ partyRole: event.target.value })}>
            {PARTY_ROLE_CHOICES.map((role) => (
              <option key={role || 'any'} value={role}>
                {words.role(role || null)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('req.col.level')} hint={t(dialog.draft.level === 'BLOCK' ? 'req.dialog.blockHint' : 'req.dialog.warnHint')}>
          <SegmentedControl
            ariaLabel={t('req.col.level')}
            size="sm"
            value={dialog.draft.level}
            onChange={(value) => actions?.onDraft?.({ level: value as 'BLOCK' | 'WARN' })}
            options={[
              { value: 'BLOCK', label: t('req.level.BLOCK') },
              { value: 'WARN', label: t('req.level.WARN') },
            ]}
          />
        </Field>
        <p className="fw-adm-hint">
          <Tag tone={dialog.draft.level === 'BLOCK' ? 'danger' : 'warning'}>{t(`req.level.${dialog.draft.level}`)}</Tag>{' '}
          {t('req.dialog.sentence', { what: words.category(dialog.draft.category), type: words.type(dialog.draft.recordType), status: words.status(dialog.draft.beforeStatus), role: words.role(dialog.draft.partyRole || null) })}
        </p>
      </div>
    </Modal>
  )
}
