'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowDown, ArrowUp, FileText, ImagePlus, Plus, Trash2, X } from 'lucide-react'
import { Banner, Card, Field } from '@nexus/ui/components'
import { Button, Input, Pill, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { DetailModal, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { Swatch } from '../../_shared/Swatch'
import { refusedField } from '../../library/model'
import { ReadField, SaveBar } from '../../library/parts'
import { emptyRule, moved, pictureAddress, setChangeCount, setDraftProblems, STATUS_TONE, type RuleDraft, type SetDraft } from '../model'
import { PACKAGING_PER } from '@nexus/factory-domain/product/branding-sets/rules'
import type { BrandingFileView } from '@nexus/factory-domain/product/branding-sets/contracts'
import type { ColoursActions, ColoursViewModel, SetModalModel } from '../view-model'

/**
 * SCR-118 pop:colours.branding — a branding set in a DetailModal (`?open=<id>`; J / K the next and previous set of the list;
 * Esc): its logos and label artwork (files of the set: pictures drawn from the API, a PDF opened in a new tab; reordered or
 * removed in the draft, a new one sent at once), its packaging rules (a key, the words, a material with a quantity per
 * garment, pack or carton — or words only), its brand colours (swatches) and the styles that read it. Save sends what
 * changed at the set's version (the EditModeBar, ⌘S); Archive… / Restore… in the header. A person without
 * product.branding.manage reads it all as text. Fetches nothing.
 */
export function BrandingSetModal({ modal, model, actions }: { modal: SetModalModel; model: ColoursViewModel; actions?: ColoursActions }) {
  const t = useT('products-colours')
  const tl = useT('library')
  const set = modal.set
  const draft = modal.draft
  const editable = !!set && set.status === 'ACTIVE' && model.can.branding
  const ids = (model.sets.items ?? []).map((row) => row.id)
  const count = set && draft ? setChangeCount(set, draft) : 0
  const problems = set && draft ? setDraftProblems(set, draft) : []
  const saveHeld = problems.length > 0 ? t('form.held.problems', { count: problems.length }) : modal.uploading ? tl('held.busy') : null
  const change = (patch: Partial<SetDraft>) => draft && actions?.onSetDraft?.({ ...draft, ...patch })
  const statusHeld = !model.can.branding ? t('held.noBranding') : modal.busy ? tl('held.busy') : set?.status === 'ARCHIVED' && set.activeOther ? t('set.restoreHeld', { code: set.activeOther.code }) : null

  return (
    <>
      <DetailModal
        open
        onClose={() => actions?.onOpenSet?.(null)}
        title={set ? `${set.code} · ${set.name}` : t('set.loading')}
        subtitle={set ? `${set.party.name} (${set.party.code})` : undefined}
        meta={
          set ? (
            <span className="fw-col-meta">
              <Pill tone={STATUS_TONE[set.status]}>{t(`setStatus.${set.status}`)}</Pill>
              {set.stylesLinked !== null && <Tag tone="info">{t('sets.styles', { count: set.stylesLinked })}</Tag>}
            </span>
          ) : undefined
        }
        actions={
          set && model.can.branding ? (
            set.status === 'ACTIVE' ? (
              <Button size="sm" variant="danger-outline" heldReason={statusHeld} onClick={() => actions?.onSetConfirm?.('archive')}>
                {t('set.archive')}
              </Button>
            ) : (
              <Button size="sm" heldReason={statusHeld} onClick={() => actions?.onSetConfirm?.('restore')}>
                {t('set.restore')}
              </Button>
            )
          ) : undefined
        }
        nav={ids.includes(modal.id) ? { ids, current: modal.id, onGo: (id) => actions?.onOpenSet?.(id), noun: t('set.noun') } : undefined}
        loading={!set && !modal.problem}
        error={modal.problem ? tl(modal.problem) : undefined}
        onRetry={() => actions?.onOpenSet?.(modal.id)}
        footer={editable && draft && count > 0 ? <SaveBar count={count} onDiscard={() => actions?.onDiscardSet?.()} onSave={() => actions?.onSaveSet?.()} held={saveHeld} busy={modal.busy} saveLabel={t('set.save')} /> : undefined}
      >
        {set && draft && (
          <div className="fw-col-set">
            {modal.saveProblem && (
              <Banner tone="danger" title={tl(modal.saveProblem)}>
                {modal.messages.length > 0 ? modal.messages.join(' ') : null}
              </Banner>
            )}
            {set.status === 'ARCHIVED' && (
              <Banner tone="info" title={t('set.archivedTitle')}>
                {set.activeOther ? t('set.archivedOther', { code: set.activeOther.code }) : t('set.archivedBody')}
              </Banner>
            )}
            {!model.can.branding && <p className="fw-lib-hint">{t('set.readOnly')}</p>}

            <Card padded>
              <h3 className="fw-lib-h3">{t('set.about')}</h3>
              {editable ? (
                <div className="fw-col-form-grid">
                  <Field label={t('newSet.name')} error={problems.some((issue) => issue.path === 'name') || refusedField(modal.refused, 'name') ? t('form.problem.setName') : undefined}>
                    <Input value={draft.name} maxLength={200} onChange={(event) => change({ name: event.target.value })} />
                  </Field>
                  <Field label={t('set.note')} hint={t('set.noteHint')}>
                    <Textarea value={draft.note} rows={2} maxLength={2000} onChange={(event) => change({ note: event.target.value })} />
                  </Field>
                </div>
              ) : (
                <div className="fw-col-form-grid">
                  <ReadField label={t('newSet.name')} value={set.name} />
                  <ReadField label={t('set.note')} value={set.note} />
                </div>
              )}
            </Card>

            <Card padded>
              <h3 className="fw-lib-h3">{t('set.files')}</h3>
              <p className="fw-lib-hint">{t('set.filesHint')}</p>
              <div className="fw-col-files-grid">
                <FileGroup role="LOGO" label={t('set.logos')} ids={draft.logoIds} files={set.files} editable={editable} modal={modal} model={model} actions={actions} onIds={(logoIds) => change({ logoIds })} />
                <FileGroup role="ARTWORK" label={t('set.artwork')} ids={draft.artworkIds} files={set.files} editable={editable} modal={modal} model={model} actions={actions} onIds={(artworkIds) => change({ artworkIds })} />
              </div>
              {modal.uploading && (
                <p className="fw-lib-hint fw-lib-inline" role="status">
                  <Spinner size={12} /> {t('set.sending', { name: modal.uploading })}
                </p>
              )}
              {modal.uploadProblem && <Banner tone="danger" title={tl(modal.uploadProblem)} />}
            </Card>

            <Card padded>
              <h3 className="fw-lib-h3">{t('set.rules')}</h3>
              <p className="fw-lib-hint">{t('set.rulesHint')}</p>
              <Rules draft={draft} editable={editable} modal={modal} problems={problems.map((issue) => issue.path)} onRules={(rules) => change({ rules })} />
            </Card>

            <Card padded>
              <h3 className="fw-lib-h3">{t('set.colours')}</h3>
              <BrandColours draft={draft} set={set} editable={editable} modal={modal} onColours={(colourIds) => change({ colourIds })} />
            </Card>

            <Card padded>
              <h3 className="fw-lib-h3">{t('set.styles')}</h3>
              {set.styles.length === 0 ? (
                <p className="fw-lib-hint">{t('set.noStyles')}</p>
              ) : (
                <ul className="fw-col-styles">
                  {set.styles.map((style) => (
                    <li key={style.id}>
                      <Link className="fw-lib-link" href={`${model.prefix}/products/styles/${style.id}`}>
                        {style.code}
                      </Link>{' '}
                      <span>{style.name}</span>
                    </li>
                  ))}
                </ul>
              )}
              {set.stylesMore && <p className="fw-lib-hint">{t('set.moreStyles')}</p>}
              <p className="fw-lib-hint">{set.status === 'ACTIVE' ? t('set.stylesHint') : t('set.stylesArchivedHint')}</p>
            </Card>
          </div>
        )}
      </DetailModal>
      {modal.confirm && set && <StatusDialog to={modal.confirm} code={set.code} busy={modal.busy} actions={actions} />}
    </>
  )
}

/** The logos or the label artwork of the set: each file (a picture drawn, a document named), moved or removed in the draft. */
function FileGroup({ role, label, ids, files, editable, modal, model, actions, onIds }: { role: 'LOGO' | 'ARTWORK'; label: string; ids: string[]; files: readonly BrandingFileView[]; editable: boolean; modal: SetModalModel; model: ColoursViewModel; actions?: ColoursActions; onIds: (ids: string[]) => void }) {
  const t = useT('products-colours')
  const input = useRef<HTMLInputElement>(null)
  const byId = new Map(files.map((file) => [file.fileId, file]))
  const addHeld = !model.can.upload ? t('held.noUpload') : modal.uploading ? t('held.sending') : null
  return (
    <div className="fw-col-files">
      <h4 className="fw-col-h4">{label}</h4>
      {ids.length === 0 ? (
        <p className="fw-lib-hint">{t('sets.none')}</p>
      ) : (
        <ul className="fw-col-file-list">
          {ids.map((id, index) => {
            const file = byId.get(id)
            if (!file) return null
            const src = file.picture ? pictureAddress(file.url) : null
            return (
              <li key={id} className="fw-col-file">
                {src ? <img className="fw-col-file-img" src={src} alt={file.name} /> : <FileText size={28} aria-hidden className="fw-col-file-icon" />}
                <span className="fw-col-file-name">
                  {file.picture || !file.available ? (
                    <span>{file.name}</span>
                  ) : (
                    <Button size="sm" variant="quiet" onClick={() => actions?.onOpenDocument?.(file.fileId)}>
                      {file.name}
                    </Button>
                  )}
                  {!file.available && <span className="fw-lib-sub">{t('set.notAvailable')}</span>}
                </span>
                {editable && (
                  <span className="fw-col-file-actions">
                    <Button size="sm" variant="quiet" aria-label={t('set.earlier', { name: file.name })} heldReason={index === 0 ? t('set.first') : null} onClick={() => onIds(moved(ids, id, -1))}>
                      <ArrowUp size={13} aria-hidden />
                    </Button>
                    <Button size="sm" variant="quiet" aria-label={t('set.later', { name: file.name })} heldReason={index === ids.length - 1 ? t('set.last') : null} onClick={() => onIds(moved(ids, id, 1))}>
                      <ArrowDown size={13} aria-hidden />
                    </Button>
                    <Button size="sm" variant="quiet" aria-label={t('set.removeFile', { name: file.name })} onClick={() => onIds(ids.filter((entry) => entry !== id))}>
                      <Trash2 size={13} aria-hidden />
                    </Button>
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {editable && (
        <>
          <input
            ref={input}
            type="file"
            hidden
            accept={role === 'LOGO' ? 'image/jpeg,image/png,image/webp' : 'image/jpeg,image/png,image/webp,application/pdf'}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) actions?.onSetFile?.(file, role)
              event.target.value = ''
            }}
          />
          <Button size="sm" heldReason={addHeld} onClick={() => input.current?.click()}>
            <ImagePlus size={13} aria-hidden /> {role === 'LOGO' ? t('set.addLogo') : t('set.addArtwork')}
          </Button>
        </>
      )}
    </div>
  )
}

/** The packaging rules: each a key, its words and — all three or none — a material, a quantity and what it is per. */
function Rules({ draft, editable, modal, problems, onRules }: { draft: SetDraft; editable: boolean; modal: SetModalModel; problems: readonly string[]; onRules: (rules: RuleDraft[]) => void }) {
  const t = useT('products-colours')
  const materials = modal.materials
  const at = (index: number, field: string) => problems.includes(`packagingRules/${index}/${field}`) || refusedField(modal.refused, `packagingRules/${index}/${field}`)
  if (!editable) {
    return draft.rules.length === 0 ? (
      <p className="fw-lib-hint">{t('set.noRules')}</p>
    ) : (
      <ul className="fw-lib-list">
        {draft.rules.map((rule) => (
          <li key={rule.key}>
            <b>{rule.key}</b> · {rule.text}
            {rule.itemId && <span className="fw-lib-sub"> · {t('set.ruleMaterial', { code: materials?.find((item) => item.id === rule.itemId)?.code ?? '—', quantity: rule.quantity, per: rule.per ? t(`per.${rule.per}`) : '' })}</span>}
          </li>
        ))}
      </ul>
    )
  }
  const put = (index: number, patch: Partial<RuleDraft>) => onRules(draft.rules.map((rule, at) => (at === index ? { ...rule, ...patch } : rule)))
  return (
    <div className="fw-col-rules">
      {draft.rules.length === 0 && <p className="fw-lib-hint">{t('set.noRules')}</p>}
      {draft.rules.map((rule, index) => (
        <fieldset key={index} className="fw-col-rule">
          <legend className="fw-lib-sub">{t('set.rule', { n: index + 1 })}</legend>
          <Field label={t('set.ruleKey')} hint={t('set.ruleKeyHint')} error={at(index, 'key') ? t('form.problem.ruleKey') : undefined}>
            <Input value={rule.key} maxLength={40} onChange={(event) => put(index, { key: event.target.value })} />
          </Field>
          <Field label={t('set.ruleText')} error={at(index, 'text') ? t('form.problem.ruleText') : undefined}>
            <Input value={rule.text} maxLength={500} onChange={(event) => put(index, { text: event.target.value })} />
          </Field>
          <Field label={t('set.ruleItem')} hint={materials === null ? t('set.noMaterialsRight') : undefined} error={at(index, 'itemId') ? t('form.problem.ruleItem') : undefined}>
            <Select value={rule.itemId} disabled={materials === null} onChange={(event) => put(index, { itemId: event.target.value, ...(event.target.value === '' ? { quantity: '', per: '' } : {}) })}>
              <option value="">{t('set.wordsOnly')}</option>
              {(materials ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {`${item.code} · ${item.name}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('set.ruleQuantity')} error={at(index, 'quantity') ? t('form.problem.ruleQuantity') : undefined}>
            <Input value={rule.quantity} inputMode="decimal" maxLength={14} disabled={!rule.itemId} onChange={(event) => put(index, { quantity: event.target.value })} />
          </Field>
          <Field label={t('set.rulePer')} error={at(index, 'per') ? t('form.problem.rulePer') : undefined}>
            <Select value={rule.per} disabled={!rule.itemId} onChange={(event) => put(index, { per: event.target.value as RuleDraft['per'] })}>
              <option value="">{t('set.pickPer')}</option>
              {PACKAGING_PER.map((per) => (
                <option key={per} value={per}>
                  {t(`per.${per}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Button size="sm" variant="quiet" aria-label={t('set.removeRule', { n: index + 1 })} onClick={() => onRules(draft.rules.filter((_, at) => at !== index))}>
            <Trash2 size={13} aria-hidden /> {t('set.remove')}
          </Button>
        </fieldset>
      ))}
      <Button size="sm" heldReason={draft.rules.length >= 50 ? t('set.rulesFull') : null} onClick={() => onRules([...draft.rules, emptyRule()])}>
        <Plus size={13} aria-hidden /> {t('set.addRule')}
      </Button>
    </div>
  )
}

/** The brand colours: swatches of the library's colours, each removable; one more picked from the active colours. */
function BrandColours({ draft, set, editable, modal, onColours }: { draft: SetDraft; set: NonNullable<SetModalModel['set']>; editable: boolean; modal: SetModalModel; onColours: (ids: string[]) => void }) {
  const t = useT('products-colours')
  const known = new Map([...set.colours, ...(modal.colours ?? [])].map((colour) => [colour.id, colour]))
  const choices = (modal.colours ?? []).filter((colour) => !draft.colourIds.includes(colour.id) && (colour.companyId === null || colour.companyId === set.companyId))
  return (
    <div className="fw-col-brand-colours">
      {draft.colourIds.length === 0 ? (
        <p className="fw-lib-hint">{t('set.noColours')}</p>
      ) : (
        <ul className="fw-col-chips">
          {draft.colourIds.map((id) => {
            const colour = known.get(id)
            if (!colour) return null
            return (
              <li key={id} className="fw-col-chip">
                <Swatch hex={colour.hex} name={colour.name} code={colour.code} withText noHex={t('swatch.noHex')} />
                {editable && (
                  <Button size="sm" variant="quiet" aria-label={t('set.removeColour', { code: colour.code })} onClick={() => onColours(draft.colourIds.filter((entry) => entry !== id))}>
                    <X size={13} aria-hidden />
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {editable && (
        <Field label={t('set.addColour')} hint={modal.colours === null ? t('set.readingColours') : undefined}>
          <Select value="" disabled={modal.colours === null || choices.length === 0} onChange={(event) => event.target.value && onColours([...draft.colourIds, event.target.value])}>
            <option value="">{choices.length === 0 && modal.colours !== null ? t('set.noMoreColours') : t('set.pickColour')}</option>
            {choices.map((colour) => (
              <option key={colour.id} value={colour.id}>
                {`${colour.code} · ${colour.name}${colour.reference ? ` · ${colour.reference}` : ''}`}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </div>
  )
}

/** Archive… / Restore… a set: what it does, a reason for the audit. */
function StatusDialog({ to, code, busy, actions }: { to: 'archive' | 'restore'; code: string; busy: boolean; actions?: ColoursActions }) {
  const t = useT('products-colours')
  const tl = useT('library')
  const [reason, setReason] = useState('')
  return (
    <Modal
      open
      onClose={() => actions?.onSetConfirm?.(null)}
      title={t(to === 'archive' ? 'set.archiveTitle' : 'set.restoreTitle', { code })}
      size="sm"
      footer={
        <>
          <Button onClick={() => actions?.onSetConfirm?.(null)}>{tl('common.back')}</Button>
          <Button variant={to === 'archive' ? 'danger' : 'primary'} heldReason={busy ? tl('held.busy') : null} onClick={() => actions?.onSetStatus?.(to, reason.trim())}>
            {t(to === 'archive' ? 'set.archive' : 'set.restore')}
          </Button>
        </>
      }
    >
      <div className="fw-lib-dialog">
        <p>{t(to === 'archive' ? 'set.archiveBody' : 'set.restoreBody')}</p>
        <Field label={tl('dialog.reason')} hint={tl('dialog.reasonHint')}>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} />
        </Field>
      </div>
    </Modal>
  )
}
