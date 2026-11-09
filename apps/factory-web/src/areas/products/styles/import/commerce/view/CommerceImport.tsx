'use client'

import Link from 'next/link'
import { ArrowRight, FileSpreadsheet, PlugZap, Upload } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { Button, Pill, RadioCard, Skeleton, Tag } from '@nexus/ui/primitives'
import { COMMERCE_IMPORT_LIMITS } from '@nexus/factory-domain/product/commerce-import/importer'
import type { StartedStylesView } from '@nexus/factory-domain/product/commerce-import/source'
import { Modal } from '../../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import type { WizardActions } from '../../../../../admin/import/view/ImportWizard'
import type { SheetImport } from '../../sheet-import'
import { SheetImportDialog } from '../../view/SheetImportDialog'
import { continueHeld, liveReasonKey, onlyStarted, type CommerceImportActions, type CommerceImportModel } from '../commerce-model'
import '../commerce.css'

export interface CommerceImportProps {
  model: CommerceImportModel | null
  /** The import wizard on `product.commerceStyles` (open between the source and the done step). */
  sheet: SheetImport | null
  /** `/w/<company>`: the done step's Open links. */
  prefix: string
  actions?: CommerceImportActions
  sheetActions?: WizardActions
}

/**
 * New style › "Nexus Commerce product" and the styles header's Import (B-W2b-209; design products.styles pop:styles.new,
 * page.h Import): the source step, the import wizard on the one importer (its name and words ours), and the done step
 * with the styles the file started. It fetches nothing.
 */
export function CommerceImport(props: CommerceImportProps) {
  return (
    <WithMessages namespaces={['products-commerce-import']}>
      <CommerceImportSteps {...props} />
    </WithMessages>
  )
}

function CommerceImportSteps({ model, sheet, prefix, actions, sheetActions }: CommerceImportProps) {
  const t = useT('products-commerce-import')
  // The wizard names the importer with our words, not the API's English label.
  const named = sheet ? { ...sheet, importers: sheet.importers.map((importer) => ({ ...importer, label: t('importer.name'), description: t('importer.fills') })) } : null
  return (
    <>
      {model?.step === 'source' && <SourceStep model={model} actions={actions} />}
      {model?.step === 'done' && <DoneStep model={model} prefix={prefix} actions={actions} />}
      {named && <SheetImportDialog model={named} actions={sheetActions} />}
    </>
  )
}

function SourceStep({ model, actions }: { model: CommerceImportModel; actions?: CommerceImportActions }) {
  const t = useT('products-commerce-import')
  const held = continueHeld(model)
  const info = model.info.status === 'ready' ? model.info.value : null
  const maxRows = info?.maxRows ?? COMMERCE_IMPORT_LIMITS.rows
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={t('source.title')}
      subtitle={t('source.subtitle')}
      size="lg"
      footer={
        <>
          <Button onClick={() => actions?.onClose?.()}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onContinue?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
            <Upload size={13} aria-hidden /> {t('source.continue')}
          </Button>
        </>
      }
    >
      <div
        className="fw-cmi-body"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            if (!held) actions?.onContinue?.()
          }
        }}
      >
        {model.held && <Banner tone="info" title={t(model.held)} />}
        <div className="fw-cmi-sources" role="radiogroup" aria-label={t('source.label')}>
          <RadioCard
            name="fw-cmi-source"
            value="EXPORT_FILE"
            checked
            selected
            title={
              <span className="fw-cmi-inline">
                <FileSpreadsheet size={14} aria-hidden /> {t('source.file.title')}
              </span>
            }
            description={t('source.file.hint', { max: maxRows })}
            onChange={() => undefined}
          />
          <RadioCard
            name="fw-cmi-source"
            value="LIVE_READ"
            checked={false}
            disabled
            title={
              <span className="fw-cmi-inline">
                <PlugZap size={14} aria-hidden /> {t('source.live.title')}
                <Tag tone="neutral">{t('source.live.off')}</Tag>
              </span>
            }
            description={info ? t(liveReasonKey(info)) : t('source.live.reason.OWNER_WORD')}
            onChange={() => undefined}
          />
        </div>
        {model.info.status === 'loading' && (
          <div aria-busy="true" className="fw-cmi-skeleton">
            <Skeleton height={16} />
          </div>
        )}
        {model.info.status === 'error' && (
          <Banner
            tone="warning"
            title={t(model.info.problem)}
            action={
              <Button size="sm" variant="quiet" onClick={() => actions?.onRetry?.()}>
                {t('common.retry')}
              </Button>
            }
          />
        )}
        <section className="fw-cmi-section" aria-labelledby="fw-cmi-makes">
          <h3 id="fw-cmi-makes" className="fw-cmi-h3">
            {t('makes.title')}
          </h3>
          <ul className="fw-cmi-list">
            <li>{t('makes.family')}</li>
            <li>{t('makes.colours')}</li>
            <li>{t('makes.skus')}</li>
            <li>{t('makes.again')}</li>
            <li>{t('makes.nothingBack')}</li>
          </ul>
        </section>
        <section className="fw-cmi-section" aria-labelledby="fw-cmi-how">
          <h3 id="fw-cmi-how" className="fw-cmi-h3">
            {t('how.title')}
          </h3>
          <p className="fw-cmi-hint">{t('how.export')}</p>
          <p className="fw-cmi-hint">{t('how.columns')}</p>
        </section>
      </div>
    </Modal>
  )
}

function DoneStep({ model, prefix, actions }: { model: CommerceImportModel; prefix: string; actions?: CommerceImportActions }) {
  const t = useT('products-commerce-import')
  const styles = model.done?.styles ?? { status: 'loading' as const }
  const only = styles.status === 'ready' ? onlyStarted(styles.value) : null
  const href = (id: string) => `${prefix}/products/styles/${id}?tab=overview`
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={t('done.title')}
      subtitle={t('done.subtitle')}
      size="lg"
      footer={
        <>
          <Button onClick={() => actions?.onClose?.()}>{t('common.close')}</Button>
          {only && (
            <Button variant="primary" asChild>
              <Link href={href(only.id)}>{t('done.open', { code: only.code })}</Link>
            </Button>
          )}
        </>
      }
    >
      <div className="fw-cmi-body">
        {styles.status === 'loading' && (
          <div aria-busy="true" className="fw-cmi-skeleton">
            <Skeleton height={20} />
            <Skeleton height={20} />
          </div>
        )}
        {styles.status === 'error' && (
          <Banner
            tone="warning"
            title={t(styles.problem)}
            action={
              <Button size="sm" variant="quiet" onClick={() => actions?.onRetry?.()}>
                {t('common.retry')}
              </Button>
            }
          >
            <p className="fw-cmi-hint">{t('done.unreadHint')}</p>
          </Banner>
        )}
        {styles.status === 'ready' && <StartedList view={styles.value} href={href} />}
        <p className="fw-cmi-hint">{t('done.next')}</p>
      </div>
    </Modal>
  )
}

function StartedList({ view, href }: { view: StartedStylesView; href: (id: string) => string }) {
  const t = useT('products-commerce-import')
  if (view.styles.length === 0)
    return <EmptyState title={view.hidden > 0 ? t('done.onlyHidden', { count: view.hidden }) : t('done.none.title')} description={view.hidden > 0 ? undefined : t('done.none.body')} />
  const started = view.styles.filter((style) => style.started).length
  return (
    <>
      <p className="fw-cmi-hint" role="status">
        {t('done.summary', { started, added: view.styles.length - started })}
      </p>
      <ul className="fw-cmi-styles" aria-label={t('done.listLabel')}>
        {view.styles.map((style) => (
          <li key={style.id} className="fw-cmi-style">
            <span className="fw-cmi-style-head">
              <Link className="fw-cmi-code" href={href(style.id)}>
                {style.code}
              </Link>
              <span className="fw-cmi-name">{style.name}</span>
            </span>
            <span className="fw-cmi-style-facts">
              <Pill tone={style.started ? 'info' : 'neutral'}>{style.started ? t('done.started') : t('done.added')}</Pill>
              <Tag tone="neutral">{t(`lifecycle.${style.lifecycle}`)}</Tag>
              <span className="fw-cmi-hint">{t('done.skus', { count: style.skus })}</span>
              <Link className="fw-cmi-open" href={href(style.id)} aria-label={t('done.openLabel', { code: style.code })}>
                <ArrowRight size={14} aria-hidden />
              </Link>
            </span>
          </li>
        ))}
      </ul>
      {view.hidden > 0 && <p className="fw-cmi-hint">{t('done.hidden', { count: view.hidden })}</p>}
    </>
  )
}

/** The styles header's Import (design page.h: "Import (from Nexus Commerce or a sheet)"), held with its reason. */
export function CommerceImportButton({ held, onImport }: { held: string | null; onImport?: () => void }) {
  return (
    <WithMessages namespaces={['products-commerce-import']}>
      <ImportButton held={held} onImport={onImport} />
    </WithMessages>
  )
}

function ImportButton({ held, onImport }: { held: string | null; onImport?: () => void }) {
  const t = useT('products-commerce-import')
  return (
    <Button size="sm" heldReason={held ? t(held) : null} onClick={() => onImport?.()} title={t('header.importHint')}>
      <Upload size={14} aria-hidden /> {t('header.import')}
    </Button>
  )
}

/** The design index's view (SCR-273): one model, the steps as the styles list draws them. */
export function CommerceImportDesign({ model }: { model: CommerceImportProps }) {
  return <CommerceImport {...model} />
}
