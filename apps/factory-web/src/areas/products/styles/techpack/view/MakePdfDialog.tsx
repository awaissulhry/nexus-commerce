'use client'

import { ExternalLink, WifiOff } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, SegmentedControl, Select, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import type { CopyPartyRow } from '../api'
import { AUDIENCES, LANGUAGES, makeHeld, NS, partyChoices, partyName, SECTIONS, withSection, type MakeDraft, type PrivateLabel, type Read, type TechPackCan, type TechPackSection } from '../model'

/** pop:styles.techpackPdf — Make tech pack PDF (the Tech pack tab, the band's ⋯, the PDF window). */
export interface MakeDialogModel {
  /** "DEMO-JKT-01 · revision 3 (draft)": what the PDF is of. */
  styleCode: string
  revision: { revision: number; status: 'DRAFT' | 'RELEASED' | 'OBSOLETE' } | null
  draft: MakeDraft
  /** The sections this person may see (the others are held with why). */
  allowed: readonly TechPackSection[]
  /** The parties a partner copy may name (parties.view); null: not read (no right), the copy names nobody. */
  parties: Read<CopyPartyRow[]> | null
  privateLabel: PrivateLabel | null
  busy: boolean
  /** A refused Make PDF in our words (a key). */
  problem: string | null
  /** Opens in a new tab (the tab, the band) or here (the window). */
  opensHere: boolean
}

export interface MakeDialogActions {
  onDraft?: (patch: Partial<MakeDraft>) => void
  onSubmit?: () => void
  onClose?: () => void
}

/**
 * Make tech pack PDF (design pop:styles.techpackPdf "Audience, sections, language · Make PDF (opens in a new tab)"): who it is for
 * (the server leaves out what that audience never gets: a partner copy has no cost, margin, pay figure, minutes or supplier
 * name), its language, the party a partner copy is for (printed on its cover; a private-label style's brand copy is for that
 * brand only), the sections. Make PDF is held with its reason; ⌘↵ makes it. Fetches nothing.
 */
export function MakePdfDialog({ model, can, online, actions }: { model: MakeDialogModel; can: TechPackCan; online: boolean; actions?: MakeDialogActions }) {
  const t = useT(NS)
  const { draft } = model
  const held = makeHeld(draft, { can, online, busy: model.busy, revision: model.revision !== null, privateLabel: model.privateLabel, allowed: model.allowed })
  const parties = partyChoices(draft.audience, model.parties?.status === 'ready' ? model.parties.value : null, model.privateLabel)
  const go = () => {
    if (!held) actions?.onSubmit?.()
  }
  const close = () => actions?.onClose?.()
  return (
    <Modal
      open
      onClose={close}
      size="md"
      title={t('techpack.make.title')}
      subtitle={model.revision ? t('techpack.make.subtitle', { code: model.styleCode, revision: model.revision.revision, status: t(`techpack.revisionStatus.${model.revision.status}`) }) : model.styleCode}
      footer={
        <>
          <Button onClick={close}>{t('techpack.common.back')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={go} aria-keyshortcuts="Meta+Enter Control+Enter">
            {model.busy ? <Spinner size={12} /> : model.opensHere ? null : <ExternalLink size={13} aria-hidden />} {t(model.opensHere ? 'techpack.make.goHere' : 'techpack.make.go')}
          </Button>
        </>
      }
    >
      <div
        className="fw-tp-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            go()
          }
        }}
      >
        {!online && <Banner tone="warning" title={<span className="fw-tp-inline"><WifiOff size={14} aria-hidden /> {t('techpack.held.offline')}</span>} />}
        {model.problem && <Banner tone="danger" title={t(model.problem)} />}
        <Field label={t('techpack.make.audience')} hint={t(`techpack.audienceHint.${draft.audience}`)}>
          <SegmentedControl
            ariaLabel={t('techpack.make.audience')}
            size="sm"
            wrap
            value={draft.audience}
            onChange={(value) => actions?.onDraft?.({ audience: AUDIENCES.find((entry) => entry === value) ?? 'INTERNAL' })}
            options={AUDIENCES.map((audience) => ({ value: audience, label: t(`techpack.audience.${audience}`) }))}
          />
        </Field>
        <div className="fw-tp-form-grid">
          <Field label={t('techpack.make.language')} hint={t('techpack.make.languageHint')}>
            <Select value={draft.language} onChange={(event) => actions?.onDraft?.({ language: LANGUAGES.find((entry) => entry === event.target.value) ?? 'it' })}>
              {LANGUAGES.map((language) => (
                <option key={language} value={language}>
                  {t(`techpack.language.${language}`)}
                </option>
              ))}
            </Select>
          </Field>
          {draft.audience !== 'INTERNAL' && (
            <Field label={t(draft.audience === 'BRAND' ? 'techpack.make.forBrand' : 'techpack.make.forWorkshop')} hint={model.privateLabel && draft.audience === 'BRAND' ? t('techpack.make.privateLabelHint', { brand: model.privateLabel.name }) : model.parties === null ? t('techpack.make.noPartiesRight') : t('techpack.make.partyHint')}>
              {model.parties?.status === 'loading' && !(model.privateLabel && draft.audience === 'BRAND') ? (
                <span className="fw-tp-hint" role="status">
                  <Spinner size={12} /> {t('techpack.make.partiesLoading')}
                </span>
              ) : (
                <Select value={draft.partyId ?? ''} disabled={parties.length === 0} onChange={(event) => actions?.onDraft?.({ partyId: event.target.value || null })}>
                  {!(model.privateLabel && draft.audience === 'BRAND') && <option value="">{t('techpack.make.nobody')}</option>}
                  {parties.map((party) => (
                    <option key={party.id} value={party.id}>
                      {partyName(party)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
        </div>
        <fieldset className="fw-tp-fieldset">
          <legend className="fw-tp-legend">{t('techpack.make.sections', { count: draft.sections.length })}</legend>
          <div className="fw-tp-checks">
            {SECTIONS.map((section) => {
              const mine = model.allowed.includes(section)
              return (
                <Checkbox
                  key={section}
                  label={
                    <span className="fw-tp-check-label">
                      {t(`techpack.section.${section}`)}
                      {!mine && <span className="fw-tp-hint"> · {t(`techpack.why.${section}`)}</span>}
                    </span>
                  }
                  checked={draft.sections.includes(section)}
                  disabled={!mine}
                  onChange={(event) => actions?.onDraft?.({ sections: withSection(draft.sections, section, event.target.checked) })}
                />
              )
            })}
          </div>
        </fieldset>
        <p className="fw-tp-hint">{t(draft.audience === 'INTERNAL' ? 'techpack.make.noMoneyInternal' : 'techpack.make.noMoneyPartner')}</p>
        <p className="fw-tp-hint">{t('techpack.make.versionRule')}</p>
      </div>
    </Modal>
  )
}
