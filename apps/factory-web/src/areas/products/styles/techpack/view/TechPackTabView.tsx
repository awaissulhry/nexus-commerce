'use client'

import Link from 'next/link'
import { ExternalLink, FileText, RefreshCw, ShieldCheck, WifiOff } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { Button, Checkbox, SegmentedControl, Select, Skeleton, Spinner } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { StyleTab } from '../../model'
import type { TechPackVersion, TechPackView } from '../api'
import { AUDIENCES, bannerWords, LANGUAGES, makeHeld, NAMESPACES, newestFirst, NS, SECTION_HOME, SECTIONS, valueOf, versionWords, windowAddress, type Read, type TechPackAudience, type TechPackCan, type TechPackLanguage, type TechPackSection, type Words } from '../model'
import { MakePdfDialog, type MakeDialogActions, type MakeDialogModel } from './MakePdfDialog'
import { BomSection, ColourwaysSection, ComplianceSection, ConstructionSection, CoverSection, LabelsSection, PicturesTable, ProtectionSection, RevisionLogSection, SizeSpecSection } from './Sections'
import '../techpack.css'

/** SCR-305 — Style › Tech pack (design products.styles rec:Style tab style.techpack). */
export interface TechPackTabModel {
  /** `/w/<company>`. */
  prefix: string
  styleId: string
  styleCode: string
  /** The revision in view (the studio's); null: the style has none yet. */
  revision: { id: string; revision: number; status: 'DRAFT' | 'RELEASED' | 'OBSOLETE' } | null
  can: TechPackCan
  /** The style's tabs this person opens (a section links only to a tab they can open). */
  tabs: readonly StyleTab[]
  audience: TechPackAudience
  language: TechPackLanguage
  /** The Contents: the sections chosen (what shows here, and what Make PDF starts with). */
  sections: readonly TechPackSection[]
  /** The live view for the audience (null: no revision to read). */
  view: Read<TechPackView> | null
  versions: Read<TechPackVersion[]> | null
  online: boolean
  make: MakeDialogModel | null
  notice: TechPackNotice | null
}

export interface TechPackNotice extends Words {
  tone: 'success' | 'info' | 'warning' | 'danger'
  /** The version made (or found), opened in the PDF window. */
  versionId?: string | null
}

export interface TechPackTabActions {
  onAudience?: (audience: TechPackAudience) => void
  onLanguage?: (language: TechPackLanguage) => void
  onSection?: (section: TechPackSection, on: boolean) => void
  onAllSections?: (on: boolean) => void
  onRetry?: () => void
  onMake?: () => void
  make?: MakeDialogActions
  onDismissNotice?: () => void
}

/**
 * The style's Tech pack tab (design style.techpack; PRD-130 the live tech pack, PRD-133 per audience): a VIEW of the live
 * revision, section by section, for one audience — the audience switch IS the preview: what a workshop or a brand never gets
 * (costs, minutes, supplier names, internal notes …) is left out by the server, not hidden here. The Contents put a section in
 * or leave it out (and link to where its data lives); the PDF versions open in the PDF window (a new tab); Make tech pack PDF
 * makes a new version (or says nothing changed). Fetches nothing: TechPackTab.tsx loads it.
 */
export function TechPackTabView({ model, actions }: { model: TechPackTabModel; actions?: TechPackTabActions }) {
  return (
    <WithMessages namespaces={[...NAMESPACES]}>
      <Tab model={model} actions={actions} />
    </WithMessages>
  )
}

function Tab({ model, actions }: { model: TechPackTabModel; actions?: TechPackTabActions }) {
  const t = useT(NS)
  const tp = useT('products')
  const locale = useLocale()
  if (!model.revision) {
    return (
      <Card padded>
        <EmptyState icon={<FileText size={24} aria-hidden />} title={t('techpack.tab.noRevision.title')} description={t('techpack.tab.noRevision.body')} />
      </Card>
    )
  }
  const view = valueOf(model.view)
  const allowed = view ? view.sections.filter((entry) => entry.allowed).map((entry) => entry.section) : []
  const held = makeHeld(
    { audience: model.audience, language: model.language, sections: [...model.sections], partyId: null },
    { can: model.can, online: model.online, busy: false, revision: true, privateLabel: null, allowed: view ? allowed : SECTIONS },
  )
  const banner = view ? bannerWords(view) : null
  const recordHref = `${model.prefix}/products/styles/${model.styleId}`
  const tabHref = (tab: StyleTab, revisionId: string | null) => `${recordHref}?tab=${tab}${revisionId ? `&rev=${revisionId}` : ''}`

  return (
    <div className="fw-tp">
      <Card padded className="fw-tp-bar-card">
        <div className="fw-tp-bar">
          <div className="fw-tp-bar-main">
            <span className="fw-tp-label" id="fw-tp-audience">
              {t('techpack.tab.audience')}
            </span>
            <SegmentedControl
              ariaLabel={t('techpack.tab.audience')}
              size="sm"
              wrap
              value={model.audience}
              onChange={(value) => actions?.onAudience?.(AUDIENCES.find((entry) => entry === value) ?? 'INTERNAL')}
              options={AUDIENCES.map((audience) => ({ value: audience, label: t(`techpack.audienceLong.${audience}`) }))}
            />
            <label className="fw-tp-inline">
              <span className="fw-tp-label">{t('techpack.tab.language')}</span>
              <Select size="sm" value={model.language} onChange={(event) => actions?.onLanguage?.(LANGUAGES.find((entry) => entry === event.target.value) ?? 'it')}>
                {LANGUAGES.map((language) => (
                  <option key={language} value={language}>
                    {t(`techpack.language.${language}`)}
                  </option>
                ))}
              </Select>
            </label>
          </div>
          <Button size="sm" variant="primary" heldReason={held && held !== 'techpack.held.noSections' ? t(held) : null} onClick={() => actions?.onMake?.()}>
            <FileText size={13} aria-hidden /> {t('techpack.tab.make')}
          </Button>
        </div>
        <p className="fw-tp-hint fw-tp-note">
          <ShieldCheck size={14} aria-hidden className="fw-tp-note-icon" />
          <span>
            {model.audience === 'INTERNAL'
              ? t(model.can.cost ? 'techpack.tab.internalCost' : 'techpack.tab.internal')
              : t('techpack.tab.leftOut', { list: (view?.leftOut ?? []).map((entry) => t(`techpack.leftOut.${entry.kind}`)).join(', ') || '—' })}
          </span>
        </p>
        {model.language !== locale && <p className="fw-tp-hint">{t('techpack.tab.otherLanguage', { language: t(`techpack.language.${model.language}`) })}</p>}
      </Card>

      {!model.online && <Banner tone="warning" title={<span className="fw-tp-inline"><WifiOff size={14} aria-hidden /> {t('techpack.tab.offline')}</span>} />}
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            <span className="fw-tp-inline">
              {model.notice.versionId && (
                <Button size="sm" asChild>
                  <a href={windowAddress(model.prefix, { styleId: model.styleId, revisionId: model.revision.id, versionId: model.notice.versionId })} target="_blank" rel="noopener">
                    <ExternalLink size={13} aria-hidden /> {t('techpack.tab.openPdf')}
                  </a>
                </Button>
              )}
              {actions?.onDismissNotice && (
                <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                  {t('techpack.common.dismiss')}
                </Button>
              )}
            </span>
          }
        />
      )}
      {banner && (
        <Banner
          tone={view?.revision.status === 'DRAFT' ? 'info' : 'warning'}
          title={t(banner.key, banner.params)}
          action={
            view?.inForce && view.inForce.id !== model.revision.id ? (
              <Button size="sm" asChild>
                <Link href={tabHref('techpack', view.inForce.id)}>{t('techpack.tab.goInForce', { revision: view.inForce.revision })}</Link>
              </Button>
            ) : undefined
          }
        />
      )}

      <div className="fw-tp-body">
        <aside className="fw-tp-side" aria-label={t('techpack.tab.side')}>
          <Card
            header={t('techpack.contents.title')}
            headingLevel={3}
            description={t('techpack.contents.intro')}
            headerAction={
              <Button size="sm" variant="quiet" onClick={() => actions?.onAllSections?.(model.sections.length < allowed.length)} disabled={!view}>
                {model.sections.length < allowed.length ? t('techpack.contents.all') : t('techpack.contents.none')}
              </Button>
            }
          >
            <ol className="fw-tp-outline">
              {SECTIONS.map((section, index) => {
                const entry = view?.sections.find((candidate) => candidate.section === section)
                const mine = entry ? entry.allowed : true
                const home = SECTION_HOME[section]
                return (
                  <li key={section} className="fw-tp-outline-item">
                    <span className="fw-tp-outline-n" aria-hidden>
                      {index + 1}
                    </span>
                    <span className="fw-tp-cell">
                      <Checkbox label={t(`techpack.section.${section}`)} checked={mine && model.sections.includes(section)} disabled={!mine || !view} onChange={(event) => actions?.onSection?.(section, event.target.checked)} />
                      {!mine ? (
                        <span className="nds-summary-sub">{t(`techpack.why.${section}`)}</span>
                      ) : model.tabs.includes(home) ? (
                        <Link className="fw-tp-link" href={tabHref(home, model.revision!.id)}>
                          {t('techpack.contents.livesIn', { tab: tp(`tab.${home}`) })}
                        </Link>
                      ) : null}
                    </span>
                  </li>
                )
              })}
            </ol>
          </Card>
          <VersionsCard model={model} locale={locale} />
        </aside>

        <div className="fw-tp-main">
          {model.view === null || model.view.status === 'loading' ? (
            <Card padded aria-busy="true">
              <p className="fw-tp-hint" role="status">
                <Spinner size={14} /> {t('techpack.tab.loading')}
              </p>
              <div className="fw-tp-stack">
                {Array.from({ length: 5 }, (_, index) => (
                  <Skeleton key={index} height={22} />
                ))}
              </div>
            </Card>
          ) : model.view.status === 'error' ? (
            <Banner
              tone="danger"
              title={t('techpack.tab.failed')}
              action={
                <Button size="sm" onClick={() => actions?.onRetry?.()}>
                  <RefreshCw size={13} aria-hidden /> {t('techpack.common.retry')}
                </Button>
              }
            >
              {t(model.view.problem)}
            </Banner>
          ) : (
            <SectionCards view={model.view.value} chosen={model.sections} tabs={model.tabs} tabHref={(tab) => tabHref(tab, model.revision!.id)} />
          )}
        </div>
      </div>

      {model.make && <MakePdfDialog model={model.make} can={model.can} online={model.online} actions={actions?.make} />}
    </div>
  )
}

function SectionCards({ view, chosen, tabs, tabHref }: { view: TechPackView; chosen: readonly TechPackSection[]; tabs: readonly StyleTab[]; tabHref: (tab: StyleTab) => string }) {
  const t = useT(NS)
  const tp = useT('products')
  const locale = useLocale()
  const range = view.style.sizes.map((size) => size.code)
  const shown = SECTIONS.filter((section) => chosen.includes(section) && view.sections.find((entry) => entry.section === section)?.allowed)
  if (shown.length === 0) {
    return (
      <Card padded>
        <EmptyState icon={<FileText size={24} aria-hidden />} title={t('techpack.tab.nothing.title')} description={t('techpack.tab.nothing.body')} />
      </Card>
    )
  }
  const body = (section: TechPackSection) => {
    switch (section) {
      case 'COVER':
        return <CoverSection view={view} />
      case 'SKETCHES':
        return <PicturesTable pictures={view.sketches ?? []} label={t('techpack.section.SKETCHES')} />
      case 'BOM':
        return view.bom ? <BomSection bom={view.bom} /> : null
      case 'COLOURWAYS':
        return view.colourways ? <ColourwaysSection colourways={view.colourways} /> : null
      case 'SIZE_SPEC':
        return view.sizeSpec ? <SizeSpecSection spec={view.sizeSpec} locale={locale} /> : <p className="fw-tp-hint">{t('techpack.spec.none')}</p>
      case 'CONSTRUCTION':
        return view.construction ? <ConstructionSection construction={view.construction} locale={locale} /> : null
      case 'LABELS':
        return view.labels ? <LabelsSection labels={view.labels} /> : null
      case 'PROTECTION':
        return view.protection ? <ProtectionSection protection={view.protection} range={range} locale={locale} /> : null
      case 'COMPLIANCE':
        return view.compliance ? <ComplianceSection compliance={view.compliance} view={view} /> : null
      case 'REVISION_LOG':
        return view.revisionLog ? <RevisionLogSection log={view.revisionLog} locale={locale} /> : null
    }
  }
  return (
    <div className="fw-tp-stack-lg">
      {shown.map((section, index) => {
        const home = SECTION_HOME[section]
        return (
          <Card
            key={section}
            header={`${index + 1}. ${t(`techpack.section.${section}`)}`}
            headingLevel={3}
            headerAction={
              tabs.includes(home) ? (
                <Link className="fw-tp-link" href={tabHref(home)}>
                  {t('techpack.contents.livesIn', { tab: tp(`tab.${home}`) })}
                </Link>
              ) : undefined
            }
          >
            {body(section)}
          </Card>
        )
      })}
    </div>
  )
}

function VersionsCard({ model, locale }: { model: TechPackTabModel; locale: 'it' | 'en' }) {
  const t = useT(NS)
  const versions = valueOf(model.versions)
  return (
    <Card header={t('techpack.versions.title')} headingLevel={3} description={t('techpack.versions.intro')}>
      {model.versions === null || model.versions.status === 'loading' ? (
        <p className="fw-tp-hint" role="status">
          <Spinner size={12} /> {t('techpack.versions.loading')}
        </p>
      ) : model.versions.status === 'error' ? (
        <p className="fw-tp-hint">{t('techpack.versions.failed')}</p>
      ) : versions && versions.length > 0 ? (
        <ul className="fw-tp-versions">
          {newestFirst(versions).map((version) => {
            const words = versionWords(version)
            return (
              <li key={version.id} className="fw-tp-version">
                <span className="fw-tp-cell">
                  <a className="fw-tp-link" href={windowAddress(model.prefix, { styleId: model.styleId, revisionId: model.revision!.id, versionId: version.id })} target="_blank" rel="noopener">
                    {t(words.key, { ...words.params, audience: version.audience ? t(`techpack.audience.${version.audience}`) : '', language: t(`techpack.language.${version.language === 'en' ? 'en' : 'it'}`) })} <ExternalLink size={12} aria-label={t('techpack.versions.newTab')} />
                  </a>
                  <span className="nds-summary-sub">{[words.params?.code, formatDateTime(version.createdAt, { locale }), version.createdBy].filter(Boolean).join(' · ')}</span>
                </span>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="fw-tp-hint">{t('techpack.versions.none')}</p>
      )}
    </Card>
  )
}
