'use client'

import { useMemo, useRef } from 'react'
import { Download, MoreHorizontal, Plus, Search } from 'lucide-react'
import { Banner, EmptyState, Field, Menu, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { CertCan } from '../../model'
import type { NotifiedBody } from '../../depth/api'
import { BODY_FIELDS, bodyDraftProblems, bodyFormHeld, bodyRows, nandoHref, numberFixed, type BodiesFilter, type BodiesModel, type BodyField } from '../../depth/model'
import { DepthMessages, NandoLink, PpeLaw, ScopeLine, useDepthT } from '../../depth/view/parts'
import type { BodiesActions } from '../use-bodies'

/**
 * SCR-291 Notified bodies (design compliance.certificates › pop:ce-nb, W2b; PRD-286): the directory in a pop-up over the
 * register (⋯ Notified bodies) or the record (Notified body tab) — name, 4-digit number, country, the clothing scope check
 * (a warning when the body is not listed for protective clothing), how many certificates name it, its NANDO entry (the
 * Commission's site, a new tab), status — on the ONE list frame (select-all, shift ranges, x, Export N while rows are
 * selected, the keys in the footer icon). Add notified body (primary) and a row's Edit open the form in the same pop-up;
 * a row's ⋯ archives or restores it. Esc closes and the focus returns to the opener. Fetches nothing.
 */
export function BodiesDialog(props: { model: BodiesModel; can: CertCan; actions?: BodiesActions }) {
  if (!props.model.open) return null
  return (
    <DepthMessages>
      <Directory {...props} />
    </DepthMessages>
  )
}

const FILTERS: readonly BodiesFilter[] = ['ACTIVE', 'ARCHIVED', 'ALL']

function Directory({ model, can, actions }: { model: BodiesModel; can: CertCan; actions?: BodiesActions }) {
  const d = useDepthT()
  const q = useT('quality')
  const mayManage = model.directory?.value?.mayManage ?? false
  const all = useMemo(() => model.directory?.value?.bodies ?? [], [model.directory?.value])
  const rows = useMemo(() => bodyRows(all, model.filter, model.q), [all, model.filter, model.q])
  const selected = rows.filter((row) => model.selected.includes(row.id))
  const manageHeld = !can.manage || !mayManage ? d('bodies.held.manage') : null
  const live = useRef({ actions, manageHeld })
  live.current = { actions, manageHeld }

  const columns = useMemo<ColDef<NotifiedBody>[]>(() => {
    const NumberCell = ({ data }: ICellRendererParams<NotifiedBody>) =>
      data ? (
        <span className="fw-q-cell">
          <span className="fw-q-num fw-q-code">{data.number}</span>
          <span className="fw-q-hint">{data.country}</span>
        </span>
      ) : null
    const NameCell = ({ data }: ICellRendererParams<NotifiedBody>) =>
      data ? (
        <span className="fw-q-cell">
          <span>{data.name}</span>
          <span className="fw-q-hint">{data.scopes[0] ?? d('bodies.noScopes')}</span>
        </span>
      ) : null
    const ScopeCell = ({ data }: ICellRendererParams<NotifiedBody>) => (data ? <ScopeLine check={data.clothing} short /> : null)
    const NandoCell = ({ data }: ICellRendererParams<NotifiedBody>) => (data ? <NandoLink href={nandoHref(data)} number={data.number} short /> : null)
    const StatusCell = ({ data }: ICellRendererParams<NotifiedBody>) => (data ? <Pill tone={data.status === 'ACTIVE' ? 'success' : 'neutral'} dot>{d(`bodies.status.${data.status}`)}</Pill> : null)
    const ActionsCell = ({ data }: ICellRendererParams<NotifiedBody>) => {
      if (!data) return null
      const held = live.current.manageHeld
      const items: MenuItemDef[] = [
        { id: 'edit', label: d('bodies.row.edit'), onSelect: () => live.current.actions?.onEdit?.(data), ...(held ? { disabled: true, description: held } : {}) },
        data.status === 'ACTIVE'
          ? { id: 'archive', label: d('bodies.row.archive'), onSelect: () => live.current.actions?.onArchive?.(data, 'ARCHIVED'), ...(held ? { disabled: true, description: held } : {}) }
          : { id: 'restore', label: d('bodies.row.restore'), onSelect: () => live.current.actions?.onArchive?.(data, 'ACTIVE'), ...(held ? { disabled: true, description: held } : {}) },
      ]
      if (data.nandoUrl) items.push({ id: 'nando', label: d('nando.open', { number: data.number }), href: nandoHref(data) ?? undefined, target: '_blank' })
      return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': d('bodies.row.menu', { number: data.number }) }} items={items} />
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<NotifiedBody>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number }): ColDef<NotifiedBody> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    return [
      column('number', d('bodies.col.number'), NumberCell, { flex: 0.7, minWidth: 120 }),
      column('name', d('bodies.col.name'), NameCell, { flex: 1.6, minWidth: 180 }),
      column('scope', d('bodies.col.scope'), ScopeCell, { flex: 1.1, minWidth: 180 }),
      { colId: 'certificates', headerName: d('bodies.col.certificates'), sortable: false, flex: 0.8, minWidth: 120, valueGetter: (params) => (params.data ? d('bodies.certificates', { count: params.data.certificates }) : '') },
      column('nando', d('bodies.col.nando'), NandoCell, { flex: 0.6, minWidth: 96 }),
      column('status', d('bodies.col.status'), StatusCell, { flex: 0.7, minWidth: 104 }),
      { ...column('actions', d('bodies.col.actions'), ActionsCell, { width: 72, minWidth: 72 }), suppressHeaderMenuButton: true },
    ]
  }, [d])

  const filtered = model.filter !== 'ACTIVE' || model.q.trim() !== ''
  const state = model.directory?.problem ? (
    <EmptyState title={d('bodies.failed')} description={q(model.directory.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{q('common.retry')}</Button>} />
  ) : model.directory?.value && rows.length === 0 ? (
    filtered && all.length > 0 ? (
      <EmptyState title={d('bodies.noMatch')} action={<Button size="sm" onClick={() => { actions?.onFilter?.('ACTIVE'); actions?.onQuery?.('') }}>{d('bodies.clear')}</Button>} />
    ) : (
      <EmptyState title={d('bodies.empty.title')} description={d('bodies.empty.body')} action={manageHeld ? undefined : <Button variant="primary" onClick={() => actions?.onNew?.()}>{d('bodies.add')}</Button>} />
    )
  ) : undefined

  if (model.form) return <BodyForm model={model} can={can} mayManage={mayManage} actions={actions} />

  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={d('bodies.title')}
      size="xxl"
      footer={
        <>
          <Button onClick={() => actions?.onClose?.()}>{d('common.close')}</Button>
          <Button variant="primary" heldReason={manageHeld} onClick={() => actions?.onNew?.()}>
            <Plus size={14} aria-hidden /> {d('bodies.add')}
          </Button>
        </>
      }
    >
      <div className="fw-cd-dialog">
        <p className="fw-q-hint">{d('bodies.intro')}</p>
        <span className="fw-cd-row">
          <PpeLaw point="art. 24–35, Annex II 1.4(j)" plainKey="law.bodies" />
        </span>
        {model.notice && (
          <Banner tone="success" title={d(model.notice.key, model.notice.params)} onDismiss={() => actions?.onDismissNotice?.()} />
        )}
        {model.problem && (
          <Banner tone="danger" title={d(model.problem)}>
            {model.lines.length > 0 && <p className="fw-q-hint fw-ce-data">{model.lines.join(' ')}</p>}
          </Banner>
        )}
        <ListFrame<NotifiedBody>
          label={d('bodies.title')}
          listKey={null}
          rows={model.directory?.problem ? [] : model.directory?.value ? rows : null}
          rowId={(row) => row.id}
          columns={columns}
          count={model.directory?.value ? d(filtered ? 'bodies.countOf' : 'bodies.count', { count: rows.length, total: all.length }) : '—'}
          search={<Input size="sm" type="search" leadingIcon={<Search size={14} aria-hidden />} aria-label={d('bodies.search')} placeholder={d('bodies.search')} value={model.q} onChange={(event) => actions?.onQuery?.(event.target.value)} />}
          tools={
            <Select size="sm" aria-label={d('bodies.filter')} value={model.filter} onChange={(event) => actions?.onFilter?.(event.target.value as BodiesFilter)}>
              {FILTERS.map((filter) => (
                <option key={filter} value={filter}>
                  {d(`bodies.filterValue.${filter}`)}
                </option>
              ))}
            </Select>
          }
          selection={{
            selected: model.selected,
            onChange: (ids) => actions?.onSelect?.(ids),
            actions: (
              <Button size="sm" onClick={() => actions?.onExport?.(selected)} aria-label={d('bodies.export', { count: selected.length })}>
                <Download size={13} aria-hidden /> <SelectionLabel>{d('bodies.export', { count: selected.length })}</SelectionLabel>
              </Button>
            ),
          }}
          onOpen={(row) => (manageHeld ? undefined : actions?.onEdit?.(row))}
          state={state}
        />
      </div>
    </Modal>
  )
}

function BodyForm({ model, can, mayManage, actions }: { model: BodiesModel; can: CertCan; mayManage: boolean; actions?: BodiesActions }) {
  const d = useDepthT()
  const form = model.form!
  const draft = form.draft
  const problems = bodyDraftProblems(draft)
  const held = bodyFormHeld(model, can, mayManage)
  const known = form.bodyId ? (model.directory?.value?.bodies.find((body) => body.id === form.bodyId) ?? null) : null
  const fixed = numberFixed(known)
  const error = (field: BodyField): string | undefined => (problems[field] && form.touched.includes(field) ? d(problems[field]!) : undefined)
  const leave = (field: BodyField) => () => actions?.onTouch?.(field)
  const save = () => {
    if (held) {
      for (const field of BODY_FIELDS) actions?.onTouch?.(field)
      return
    }
    actions?.onSave?.()
  }
  return (
    <Modal
      open
      onClose={() => actions?.onBack?.()}
      title={form.mode === 'new' ? d('bodyForm.titleNew') : d('bodyForm.titleEdit', { number: known?.number ?? draft.number })}
      size="lg"
      footer={
        <>
          <Button onClick={() => actions?.onBack?.()}>{d('bodyForm.back')}</Button>
          <Button variant="primary" heldReason={held ? d(held) : null} onClick={save} aria-keyshortcuts="Meta+Enter Control+Enter">
            {model.busy ? <Spinner size={12} /> : null} {d(form.mode === 'new' ? 'bodyForm.add' : 'bodyForm.save')}
          </Button>
        </>
      }
    >
      <div
        className="fw-cd-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            save()
          }
        }}
      >
        <p className="fw-q-hint">{d('bodyForm.intro')}</p>
        <div className="fw-cd-form">
          <Field label={d('bodyForm.number')} required hint={fixed ? d('bodyForm.numberFixed', { count: known!.linked }) : d('bodyForm.numberHint')} error={error('number')}>
            <Input autoFocus={form.mode === 'new'} value={draft.number} inputMode="numeric" maxLength={4} readOnly={fixed} aria-readonly={fixed ? 'true' : undefined} onChange={(event) => actions?.onDraft?.({ number: event.target.value.replace(/\D/g, '') })} onBlur={leave('number')} />
          </Field>
          <Field label={d('bodyForm.country')} required hint={d('bodyForm.countryHint')} error={error('country')}>
            <Input value={draft.country} maxLength={2} onChange={(event) => actions?.onDraft?.({ country: event.target.value.toUpperCase() })} onBlur={leave('country')} />
          </Field>
          <div className="fw-cd-wide">
            <Field label={d('bodyForm.name')} required error={error('name')}>
              <Input autoFocus={form.mode === 'edit'} value={draft.name} maxLength={300} onChange={(event) => actions?.onDraft?.({ name: event.target.value })} onBlur={leave('name')} />
            </Field>
          </div>
          <div className="fw-cd-wide">
            <Field label={d('bodyForm.address')} required error={error('address')}>
              <Textarea value={draft.address} maxLength={500} rows={2} onChange={(event) => actions?.onDraft?.({ address: event.target.value })} onBlur={leave('address')} />
            </Field>
          </div>
          <div className="fw-cd-wide">
            <Field label={d('bodyForm.nando')} hint={d('bodyForm.nandoHint')} error={error('nandoUrl')}>
              <Input value={draft.nandoUrl} type="url" maxLength={2000} placeholder="https://" onChange={(event) => actions?.onDraft?.({ nandoUrl: event.target.value })} onBlur={leave('nandoUrl')} />
            </Field>
          </div>
          <div className="fw-cd-wide">
            <Field label={d('bodyForm.scopes')} hint={d('bodyForm.scopesHint')} error={error('scopes')}>
              <Textarea value={draft.scopes} rows={3} onChange={(event) => actions?.onDraft?.({ scopes: event.target.value })} onBlur={leave('scopes')} />
            </Field>
          </div>
          <Field label={d('bodyForm.email')} error={error('contactEmail')}>
            <Input value={draft.contactEmail} type="email" maxLength={200} onChange={(event) => actions?.onDraft?.({ contactEmail: event.target.value })} onBlur={leave('contactEmail')} />
          </Field>
          <Field label={d('bodyForm.phone')} error={error('contactPhone')}>
            <Input value={draft.contactPhone} maxLength={40} onChange={(event) => actions?.onDraft?.({ contactPhone: event.target.value })} onBlur={leave('contactPhone')} />
          </Field>
          <div className="fw-cd-wide">
            <Field label={d('bodyForm.note')} error={error('note')}>
              <Textarea value={draft.note} maxLength={2000} rows={2} onChange={(event) => actions?.onDraft?.({ note: event.target.value })} onBlur={leave('note')} />
            </Field>
          </div>
        </div>
        {model.problem && (
          <Banner tone="danger" title={d(model.problem)}>
            {model.lines.length > 0 && <p className="fw-q-hint fw-ce-data">{model.lines.join(' ')}</p>}
          </Banner>
        )}
      </div>
    </Modal>
  )
}
