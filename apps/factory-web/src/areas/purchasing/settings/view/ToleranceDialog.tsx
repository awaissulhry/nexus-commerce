'use client'

import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, NumberStepper, RadioCard, SegmentedControl, Select, Skeleton } from '@nexus/ui/primitives'
import { Combobox, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import type { Tolerance } from '../api'
import { draftProblems, draftUpdateBody, ITEM_KINDS, MAX_NOTE, TOLERANCE_ACTIONS, type ItemKind, type MaterialMode, type ToleranceDraft } from '../model'
import type { PurchasingSettingsActions, PurchasingSettingsModel } from '../view-model'
import { NS } from './parts'
import { RuleWords, useScopeWords } from './ToleranceCard'

/**
 * The tolerance dialog (`?tolerance=<id>|new`): a NEW exception names its company (this one or every company), a supplier or
 * every supplier, and a material, a kind of material or every material — at least a supplier or a material (the default is
 * kept on the card) —, then over and under in percent, what happens beyond, a note. An existing rule's scope never changes
 * (archive it and add another): its figures, beyond and note change; Archive / Reactivate. A rule the person may not keep,
 * or an archived one, is shown as text. ⌘↵ saves; problems at their fields after the first Save.
 */
export function ToleranceDialog({ model, actions }: { model: PurchasingSettingsModel; actions?: PurchasingSettingsActions }) {
  const t = useT(NS)
  const words = useScopeWords()
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  const dialog = model.dialog
  // ⌘↵ / Ctrl+↵: Save while the dialog is open.
  useEffect(() => {
    if (!dialog) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        latest.current.actions?.onDialogSave?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialog])
  if (!dialog) return null
  const rows = model.tolerances.value ?? []
  const draft = dialog.draft
  const row = draft.id ? (rows.find((entry) => entry.id === draft.id) ?? null) : null
  const editable = row ? row.mayChange && row.status === 'ACTIVE' : true
  const problems = draftProblems(draft, rows)
  const shown = dialog.shown
  const busy = model.busy === 'dialog'
  const offline = model.live === 'offline'
  const set = (next: Partial<ToleranceDraft>) => actions?.onDraft?.({ ...draft, ...next })
  const apiField = (field: string) => dialog.problem?.fields[field]
  const fieldError = (problem: string | undefined, field: string) => (shown && problem ? t(problem) : apiField(field) ? t(apiField(field)!) : undefined)
  const title = row ? t(editable ? 'dialog.editTitle' : 'dialog.viewTitle', { rule: `${words.supplier(row)} · ${words.material(row)}` }) : t('dialog.newTitle')
  const unchanged = row ? draftUpdateBody(row, draft) === null : false
  const saveHeld = busy ? t('held.busy') : offline ? t('held.offline') : unchanged ? t('held.nothingChanged') : shown && Object.keys(problems).length > 0 ? t(Object.values(problems)[0]!) : null

  const footer = (): ReactNode => {
    if (!editable) {
      return (
        <span className="fw-pus-actions">
          {row && row.status === 'ARCHIVED' && (
            <Button variant="secondary" heldReason={!row.mayChange ? t(row.companyId === null ? 'held.noToleranceRightAll' : 'held.noToleranceRight') : offline ? t('held.offline') : busy ? t('held.busy') : null} onClick={() => actions?.onMove?.(row, 'reactivate')}>
              {t('row.reactivate')}
            </Button>
          )}
          <Button variant="primary" onClick={() => actions?.onDialogClose?.()}>
            {t('common.close')}
          </Button>
        </span>
      )
    }
    return (
      <span className="fw-pus-actions">
        {row && (
          <Button variant="quiet" heldReason={offline ? t('held.offline') : busy ? t('held.busy') : null} onClick={() => actions?.onMove?.(row, 'archive')}>
            {t('row.archive')}
          </Button>
        )}
        <Button variant="secondary" onClick={() => actions?.onDialogClose?.()}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" heldReason={saveHeld} onClick={() => actions?.onDialogSave?.()}>
          {t(row ? 'dialog.save' : 'dialog.create')}
        </Button>
      </span>
    )
  }

  return (
    <Modal open onClose={() => actions?.onDialogClose?.()} size="md" title={title} footer={footer()}>
      <div className="fw-pus-stack">
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem.key)} />}
        {row ? <ScopeFacts row={row} /> : <ScopeFields model={model} draft={draft} set={set} error={(problem, field) => fieldError(problem, field)} problems={problems} />}
        {!editable && row ? (
          <ReadFacts row={row} />
        ) : (
          <>
            <div className="fw-pus-fields">
              <Field label={t('tolerance.over')} hint={t('tolerance.overHint')} required error={fieldError(problems.over, 'overPct')}>
                <span className="fw-pus-stepper">
                  <NumberStepper value={draft.over} min={0} max={100} step={0.5} suffix="%" size="sm" disabled={busy} decrementLabel={t('common.less')} incrementLabel={t('common.more')} placeholder={t('tolerance.overPlaceholder')} aria-label={t('tolerance.over')} onChange={(over) => set({ over })} />
                </span>
              </Field>
              <Field label={t('tolerance.under')} hint={t('tolerance.underHint')} required error={fieldError(problems.under, 'underPct')}>
                <span className="fw-pus-stepper">
                  <NumberStepper value={draft.under} min={0} max={100} step={0.5} suffix="%" size="sm" disabled={busy} decrementLabel={t('common.less')} incrementLabel={t('common.more')} placeholder={t('tolerance.underPlaceholder')} aria-label={t('tolerance.under')} onChange={(under) => set({ under })} />
                </span>
              </Field>
            </div>
            <fieldset className="fw-pus-choices" disabled={busy}>
              <legend className="fw-pus-question">{t('tolerance.beyond')}</legend>
              {TOLERANCE_ACTIONS.map((action) => (
                <RadioCard key={action} name="pus-dialog-beyond" checked={draft.whenBeyond === action} selected={draft.whenBeyond === action} onChange={() => set({ whenBeyond: action })} title={t(`tolerance.beyondTitle.${action}`)} description={t(`tolerance.beyondHint.${action}`)} />
              ))}
            </fieldset>
            <Field label={t('dialog.note')} hint={t('dialog.noteHint')} error={fieldError(problems.note, 'note')}>
              <Textarea value={draft.note} rows={2} honourRows limit={MAX_NOTE} disabled={busy} onChange={(event) => set({ note: event.target.value })} />
            </Field>
          </>
        )}
      </div>
    </Modal>
  )
}

/** A kept rule's scope, as text (it never changes). */
function ScopeFacts({ row }: { row: Tolerance }) {
  const t = useT(NS)
  const words = useScopeWords()
  return (
    <div className="fw-pus-stack">
      <KeyValue
        items={[
          { label: t('dialog.whose'), value: words.whose(row) },
          { label: t('tolerance.col.supplier'), value: words.supplier(row) },
          { label: t('tolerance.col.material'), value: words.material(row) },
        ]}
      />
      <p className="fw-pus-hint">{t('dialog.scopeFixed')}</p>
    </div>
  )
}

/** An archived rule, or one the person may not keep: its figures as text, with why. */
function ReadFacts({ row }: { row: Tolerance }) {
  const t = useT(NS)
  return (
    <div className="fw-pus-stack">
      <p className="fw-pus-held">{t(row.status === 'ARCHIVED' ? 'dialog.archived' : row.companyId === null ? 'held.noToleranceRightAll' : 'held.noToleranceRight')}</p>
      <div className="fw-pus-inforce-row">
        <span className="fw-pus-sub">{t('tolerance.col.rule')}</span>
        <RuleWords row={row} />
      </div>
      {row.note && <p className="fw-pus-hint">{row.note}</p>}
    </div>
  )
}

/** A new exception's scope: whose, supplier, material (a kind or one). */
function ScopeFields({ model, draft, set, error, problems }: { model: PurchasingSettingsModel; draft: ToleranceDraft; set: (next: Partial<ToleranceDraft>) => void; error: (problem: string | undefined, field: string) => string | undefined; problems: ReturnType<typeof draftProblems> }) {
  const t = useT(NS)
  const busy = model.busy === 'dialog'
  // The DS Combobox takes no aria-label: each names itself by a hidden label (aria-labelledby reads hidden text).
  const supplierLabel = useId()
  const materialLabel = useId()
  const supplierPicker = (): ReactNode => {
    if (!model.can.suppliers) return <p className="fw-pus-held">{t('held.noPartiesView')}</p>
    if (!model.suppliers || (!model.suppliers.value && !model.suppliers.problem)) return <Skeleton height={36} />
    if (model.suppliers.problem) return <p className="fw-pus-held">{t(model.suppliers.problem)}</p>
    return (
      <Combobox
        options={[{ value: '', label: t('tolerance.everySupplier') }, ...model.suppliers.value!.map((supplier) => ({ value: supplier.id, label: `${supplier.name} · ${supplier.code}` }))]}
        value={draft.supplierId ?? ''}
        placeholder={t('dialog.supplierPlaceholder')}
        labelledBy={supplierLabel}
        onChange={(id) => set({ supplierId: id || null })}
      />
    )
  }
  const materialPicker = (): ReactNode => {
    if (draft.materialMode === 'ALL') return null
    if (draft.materialMode === 'KIND') {
      return (
        <Select size="sm" value={draft.itemKind ?? ''} disabled={busy} aria-label={t('dialog.kind')} onChange={(event) => set({ itemKind: (event.target.value || null) as ItemKind | null })}>
          <option value="">{t('dialog.kindPlaceholder')}</option>
          {ITEM_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`itemKind.${kind}`)}
            </option>
          ))}
        </Select>
      )
    }
    if (!model.can.materials) return <p className="fw-pus-held">{t('held.noMaterialsView')}</p>
    if (!model.materials || (!model.materials.value && !model.materials.problem)) return <Skeleton height={36} />
    if (model.materials.problem) return <p className="fw-pus-held">{t(model.materials.problem)}</p>
    return <Combobox options={model.materials.value!.map((material) => ({ value: material.id, label: `${material.code} · ${material.name}` }))} value={draft.itemId ?? ''} placeholder={t('dialog.materialPlaceholder')} labelledBy={materialLabel} onChange={(id) => set({ itemId: id || null })} />
  }
  return (
    <div className="fw-pus-stack">
      <span id={supplierLabel} hidden>
        {t('tolerance.col.supplier')}
      </span>
      <span id={materialLabel} hidden>
        {t('dialog.mode.ITEM')}
      </span>
      {model.address.scope === 'company' ? (
        <Field label={t('dialog.whose')} hint={t('dialog.whoseHint')}>
          <SegmentedControl
            size="sm"
            ariaLabel={t('dialog.whose')}
            value={draft.companyId === null ? 'all' : 'company'}
            onChange={(value) => set({ companyId: value === 'all' ? null : model.companyId })}
            options={[
              { value: 'company', label: model.companyName },
              { value: 'all', label: t('common.everyCompany') },
            ]}
          />
        </Field>
      ) : (
        <p className="fw-pus-hint">{t('dialog.forEveryCompany')}</p>
      )}
      <Field label={t('tolerance.col.supplier')} hint={t('dialog.supplierHint')} error={error(undefined, 'supplierId')}>
        {supplierPicker()}
      </Field>
      <Field label={t('tolerance.col.material')} hint={t('dialog.materialHint')} error={error(problems.material, problems.material === 'problem.kindNeeded' ? 'itemKind' : 'itemId')}>
        <span className="fw-pus-stack">
          <SegmentedControl
            size="sm"
            ariaLabel={t('tolerance.col.material')}
            value={draft.materialMode}
            onChange={(value) => set({ materialMode: value as MaterialMode, itemKind: value === 'KIND' ? draft.itemKind : null, itemId: value === 'ITEM' ? draft.itemId : null })}
            options={[
              { value: 'ALL', label: t('dialog.mode.ALL') },
              { value: 'KIND', label: t('dialog.mode.KIND') },
              { value: 'ITEM', label: t('dialog.mode.ITEM') },
            ]}
          />
          {materialPicker()}
        </span>
      </Field>
      {problems.scope && (problems.scope === 'problem.sameScope' || model.dialog?.shown) && <p className="fw-pus-problem">{t(problems.scope)}</p>}
    </div>
  )
}
