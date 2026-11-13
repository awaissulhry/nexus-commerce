'use client'

import Link from 'next/link'
import { Banner } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { NAMESPACE, type Phrase, type RemakePart } from '../model'
import '../outcome-remake.css'

type Translate = (key: string, params?: Record<string, string | number>) => string
const say = (t: Translate, words: Phrase) => t(words.key, words.params as Record<string, string | number> | undefined)

/**
 * A line's remake as a return outcome (B-W2b-368, XF1:03) in the RMA's Inspection & decision: the unit, the revision the remake is
 * made to and its factory review, where the returned unit goes, and "Make the remake order" (held with its reason) or the remake
 * order once made. Draws one model, fetches nothing.
 */
export function RemakeOutcome({ part, onMake, onRetry }: { part: RemakePart; onMake?: () => void; onRetry?: () => void }) {
  return (
    <WithMessages namespaces={[NAMESPACE]}>
      <Body part={part} onMake={onMake} onRetry={onRetry} />
    </WithMessages>
  )
}

function Body({ part, onMake, onRetry }: { part: RemakePart; onMake?: () => void; onRetry?: () => void }) {
  const t = useT(NAMESPACE)
  if (part.state === 'loading') {
    return (
      <p className="fw-mtr-reading" role="status">
        <Spinner size={12} /> {t('remake.reading')}
      </p>
    )
  }
  if (part.state === 'error') {
    return (
      <Banner tone="danger" title={t('remake.failed')} action={<Button size="sm" onClick={() => onRetry?.()}>{t('remake.retry')}</Button>}>
        {say(t, part.problem)}
      </Banner>
    )
  }
  if (part.state === 'notUnit') return <Banner tone="warning" title={say(t, part.words)} />
  return (
    <section className="fw-mtr-remake" aria-label={t('remake.title')}>
      <h4 className="fw-mtr-h4">{t('remake.title')}</h4>
      <span className="fw-mtr-stack">
        <span className="fw-mtr-strong">{say(t, part.unit)}</span>
        <span>{say(t, part.madeTo)}</span>
        <span>
          {say(t, part.remakeTo)} · {say(t, part.review)}
        </span>
        <span className="fw-mtr-hint">{t('remake.goods')}</span>
      </span>
      {part.order ? (
        <span className="fw-mtr-unit">
          <span>{t(part.order.waits ? 'remake.orderWaits' : 'remake.order', { number: part.order.number })}</span>
          <Button size="sm" variant="quiet" asChild>
            <Link href={part.order.href}>{t('remake.openOrder')}</Link>
          </Button>
        </span>
      ) : (
        <span className="fw-mtr-unit">
          <span className="fw-mtr-hint">{t('remake.makeHint')}</span>
          <Button size="sm" variant="primary" heldReason={part.held ? say(t, part.held) : null} onClick={() => onMake?.()}>
            {t('remake.make')}
          </Button>
        </span>
      )}
      {part.problem && (
        <p className="fw-mtr-problem" role="alert">
          {say(t, part.problem)}
        </p>
      )}
    </section>
  )
}
