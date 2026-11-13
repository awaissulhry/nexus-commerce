'use client'

import { useMemo } from 'react'
import { ArrowLeftRight, FilePen } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { VersionCompare } from '@nexus/ui/patterns/VersionCompare/index'
import { Button, Select, Spinner } from '@nexus/ui/primitives'
import { Modal, useDsWords } from '../../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../../lib/i18n/locales'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import type { VersionStatus } from '../../../api'
import { DEPTH_NS, type Words } from '../../lines-depth/model'
import { useDepthWords } from '../../lines-depth/words'
import type { VersionsCompared } from '../api'
import { fullChangeNote, sectionDiffers, sectionsOf, sectionShape, type CompareWords } from '../model'
import '../../lines-depth/depth.css'

export interface CompareVersionsModel {
  from: number
  to: number
  /** Every version of the quote (the pickers), newest first, with what its head says. */
  versions: ReadonlyArray<{ revision: number; status: VersionStatus; sentAt: string | null }>
  state: { status: 'loading' } | { status: 'ready'; value: VersionsCompared } | { status: 'error'; problem: string }
  /** Why "Use as change note" cannot fill the draft's What changed now, or null. */
  noteHeld: Words | null
  noteSaving: boolean
  /** The note went into the draft. */
  noteDone: boolean
}

export interface CompareVersionsActions {
  onPair?: (pair: { from: number; to: number }) => void
  onUseNote?: (note: string) => void
  onClose?: () => void
  onRetry?: () => void
}

/**
 * SCR-415 — Compare versions (design pop:quotes.compare and quote.versions.compare, SAL-158; B-W2b-302's compare): two
 * versions of the quote side by side in the DS VersionCompare, one per section that differs — terms (dates, payment,
 * deposit, acceptance, Incoterm), lines (added, removed, changed; pieces per size), prices (price grain) and margin
 * (margin grain) — totals before → after. "Use as change note" fills the draft version's What changed with the same facts
 * in plain words (VersionCompare's note, in the page's language). Nothing else writes.
 */
export function CompareVersions({ model, actions }: { model: CompareVersionsModel; actions?: CompareVersionsActions }) {
  return (
    <WithMessages namespaces={['sales', DEPTH_NS]}>
      <Compare model={model} actions={actions} />
    </WithMessages>
  )
}

function Compare({ model, actions }: { model: CompareVersionsModel; actions?: CompareVersionsActions }) {
  const { t, sales, say } = useDepthWords()
  const locale = useLocale()
  const ds = useDsWords()
  const day = (value: string) => formatDate(`${value}T12:00:00Z`, { locale })
  const words = useMemo<CompareWords>(
    () => ({
      field: (id) => t(`compare.field.${id}`),
      total: (id) => t(`compare.total.${id}`),
      value: (field, value) => {
        if (value === null) return null
        if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return day(value)
        if (field === 'acceptanceMode') return ['SIGN', 'SIGN_AND_PAY', 'PAY'].includes(value) ? t(`terms.acceptance.${value === 'PAY' ? 'SIGN_AND_PAY' : value}`) : value
        if (field === 'language') return value === 'it' || value === 'en' ? sales(`languageName.${value}`) : value
        if (field === 'deposit') return value.replace(/\b(ACCONTO|CAPARRA)\b/, (kind) => sales(`depositKind.${kind}`))
        if (field === 'firmOffer' || field === 'shipComplete') return value === '✓' ? t('compare.yes') : value
        // A schedule names its days inside the text ("2026-12-02 50 2, 52 2"): each day said in the page's language.
        return value.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (iso) => day(iso))
      },
    }),
    // day() reads the locale only.
    [t, sales, locale],
  )
  const headOf = (revision: number) => {
    const version = model.versions.find((entry) => entry.revision === revision)
    return { label: t('compare.version', { n: revision }), note: version ? [sales(`status.${version.status}`), version.sentAt ? t('compare.sentOn', { date: formatDate(version.sentAt, { locale }) }) : null].filter(Boolean).join(' · ') : null }
  }
  const before = headOf(model.from)
  const after = headOf(model.to)
  const sections = model.state.status === 'ready' ? sectionsOf(model.state.value) : []
  const differing = sections.filter(sectionDiffers)
  const same = sections.filter((section) => !sectionDiffers(section))
  const note = differing.length > 0 ? fullChangeNote(before, after, differing, words, ds.versionCompare) : ''
  const noteHeld = model.state.status !== 'ready' ? t('compare.held.reading') : !note ? t('compare.held.same') : model.noteHeld ? say(model.noteHeld) : model.noteSaving ? sales('held.busy') : null
  const option = (version: CompareVersionsModel['versions'][number]) => (
    <option key={version.revision} value={version.revision}>
      {t('compare.option', { n: version.revision, status: sales(`status.${version.status}`) })}
    </option>
  )

  return (
    <Modal
      open
      size="xl"
      onClose={() => actions?.onClose?.()}
      title={t('compare.title')}
      footer={
        <>
          <Button onClick={() => actions?.onClose?.()}>{sales('common.close')}</Button>
          <Button variant="primary" heldReason={noteHeld} onClick={() => note && actions?.onUseNote?.(note)}>
            <FilePen size={14} aria-hidden /> {model.noteDone ? t('compare.noteDone') : t('compare.useNote')}
          </Button>
        </>
      }
    >
      <div className="fw-q-stack">
        <div className="fw-qd-pair">
          <Field label={t('compare.from')}>
            <Select size="sm" value={String(model.from)} onChange={(event) => actions?.onPair?.({ from: Number(event.target.value), to: model.to })}>
              {model.versions.map(option)}
            </Select>
          </Field>
          <Button size="sm" variant="quiet" onClick={() => actions?.onPair?.({ from: model.to, to: model.from })} aria-label={t('compare.swap')} title={t('compare.swap')}>
            <ArrowLeftRight size={14} aria-hidden />
          </Button>
          <Field label={t('compare.to')}>
            <Select size="sm" value={String(model.to)} onChange={(event) => actions?.onPair?.({ from: model.from, to: Number(event.target.value) })}>
              {model.versions.map(option)}
            </Select>
          </Field>
        </div>
        {model.from === model.to ? (
          <p className="fw-q-hint">{t('compare.pickTwo')}</p>
        ) : model.state.status === 'loading' ? (
          <p className="fw-q-hint" role="status">
            <Spinner size={14} /> {t('compare.reading')}
          </p>
        ) : model.state.status === 'error' ? (
          <Banner
            tone="danger"
            title={sales(model.state.problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {sales('common.retry')}
              </Button>
            }
          />
        ) : (
          <>
            {differing.length === 0 && <Banner tone="info" title={t('compare.same')} />}
            {differing.map((section) => {
              const shape = sectionShape(section, words)
              return (
                <section key={section.id} className="fw-qd-compare-part" aria-label={t(`compare.section.${section.id}`)}>
                  <h3 className="fw-q-h3">{t(`compare.section.${section.id}`)}</h3>
                  <VersionCompare before={before} after={after} lines={shape.lines} fields={shape.fields} sizes={shape.sizes} totals={shape.totals} locale={INTL_LOCALE[locale]} labels={ds.versionCompare} />
                </section>
              )
            })}
            {same.length > 0 && <p className="fw-q-hint">{t('compare.unchanged', { sections: same.map((section) => t(`compare.section.${section.id}`)).join(' · ') })}</p>}
            {model.state.value.prices === undefined && <p className="fw-q-hint">{t('compare.noPrices')}</p>}
            {model.noteDone && <Banner tone="success" title={t('compare.noteSaved')} />}
          </>
        )}
      </div>
    </Modal>
  )
}
