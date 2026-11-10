'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Banner, Card } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import type { ApiClient } from '../../../../lib/api/client'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { problemKey } from '../../../quality/_shared/model'
import { readTextileChecks, type TextileChecks } from '../../../compliance/labels/depth/api'
import { CompositionGroups } from '../../../compliance/labels/depth/view/BomComposition'
import '../../../compliance/labels/depth/depth.css'

const NS = 'compliance-labels-depth'

/** The part's read: not asked, being read, read, or the problem (a `quality` key). */
export type StyleComposition = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: TextileChecks } | { status: 'error'; problem: string }

/**
 * B-W2b-270: the style's composition computed from the BOM, for its Compliance tab (design products.styles › style.cp.label
 * "Composition computed from the BOM (W2b)"; B-W2b-208's textile checks of the revision in view), read while that tab shows
 * (compliance.certificates.view) and again with `reload`.
 */
export function useStyleComposition({ api, styleId, revisionId, enabled }: { api: ApiClient; styleId: string; revisionId: string | null; enabled: boolean }): { read: StyleComposition; reload: () => void } {
  const [read, setRead] = useState<StyleComposition>({ status: 'idle' })
  const load = useCallback(() => {
    if (!enabled) return
    setRead((current) => (current.status === 'ready' && (revisionId === null || current.value.revision.id === revisionId) ? current : { status: 'loading' }))
    readTextileChecks(api, styleId, { revisionId })
      .then((value) => setRead({ status: 'ready', value }))
      .catch((error: unknown) => setRead({ status: 'error', problem: problemKey(error) }))
  }, [api, styleId, revisionId, enabled])
  useEffect(() => load(), [load])
  return { read, reload: load }
}

/**
 * SCR-045 Compliance › Garment label and documents › Composition computed from the BOM (B-W2b-270; PRD-338): per group of
 * colourways that agree, each part (outer fabric, lining, padding, membrane) with its fibres in their official names, by
 * weight or as its one material says, the parts the BOM could not compute named (a missing weight), and how much of the
 * garment is textile. The label itself is written in Compliance › Labels & marking (linked). Absent (idle) for a person
 * who does not read compliance. It fetches nothing.
 */
export function StyleCompositionCard({ read, prefix, labelId, onRetry }: { read: StyleComposition | null | undefined; prefix: string; labelId?: string | null; onRetry?: () => void }) {
  if (!read || read.status === 'idle') return null
  return (
    <WithMessages namespaces={[NS, 'quality']}>
      <Body read={read} prefix={prefix} labelId={labelId ?? null} onRetry={onRetry} />
    </WithMessages>
  )
}

function Body({ read, prefix, labelId, onRetry }: { read: Exclude<StyleComposition, { status: 'idle' }>; prefix: string; labelId: string | null; onRetry?: () => void }) {
  const d = useT(NS)
  const q = useT('quality')
  const locale = useLocale()
  if (read.status === 'loading')
    return (
      <Card header={d('styleComposition.title')} aria-busy="true">
        <div className="fw-q-stack" role="status" aria-label={d('styleComposition.loading')}>
          <Skeleton height={18} width="70%" />
          <Skeleton height={18} width="45%" />
        </div>
      </Card>
    )
  if (read.status === 'error')
    return (
      <Card header={d('styleComposition.title')}>
        <Banner tone="warning" title={d('composition.failed')} action={onRetry ? <Button size="sm" onClick={onRetry}>{d('styleComposition.retry')}</Button> : undefined}>
          {q(read.problem)}
        </Banner>
      </Card>
    )
  const checks = read.value
  const label = checks.label
  return (
    <Card
      header={d('styleComposition.title')}
      description={d('styleComposition.intro', { revision: checks.revision.revision, size: checks.size ?? '—' })}
      headerAction={
        label || labelId ? (
          <Link className="fw-q-link" href={`${prefix}/compliance/labels/${encodeURIComponent(label?.id ?? labelId ?? '')}`}>
            {d('styleComposition.openLabel')}
          </Link>
        ) : undefined
      }
    >
      <div className="fw-q-stack">
        <CompositionGroups checks={checks} language={locale} />
        <p className="fw-q-hint">{label ? d('styleComposition.label', { code: label.code, revision: label.revision }) : d('styleComposition.noLabel')}</p>
      </div>
    </Card>
  )
}
