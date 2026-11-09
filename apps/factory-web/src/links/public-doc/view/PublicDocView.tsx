'use client'

import type { FormEvent, ReactNode } from 'react'
import { Award, Download, ExternalLink, FileCheck2, Info, QrCode as QrIcon, SearchX, ShieldAlert, ShieldCheck, Shirt } from 'lucide-react'
import { Banner, Card, Disclosure, EmptyState, Field, FileRow, KeyValue, Listbox } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Input, Pill, Skeleton, Spinner } from '@nexus/ui/primitives'
import { formatDate } from '../../../lib/i18n/format'
import type { Translate } from '../../../lib/i18n/messages'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../lib/pdf/labels'
import { WithMessages } from '../../../record-panels/i18n'
import { LinkFrameView } from '../../../shell/links/view/LinkFrameView'
import type { PublicDocFile, PublicDocPage } from '@nexus/factory-domain/compliance/public-doc/contracts'
import { careText, dayInstant, fileIn, languageName, monthOf, pdfName, publicDocFileUrl, readerFirst, spanMonths, styleName, type PublicDocActions, type PublicDocViewModel } from '../model'
import '../public-doc.css'

export type { PublicDocActions, PublicDocViewModel } from '../model'

/**
 * SCR-102 — the public DoC (design links.doc, link-page; PRD-294, PRD-356; Reg. (EU) 2016/425 art. 8(8), Reg. (EU)
 * 2023/988 art. 19): what the QR on the garment label and in the instructions opens, for anyone, with no sign-in. The link
 * frame (the sender's logo and name, the language, whom to ask, the privacy notice) around the page: this product (the
 * style, the batch from the QR, the legal maker — the brand for private label), the declaration valid for this batch in
 * the reader's language (the PDF read in the page, every published language one choice away, Download, the PDF in a new
 * tab), the certificate summary, the instructions and safety information of the same revision, the earlier versions with
 * the batches they cover, and Type the code when the QR is damaged. No price, no person. The recall notice (W2b-4) and
 * Report a problem (W2b-5) join later.
 */
export function PublicDocView({ model, actions }: { model: PublicDocViewModel; actions?: PublicDocActions }) {
  return (
    <WithMessages namespaces={['public-doc']}>
      <PublicDocPageView model={model} actions={actions} />
    </WithMessages>
  )
}

function PublicDocPageView({ model, actions }: { model: PublicDocViewModel; actions?: PublicDocActions }) {
  const t = useT('public-doc')
  const page = model.page
  const title = page && model.kind === 'found' ? t('title', { style: styleName(page, model.readerLanguages) }) : t('titleLookup')
  return (
    <LinkFrameView model={{ sender: model.sender, title, body: { kind: 'task' }, timeZone: model.timeZone }}>
      {model.kind === 'loading' ? (
        <LoadingBody slow={model.slow} />
      ) : model.kind === 'error' ? (
        <Card padded className="fw-link-state tone-danger">
          <EmptyState
            icon={<ShieldAlert size={28} aria-hidden />}
            title={t('error.title')}
            description={t('error.body')}
            action={
              <Button variant="primary" onClick={() => actions?.onRetry?.()}>
                {t('error.retry')}
              </Button>
            }
          />
        </Card>
      ) : model.kind === 'found' && page ? (
        <FoundBody page={page} model={model} actions={actions} />
      ) : (
        <div className="fw-pd">
          <p className="fw-pd-hint">{t('intro')}</p>
          <LookupCard model={model} actions={actions} first />
        </div>
      )}
    </LinkFrameView>
  )
}

// ---- loading: the shape of what comes --------------------------------------------------------------------------------------

function LoadingBody({ slow }: { slow: boolean }) {
  const t = useT('public-doc')
  return (
    <div className="fw-pd" aria-busy="true">
      <Card padded className="fw-pd-card">
        <Skeleton width="40%" height={20} />
        <Skeleton height={44} />
        <Skeleton width="70%" height={18} />
      </Card>
      <Card padded className="fw-pd-card">
        <Skeleton width="50%" height={20} />
        <Skeleton height={320} />
      </Card>
      <p className="fw-pd-hint" role="status">
        {slow ? (
          <>
            <Spinner size={14} /> {t('loading.slow')}
          </>
        ) : (
          t('loading.label')
        )}
      </p>
    </div>
  )
}

// ---- the page ---------------------------------------------------------------------------------------------------------------

function FoundBody({ page, model, actions }: { page: PublicDocPage; model: PublicDocViewModel; actions?: PublicDocActions }) {
  const t = useT('public-doc')
  return (
    <div className="fw-pd">
      {page.others.length > 0 && <OthersBanner page={page} actions={actions} />}
      <ProductSection page={page} model={model} />
      <DeclarationSection page={page} model={model} actions={actions} />
      {page.ppe.category !== 'NOT_PPE' && <CertificateSection page={page} />}
      <InstructionsSection page={page} model={model} />
      {page.ppe.category !== 'NOT_PPE' && <VersionsSection page={page} model={model} />}
      <LookupCard model={model} actions={actions} />
      <div className="fw-pd-foot">
        <p className="fw-pd-hint fw-pd-code">
          <QrIcon size={14} aria-hidden /> <span className="fw-pd-mono">{page.code}</span>
        </p>
        <p className="fw-pd-hint">{t('intro')}</p>
      </div>
    </div>
  )
}

/** A section's heading row: its icon and title (the card's name for assistive technology), a status, a line of help. */
function SectionHead({ id, icon, title, hint, extra }: { id: string; icon: ReactNode; title: string; hint?: string; extra?: ReactNode }) {
  return (
    <div className="fw-pd-head">
      <h2 className="fw-pd-h2" id={id}>
        {icon} {title}
      </h2>
      {extra}
      {hint && <p className="fw-pd-hint fw-pd-head-hint">{hint}</p>}
    </div>
  )
}

function StandingPill({ page, locale }: { page: PublicDocPage; locale: string }) {
  const t = useT('public-doc')
  if (!page.declaration) return null
  return page.declaration.standing === 'CURRENT' ? (
    <Pill tone="success">{t('standing.CURRENT')}</Pill>
  ) : (
    <Pill tone="warning">{t('standing.EARLIER', { month: monthOf(page.declaration.before!, locale) })}</Pill>
  )
}

// sec:product — What the QR points to.
function ProductSection({ page, model }: { page: PublicDocPage; model: PublicDocViewModel }) {
  const t = useT('public-doc')
  const locale = useLocale()
  const day = (value: string) => formatDate(dayInstant(value), { locale, timeZone: 'UTC' })
  const { product } = page
  const items = [
    { label: t('product.style'), value: t('product.styleValue', { name: styleName(page, model.readerLanguages), code: product.style.code }) },
    ...(product.batch ? [{ label: t('product.batch'), value: <span className="fw-pd-mono">{product.batch.number}</span> }, { label: t('product.made'), value: day(product.batch.releasedOn) }] : []),
    {
      label: t('product.maker'),
      value: product.maker ? (
        <span className="fw-pd-lines">
          <span>{product.maker.name}</span>
          <span>{product.maker.address}</span>
        </span>
      ) : (
        t('product.noMaker')
      ),
      ...(product.maker?.role === 'BRAND' ? { hint: t('product.makerBrand') } : {}),
    },
    ...(product.importer
      ? [
          {
            label: t('product.importer'),
            value: (
              <span className="fw-pd-lines">
                <span>{product.importer.name}</span>
                <span>{product.importer.address}</span>
              </span>
            ),
          },
        ]
      : []),
  ]
  return (
    <Card padded className="fw-pd-card" aria-labelledby="fw-pd-product">
      <SectionHead id="fw-pd-product" icon={<Shirt size={18} aria-hidden />} title={t('product.heading')} extra={<StandingPill page={page} locale={locale} />} />
      <p className="fw-pd-lead">{product.batch ? t('product.scannedBatch', { batch: product.batch.number }) : t('product.scannedStyle', { code: product.style.code })}</p>
      <KeyValue items={items} labelCase="sentence" columns={2} />
    </Card>
  )
}

// sec:declaration — The DoC valid for this batch, in the reader's language (PRD-294).
function DeclarationSection({ page, model, actions }: { page: PublicDocPage; model: PublicDocViewModel; actions?: PublicDocActions }) {
  const t = useT('public-doc')
  const shell = useT('shell')
  const locale = useLocale()
  const day = (value: string) => formatDate(dayInstant(value), { locale, timeZone: 'UTC' })
  const declaration = page.declaration
  if (!declaration) {
    const notPpe = page.missing === 'NOT_PPE'
    const sender = page.sender.companyName
    return (
      <Card padded className="fw-pd-card" aria-labelledby="fw-pd-declaration">
        <SectionHead id="fw-pd-declaration" icon={<FileCheck2 size={18} aria-hidden />} title={t('declaration.heading')} />
        <EmptyState
          icon={notPpe ? <Info size={28} aria-hidden /> : <FileCheck2 size={28} aria-hidden />}
          title={notPpe ? t('declaration.notPpe.title') : t('declaration.notPublished.title')}
          description={notPpe ? t('declaration.notPpe.body') : sender ? t('declaration.notPublished.body', { sender }) : t('declaration.notPublished.bodyNoSender')}
        />
      </Card>
    )
  }
  const shown = fileIn(declaration.files, model.language)
  const span = declaration.batches ? spanMonths(declaration.batches, locale) : null
  return (
    <Card padded className="fw-pd-card" aria-labelledby="fw-pd-declaration">
      <SectionHead id="fw-pd-declaration" icon={<FileCheck2 size={18} aria-hidden />} title={t('declaration.heading')} />
      <p className="fw-pd-hint">
        {t('declaration.revision', { revision: declaration.revision })}
        {span ? ` · ${'one' in span ? t('declaration.forBatchesOne', { month: span.one }) : t('declaration.forBatches', { from: span.from, to: span.to })}` : ''}
      </p>
      {declaration.standing === 'EARLIER' && declaration.before && <Banner tone="warning" title={t('declaration.earlier', { month: monthOf(declaration.before, locale) })} />}
      <div className="fw-pd-choose">
        {declaration.files.length > 1 ? (
          <Field label={t('declaration.language')} hint={t('declaration.languageHint')}>
            <Listbox
              options={readerFirst(declaration.files, model.readerLanguages).map((file) => ({ value: file.language, label: languageName(file.language, locale) }))}
              value={shown?.language}
              onChange={(value) => actions?.onLanguage?.(value)}
              width="min(100%, 280px)"
            />
          </Field>
        ) : (
          shown && <p className="fw-pd-hint">{t('language.only', { language: languageName(shown.language, locale) })}</p>
        )}
      </div>
      {shown && (
        <>
          <KeyValue
            dense
            labelCase="sentence"
            columns={2}
            items={[
              ...(shown.number ? [{ label: t('declaration.number'), value: <span className="fw-pd-mono">{shown.number}</span> }] : []),
              ...(shown.issuedOn ? [{ label: t('declaration.issued'), value: day(shown.issuedOn) }] : []),
              { label: t('declaration.fingerprint'), value: <span className="fw-pd-mono fw-pd-sha">{shown.sha256}</span> },
            ]}
          />
          <div className="fw-pd-actions">
            <Button asChild variant="primary">
              <a href={publicDocFileUrl(page.path, shown.fileId, true)} download={pdfName(shown.name)}>
                <Download size={16} aria-hidden /> {t('declaration.download')}
              </a>
            </Button>
            <Button asChild variant="secondary">
              <a href={publicDocFileUrl(page.path, shown.fileId)} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={16} aria-hidden /> {t('declaration.openTab')}
              </a>
            </Button>
          </div>
          <PdfArea model={model} file={shown} actions={actions} t={t} shellLabels={pdfViewerLabels(shell)} />
        </>
      )}
    </Card>
  )
}

function PdfArea({ model, file, actions, t, shellLabels }: { model: PublicDocViewModel; file: PublicDocFile; actions?: PublicDocActions; t: Translate; shellLabels: ReturnType<typeof pdfViewerLabels> }) {
  const pdf = model.pdf?.fileId === file.fileId ? model.pdf : null
  if (pdf?.state === 'ready' && pdf.data) {
    return (
      <div className="fw-pd-viewer">
        <PdfViewer src={pdf.data} title={file.name} fileName={pdfName(file.name)} labels={shellLabels} height="min(70vh, 760px)" />
      </div>
    )
  }
  if (pdf?.state === 'failed') {
    return (
      <Card padded className="fw-link-state tone-warning">
        <EmptyState
          icon={<FileCheck2 size={28} aria-hidden />}
          title={t('declaration.pdf.failedTitle')}
          description={t('declaration.pdf.failedBody')}
          action={
            <Button variant="secondary" onClick={() => actions?.onRetryPdf?.()}>
              {t('declaration.pdf.retry')}
            </Button>
          }
        />
      </Card>
    )
  }
  return (
    <div className="fw-pd-viewer" aria-busy="true">
      <p className="fw-pd-hint" role="status">
        <Spinner size={14} /> {t('declaration.pdf.loading')}
      </p>
      <Skeleton height={320} />
    </div>
  )
}

// sec:certificate — The facts an authority or a buyer checks.
function CertificateSection({ page }: { page: PublicDocPage }) {
  const t = useT('public-doc')
  const locale = useLocale()
  const day = (value: string) => formatDate(dayInstant(value), { locale, timeZone: 'UTC' })
  const { ppe, certificate } = page
  const standard = ppe.standard ? (ppe.ppeClass ? t('certificate.standardClass', { standard: ppe.standard, ppeClass: ppe.ppeClass }) : ppe.standard) : null
  const items = [
    { label: t('certificate.category'), value: t(`certificate.categoryValue.${ppe.category}`) },
    ...(certificate
      ? [
          { label: t('certificate.standard'), value: certificate.ppeClass ? t('certificate.standardClass', { standard: certificate.standard, ppeClass: certificate.ppeClass }) : certificate.standard },
          { label: t('certificate.notifiedBody'), value: t('certificate.notifiedBodyValue', { name: certificate.notifiedBody.name, number: certificate.notifiedBody.number }) },
          { label: t('certificate.number'), value: <span className="fw-pd-mono">{certificate.number}</span> },
          {
            label: t('certificate.validity'),
            value: t('certificate.validityValue', { from: day(certificate.validFrom), to: day(certificate.validTo) }),
            hint: (
              <Pill tone={certificate.validOnDay ? 'success' : 'warning'}>
                {page.kind === 'BATCH'
                  ? certificate.validOnDay
                    ? t('certificate.validOnBatch', { day: day(certificate.day) })
                    : t('certificate.notValidOnBatch', { day: day(certificate.day) })
                  : certificate.validOnDay
                    ? t('certificate.validToday')
                    : t('certificate.notValidToday', { day: day(certificate.day) })}
              </Pill>
            ),
          },
        ]
      : standard
        ? [{ label: t('certificate.standard'), value: standard }]
        : []),
  ]
  const sender = page.sender.companyName
  return (
    <Card padded className="fw-pd-card" aria-labelledby="fw-pd-certificate">
      <SectionHead id="fw-pd-certificate" icon={certificate ? <ShieldCheck size={18} aria-hidden /> : <Award size={18} aria-hidden />} title={t('certificate.heading')} hint={t('certificate.hint')} />
      <KeyValue items={items} labelCase="sentence" columns={2} />
      {!ppe.certificateRequired ? (
        <p className="fw-pd-hint">{t('certificate.selfCertified')}</p>
      ) : (
        !certificate && <p className="fw-pd-hint">{sender ? t('certificate.none', { sender }) : t('certificate.noneNoSender')}</p>
      )}
    </Card>
  )
}

/** A published PDF as a row: its kind and language, with Open (a new tab) and Download. */
function PdfRow({ code, file, label, t }: { code: string; file: PublicDocFile; label: string; t: Translate }) {
  return (
    <FileRow
      name={label}
      size={file.sizeBytes}
      status={file.name}
      actions={
        <>
          <Button asChild variant="ghost" size="sm">
            <a href={publicDocFileUrl(code, file.fileId)} target="_blank" rel="noopener noreferrer" aria-label={t('instructions.openNamed', { name: label })}>
              <ExternalLink size={14} aria-hidden /> {t('instructions.open')}
            </a>
          </Button>
          <Button asChild variant="secondary" size="sm">
            <a href={publicDocFileUrl(code, file.fileId, true)} download={pdfName(file.name)} aria-label={t('instructions.downloadNamed', { name: label })}>
              <Download size={14} aria-hidden /> {t('instructions.download')}
            </a>
          </Button>
        </>
      }
    />
  )
}

// sec:instructions — User information per style and batch (PRD-356).
function InstructionsSection({ page, model }: { page: PublicDocPage; model: PublicDocViewModel }) {
  const t = useT('public-doc')
  const locale = useLocale()
  const files = readerFirst(page.instructions.files, model.readerLanguages)
  return (
    <Card padded className="fw-pd-card" aria-labelledby="fw-pd-instructions">
      <SectionHead id="fw-pd-instructions" icon={<Info size={18} aria-hidden />} title={t('instructions.heading')} hint={t('instructions.hint')} />
      {files.length > 0 ? (
        <div className="fw-pd-rows" role="list">
          {files.map((file) => (
            <div role="listitem" key={file.fileId}>
              <PdfRow code={page.path} file={file} label={t('instructions.leaflet', { language: languageName(file.language, locale) })} t={t} />
            </div>
          ))}
        </div>
      ) : (
        <p className="fw-pd-hint">{t('instructions.none')}</p>
      )}
      {page.instructions.care.length > 0 && (
        <div className="fw-pd-care">
          <h3 className="fw-pd-h3">{t('instructions.care')}</h3>
          <ul className="fw-pd-care-list">
            {page.instructions.care.map((line, index) => (
              <li key={`${line.symbol}-${index}`}>{careText(line, model.readerLanguages)}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}

// sec:versions — Older DoCs stay reachable for the batches they cover.
function VersionsSection({ page, model }: { page: PublicDocPage; model: PublicDocViewModel }) {
  const t = useT('public-doc')
  const locale = useLocale()
  const day = (value: string) => formatDate(dayInstant(value), { locale, timeZone: 'UTC' })
  return (
    <Card padded className="fw-pd-card" aria-labelledby="fw-pd-versions">
      <SectionHead id="fw-pd-versions" icon={<FileCheck2 size={18} aria-hidden />} title={t('versions.heading')} hint={t('versions.hint')} />
      {page.versions.length === 0 ? (
        <p className="fw-pd-hint">{t('versions.none')}</p>
      ) : (
        <div className="fw-pd-versions">
          {page.versions.map((version) => {
            const span = version.batches ? spanMonths(version.batches, locale) : null
            const parts = [
              t('versions.summary', { revision: version.revision }),
              ...(version.issuedOn ? [t('versions.issued', { date: day(version.issuedOn) })] : []),
              span ? ('one' in span ? t('versions.batchesOne', { month: span.one }) : t('versions.batches', { from: span.from, to: span.to })) : t('versions.noBatches'),
            ]
            return (
              <Disclosure key={version.revision} summary={parts.join(' · ')}>
                <div className="fw-pd-rows" role="list">
                  {readerFirst(version.declarations, model.readerLanguages).map((file) => (
                    <div role="listitem" key={file.fileId}>
                      <PdfRow code={page.path} file={file} label={t('versions.declaration', { language: languageName(file.language, locale) })} t={t} />
                    </div>
                  ))}
                  {readerFirst(version.instructions, model.readerLanguages).map((file) => (
                    <div role="listitem" key={file.fileId}>
                      <PdfRow code={page.path} file={file} label={t('versions.leaflet', { language: languageName(file.language, locale) })} t={t} />
                    </div>
                  ))}
                </div>
              </Disclosure>
            )
          })}
        </div>
      )}
    </Card>
  )
}

function OthersBanner({ page, actions }: { page: PublicDocPage; actions?: PublicDocActions }) {
  const t = useT('public-doc')
  return (
    <Banner tone="info" title={t('others.title')}>
      <span>{t('others.body')}</span>
      <span className="fw-pd-others">
        {page.others.map((other) => (
          <Button key={other.n} variant="secondary" size="sm" onClick={() => actions?.onPick?.(other.n)}>
            {other.batch ? t('others.batch', { style: other.style.name, batch: other.batch }) : t('others.style', { style: other.style.name })}
          </Button>
        ))}
      </span>
    </Banner>
  )
}

// sec:lookup — Type the code, when the QR is damaged.
function LookupCard({ model, actions, first = false }: { model: PublicDocViewModel; actions?: PublicDocActions; first?: boolean }) {
  const t = useT('public-doc')
  const { lookup } = model
  const waitWords = lookup.wait
    ? lookup.wait.unit === 'seconds'
      ? t('lookup.waitSeconds', { count: lookup.wait.count })
      : lookup.wait.count === 1
        ? t('lookup.waitOne')
        : t('lookup.wait', { count: lookup.wait.count })
    : null
  const error = lookup.problem ? t(`lookup.${lookup.problem}`) : null
  const submit = (event: FormEvent) => {
    event.preventDefault()
    actions?.onLookupSubmit?.()
  }
  return (
    <Card padded className="fw-pd-card fw-pd-lookup" aria-labelledby="fw-pd-lookup">
      <SectionHead id="fw-pd-lookup" icon={lookup.problem === 'unknown' ? <SearchX size={18} aria-hidden /> : <QrIcon size={18} aria-hidden />} title={t('lookup.heading')} hint={t('lookup.hint')} />
      <form className="fw-pd-form" onSubmit={submit} noValidate>
        <Field label={t('lookup.label')} error={error}>
          <Input
            value={lookup.text}
            onChange={(event) => actions?.onLookupText?.(event.target.value)}
            placeholder={t('lookup.placeholder')}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
            maxLength={40}
            className="fw-pd-mono"
            autoFocus={first}
          />
        </Field>
        <Button type="submit" variant={first ? 'primary' : 'secondary'} heldReason={lookup.wait ? t('lookup.held') : lookup.busy ? t('lookup.opening') : null}>
          {lookup.busy && <Spinner size={14} />} {lookup.busy ? t('lookup.opening') : t('lookup.open')}
        </Button>
      </form>
      {waitWords && <Banner tone="warning" title={waitWords} />}
      {lookup.checking && (
        <p className="fw-pd-hint" role="status">
          <Spinner size={14} /> {t('lookup.checking')}
        </p>
      )}
    </Card>
  )
}
