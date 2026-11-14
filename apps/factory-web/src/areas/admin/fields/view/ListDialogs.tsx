'use client'

import { Banner, Field as DsField } from '@nexus/ui/components'
import { Button, Input, Kbd, RadioCard, TagGlyph } from '@nexus/ui/primitives'
import { ColorSwatchPicker, IconPicker, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { ListKey } from '../../../../list-frame/model'
import type { ListValue, Picklist } from '../api'
import { codeFrom, FIELDS_NS, labelIn, listDraftHeld, typedCode, typedValueCode, valueCodeFrom, valueDraftHeld, type ListDraft, type Mark, type ValueDraft } from '../model'

const saveOnMetaEnter = (save: () => void) => (event: React.KeyboardEvent) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    save()
  }
}

/** New list: its key and names in Italian and English, of every company or of one. */
export function NewListDialog({ draft, fault, codes, companies, busy, onDraft, onSave, onClose }: { draft: ListDraft; fault: string | null; codes: readonly string[]; companies: readonly { id: string; name: string }[]; busy: boolean; onDraft?: (draft: ListDraft) => void; onSave?: () => void; onClose?: () => void }) {
  const t = useT(FIELDS_NS)
  const held = listDraftHeld(draft, codes, busy)
  const set = (patch: Partial<ListDraft>) => {
    const next = { ...draft, ...patch }
    if (patch.labelEn !== undefined && !next.codeTyped) next.code = codeFrom(patch.labelEn)
    if (patch.code !== undefined) next.codeTyped = true
    onDraft?.(next)
  }
  const save = () => {
    if (!held) onSave?.()
  }
  return (
    <Modal
      open
      size="md"
      onClose={() => onClose?.()}
      title={t('listDialog.title')}
      footer={
        <>
          <Button onClick={() => onClose?.()}>{t('fieldDialog.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={save} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('listDialog.add')}
          </Button>
        </>
      }
    >
      <div className="fw-flds-dialog-form" onKeyDown={saveOnMetaEnter(save)}>
        {fault && <Banner tone="danger" title={t(fault)} />}
        <p className="fw-flds-muted">{t('listDialog.intro')}</p>
        <DsField label={t('fieldDialog.labelIt')} required>
          <Input value={draft.labelIt} maxLength={80} lang="it" autoFocus onChange={(event) => set({ labelIt: event.target.value })} />
        </DsField>
        <DsField label={t('fieldDialog.labelEn')} required>
          <Input value={draft.labelEn} maxLength={80} lang="en" onChange={(event) => set({ labelEn: event.target.value })} />
        </DsField>
        <DsField label={t('listDialog.code')} required hint={t('listDialog.codeHint')} error={draft.code && codes.includes(draft.code) ? t('wait.listCodeTaken') : undefined}>
          <Input value={draft.code} maxLength={40} spellCheck={false} onChange={(event) => set({ code: typedCode(event.target.value) })} />
        </DsField>
        {companies.length > 0 && (
          <fieldset className="fw-flds-choices">
            <legend>{t('fieldDialog.whose')}</legend>
            <div className="fw-flds-choice-row">
              <RadioCard variant="row" name="fw-flds-list-company" value="" checked={draft.companyId === null} selected={draft.companyId === null} onChange={() => set({ companyId: null })} title={t('whose.every')} description={t('whose.everyHint')} />
              {companies.map((company) => (
                <RadioCard key={company.id} variant="row" name="fw-flds-list-company" value={company.id} checked={draft.companyId === company.id} selected={draft.companyId === company.id} onChange={() => set({ companyId: company.id })} title={t('whose.one', { company: company.name })} description={t('whose.listOneHint')} />
              ))}
            </div>
          </fieldset>
        )}
      </div>
    </Modal>
  )
}

/** Rename a list: its names in both languages (its key never changes). */
export function RenameListDialog({ list, labelIt, labelEn, fault, busy, onChange, onSave, onClose }: { list: Picklist; labelIt: string; labelEn: string; fault: string | null; busy: boolean; onChange?: (labels: { labelIt: string; labelEn: string }) => void; onSave?: () => void; onClose?: () => void }) {
  const t = useT(FIELDS_NS)
  const held = busy ? 'wait.busy' : labelIt.trim() === '' ? 'wait.labelIt' : labelEn.trim() === '' ? 'wait.labelEn' : labelIt.trim() === list.labelIt && labelEn.trim() === list.labelEn ? 'wait.nothingChanged' : null
  const save = () => {
    if (!held) onSave?.()
  }
  return (
    <Modal
      open
      size="md"
      onClose={() => onClose?.()}
      title={t('renameDialog.title', { code: list.code })}
      footer={
        <>
          <Button onClick={() => onClose?.()}>{t('fieldDialog.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={save} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('fieldDialog.save')}
          </Button>
        </>
      }
    >
      <div className="fw-flds-dialog-form" onKeyDown={saveOnMetaEnter(save)}>
        {fault && <Banner tone="danger" title={t(fault)} />}
        <DsField label={t('fieldDialog.labelIt')} required>
          <Input value={labelIt} maxLength={80} lang="it" autoFocus onChange={(event) => onChange?.({ labelIt: event.target.value, labelEn })} />
        </DsField>
        <DsField label={t('fieldDialog.labelEn')} required>
          <Input value={labelEn} maxLength={80} lang="en" onChange={(event) => onChange?.({ labelIt, labelEn: event.target.value })} />
        </DsField>
      </div>
    </Modal>
  )
}

/** New value: code, labels, colour, icon, description; it goes at the list's end. */
export function NewValueDialog({ list, draft, fault, busy, onDraft, onSave, onClose }: { list: Picklist; draft: ValueDraft; fault: string | null; busy: boolean; onDraft?: (draft: ValueDraft) => void; onSave?: () => void; onClose?: () => void }) {
  const t = useT(FIELDS_NS)
  const locale = useLocale()
  const held = valueDraftHeld(draft, list, busy)
  const set = (patch: Partial<ValueDraft>) => {
    const next = { ...draft, ...patch }
    if (patch.labelEn !== undefined && !next.codeTyped) next.code = valueCodeFrom(patch.labelEn)
    if (patch.code !== undefined) next.codeTyped = true
    onDraft?.(next)
  }
  const save = () => {
    if (!held) onSave?.()
  }
  const taken = list.values.find((value) => value.code === draft.code)
  return (
    <Modal
      open
      size="lg"
      onClose={() => onClose?.()}
      title={t('valueDialog.title', { list: labelIn(list, locale) })}
      footer={
        <>
          <Button onClick={() => onClose?.()}>{t('fieldDialog.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={save} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('valueDialog.add')}
          </Button>
        </>
      }
    >
      <div className="fw-flds-dialog-form" onKeyDown={saveOnMetaEnter(save)}>
        {fault && <Banner tone="danger" title={t(fault)} />}
        <div className="fw-flds-form-grid">
          <DsField label={t('fieldDialog.labelIt')} required>
            <Input value={draft.labelIt} maxLength={80} lang="it" autoFocus onChange={(event) => set({ labelIt: event.target.value })} />
          </DsField>
          <DsField label={t('fieldDialog.labelEn')} required>
            <Input value={draft.labelEn} maxLength={80} lang="en" onChange={(event) => set({ labelEn: event.target.value })} />
          </DsField>
          <DsField label={t('values.col.code')} required hint={t('valueDialog.codeHint')} error={taken ? t(taken.active ? 'wait.valueCodeTaken' : 'fault.valueTakenInactive') : undefined}>
            <Input value={draft.code} maxLength={40} spellCheck={false} onChange={(event) => set({ code: typedValueCode(event.target.value) })} />
          </DsField>
          <DsField label={t('values.col.description')} hint={t('valueDialog.descriptionHint')}>
            <Textarea value={draft.description} maxLength={500} rows={2} onChange={(event) => set({ description: event.target.value })} />
          </DsField>
        </div>
        <div className="fw-flds-pickers">
          <DsField label={t('look.icon')} hint={t('look.iconHint')}>
            <IconPicker value={draft.icon} color={draft.colour} ariaLabel={t('look.icon')} onChange={(icon) => set({ icon })} />
          </DsField>
          <DsField label={t('look.colour')} hint={t('look.colourHint')}>
            <span className="fw-flds-inline">
              <ColorSwatchPicker value={draft.colour} ariaLabel={t('look.colour')} onChange={(colour) => set({ colour })} />
              <Button size="sm" variant="quiet" heldReason={draft.colour ? null : t('look.noColourYet')} onClick={() => set({ colour: null })}>
                {t('look.clearColour')}
              </Button>
            </span>
          </DsField>
        </div>
      </div>
    </Modal>
  )
}

/** A value's icon and colour: each pick saves by itself (autosave); the mark says how it went. */
export function LookDialog({ value, mark, onLook, onClose }: { value: ListValue; mark: Mark | undefined; onLook?: (change: { icon?: string | null; colour?: string | null }) => void; onClose?: () => void }) {
  const t = useT(FIELDS_NS)
  const locale = useLocale()
  const status = !mark ? null : mark.state === 'refused' || mark.state === 'unknown' ? t(mark.fault) : t(`mark.${mark.state}`)
  return (
    <Modal
      open
      size="md"
      onClose={() => onClose?.()}
      title={t('look.title', { code: value.code })}
      footer={
        <>
          {status && (
            <span className={mark?.state === 'refused' ? 'fw-flds-danger' : 'fw-flds-muted'} role="status">
              {status}
            </span>
          )}
          <Button variant="primary" onClick={() => onClose?.()}>
            {t('look.done')}
          </Button>
        </>
      }
    >
      <div className="fw-flds-dialog-form">
        <p className="fw-flds-look">
          <TagGlyph icon={value.icon} color={value.colour} size={28} />
          <span>{labelIn(value, locale)}</span>
        </p>
        <DsField label={t('look.icon')} hint={t('look.iconHint')}>
          <IconPicker value={value.icon} color={value.colour} ariaLabel={t('look.icon')} onChange={(icon) => onLook?.({ icon })} />
        </DsField>
        <DsField label={t('look.colour')} hint={t('look.colourHint')}>
          <span className="fw-flds-inline">
            <ColorSwatchPicker value={value.colour} ariaLabel={t('look.colour')} onChange={(colour) => onLook?.({ colour })} />
            <Button size="sm" variant="quiet" heldReason={value.colour ? null : t('look.noColourYet')} onClick={() => onLook?.({ colour: null })}>
              {t('look.clearColour')}
            </Button>
          </span>
        </DsField>
      </div>
    </Modal>
  )
}

/** The page's keys (the footer's icon opens this too). */
export function KeysDialog({ keys, onClose }: { keys: readonly ListKey[]; onClose: () => void }) {
  const t = useT(FIELDS_NS)
  const lists = useT('lists')
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <dl className="fw-flds-keys">
        {keys.map((entry) => (
          <div key={entry.keys.join('+')}>
            <dt>
              {entry.keys.map((key) => (
                <Kbd key={key}>{key === 'click' ? lists('keys.click') : key}</Kbd>
              ))}
            </dt>
            <dd>{entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}
