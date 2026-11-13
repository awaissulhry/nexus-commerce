'use client'

import Link from 'next/link'
import { Card, EmptyState } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import type { TemplateView } from '../../api'
import { ridersHref } from '../../model'
import { useWords } from '../../parts'

/**
 * Measurement template › Where used (design template.whereused: "Styles that use it and rider profiles measured with it"): the
 * styles measured with it and how many are made to measure, the rider profile revisions measured for its garment type, and the
 * way to those riders (Sales › Made-to-measure with its garment type). The API counts them; a per-style list is not read here
 * (named gap). Fetches nothing.
 */
export function WhereUsedTab({ prefix, template }: { prefix: string; template: TemplateView }) {
  const { t } = useWords()
  const used = template.styles.measured > 0 || template.profiles > 0
  return (
    <Card padded>
      <section className="fw-lib-stack" aria-labelledby="mtt-used">
        <h2 id="mtt-used" className="fw-lib-title">
          {t('used.title')}
        </h2>
        {!used ? (
          <EmptyState
            title={t('used.empty')}
            description={t('used.emptyBody', { code: template.code })}
            action={
              <Button size="sm" asChild>
                <Link href={ridersHref(prefix, template.code)}>{t('used.openRiders', { code: template.code })}</Link>
              </Button>
            }
          />
        ) : (
          <>
            <dl className="fw-mtt-facts">
              <div className="fw-lib-readfield">
                <dt className="fw-lib-readfield-label">{t('used.styles')}</dt>
                <dd className="fw-lib-readfield-value">{t('used.stylesValue', { count: template.styles.measured, mtm: template.styles.madeToMeasure })}</dd>
              </div>
              <div className="fw-lib-readfield">
                <dt className="fw-lib-readfield-label">{t('used.profiles')}</dt>
                <dd className="fw-lib-readfield-value">{t('used.profilesValue', { count: template.profiles })}</dd>
              </div>
            </dl>
            <p className="fw-lib-hint">{t('used.kept')}</p>
            <Link className="fw-lib-link" href={ridersHref(prefix, template.code)}>
              {t('used.openRiders', { code: template.code })}
            </Link>
          </>
        )}
      </section>
    </Card>
  )
}
