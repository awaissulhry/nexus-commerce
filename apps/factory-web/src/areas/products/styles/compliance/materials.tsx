'use client'

import Link from 'next/link'
import { Banner, Card, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import { WithMessages } from '../../../../record-panels/i18n'
import { useT } from '../../../../lib/i18n/provider'
import { APPROVAL_TONE, type PartRead } from '../../materials/approval/depth-model'
import type { MaterialApprovalsView } from '../../materials/approval/api'
import { useDepthWords } from '../../materials/approval/words'
// The library's layout classes (fw-lib-*): this card sits on the style page.
import '../../library/library.css'

const NS = 'products-materials-depth'

export type StyleMaterialApprovals = PartRead<MaterialApprovalsView>

/**
 * SCR-045 Compliance › Material checks — Blocked or unapproved materials (B-W2b-238; PRD-035; design style.cp.materials):
 * the materials of the revision's BOM (its lines and their alternates) that are blocked, approved on a condition or not
 * reviewed yet, each a link to the material's Compliance tab with the lines that name it and why. A blocked one holds the
 * release of a draft (the database refuses it); a released revision keeps it as it is. Nothing to show: "Nothing to check".
 * Absent (null) for a person who does not read the BOM. It fetches nothing.
 */
export function MaterialApprovalsCard({ read, prefix, onRetry }: { read: StyleMaterialApprovals | null | undefined; prefix: string; onRetry?: () => void }) {
  if (!read || read.status === 'idle') return null
  return (
    <WithMessages namespaces={[NS, 'library']}>
      <Body read={read} prefix={prefix} onRetry={onRetry} />
    </WithMessages>
  )
}

function Body({ read, prefix, onRetry }: { read: StyleMaterialApprovals; prefix: string; onRetry?: () => void }) {
  const t = useT(NS)
  const words = useDepthWords()
  if (read.status === 'loading')
    return (
      <Card header={t('styleChecks.title')} aria-busy="true">
        <div className="fw-lib-stack" role="status" aria-label={t('loading')}>
          <Skeleton height={18} width="70%" />
          <Skeleton height={18} width="50%" />
        </div>
      </Card>
    )
  if (read.status === 'error')
    return (
      <Card header={t('styleChecks.title')}>
        <Banner tone="danger" title={t('styleChecks.failed')} action={onRetry ? <Button size="sm" onClick={onRetry}>{t('retry')}</Button> : undefined}>
          {words(read.problem)}
        </Banner>
      </Card>
    )
  if (read.status !== 'ready') return null
  const view = read.value
  const open = view.materials.filter((material) => material.approval !== 'APPROVED')
  const draft = view.revision.status === 'DRAFT'
  return (
    <Card header={t('styleChecks.title')} description={t('styleChecks.intro', { revision: view.revision.revision })}>
      <div className="fw-lib-stack">
        {view.counts.blocked > 0 && <Banner tone={draft ? 'danger' : 'warning'} title={t(draft ? 'styleChecks.blockedDraft' : 'styleChecks.blockedReleased', { count: view.counts.blocked })} />}
        {open.length === 0 ? (
          <p className="fw-lib-hint">{t('styleChecks.none', { count: view.materials.length })}</p>
        ) : (
          <SummaryTable
            label={t('styleChecks.title')}
            stackOnPhone
            columns={[t('styleChecks.col.material'), t('styleChecks.col.lines'), t('styleChecks.col.approval'), t('styleChecks.col.why')]}
            rows={open.map((material) => ({
              id: material.itemId,
              cells: [
                <span key="m" className="fw-lib-cell">
                  <Link className="fw-lib-link" href={`${prefix}/products/materials/${material.itemId}?tab=compliance`}>
                    {material.code}
                  </Link>
                  <span className="fw-lib-sub">{material.name}</span>
                </span>,
                material.alternateOnly ? t('styleChecks.alternateOn', { lines: material.lines.join(', ') }) : material.lines.join(', '),
                <Pill key="a" tone={APPROVAL_TONE[material.approval]}>
                  {t(`approval.state.${material.approval}`)}
                </Pill>,
                material.note ?? (material.approval === 'PENDING' ? t('styleChecks.pendingWhy') : '—'),
              ],
            }))}
          />
        )}
      </div>
    </Card>
  )
}
