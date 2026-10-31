'use client'

import Link from 'next/link'
import { GARMENT_ZONES } from '@nexus/factory-domain/quality/defects/rules'
import { Banner, Field, FileDropzone, Modal } from '@nexus/ui/components'
import { Button, Input, Select, Spinner, Textarea } from '@nexus/ui/primitives'
import { useLocale } from '../../../../../lib/i18n/provider'
import { DEFECT_CLASSES, NCR_SOURCES, QUALITY_STAGES, UOMS, type Person, type SiteChoice } from '../../api'
import { recordLabel, type NcrCan } from '../../model'
import { NoticeLine, StagePill, useNcrWords } from '../../parts'
import type { ListDialog, NcrListActions, NewNcrDraft } from '../view-model'

const QUANTITY = /^\d{1,14}([.,]\d{1,4})?$/

/** Why Create NCR is held (null: it may be created), in the `ncr` catalogue. */
export function newHeldKey(dialog: Extract<ListDialog, { kind: 'new' }>, can: Pick<NcrCan, 'raise'>): string | null {
  const { draft, from } = dialog
  if (!can.raise) return 'new.heldRaise'
  if (from && from.prefill === null && from.problem === null) return 'new.heldReading'
  if (!(from?.prefill?.siteId ?? draft.siteId)) return 'new.heldSite'
  if (!draft.title.trim()) return 'new.heldTitle'
  if (!QUANTITY.test(draft.quantityAffected.trim()) || Number(draft.quantityAffected.replace(',', '.')) <= 0) return 'new.heldQuantity'
  if (!draft.severity) return 'new.heldSeverity'
  return null
}

/**
 * New NCR (design quality.ncr pop:ncr-new; QHS-080 "from anywhere", QHS-081 its content): prefilled from the record it is
 * raised from (what, where found, style, size, lot, serial, defect, photos) or typed by hand with its site; title,
 * quantity affected and suspect, severity, defect code (the library), where on the garment (the design's GarmentZoneMap,
 * composed here as a zone picker in words — a named stand-in), where found, owner, photos. The number is the factory's,
 * given at Create. Esc closes; focus returns to the opener (the DS Modal).
 */
export function NewNcrDialog({ prefix, dialog, sites, people, can, actions }: { prefix: string; dialog: Extract<ListDialog, { kind: 'new' }>; sites: readonly SiteChoice[] | null; people: readonly Person[] | null; can: NcrCan; actions?: NcrListActions }) {
  const { t } = useNcrWords()
  const lang = useLocale()
  const { draft, from } = dialog
  const prefill = from?.prefill ?? null
  const set = (patch: Partial<NewNcrDraft>) => actions?.onNewDraft?.(patch)
  const held = newHeldKey(dialog, can)
  const defects = Array.isArray(dialog.defects) ? dialog.defects : []
  const categories = [...new Map(defects.map((defect) => [defect.category.id, defect.category])).values()]
  const siteKnown = prefill?.siteId ? (sites?.find((site) => site.id === prefill.siteId) ?? null) : null
  return (
    <Modal
      open
      onClose={() => actions?.onDialogClose?.()}
      title={prefill ? t('new.titleFrom', { label: recordLabel(t, prefill.fromType, prefill.label) }) : t('new.title')}
      size="lg"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={() => actions?.onDialogClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held ? t(held) : null} disabled={dialog.busy} onClick={() => actions?.onSubmitNew?.()}>
            {dialog.busy ? <Spinner size={12} /> : null} {t('new.submit')}
          </Button>
        </>
      }
    >
      <div className="fw-q-stack">
        <p className="fw-q-hint">{t('new.intro')}</p>
        <NoticeLine notice={dialog.notice} />
        {from && from.prefill === null && from.problem === null && (
          <p className="fw-q-loading" role="status">
            <Spinner size={14} /> {t('new.reading')}
          </p>
        )}
        {from?.problem && <Banner tone="warning" title={t('new.readFailed')} />}
        {prefill && prefill.existing.length > 0 && (
          <Banner tone="info" title={t('new.existing', { count: prefill.existing.length })}>
            <ul className="fw-ncr-existing">
              {prefill.existing.map((ncr) => (
                <li key={ncr.id} className="fw-ncr-row">
                  <Link className="fw-q-link fw-q-code" href={`${prefix}/quality/ncr/${encodeURIComponent(ncr.id)}`}>
                    {ncr.number}
                  </Link>
                  <StagePill stage={ncr.stage} />
                </li>
              ))}
            </ul>
          </Banner>
        )}
        <div className="fw-ncr-form">
          {prefill?.siteId ? (
            <Field label={t('new.site')}>
              <span>{siteKnown ? `${siteKnown.code} · ${siteKnown.name}` : '—'}</span>
            </Field>
          ) : (
            <Field label={t('new.site')} required hint={sites === null ? undefined : sites.length === 0 ? t('new.sitesFailed') : undefined}>
              <Select size="sm" value={draft.siteId} onChange={(event) => set({ siteId: event.target.value })}>
                <option value="">{t('new.sitePick')}</option>
                {(sites ?? []).map((site) => (
                  <option key={site.id} value={site.id}>
                    {`${site.code} · ${site.name}`}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('new.owner')}>
            <Select size="sm" value={draft.ownerId} onChange={(event) => set({ ownerId: event.target.value })}>
              <option value="">{t('new.ownerNone')}</option>
              {(people ?? []).map((person) => (
                <option key={person.id} value={person.id}>
                  {person.me ? t('common.me', { name: person.name }) : person.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="is-wide">
            <Field label={t('new.fieldTitle')} hint={t('new.fieldTitleHint')} required>
              <Input size="sm" value={draft.title} maxLength={160} onChange={(event) => set({ title: event.target.value })} />
            </Field>
          </div>
          <div className="is-wide">
            <Field label={t('new.description')}>
              <Textarea value={draft.description} rows={3} maxLength={4000} onChange={(event) => set({ description: event.target.value })} />
            </Field>
          </div>
          <Field label={t('new.affected')} required>
            <span className="fw-ncr-row">
              <Input size="sm" inputMode="decimal" value={draft.quantityAffected} onChange={(event) => set({ quantityAffected: event.target.value })} aria-describedby="ncr-new-unit" />
              <Select size="sm" id="ncr-new-unit" aria-label={t('new.unit')} value={draft.uom} onChange={(event) => set({ uom: event.target.value as NewNcrDraft['uom'] })}>
                {UOMS.map((uom) => (
                  <option key={uom} value={uom}>
                    {t(`uom.${uom}`)}
                  </option>
                ))}
              </Select>
            </span>
          </Field>
          <Field label={t('new.suspect')} hint={t('new.suspectHint')}>
            <Input size="sm" inputMode="decimal" value={draft.quantitySuspect} onChange={(event) => set({ quantitySuspect: event.target.value })} />
          </Field>
          <Field label={t('new.severity')} required>
            <Select size="sm" value={draft.severity} onChange={(event) => set({ severity: event.target.value as NewNcrDraft['severity'] })}>
              <option value="">—</option>
              {DEFECT_CLASSES.map((severity) => (
                <option key={severity} value={severity}>
                  {t(`severity.${severity}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('new.defect')} hint={dialog.defects === 'failed' ? t('new.defectsFailed') : undefined}>
            <Select
              size="sm"
              value={draft.defectCodeId}
              onChange={(event) => {
                const picked = defects.find((defect) => defect.id === event.target.value)
                set({ defectCodeId: event.target.value, ...(picked && !draft.severity ? { severity: picked.severity } : {}), ...(picked?.zone && !draft.zone ? { zone: picked.zone } : {}) })
              }}
            >
              <option value="">{dialog.defects === null ? t('common.working') : t('new.defectNone')}</option>
              {categories.map((category) => (
                <optgroup key={category.id} label={lang === 'it' ? category.labelIt : category.labelEn}>
                  {defects
                    .filter((defect) => defect.category.id === category.id)
                    .map((defect) => (
                      <option key={defect.id} value={defect.id}>
                        {`${defect.code} · ${lang === 'it' ? defect.labelIt : defect.labelEn}`}
                      </option>
                    ))}
                </optgroup>
              ))}
            </Select>
          </Field>
          <Field label={t('new.zone')} hint={t('new.zoneHint')}>
            <Select size="sm" value={draft.zone} onChange={(event) => set({ zone: event.target.value })}>
              <option value="">{t('new.zoneNone')}</option>
              {GARMENT_ZONES.map((zone) => (
                <option key={zone.id} value={zone.id}>
                  {t(`zone.${zone.id}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('new.source')}>
            <Select size="sm" value={draft.source} onChange={(event) => set({ source: event.target.value as NewNcrDraft['source'] })}>
              {NCR_SOURCES.map((source) => (
                <option key={source} value={source}>
                  {t(`source.${source}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('new.foundAt')}>
            <Select size="sm" value={draft.foundAt} onChange={(event) => set({ foundAt: event.target.value as NewNcrDraft['foundAt'] })}>
              {QUALITY_STAGES.map((stage) => (
                <option key={stage} value={stage}>
                  {t(`foundAt.${stage}`)}
                </option>
              ))}
            </Select>
          </Field>
          <div className="is-wide">
            <Field label={t('new.photos')} hint={prefill && prefill.files.length > 0 ? t('new.photosFrom', { count: prefill.files.length }) : undefined}>
              {can.filesUpload ? (
                <div className="fw-q-stack">
                  <FileDropzone accept=".jpg,.jpeg,.png,.webp,.heic" multiple maxBytes={15 * 1024 * 1024} hint={t('new.photosAdd')} onFiles={(files) => actions?.onPhotos?.(files)} />
                  {draft.photos.length > 0 && <p className="fw-q-hint">{t('new.photosAdded', { count: draft.photos.length })}: {draft.photos.join(', ')}</p>}
                </div>
              ) : (
                <p className="fw-q-hint">{t('new.photosHeld')}</p>
              )}
            </Field>
          </div>
        </div>
      </div>
    </Modal>
  )
}
