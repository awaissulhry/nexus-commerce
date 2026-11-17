'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, FileText } from 'lucide-react'
import { Banner, Card, Disclosure, KeyValue, SummaryTable, type KeyValueItem } from '@nexus/ui/components'
import { Button, Pill, Spinner } from '@nexus/ui/primitives'
import { FileRow, Modal } from '../../../../lib/i18n/ds-parts'
import { FreshnessLine } from '../../../../lib/production/view/FreshnessLine'
import type { FinalInspection, ProductionQuality, QualityPhoto } from '../../production/api'
import { anyTakenBack, checkPiecesText, FINAL_STATE_TONE, finalLinesText, photoStepHeld, qualityLinesOf, qualityNothing, reportNamesOf, type QualityLineRow } from '../../production/model'
import { useOrderWords } from '../words'
import { Loading, ReadFailed, SizeRunTable } from './parts'

/**
 * F-PR-12c — portal order › Status & progress, part 3: + Quality & photos (production plan §4 "first piece, in-line, final
 * results and photos of its own goods — single-brand work orders only"; 06-tree P-ORD-quality; wall PW-P04), drawn only at the
 * level Quality & photos (the order's quality read, B-PR-19: below it the API answers 404 and nothing is drawn).
 *
 *   Released by quality   per line, and per size behind "Per size", the pieces of its own cells released by quality and those
 *                         taken back since (never above what it ordered); a line partly made on a work order that is not its
 *                         alone says, in the API's words, that its results are not shared
 *   Checks during production   first piece, cutting and end-of-line checks: the last result, the count, the pieces with a defect
 *   Final inspection      each one: the lines it judges, its result and day, the sampling plan over its own garments, the defects
 *                         found once decided, and "Open the report" (the factory's PDF) when one is issued
 *   Holds                 what held its goods, by reason in our words, active or ended (never a note, never who)
 *   Photos                the photos the factory shared on its order, opened one at a time (QualityPhotoDialog)
 *
 * Never the inspection's own number, a work order, a lot of another's goods, an inspector, a worker, a line or a note: the API
 * sends none and the web keeps none. Draws one view model and fetches nothing; OrderPage reads, opens the PDF and the photos.
 */

export interface QualityCardActions {
  onRetryQuality?: () => void
  /** "Open the report": the inspection's PDF in the viewer, with the viewer's title and the name a download takes. */
  onReport?: (report: { inspectionId: string; title: string; fileName: string }) => void
  /** A photo opened full size, among the order's photos (Previous / Next move through them). */
  onPhoto?: (photos: readonly QualityPhoto[], index: number) => void
}

export function ProductionQualityCard({
  quality,
  refreshSeconds,
  offline,
  fileHeld,
  actions,
}: {
  quality: { state: 'loading' | 'error' | 'ready'; read: ProductionQuality | null }
  /** The order's production read comes again every n seconds, and this read with it (null: no timer). */
  refreshSeconds: number | null
  offline: boolean
  /** Why a file cannot open now (a preview of the account, offline), or null. */
  fileHeld: string | null
  actions?: QualityCardActions
}) {
  const words = useOrderWords()
  const { t, time } = words
  const read = quality.read
  const fresh = read ? (
    refreshSeconds ? (
      <FreshnessLine mode={offline ? 'offline' : 'polling'} asOf={read.asOf} everySeconds={refreshSeconds} />
    ) : (
      <span className="fw-pord-sub">{t('band.updated', { time: time(read.asOf) })}</span>
    )
  ) : null
  return (
    <Card header={t('production.quality.title')} headingLevel={2} headerAction={fresh}>
      <div className="fw-pord-stack">
        {quality.state === 'error' ? <ReadFailed title={t('production.quality.failed')} onRetry={actions?.onRetryQuality} /> : null}
        {read ? <QualityBody read={read} fileHeld={fileHeld} actions={actions} /> : quality.state === 'loading' ? <Loading rows={2} height={40} label={t('production.quality.label')} /> : null}
      </div>
    </Card>
  )
}

function QualityBody({ read, fileHeld, actions }: { read: ProductionQuality; fileHeld: string | null; actions?: QualityCardActions }) {
  const { t, locale } = useOrderWords()
  if (qualityNothing(read)) return <p className="fw-pord-hint">{t('production.quality.none')}</p>
  return (
    <section className="fw-pord-quality" aria-label={t('production.quality.label')}>
      <Released lines={qualityLinesOf(read, locale, t)} takenBack={anyTakenBack(read)} />
      {read.checks.length > 0 ? <Checks read={read} /> : null}
      {read.finals.length > 0 ? <Finals finals={read.finals} fileHeld={fileHeld} actions={actions} /> : null}
      {read.holds.length > 0 ? <Holds read={read} /> : null}
      {read.photos.length > 0 ? <Photos photos={read.photos} fileHeld={fileHeld} actions={actions} /> : null}
    </section>
  )
}

function Part({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="fw-pord-section" aria-labelledby={id}>
      <h3 id={id} className="fw-pord-h3">
        {title}
      </h3>
      {children}
    </section>
  )
}

/** Released by quality: per line (a phone stacks the rows), per size behind "Per size" when a line has several. */
function Released({ lines, takenBack }: { lines: readonly QualityLineRow[]; takenBack: boolean }) {
  const { t } = useOrderWords()
  const heads = [t('sizes.ordered'), t('production.quality.released.released'), t('production.quality.released.reversed')]
  return (
    <Part id="fw-pord-quality-released" title={t('production.quality.released.title')}>
      <SummaryTable
        label={t('production.quality.released.label')}
        columns={[t('production.quality.released.line'), ...heads]}
        widths={['46%', undefined, undefined, undefined]}
        align={[undefined, 'right', 'right', 'right']}
        stackOnPhone
        rows={lines.map((line) => ({ id: line.id, cells: [line.label, line.ordered, line.released, line.reversed] }))}
      />
      {takenBack ? <p className="fw-pord-hint">{t('production.quality.released.reversedHint')}</p> : null}
      {lines.flatMap((line) => (line.shared ? [<p key={`shared-${line.id}`} className="fw-pord-hint">{t('production.quality.released.shared', { line: line.label, words: line.shared })}</p>] : []))}
      {lines
        .filter((line) => line.sizes.length > 1)
        .map((line) => (
          <Disclosure key={line.id} summary={t('production.quality.released.sizesOf', { title: line.label })}>
            <SizeRunTable label={t('production.quality.released.sizesOf', { title: line.label })} run={{ heads, rows: line.sizes.map((size) => ({ size: size.size, cells: [size.ordered, size.released, size.reversed] })) }} />
          </Disclosure>
        ))}
    </Part>
  )
}

/** First piece, cutting and end-of-line checks: the last result, how many passed / failed / wait, the pieces with a defect. */
function Checks({ read }: { read: ProductionQuality }) {
  const { t, locale, day } = useOrderWords()
  return (
    <Part id="fw-pord-quality-checks" title={t('production.quality.checks.title')}>
      <SummaryTable
        label={t('production.quality.checks.title')}
        columns={[t('production.quality.checks.check'), t('production.quality.checks.result'), t('production.quality.checks.soFar'), t('production.quality.checks.lastOn')]}
        widths={['30%', '22%', undefined, undefined]}
        stackOnPhone
        rows={read.checks.map((check) => {
          const pieces = checkPiecesText(check, t)
          return {
            id: check.kind,
            cells: [
              check.words[locale],
              <Pill key="state" tone={FINAL_STATE_TONE[check.state]}>
                {check.stateWords[locale]}
              </Pill>,
              <span key="count">
                {check.countWords[locale]}
                {pieces ? (
                  <>
                    <br />
                    <span className="nds-summary-sub">{pieces}</span>
                  </>
                ) : null}
              </span>,
              check.lastOn ? day(check.lastOn) : '—',
            ],
          }
        })}
      />
    </Part>
  )
}

/** Each final inspection of its own work: the lines, the result and day, the sampling, the defects, its report. */
function Finals({ finals, fileHeld, actions }: { finals: readonly FinalInspection[]; fileHeld: string | null; actions?: QualityCardActions }) {
  const { t, locale, day } = useOrderWords()
  return (
    <Part id="fw-pord-quality-finals" title={t('production.quality.finals.title')}>
      {finals.map((final) => {
        const lines = finalLinesText(final, t)
        const sampling = final.sampling
        const items: KeyValueItem[] = [
          { label: t('production.quality.finals.sample'), value: t('production.quality.finals.sampleOf', { sample: sampling.sample, garments: sampling.garments }) },
          { label: t('production.quality.finals.level'), value: sampling.inspectionLevel },
          { label: t('production.quality.finals.aql'), value: t('production.quality.finals.aqlValue', { major: sampling.aqlMajor, minor: sampling.aqlMinor, acceptMajor: sampling.acceptMajor, acceptMinor: sampling.acceptMinor }) },
          ...(final.defects ? [{ label: t('production.quality.finals.defects'), value: t('production.quality.finals.defectsValue', { critical: final.defects.critical, major: final.defects.major, minor: final.defects.minor }) }] : []),
        ]
        return (
          <div key={final.inspectionId} className="fw-pord-final">
            <div className="fw-pord-docline">
              <strong>{lines}</strong>
              <Pill tone={FINAL_STATE_TONE[final.state]}>{final.stateWords[locale]}</Pill>
              <span className="fw-pord-sub">{final.decidedOn ? t('production.quality.finals.decidedOn', { date: day(final.decidedOn) }) : t('production.quality.finals.waiting')}</span>
            </div>
            <KeyValue columns={2} phoneColumns={1} labelCase="sentence" items={items} />
            {final.defects && final.defects.found.length > 0 ? (
              <SummaryTable
                label={t('production.quality.finals.foundOf', { lines })}
                columns={[t('production.quality.finals.defect'), t('production.quality.finals.class'), t('production.quality.finals.garments')]}
                widths={['50%', undefined, undefined]}
                align={[undefined, undefined, 'right']}
                stackOnPhone
                rows={final.defects.found.map((found, index) => ({ id: `${found.defectClass}-${found.code}-${index}`, cells: [found.words ? found.words[locale] : found.code, found.classWords[locale], found.garments] }))}
              />
            ) : null}
            {final.report ? (
              <div className="fw-pord-buttons">
                <Button size="sm" heldReason={fileHeld} onClick={() => actions?.onReport?.({ inspectionId: final.inspectionId, ...reportNamesOf(final, day, t) })}>
                  <FileText size={14} aria-hidden /> {t('production.quality.finals.openReport')}
                </Button>
              </div>
            ) : final.state !== 'WAITING' ? (
              <p className="fw-pord-hint">{t('production.quality.finals.noReport')}</p>
            ) : null}
          </div>
        )
      })}
    </Part>
  )
}

/** What held its goods, by reason in our words, active or ended. */
function Holds({ read }: { read: ProductionQuality }) {
  const { t, locale, day } = useOrderWords()
  return (
    <Part id="fw-pord-quality-holds" title={t('production.quality.holds.title')}>
      <SummaryTable
        label={t('production.quality.holds.title')}
        columns={[t('production.quality.holds.reason'), t('production.quality.holds.state'), t('production.quality.holds.since'), t('production.quality.holds.until')]}
        widths={['40%', '20%', undefined, undefined]}
        stackOnPhone
        rows={read.holds.map((hold, index) => ({
          id: `${hold.kind}-${index}`,
          cells: [
            hold.words[locale],
            <Pill key="state" tone={hold.active ? 'warning' : 'neutral'}>
              {hold.stateWords[locale]}
            </Pill>,
            day(hold.since),
            hold.until ? day(hold.until) : '—',
          ],
        }))}
      />
    </Part>
  )
}

/** The photos the factory shared on its order: one row each, opened full size one at a time. */
function Photos({ photos, fileHeld, actions }: { photos: readonly QualityPhoto[]; fileHeld: string | null; actions?: QualityCardActions }) {
  const { t, day } = useOrderWords()
  return (
    <Part id="fw-pord-quality-photos" title={t('production.quality.photos.title')}>
      <ul className="fw-pord-files" aria-label={t('production.quality.photos.title')}>
        {photos.map((photo, index) => (
          <li key={photo.id}>
            <FileRow
              name={photo.name}
              size={photo.sizeBytes}
              status={t('production.quality.photos.sharedOn', { date: day(photo.sharedOn) })}
              actions={
                <Button size="sm" variant="quiet" heldReason={fileHeld} onClick={() => actions?.onPhoto?.(photos, index)}>
                  {t('production.quality.photos.view')}
                </Button>
              }
            />
          </li>
        ))}
      </ul>
    </Part>
  )
}

// ── a photo full size ───────────────────────────────────────────────────────────────────────────────────────────────
export interface QualityPhotoModel {
  photos: readonly { id: string; name: string }[]
  index: number
  state: 'loading' | 'error' | 'ready'
  /** The picture's address (an object URL of the bytes read once). */
  src: string | null
  /** Why it could not be shown (a key of `portal-orders`); null: it failed to load and may be tried again. */
  problem: string | null
}

/**
 * One photo of the order full size (design P-ORD-quality "open photo"): on the DS Modal in the page's words — the DS Lightbox's
 * media part writes English ("Open original") on an Italian page, as the returns' viewer found. Previous / Next held at the ends
 * with the reason (never wrapping), ← → move while the focus is in the dialog, Esc and Close close.
 */
export function QualityPhotoDialog({ model, onIndex, onClose, onRetry }: { model: QualityPhotoModel; onIndex?: (index: number) => void; onClose?: () => void; onRetry?: () => void }) {
  const { t } = useOrderWords()
  const bodyRef = useRef<HTMLDivElement>(null)
  const latest = useRef({ model, onIndex })
  latest.current = { model, onIndex }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const dialog = bodyRef.current?.closest('[role="dialog"]')
      if (!dialog || !document.activeElement || !dialog.contains(document.activeElement)) return
      const { model: now, onIndex: move } = latest.current
      const next = now.index + (event.key === 'ArrowLeft' ? -1 : 1)
      if (next < 0 || next >= now.photos.length) return
      event.preventDefault()
      move?.(next)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  const photo = model.photos[model.index]
  if (!photo) return null
  const count = model.photos.length
  return (
    <Modal
      open
      onClose={() => onClose?.()}
      size="xl"
      title={photo.name}
      subtitle={t('production.quality.photos.count', { n: model.index + 1, count })}
      initialFocus="dialog"
      footer={
        <>
          {count > 1 ? (
            <>
              <Button aria-keyshortcuts="ArrowLeft" heldReason={photoStepHeld(model.index, count, -1, t)} onClick={() => onIndex?.(model.index - 1)}>
                <ChevronLeft size={16} aria-hidden /> {t('production.quality.photos.previous')}
              </Button>
              <Button aria-keyshortcuts="ArrowRight" heldReason={photoStepHeld(model.index, count, 1, t)} onClick={() => onIndex?.(model.index + 1)}>
                {t('production.quality.photos.next')} <ChevronRight size={16} aria-hidden />
              </Button>
            </>
          ) : null}
          <Button onClick={() => onClose?.()}>{t('dialog.close')}</Button>
        </>
      }
    >
      <div ref={bodyRef} className="fw-pord-photo">
        {model.state === 'loading' ? (
          <span className="fw-pord-sub" role="status">
            <Spinner size={20} /> {t('production.quality.photos.loading')}
          </span>
        ) : model.state === 'error' || !model.src ? (
          <Banner
            tone="danger"
            title={t(model.problem ?? 'production.quality.photos.failed')}
            action={
              model.problem ? undefined : (
                <Button size="sm" onClick={() => onRetry?.()}>
                  {t('state.retry')}
                </Button>
              )
            }
          />
        ) : (
          <img className="fw-pord-photo-img" src={model.src} alt={t('production.quality.photos.alt', { name: photo.name })} />
        )}
      </div>
    </Modal>
  )
}
