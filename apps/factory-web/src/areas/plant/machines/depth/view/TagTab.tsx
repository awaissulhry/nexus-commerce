'use client'

import Link from 'next/link'
import { Printer, QrCode as QrIcon } from 'lucide-react'
import { Card, KeyValue } from '@nexus/ui/components'
import { LabelPreview } from '@nexus/ui/components/LabelPreview/index'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { TIME_ZONE } from '../../../_shared/model'
import type { Loaded } from '../../../_shared/parts'
import type { TagJob } from '../api'
import { printStateOf, tagLayout } from '../model'
import { TagQr, useDepthWords, useSay } from '../parts'

/**
 * Machine › Tag (design plant.machines rec:Machine/tag; QHS-164): the tag on the machine to scale — its QR (the asset number),
 * the asset number, its type and place, "Scan to report a problem" — the newest tag sent to a label printer and where it
 * stands (queued, sent, printed or failed with Retry), what the QR opens, and Print tag / Reprint (the same tag: the old one
 * keeps opening the machine). A retired machine's tag no longer offers "Report a problem": nothing to print.
 */
export function TagTab({
  machine,
  job,
  canPrint,
  sheetHref,
  onPrint,
  onRetry,
}: {
  machine: { assetNumber: string; typeWords: string; placeWords: string; retired: boolean }
  job: Loaded<TagJob | null>
  canPrint: boolean
  sheetHref: string
  onPrint?: () => void
  onRetry?: (job: TagJob) => void
}) {
  const t = useDepthWords()
  const say = useSay()
  const locale = useLocale()
  const place = { locale, timeZone: TIME_ZONE }
  const last = job.status === 'ready' ? job.value : null
  const printHeld = machine.retired ? t('tags.held.retired') : canPrint ? null : t('tags.held.noRight')
  return (
    <div className="fw-md-split">
      <Card padded>
        <section className="fw-md-stack tight" aria-label={t('tag.title')}>
          <h3 className="fw-md-h3">{t('tag.title')}</h3>
          <LabelPreview
            layout={tagLayout(t, machine)}
            scale={4}
            renderQr={(value) => <TagQr value={value} label={t('tags.qrLabel', { machine: machine.assetNumber })} />}
            codeLabel={() => t('tags.qrLabel', { machine: machine.assetNumber })}
            {...(last ? { print: printStateOf(t, last, formatDateTime(last.at, place)) } : {})}
            {...(last?.state === 'FAILED' ? { onRetry: () => onRetry?.(last), retryLabel: t('tags.retry'), retryHeldReason: canPrint ? null : t('tags.held.noRight') } : {})}
            actions={
              <>
                <Button size="sm" variant="primary" heldReason={printHeld} onClick={() => onPrint?.()}>
                  <Printer size={13} aria-hidden /> {t(last ? 'tag.reprint' : 'tag.print')}
                </Button>
                <Button size="sm" asChild>
                  <Link href={sheetHref} target="_blank">
                    <QrIcon size={13} aria-hidden /> {t('tags.paper')}
                  </Link>
                </Button>
              </>
            }
          />
        </section>
      </Card>
      <Card padded>
        <aside className="fw-md-stack tight" aria-label={t('tag.facts')}>
          <h3 className="fw-md-h3">{t('tag.facts')}</h3>
          {job.status === 'loading' ? (
            <Skeleton height={60} />
          ) : (
            <KeyValue
              dense
              labelCase="sentence"
              items={[
                { label: t('tag.printedOn'), value: last?.printedAt ? formatDateTime(last.printedAt, place) : t('tag.notPrinted') },
                { label: t('tag.state'), value: job.status === 'error' ? (say({ key: job.problem }) ?? '') : last ? t(`printState.${last.state}`) : t('tag.noJob') },
                ...(last ? [{ label: t('tag.printer'), value: last.printerCode }] : []),
              ]}
            />
          )}
          <h4 className="fw-md-h4">{t('tag.opensTitle')}</h4>
          <ul className="fw-md-list">
            <li>{t('tag.opensStation')}</li>
            <li>{t('tag.opensPhone')}</li>
            <li>{t('tag.opensReprint')}</li>
          </ul>
          {machine.retired && <p className="fw-md-muted">{t('tag.retired')}</p>}
        </aside>
      </Card>
    </div>
  )
}
