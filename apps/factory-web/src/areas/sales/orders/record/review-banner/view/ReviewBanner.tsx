'use client'

import Link from 'next/link'
import { Ruler } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { NAMESPACE, type Phrase, type ReviewBannerModel } from '../model'
import '../review-banner.css'

type Translate = (key: string, params?: Record<string, string | number>) => string
const say = (t: Translate, words: Phrase) => t(words.key, words.params as Record<string, string | number> | undefined)

/**
 * "Waits for the factory review" (B-W2b-368, XF1:02) above the order record's tabs: the reason MEASUREMENTS in words and each
 * unit still waiting with its review (the rider profile), held with the reason without the right to see measurements. Draws one
 * model, fetches nothing; nothing at all while the order does not wait for a unit.
 */
export function ReviewBanner({ model, onRetry }: { model: ReviewBannerModel | null; onRetry?: () => void }) {
  if (!model || (model.state === 'ready' && !model.waits)) return null
  return (
    <WithMessages namespaces={[NAMESPACE]}>
      <Body model={model} onRetry={onRetry} />
    </WithMessages>
  )
}

function Body({ model, onRetry }: { model: ReviewBannerModel; onRetry?: () => void }) {
  const t = useT(NAMESPACE)
  if (model.state === 'loading') {
    return (
      <p className="fw-mtf-reading" role="status">
        <Spinner size={12} /> {t('banner.reading')}
      </p>
    )
  }
  if (model.state === 'error') {
    return (
      <Banner tone="danger" title={t('banner.failed')} action={<Button size="sm" onClick={() => onRetry?.()}>{t('banner.retry')}</Button>}>
        {say(t, model.problem)}
      </Banner>
    )
  }
  if (!model.waits) return null
  return (
    <div className="fw-mtf-banner" role="region" aria-label={t('banner.title')}>
      <Banner tone="warning" icon={<Ruler size={16} aria-hidden />} title={t('banner.title')}>
        <span className="fw-mtf-stack">
          <span>{t('banner.reason')}</span>
          <span className="fw-mtf-units">
            {model.units.map((unit) => (
              <span key={unit.lineId} className="fw-mtf-unit">
                <span className="fw-mtf-unit-words">
                  <span className="fw-mtf-strong">{say(t, unit.line)}</span>
                  <span>{say(t, unit.review)}</span>
                  {unit.off && <span>{say(t, unit.off)}</span>}
                </span>
                {unit.href ? (
                  <Button size="sm" variant="quiet" asChild>
                    <Link href={unit.href}>{t('banner.open')}</Link>
                  </Button>
                ) : (
                  <Button size="sm" variant="quiet" heldReason={unit.held ? say(t, unit.held) : null}>
                    {t('banner.open')}
                  </Button>
                )}
              </span>
            ))}
          </span>
          <span className="fw-mtf-hint">{t('banner.after')}</span>
        </span>
      </Banner>
    </div>
  )
}
