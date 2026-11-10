'use client'

import { useState } from 'react'
import { Search } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, Select, Spinner, Toggle } from '@nexus/ui/primitives'
import { BOM_SECTIONS } from '@nexus/factory-domain/product/bom-structure/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { refusedField } from '../../../library/model'
import { EFFECT_FIELDS, effectDraftProblems, OPTION_LIMITS, PART_EFFECT_KINDS, valueDraftProblems, type EffectDraft, type GroupRecord, type PartEffectKind, type PickedRef, type ValueDraft } from '../../model'
import type { GroupRecordActions, GroupRecordModel, PickerModel, RecordDialog } from '../../view-model'
import { useSay } from '../../view/parts'

/**
 * The record's dialogs (B-W2b-242): Add option, Archive / Restore an option, "outside the certificate" (the note), Add /
 * Edit effect (option, kind, then the kind's own fields: a material picked by search, the material it replaces or leaves
 * out, quantity and unit, section, an operation, minutes, a note), Remove effect, Add styles (search, pick, Add N; the
 * styles refused said one by one), Withdraw from a style, Archive / Restore the group. Each holds its button with the first
 * reason; ⌘↵ confirms. They fetch nothing.
 */
export function RecordDialogs({ group, model, actions }: { group: GroupRecord; model: GroupRecordModel; actions?: GroupRecordActions }) {
  const dialog = model.dialog
  if (!dialog) return null
  switch (dialog.kind) {
    case 'addValue':
      return <AddValueDialog group={group} dialog={dialog} actions={actions} />
    case 'archiveValue':
    case 'restoreValue':
      return <ValueStatusDialog group={group} dialog={dialog} busy={model.busy} actions={actions} />
    case 'certificate':
      return <CertificateDialog group={group} dialog={dialog} actions={actions} />
    case 'effect':
      return <EffectDialog group={group} dialog={dialog} model={model} actions={actions} />
    case 'removeEffect':
      return <RemoveEffectDialog group={group} dialog={dialog} busy={model.busy} actions={actions} />
    case 'styles':
      return <AddStylesDialog group={group} dialog={dialog} actions={actions} />
    case 'withdraw':
      return <WithdrawDialog group={group} dialog={dialog} busy={model.busy} actions={actions} />
    case 'archive':
    case 'restore':
      return <GroupStatusDialog group={group} to={dialog.kind} busy={model.busy} actions={actions} />
    default:
      return null
  }
}

const onConfirmKey = (go: () => void) => (event: React.KeyboardEvent) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    go()
  }
}

function AddValueDialog({ group, dialog, actions }: { group: GroupRecord; dialog: Extract<RecordDialog, { kind: 'addValue' }>; actions?: GroupRecordActions }) {
  const t = useT('products-options')
  const tl = useT('library')
  const draft = dialog.draft
  const set = (patch: Partial<ValueDraft>) => actions?.onDialog?.({ ...dialog, draft: { ...draft, ...patch }, refused: [] })
  const problems = valueDraftProblems(draft, group.kind, group.values)
  const touched = draft.code.trim() !== '' || draft.name.trim() !== ''
  const problemAt = (field: string) => {
    if (refusedField(dialog.refused, field) || (field === 'maxLength' && refusedField(dialog.refused, 'freeTextMaxLength')) || (field === 'pattern' && refusedField(dialog.refused, 'freeTextPattern'))) return t('form.refused')
    if (!touched) return undefined
    const problem = problems.find((entry) => entry.field === field)
    return problem ? t(problem.key, problem.params) : undefined
  }
  const held = problems.length > 0 ? t('form.held', { count: problems.length }) : dialog.busy ? tl('held.busy') : null
  const save = () => {
    if (!held) actions?.onAddValue?.()
  }
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('value.title', { code: group.code })}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{tl('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={save} aria-keyshortcuts="Meta+Enter Control+Enter">
            {dialog.busy ? <Spinner size={12} /> : null} {t('value.add')}
          </Button>
        </>
      }
    >
      <div className="fw-lib-dialog" onKeyDown={onConfirmKey(save)}>
        {dialog.problem && (
          <Banner tone="danger" title={tl(dialog.problem)}>
            {dialog.messages.length > 0 ? dialog.messages.join(' ') : null}
          </Banner>
        )}
        <div className="fw-lib-form-grid">
          <Field label={t('value.code')} hint={t('value.codeHint')} error={problemAt('code')}>
            <Input value={draft.code} maxLength={OPTION_LIMITS.code} autoFocus onChange={(event) => set({ code: event.target.value })} />
          </Field>
          <Field label={t('value.name')} error={problemAt('name')}>
            <Input value={draft.name} maxLength={OPTION_LIMITS.name} onChange={(event) => set({ name: event.target.value })} />
          </Field>
          <div className="fw-lib-span">
            <Field label={t('value.freeText')} hint={group.kind === 'FREE_TEXT' ? t('value.freeTextGroup') : t('value.freeTextHint')} error={problemAt('freeText')}>
              <span className="fw-lib-inline">
                <Toggle checked={draft.freeText} aria-label={t('value.freeText')} onChange={(next) => set({ freeText: next, maxLength: next && draft.maxLength === '' ? '30' : draft.maxLength })} />
                <span aria-hidden>{draft.freeText ? tl('common.yes') : tl('common.no')}</span>
              </span>
            </Field>
          </div>
          {draft.freeText && (
            <>
              <Field label={t('value.maxLength')} hint={t('value.maxLengthHint', { max: OPTION_LIMITS.freeTextLength })} error={problemAt('maxLength')}>
                <Input inputMode="numeric" value={draft.maxLength} maxLength={3} onChange={(event) => set({ maxLength: event.target.value })} />
              </Field>
              <Field label={t('value.pattern')} hint={t('options.patternHint')} error={problemAt('pattern')}>
                <Input className="fw-lib-mono" value={draft.pattern} maxLength={OPTION_LIMITS.pattern} onChange={(event) => set({ pattern: event.target.value })} />
              </Field>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}

function ValueStatusDialog({ group, dialog, busy, actions }: { group: GroupRecord; dialog: Extract<RecordDialog, { kind: 'archiveValue' | 'restoreValue' }>; busy: boolean; actions?: GroupRecordActions }) {
  const t = useT('products-options')
  const tl = useT('library')
  const [reason, setReason] = useState('')
  const value = group.values.find((entry) => entry.id === dialog.valueId)
  if (!value) return null
  const to = dialog.kind === 'archiveValue' ? 'archive' : 'restore'
  const requiredBy = group.rules.filter((rule) => rule.status === 'ACTIVE' && rule.kind === 'REQUIRES' && rule.otherValueId === value.id).length
  const held = busy ? tl('held.busy') : to === 'archive' && requiredBy > 0 ? t('value.held.required', { count: requiredBy }) : null
  const go = () => {
    if (!held) actions?.onValueStatus?.(value.id, to, reason.trim())
  }
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t(to === 'archive' ? 'value.archiveTitle' : 'value.restoreTitle', { code: value.code })}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{tl('common.back')}</Button>
          <Button variant={to === 'archive' ? 'danger' : 'primary'} heldReason={held} onClick={go}>
            {t(to === 'archive' ? 'options.archive' : 'options.restore')}
          </Button>
        </>
      }
    >
      <div className="fw-lib-dialog" onKeyDown={onConfirmKey(go)}>
        <ul className="fw-lib-list">
          {to === 'archive' ? (
            <>
              <li>{t('value.archiveReach')}</li>
              {value.usedBy.lines + value.usedBy.steps > 0 && <li>{t('value.archiveUsed', { lines: value.usedBy.lines, steps: value.usedBy.steps })}</li>}
              <li>{t('value.archiveBack')}</li>
            </>
          ) : (
            <li>{t('value.restoreReach')}</li>
          )}
        </ul>
        <Field label={tl('dialog.reason')} hint={tl('dialog.reasonHint')}>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} />
        </Field>
      </div>
    </Modal>
  )
}

function CertificateDialog({ group, dialog, actions }: { group: GroupRecord; dialog: Extract<RecordDialog, { kind: 'certificate' }>; actions?: GroupRecordActions }) {
  const t = useT('products-options')
  const tl = useT('library')
  const value = group.values.find((entry) => entry.id === dialog.valueId)
  const held = dialog.note.trim() === '' ? t('effect.problem.certificate') : dialog.note.trim().length > OPTION_LIMITS.note ? t('effect.problem.note', { max: OPTION_LIMITS.note }) : dialog.busy ? tl('held.busy') : null
  const go = () => {
    if (!held) actions?.onSaveCertificate?.()
  }
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('certificate.title', { code: value?.code ?? '' })}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{tl('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={go}>
            {dialog.busy ? <Spinner size={12} /> : null} {t('certificate.save')}
          </Button>
        </>
      }
    >
      <div className="fw-lib-dialog" onKeyDown={onConfirmKey(go)}>
        <p className="fw-lib-hint">{t('certificate.body')}</p>
        {dialog.problem && <Banner tone="danger" title={tl(dialog.problem)} />}
        <Field label={t('certificate.note')} hint={t('certificate.noteHint')}>
          <Textarea autoFocus value={dialog.note} rows={3} maxLength={OPTION_LIMITS.note} onChange={(event) => actions?.onDialog?.({ ...dialog, note: event.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}

/** A search field and the found records as a choice ("Pick a material"); the picked one stays listed. */
function Picker({ label, hint, picker, picked, error, onSearch, onPick, searchLabel }: { label: string; hint?: string; picker: PickerModel; picked: PickedRef | null; error?: string; onSearch: (q: string) => void; onPick: (ref: PickedRef | null) => void; searchLabel: string }) {
  const t = useT('products-options')
  const choices = [...(picked ? [picked] : []), ...(picker.results ?? []).filter((entry) => entry.id !== picked?.id)]
  return (
    <Field label={label} hint={hint} error={error}>
      <span className="fw-opt-picker">
        <Input size="sm" type="search" aria-label={searchLabel} placeholder={searchLabel} leadingIcon={<Search size={13} aria-hidden />} value={picker.q} onChange={(event) => onSearch(event.target.value)} />
        <Select size="sm" aria-label={label} value={picked?.id ?? ''} onChange={(event) => onPick(choices.find((entry) => entry.id === event.target.value) ?? null)}>
          <option value="">{picker.results === null && picker.q.trim() !== '' ? t('rules.reading') : choices.length === 0 ? t('effect.searchFirst') : t('effect.pick')}</option>
          {choices.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.code} · {entry.name}
            </option>
          ))}
        </Select>
      </span>
    </Field>
  )
}

function EffectDialog({ group, dialog, model, actions }: { group: GroupRecord; dialog: Extract<RecordDialog, { kind: 'effect' }>; model: GroupRecordModel; actions?: GroupRecordActions }) {
  const t = useT('products-options')
  const tl = useT('library')
  const draft = dialog.draft
  const set = (patch: Partial<EffectDraft>) => actions?.onDialog?.({ ...dialog, draft: { ...draft, ...patch }, refused: [] })
  const editing = dialog.mode === 'edit'
  const effect = editing ? group.effects.find((entry) => entry.id === dialog.effectId) : undefined
  const hasSizes = !!effect?.sizeQuantities && Object.keys(effect.sizeQuantities).length > 0
  const problems = effectDraftProblems(draft, hasSizes)
  const fields = EFFECT_FIELDS[draft.kind]
  const problemAt = (field: string) => {
    if (refusedField(dialog.refused, field) || (field === 'item' && refusedField(dialog.refused, 'itemId')) || (field === 'target' && refusedField(dialog.refused, 'targetItemId')) || (field === 'operation' && refusedField(dialog.refused, 'operationId'))) return t('form.refused')
    const problem = problems.find((entry) => entry.field === field)
    return problem ? t(problem.key, problem.params) : undefined
  }
  const pickerHeld = (which: 'material' | 'operation') => (which === 'material' ? (model.can.materials ? undefined : t('effect.noMaterials')) : model.can.operations ? undefined : t('effect.noOperations'))
  const held = problems.length > 0 ? t('form.held', { count: problems.length }) : dialog.busy ? tl('held.busy') : null
  const save = () => {
    if (!held) actions?.onSaveEffect?.()
  }
  const active = group.values.filter((value) => value.status === 'ACTIVE' || value.id === draft.valueId)
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={editing ? t('effect.editTitle') : t('effect.newTitle')}
      size="lg"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{tl('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={save} aria-keyshortcuts="Meta+Enter Control+Enter">
            {dialog.busy ? <Spinner size={12} /> : null} {editing ? t('effect.save') : t('effect.add')}
          </Button>
        </>
      }
    >
      <div className="fw-lib-dialog" onKeyDown={onConfirmKey(save)}>
        {dialog.problem && (
          <Banner tone="danger" title={tl(dialog.problem)}>
            {dialog.messages.length > 0 ? dialog.messages.join(' ') : null}
          </Banner>
        )}
        <div className="fw-lib-form-grid">
          <Field label={t('effect.option')} hint={editing ? t('effect.fixed') : undefined}>
            <Select value={draft.valueId} disabled={editing} onChange={(event) => set({ valueId: event.target.value })}>
              {active.map((value) => (
                <option key={value.id} value={value.id}>
                  {value.code} · {value.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('effect.kind')} hint={editing ? t('effect.fixed') : t(`effectHint.${draft.kind}`)}>
            <Select value={draft.kind} disabled={editing} onChange={(event) => set({ kind: event.target.value as PartEffectKind })}>
              {PART_EFFECT_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`effectKind.${kind}`)}
                </option>
              ))}
            </Select>
          </Field>
          {fields.includes('item') && (
            <Picker
              label={t(draft.kind === 'BOM_REPLACE' ? 'effect.itemIn' : 'effect.item')}
              hint={pickerHeld('material')}
              picker={dialog.material}
              picked={draft.item}
              error={problemAt('item')}
              searchLabel={t('effect.searchMaterial')}
              onSearch={(q) => actions?.onSearch?.('material', q)}
              onPick={(item) => set({ item })}
            />
          )}
          {fields.includes('target') && (
            <Picker
              label={t(draft.kind === 'BOM_REMOVE' ? 'effect.targetOut' : 'effect.target')}
              hint={pickerHeld('material')}
              picker={dialog.target}
              picked={draft.target}
              error={problemAt('target')}
              searchLabel={t('effect.searchMaterial')}
              onSearch={(q) => actions?.onSearch?.('target', q)}
              onPick={(target) => set({ target })}
            />
          )}
          {fields.includes('qty') && (
            <div className="fw-lib-pair">
              <Field label={t('effect.qty')} hint={draft.kind === 'BOM_REPLACE' ? t('effect.qtyReplaceHint') : t('effect.qtyHint')} error={problemAt('qty')}>
                <Input inputMode="decimal" value={draft.qty} maxLength={20} onChange={(event) => set({ qty: event.target.value })} />
              </Field>
              <Field label={t('effect.uom')} error={problemAt('uom')}>
                <Select value={draft.uom} onChange={(event) => set({ uom: event.target.value })}>
                  <option value="">{t('effect.noUom')}</option>
                  {UOMS.map((uom) => (
                    <option key={uom} value={uom}>
                      {tl(`uom.${uom}`)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
          {fields.includes('section') && (
            <Field label={t('effect.section')} hint={t('effect.sectionHint')}>
              <Select value={draft.section} onChange={(event) => set({ section: event.target.value })}>
                <option value="">{t('effect.noSection')}</option>
                {BOM_SECTIONS.map((section) => (
                  <option key={section} value={section}>
                    {t(`section.${section}`)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {fields.includes('operation') && (
            <Picker
              label={t(draft.kind === 'MINUTES' ? 'effect.operationAt' : 'effect.operation')}
              hint={pickerHeld('operation') ?? (draft.kind === 'MINUTES' ? t('effect.operationAtHint') : undefined)}
              picker={dialog.operation}
              picked={draft.operation}
              error={problemAt('operation')}
              searchLabel={t('effect.searchOperation')}
              onSearch={(q) => actions?.onSearch?.('operation', q)}
              onPick={(operation) => set({ operation })}
            />
          )}
          {fields.includes('minutes') && (
            <Field label={t('effect.minutes')} hint={t(draft.kind === 'MINUTES' ? 'effect.minutesSignedHint' : 'effect.minutesHint')} error={problemAt('minutes')}>
              <Input inputMode="decimal" value={draft.minutes} maxLength={12} onChange={(event) => set({ minutes: event.target.value })} />
            </Field>
          )}
          <div className="fw-lib-span">
            <Field label={t(draft.kind === 'CERTIFICATE' ? 'certificate.note' : 'effect.note')} hint={draft.kind === 'CERTIFICATE' ? t('certificate.noteHint') : undefined} error={problemAt('note')}>
              <Textarea value={draft.note} rows={2} maxLength={OPTION_LIMITS.note} onChange={(event) => set({ note: event.target.value })} />
            </Field>
          </div>
        </div>
        {hasSizes && <p className="fw-lib-hint">{t('effect.sizesKept', { count: Object.keys(effect!.sizeQuantities!).length })}</p>}
      </div>
    </Modal>
  )
}

function RemoveEffectDialog({ group, dialog, busy, actions }: { group: GroupRecord; dialog: Extract<RecordDialog, { kind: 'removeEffect' }>; busy: boolean; actions?: GroupRecordActions }) {
  const t = useT('products-options')
  const tl = useT('library')
  const say = useSay()
  const effect = group.effects.find((entry) => entry.id === dialog.effectId)
  if (!effect) return null
  const value = group.values.find((entry) => entry.id === effect.valueId)
  const go = () => {
    if (!busy) actions?.onRemoveEffect?.(effect.id)
  }
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('effect.removeTitle', { code: value?.code ?? '' })}
      size="sm"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{tl('common.back')}</Button>
          <Button variant="danger" heldReason={busy ? tl('held.busy') : null} onClick={go}>
            {t('effects.remove')}
          </Button>
        </>
      }
    >
      <div className="fw-lib-dialog" onKeyDown={onConfirmKey(go)}>
        <p>
          {t(`effectKind.${effect.kind}`)}: {say(effect.words)}
        </p>
        <p className="fw-lib-hint">{t('effect.removeBody')}</p>
      </div>
    </Modal>
  )
}

function AddStylesDialog({ group, dialog, actions }: { group: GroupRecord; dialog: Extract<RecordDialog, { kind: 'styles' }>; actions?: GroupRecordActions }) {
  const t = useT('products-options')
  const tl = useT('library')
  const offered = new Set(group.styles.filter((offer) => offer.status === 'ACTIVE').map((offer) => offer.style.id))
  const results = dialog.results ?? []
  const held = dialog.picked.length === 0 ? t('styles.held.pick') : dialog.busy ? tl('held.busy') : null
  const go = () => {
    if (!held) actions?.onAddStyles?.()
  }
  const toggle = (id: string, on: boolean) => actions?.onDialog?.({ ...dialog, picked: on ? [...dialog.picked, id] : dialog.picked.filter((entry) => entry !== id) })
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('styles.addTitle', { code: group.code })}
      size="lg"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{dialog.outcome ? t('styles.done') : tl('common.back')}</Button>
          {!dialog.outcome && (
            <Button variant="primary" heldReason={held} onClick={go}>
              {dialog.busy ? <Spinner size={12} /> : null} {t('styles.addN', { count: dialog.picked.length })}
            </Button>
          )}
        </>
      }
    >
      <div className="fw-lib-dialog" onKeyDown={onConfirmKey(go)}>
        {dialog.outcome ? (
          <>
            {dialog.outcome.added.length > 0 && <Banner tone="success" title={t('styles.added', { count: dialog.outcome.added.length })}>{dialog.outcome.added.join(', ')}</Banner>}
            {dialog.outcome.refused.length > 0 && (
              <Banner tone="warning" title={t('styles.refusedTitle', { count: dialog.outcome.refused.length })}>
                <ul className="fw-lib-list">
                  {dialog.outcome.refused.map((entry) => (
                    <li key={entry.code}>
                      <span className="fw-lib-mono">{entry.code}</span>: {entry.key.startsWith('problem.') ? tl(entry.key) : t(entry.key)}
                      {entry.message ? <span className="fw-opt-wrap fw-opt-said">{entry.message}</span> : null}
                    </li>
                  ))}
                </ul>
              </Banner>
            )}
          </>
        ) : (
          <>
            <p className="fw-lib-hint">{t('styles.addBody')}</p>
            <Input type="search" autoFocus aria-label={t('styles.search')} placeholder={t('styles.search')} leadingIcon={<Search size={13} aria-hidden />} value={dialog.q} onChange={(event) => actions?.onFindStyles?.(event.target.value)} />
            {dialog.results === null ? (
              <p className="fw-lib-hint fw-lib-inline" role="status">
                <Spinner size={12} /> {t('rules.reading')}
              </p>
            ) : results.length === 0 ? (
              <p className="fw-lib-hint">{t('styles.none')}</p>
            ) : (
              <ul className="fw-opt-pick-list">
                {results.map((style) => {
                  const already = offered.has(style.id)
                  return (
                    <li key={style.id}>
                      <Checkbox
                        checked={already || dialog.picked.includes(style.id)}
                        disabled={already}
                        onChange={(event) => toggle(style.id, event.target.checked)}
                        label={
                          <span className="fw-lib-cell">
                            <span>
                              <span className="fw-lib-mono">{style.code}</span> · {style.name}
                            </span>
                            <span className="fw-lib-sub">{already ? t('styles.already') : t(`styleStatus.${style.status}`)}</span>
                          </span>
                        }
                      />
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

function WithdrawDialog({ group, dialog, busy, actions }: { group: GroupRecord; dialog: Extract<RecordDialog, { kind: 'withdraw' }>; busy: boolean; actions?: GroupRecordActions }) {
  const t = useT('products-options')
  const tl = useT('library')
  const offer = group.styles.find((entry) => entry.id === dialog.offerId)
  if (!offer) return null
  const go = () => {
    if (!busy) actions?.onWithdraw?.(offer.id)
  }
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('styles.withdrawTitle', { code: offer.style.code })}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{tl('common.back')}</Button>
          <Button variant="danger" heldReason={busy ? tl('held.busy') : null} onClick={go}>
            {t('styles.withdraw')}
          </Button>
        </>
      }
    >
      <div className="fw-lib-dialog" onKeyDown={onConfirmKey(go)}>
        <ul className="fw-lib-list">
          <li>{t('styles.withdrawReach', { code: group.code })}</li>
          <li>{t('styles.withdrawKept')}</li>
          <li>{t('styles.withdrawRule')}</li>
        </ul>
      </div>
    </Modal>
  )
}

function GroupStatusDialog({ group, to, busy, actions }: { group: GroupRecord; to: 'archive' | 'restore'; busy: boolean; actions?: GroupRecordActions }) {
  const t = useT('products-options')
  const tl = useT('library')
  const [reason, setReason] = useState('')
  const go = () => {
    if (!busy) actions?.onMoveGroup?.(to, reason.trim())
  }
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t(to === 'archive' ? 'archive.one' : 'restore.one', { code: group.code })}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{tl('common.back')}</Button>
          <Button variant={to === 'archive' ? 'danger' : 'primary'} heldReason={busy ? tl('held.busy') : null} onClick={go}>
            {t(to === 'archive' ? 'record.archive' : 'record.restore')}
          </Button>
        </>
      }
    >
      <div className="fw-lib-dialog" onKeyDown={onConfirmKey(go)}>
        <ul className="fw-lib-list">
          {to === 'archive' ? (
            <>
              <li>{t('archive.reach')}</li>
              {group.counts.styles > 0 && <li>{t('archive.offered', { count: 1 })}</li>}
              <li>{t('archive.back')}</li>
            </>
          ) : (
            <li>{t('restore.reach')}</li>
          )}
        </ul>
        <Field label={tl('dialog.reason')} hint={tl('dialog.reasonHint')}>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} />
        </Field>
      </div>
    </Modal>
  )
}
