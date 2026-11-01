'use client'

import { Fragment, useRef, type ReactNode } from 'react'
import { ClipboardCheck, Paperclip, Tag as TagIcon, Truck } from 'lucide-react'
import { Banner, Disclosure } from '@nexus/ui/components'
import { Button, Kbd, Pill, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { QualityMessages } from '../../../quality/_shared/parts'
import type { CertificateStatus, GateResult } from '../api'
import { GATE_STOPS, leftOf, STATUS_TONE, type FieldProblem, type Left } from '../model'
import '../certificates.css'

/**
 * The parts both certificate screens draw (the register SCR-050 and the certificate record SCR-051): the screen's words
 * with the shared quality words, the status pill, the validity in words (a word with every colour, never colour alone),
 * the gate explainer, the gate's answer in a sentence (design GateExplainer: a DS part not built yet, composed here), a
 * PDF chooser in this app's words and the keys dialog. Nothing here fetches.
 */

export function CertMessages({ children }: { children?: ReactNode }) {
  return <QualityMessages namespaces={['certificates']}>{children}</QualityMessages>
}

/** A field's problem in words; a day in it (the five-year rule's latest day) in the person's language. */
export function useProblemWords() {
  const t = useT('certificates')
  const day = useDay()
  return (problem: FieldProblem): string => t(problem.key, problem.params && 'latest' in problem.params ? { ...problem.params, latest: day(String(problem.params.latest)) } : problem.params)
}

/** A calendar day (YYYY-MM-DD) in the person's language. */
export function useDay() {
  const locale = useLocale()
  return (date: string | null | undefined): string => (date ? formatDate(`${date}T12:00:00Z`, { locale }) : '—')
}

export function StatusPill({ status }: { status: CertificateStatus }) {
  const t = useT('certificates')
  return (
    <Pill tone={STATUS_TONE[status]} dot>
      {t(`status.${status}`)}
    </Pill>
  )
}

/** The validity's words ("3 years 4 months left", "Expired 12 days ago"). */
export function useLeftWords() {
  const t = useT('certificates')
  return (left: Left): string => {
    const span = (years: number, months: number) => [years > 0 ? t('left.years', { count: years }) : '', months > 0 || years === 0 ? t('left.months', { count: months }) : ''].filter(Boolean).join(' ')
    switch (left.kind) {
      case 'withdrawn':
        return t('left.withdrawn')
      case 'notRegistered':
        return t('left.notRegistered', { span: span(left.years, left.months) })
      case 'expired':
        return t('left.expired', { count: left.days })
      case 'lastDay':
        return t('left.lastDay')
      case 'days':
        return t('left.days', { count: left.days })
      case 'span':
        return t('left.span', { span: span(left.years, left.months) })
    }
  }
}

export function LeftTag({ certificate, today }: { certificate: { status: CertificateStatus; validFrom: string; validTo: string }; today: string | null }) {
  const words = useLeftWords()
  if (!today) return <span className="fw-q-hint">—</span>
  const left = leftOf(certificate, today)
  return <Tag tone={left.tone}>{words(left)}</Tag>
}

/** The certificate gate in one sentence, where it acts and what "covered" means (design ce-explainer, collapsible). */
export function GateExplainer({ open, onToggle, onCheck, checkHeld }: { open: boolean; onToggle?: (open: boolean) => void; onCheck?: () => void; checkHeld?: string | null }) {
  const t = useT('certificates')
  const icons = { release: <ClipboardCheck size={16} aria-hidden />, label: <TagIcon size={16} aria-hidden />, ship: <Truck size={16} aria-hidden /> }
  return (
    <Disclosure className="fw-ce-explainer" summary={t('explainer.summary')} open={open} onToggle={(event) => onToggle?.((event.currentTarget as HTMLDetailsElement).open)}>
      <div className="fw-ce-explainer-body">
        <p className="fw-ce-rule">{t('explainer.rule')}</p>
        <ul className="fw-ce-places" aria-label={t('explainer.placesLabel')}>
          {GATE_STOPS.map((stop) => (
            <li key={stop}>
              {icons[stop]} <span>{t(`stop.${stop}`)}</span>
            </li>
          ))}
        </ul>
        <div>
          <p className="fw-q-hint">{t('explainer.coveredIntro')}</p>
          <ul className="fw-ce-list">
            {(['status', 'dates', 'style', 'colour', 'size', 'mtm'] as const).map((entry) => (
              <li key={entry}>{t(`explainer.covered.${entry}`)}</li>
            ))}
          </ul>
        </div>
        <span className="fw-q-tags">
          <Tag tone="neutral">{t('law.annexV')}</Tag>
          <Tag tone="neutral">{t('law.en17092')}</Tag>
          {onCheck && (
            <Button size="sm" onClick={onCheck} heldReason={checkHeld ? t(checkHeld) : null} aria-keyshortcuts="k">
              {t('check.open')}
            </Button>
          )}
        </span>
      </div>
    </Disclosure>
  )
}

/** The gate's answer in a sentence, with each reason, who can fix it and how; the API's sentences kept as data. */
export function GateAnswer({ result, styleCode, colourwayCode }: { result: GateResult; styleCode: string; colourwayCode: string }) {
  const t = useT('certificates')
  const day = useDay()
  const place = { style: styleCode, colourway: colourwayCode, size: result.size ?? '—', date: day(result.date) }
  if (result.outcome === 'covered' && result.certificate) {
    const c = result.certificate
    return (
      <Banner tone="success" title={t('check.covered', { ...place, number: c.number })}>
        <p className="fw-ce-answer-line">{t('check.coveredBy', { standard: c.standard, class: c.ppeClass ?? '—', body: `${c.notifiedBodyNumber} · ${c.notifiedBodyName}`, from: day(c.validFrom), to: day(c.validTo) })}</p>
      </Banner>
    )
  }
  if (result.outcome === 'not_required')
    return (
      <Banner tone="info" title={t('check.notRequired', place)}>
        {result.message && <p className="fw-q-hint">{result.message}</p>}
      </Banner>
    )
  return (
    <Banner tone="danger" title={t('check.refused', place)}>
      <ul className="fw-ce-reasons">
        {result.reasons.map((reason, index) => (
          <li key={`${reason.code}-${index}`}>
            <span className="fw-ce-reason">{t(`gate.${reason.code}`)}</span>
            <span className="fw-q-hint">{t(`gateFix.${reason.code}`)}</span>
            <span className="fw-q-hint fw-ce-data">{reason.message}</span>
          </li>
        ))}
      </ul>
      <p className="fw-q-hint">{t('check.stops')}</p>
    </Banner>
  )
}

/** A PDF chooser in this app's words: a button, the chosen name, what may be chosen. The bytes go to the container. */
export function PdfChooser({ name, onFile, label, hint, held }: { name: string | null; onFile?: (file: File) => void; label: string; hint: string; held?: string | null }) {
  const t = useT('certificates')
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="fw-ce-file">
      <span className="fw-ce-file-label">{label}</span>
      <span className="fw-q-cell-row">
        <Button size="sm" onClick={() => input.current?.click()} heldReason={held ?? null}>
          <Paperclip size={14} aria-hidden /> {name ? t('file.change') : t('file.choose')}
        </Button>
        <span className={name ? 'fw-q-code' : 'fw-q-hint'}>{name ?? t('file.none')}</span>
      </span>
      <span className="fw-q-hint">{hint}</span>
      <input
        ref={input}
        type="file"
        hidden
        accept=".pdf,application/pdf"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) onFile?.(file)
          event.target.value = ''
        }}
      />
    </div>
  )
}

/** The page's keys, in a dialog (`?` and the keys panel's "All shortcuts"). */
export function ShortcutsDialog({ open, keys, onClose }: { open: boolean; keys: ReadonlyArray<{ keys: readonly string[]; does: string }>; onClose?: () => void }) {
  const t = useT('certificates')
  const q = useT('quality')
  return (
    <Modal open={open} onClose={() => onClose?.()} title={t('keys.title')} size="sm" footer={<Button onClick={() => onClose?.()}>{q('common.close')}</Button>}>
      <dl className="fw-ce-keymap">
        {keys.map((entry) => (
          <Fragment key={entry.does}>
            <dt>
              {entry.keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </dt>
            <dd>{entry.does}</dd>
          </Fragment>
        ))}
      </dl>
    </Modal>
  )
}

/** A key's words: a `lists` message key (the frame's keys), else the screen's own words. */
export function useListWords() {
  const t = useT('lists')
  return (does: string) => {
    const text = t(does)
    return text === does ? does : text
  }
}

/** The date field's calendar language. */
export const dateLocale = (locale: string): string => (locale === 'it' ? 'it-IT' : 'en-GB')
