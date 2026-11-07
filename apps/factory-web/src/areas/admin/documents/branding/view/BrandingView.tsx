'use client'

import { useEffect, useId, type ReactNode } from 'react'
import { ExternalLink, FileText, ImageOff, Mail, Palette, Store } from 'lucide-react'
import type { BrandingView as Branding } from '@nexus/factory-domain/branding/contracts'
import { LOGO_MAX_BYTES } from '@nexus/factory-domain/branding/rules'
import { Banner, Card, EmptyState, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, Pill, SegmentedControl, Select } from '@nexus/ui/primitives'
import { brandingAttrs, checkBranding } from '@nexus/ui/tokens/branding'
import '@nexus/ui/styles/branding.css'
import { EditModeBar, FileDropzone } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { ListKeysInfo } from '../../../../../list-frame/ListKeysInfo'
import type { ListKey } from '../../../../../list-frame/model'
import { WithMessages } from '../../../../../record-panels/i18n'
import { ListState, PageHead, StepUp } from '../../../shared/view/parts'
import { sampleHref } from '../../api'
import {
  accentUses,
  changesOf,
  draftOf,
  logoHeld,
  problemsOf,
  ratioWords,
  saveHeld,
  shownOf,
  tokensOf,
  type BrandingDraft,
  type BrandingPageView,
  type BrandingSectionModel,
  type LogoSlot,
} from '../model'
import '../branding.css'

export type { BrandingSectionModel } from '../model'

export interface BrandingActions {
  onView?: (view: BrandingPageView) => void
  onCompany?: (companyId: string) => void
  /** The form changed (null: back to what is saved). */
  onDraft?: (draft: BrandingDraft | null) => void
  /** A picture was picked for a logo: the container uploads it. */
  onPickLogo?: (slot: LogoSlot, file: File) => void
  onSave?: () => void
  onRetry?: () => void
  onDismissNotice?: () => void
  onSubmitStepUp?: (code: string) => void
  onCancelStepUp?: () => void
}

const NAMESPACES = ['admin', 'records', 'lists', 'admin-documents', 'admin-branding']

/**
 * SCR-014 › Branding (B-W2b-161; design admin.documents/sec:branding, a W2b section of a W0 page; PLT-228, SAL-064): the
 * company's logo and logo for dark pages, its accent colour (judged by the design system's contrast rule, per theme, in
 * words), the name its mail to partners goes out under and the name of its portal; beside them what partners will see —
 * the portal's head in the design system's branding tokens, the From line of a mail, the documents. Saved with the
 * EditModeBar (⌘S) and a fresh code. 1 / 2 / 5 switch the page's lists. Fetches nothing (BrandingSection.tsx reads the API).
 */
export function BrandingView({ model, actions }: { model: BrandingSectionModel; actions?: BrandingActions }) {
  return (
    <WithMessages namespaces={NAMESPACES}>
      <BrandingPage model={model} actions={actions} />
    </WithMessages>
  )
}

function useViewKeys(model: BrandingSectionModel, actions?: BrandingActions) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || model.stepUp?.open) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.closest('[role="dialog"]'))) return
      if (event.key === '1') actions?.onView?.('numbers')
      else if (event.key === '2') actions?.onView?.('documents')
      // B-W2b-177: Required documents.
      else if (event.key === '6') actions?.onView?.('required')
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model.stepUp?.open, actions])
}

function BrandingPage({ model, actions }: { model: BrandingSectionModel; actions?: BrandingActions }) {
  const t = useT('admin-branding')
  const td = useT('admin-documents')
  const ta = useT('admin')
  useViewKeys(model, actions)
  const active = model.companies.filter((company) => company.status === 'ACTIVE')
  const keys: ListKey[] = [
    { keys: ['1'], does: td('docs.keys.numbers') },
    { keys: ['2'], does: td('docs.keys.documents') },
    // 5: Branding's place among the design's six lists (E-mails and Labels, 3 and 4, come with their steps).
    { keys: ['5'], does: td('docs.keys.branding') },
    { keys: ['6'], does: td('docs.keys.required') },
    { keys: ['⌘', 'S'], does: t('brand.keys.save') },
  ]
  return (
    <div className="fw-adm fw-adm-docs fw-brand">
      <PageHead intro={t('brand.intro')} />
      <div className="fw-brand-band">
        <SegmentedControl
          ariaLabel={td('docs.views.label')}
          size="sm"
          value="branding"
          onChange={(value) => actions?.onView?.(value as BrandingPageView)}
          options={[
            { value: 'numbers', label: td('docs.views.numbers') },
            { value: 'documents', label: td('docs.views.documents') },
            { value: 'branding', label: td('docs.views.branding') },
            // B-W2b-177: Required documents.
            { value: 'required', label: td('docs.views.required') },
          ]}
        />
        {active.length > 1 && model.companyId && (
          <Select size="sm" aria-label={td('docs.company.label')} value={model.companyId} onChange={(event) => actions?.onCompany?.(event.target.value)}>
            {active.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </Select>
        )}
      </div>
      {model.notice && (
        <Banner tone={model.notice.tone} onDismiss={actions?.onDismissNotice}>
          {t(model.notice.key, model.notice.params)}
        </Banner>
      )}
      {model.read.status === 'ready' ? (
        <BrandingForm model={model} branding={model.read.branding} actions={actions} />
      ) : (
        <ListState loading={model.read.status === 'loading'} problem={model.read.status === 'failed' ? model.read.problem : null} onRetry={actions?.onRetry} rows={6} />
      )}
      {/* The page's keys: only in the foot's info icon (Owner rule 2026-10-29). */}
      <div className="fw-brand-foot">
        <ListKeysInfo keys={keys} />
      </div>
      <StepUp model={model.stepUp} onSubmit={actions?.onSubmitStepUp} onClose={actions?.onCancelStepUp} confirmLabel={ta('stepUp.confirm')} />
    </div>
  )
}

function BrandingForm({ model, branding, actions }: { model: BrandingSectionModel; branding: Branding; actions?: BrandingActions }) {
  const t = useT('admin-branding')
  const ta = useT('admin')
  const draft = model.draft ?? draftOf(branding)
  const changes = changesOf(branding, model.draft)
  const problems = problemsOf(draft)
  const held = saveHeld(model, branding, model.draft)
  const readOnly = !branding.mayChange
  const set = (patch: Partial<BrandingDraft>) => actions?.onDraft?.({ ...draft, ...patch })
  const company = model.companies.find((entry) => entry.id === branding.companyId)
  const locale = useLocale()
  return (
    <>
      <Card
        header={t('brand.title')}
        description={t('brand.description')}
        headingLevel={2}
        className="fw-brand-card"
        headerAction={
          company?.legalReady !== false ? (
            <a className="fw-adm-docs-link" href={sampleHref(branding.companyId, 'QUOTE', locale === 'en' ? 'en' : 'it')} target="_blank" rel="noopener noreferrer">
              {t('brand.preview.document')} <ExternalLink size={12} aria-hidden />
              <span className="fw-adm-sr">{t('brand.newTab')}</span>
            </a>
          ) : (
            <Button size="sm" variant="quiet" heldReason={t('brand.preview.heldLegal')}>
              {t('brand.preview.document')}
            </Button>
          )
        }
      >
        {!branding.saved && !model.draft && (
          <EmptyState
            icon={<Palette size={20} aria-hidden />}
            title={t('brand.empty.title')}
            description={t('brand.empty.body', { company: branding.companyName })}
            action={
              readOnly ? undefined : (
                <Button size="sm" variant="primary" onClick={() => document.getElementById('fw-brand-drop-logo')?.querySelector<HTMLElement>('button')?.focus()}>
                  {t('brand.empty.action')}
                </Button>
              )
            }
          />
        )}
        {readOnly && <p className="fw-brand-note">{t('brand.readOnly')}</p>}
        <div className="fw-brand-grid">
          <div className="fw-brand-fields">
            <LogoField slot="logo" model={model} branding={branding} draft={draft} actions={actions} />
            <LogoField slot="logoDark" model={model} branding={branding} draft={draft} actions={actions} />
            <AccentField draft={draft} companyName={branding.companyName} problem={problems.accent} readOnly={readOnly} onChange={(accent) => set({ accent })} />
            <Field label={t('brand.field.sender.label')} hint={t('brand.field.sender.hint', { company: branding.companyName })} error={problems.sender ? t(problems.sender, { max: 80 }) : undefined}>
              <Input value={draft.sender} maxLength={120} readOnly={readOnly} placeholder={branding.companyName} onChange={(event) => set({ sender: event.target.value })} />
            </Field>
            <Field label={t('brand.field.label.label')} hint={t('brand.field.label.hint', { company: branding.companyName })} error={problems.label ? t(problems.label, { max: 60 }) : undefined}>
              <Input value={draft.label} maxLength={100} readOnly={readOnly} placeholder={branding.companyName} onChange={(event) => set({ label: event.target.value })} />
            </Field>
          </div>
          <Previews draft={draft} branding={branding} />
        </div>
        {model.problem && (
          <Banner tone="danger" title={t('brand.problem.save')}>
            {ta(model.problem)}
          </Banner>
        )}
      </Card>
      {changes.length > 0 && (
        <EditModeBar
          count={changes.length}
          message={ta('form.unsaved', { count: changes.length })}
          applyLabel={ta('common.save')}
          applyHeldReason={held ? t(held) : null}
          busy={model.busy}
          saveShortcut
          onDiscard={() => actions?.onDraft?.(null)}
          onApply={() => actions?.onSave?.()}
        />
      )}
    </>
  )
}

function LogoField({ slot, model, branding, draft, actions }: { slot: LogoSlot; model: BrandingSectionModel; branding: Branding; draft: BrandingDraft; actions?: BrandingActions }) {
  const t = useT('admin-branding')
  const value = slot === 'logo' ? draft.logo : draft.logoDark
  const held = logoHeld(branding, draft, slot, model.uploading)
  const busy = model.uploading === slot
  const problem = model.uploadProblem?.slot === slot ? model.uploadProblem.key : null
  const id = useId()
  return (
    <div className="fw-brand-logo" id={`fw-brand-drop-${slot}`} role="group" aria-labelledby={id}>
      <span className="fw-brand-label" id={id}>
        {t(`brand.logo.${slot}.label`)}
      </span>
      <div className="fw-brand-logo-row">
        {/* Each logo on the ground it is made for, whatever the office's theme: the logo for dark pages on the dark theme's
            own surface (the DS tokens under `.dark`), a logo for light pages on white. */}
        <div className={`fw-brand-logo-box${slot === 'logoDark' ? ' dark' : value ? ' on-light' : ''}`}>
          {value ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value.src} alt={t('brand.logo.alt', { name: value.name })} />
          ) : (
            <span className="fw-brand-logo-none">
              <ImageOff size={16} aria-hidden /> {slot === 'logo' ? t('brand.logo.none') : t('brand.logo.noneDark')}
            </span>
          )}
        </div>
        <div className="fw-brand-logo-actions">
          {value && <span className="fw-brand-file">{value.name}</span>}
          {held ? (
            <Button size="sm" heldReason={t(held)}>
              {value ? t('brand.logo.replace') : t('brand.logo.add')}
            </Button>
          ) : (
            <FileDropzone
              accept=".png,.jpg,.jpeg"
              maxBytes={LOGO_MAX_BYTES}
              disabled={busy}
              hint={busy ? t('brand.logo.uploading') : t('brand.logo.hint')}
              onFiles={(files) => files[0] && actions?.onPickLogo?.(slot, files[0])}
            />
          )}
          {value && !held && (
            <Button size="sm" variant="quiet" onClick={() => actions?.onDraft?.(slot === 'logo' ? { ...draft, logo: null, logoDark: null } : { ...draft, logoDark: null })}>
              {t('brand.logo.remove')}
            </Button>
          )}
        </div>
      </div>
      <p className="fw-brand-hint">{slot === 'logo' ? t('brand.logo.logo.hint') : t('brand.logo.logoDark.hint')}</p>
      {problem && (
        <p className="fw-brand-error" role="alert">
          {t(problem)}
        </p>
      )}
    </div>
  )
}

function AccentField({ draft, companyName, problem, readOnly, onChange }: { draft: BrandingDraft; companyName: string; problem?: string; readOnly: boolean; onChange: (accent: string) => void }) {
  const t = useT('admin-branding')
  const locale = useLocale()
  const uses = accentUses(draft.accent, companyName)
  const colour = problem ? null : (checkBranding({ name: companyName || '-', accent: draft.accent }).light.colour ?? null)
  return (
    <Field label={t('brand.field.accent.label')} hint={t('brand.field.accent.hint')} error={problem ? t(problem) : undefined}>
      <div className="fw-brand-accent">
        {/* The company's own colour, shown as given (data, not an app colour). */}
        <span className={`fw-brand-swatch${colour ? '' : ' empty'}`} style={colour ? { background: colour } : undefined} aria-hidden />
        <Input value={draft.accent} maxLength={16} readOnly={readOnly} placeholder="#1f5fa8" spellCheck={false} onChange={(event) => onChange(event.target.value)} />
      </div>
      <ul className="fw-brand-uses" aria-live="polite">
        {uses.map((use) => (
          <li key={use.theme}>
            <Pill tone={use.use === 'PRIMARY' ? 'success' : use.use === 'ACCENT' ? 'warning' : 'neutral'} size="sm">
              {t(`brand.theme.${use.theme}`)}
            </Pill>{' '}
            {t(`brand.use.${use.use}`, { ratio: use.ratio === null ? '' : ratioWords(use.ratio, locale) })}
          </li>
        ))}
      </ul>
    </Field>
  )
}

function Previews({ draft, branding }: { draft: BrandingDraft; branding: Branding }) {
  const t = useT('admin-branding')
  const tokens = tokensOf(draft, branding.companyName)
  const brand = checkBranding(tokens)
  const shown = shownOf(draft, branding.companyName)
  const darkLogo = brand.logoDarkUrl && brand.logoDarkUrl !== brand.logoUrl ? brand.logoDarkUrl : null
  return (
    <aside className="fw-brand-previews" aria-label={t('brand.preview.label')}>
      <PreviewBlock icon={<Store size={14} aria-hidden />} title={t('brand.preview.portal')}>
        {/* The portal's head as partners see it before they type anything: the DS branding tokens on this subtree. */}
        <div className="fw-brand-portal" {...brandingAttrs(brand)} inert>
          <div className="fw-brand-portal-head">
            {brand.logoUrl ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className={`fw-brand-portal-logo${darkLogo ? ' for-light' : ''}`} src={brand.logoUrl} alt={brand.name} />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {darkLogo && <img className="fw-brand-portal-logo for-dark" src={darkLogo} alt={brand.name} />}
              </>
            ) : (
              <span className="fw-brand-portal-name">{brand.name}</span>
            )}
          </div>
          <span className="fw-brand-portal-rule" aria-hidden />
          <p className="fw-brand-portal-title">{t('brand.preview.portalTitle', { portal: shown.portal })}</p>
          <div className="fw-brand-portal-actions">
            <Button size="sm" variant="primary">
              {t('brand.preview.portalButton')}
            </Button>
            <span className="fw-brand-portal-link">{t('brand.preview.portalLink')}</span>
          </div>
        </div>
      </PreviewBlock>
      <PreviewBlock icon={<Mail size={14} aria-hidden />} title={t('brand.preview.mail')}>
        <KeyValue
          dense
          labelCase="sentence"
          items={[
            { label: t('brand.preview.mailFrom'), value: t('brand.preview.mailFromValue', { sender: shown.sender }) },
            { label: t('brand.preview.mailSignature'), value: t('brand.preview.mailSignatureValue', { sender: shown.sender }) },
          ]}
        />
      </PreviewBlock>
      <PreviewBlock icon={<FileText size={14} aria-hidden />} title={t('brand.preview.documents')}>
        <p className="fw-brand-hint">{draft.logo ? t('brand.preview.documentsLogo') : t('brand.preview.documentsName', { company: branding.companyName })}</p>
        <p className="fw-brand-hint">{t('brand.preview.documentsSaved')}</p>
      </PreviewBlock>
    </aside>
  )
}

function PreviewBlock({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="fw-brand-preview">
      <h3 className="fw-brand-preview-title">
        {icon} {title}
      </h3>
      {children}
    </section>
  )
}
