'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { AlertCircle, FileQuestion, Lock } from 'lucide-react'
import { Card, EmptyState } from '@nexus/ui/components'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import { rightRef } from '../../../../lib/i18n/rights'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { ProjectFrame } from '../../../products/projects/record/ProjectFrame'
import type { RecordSummary } from '../api'
import { linkWords, recordName, stateTone, SUMMARY_NS, SUMMARY_RIGHT, wordsIn, type Opener, type SummaryState } from '../model'
import { RecordSummaryView } from './RecordSummaryView'
import '../record-summary.css'

/**
 * SCR-006-generic — the generic record page (B-TH-272; threads plan PL5; O-REC-ANY.summary, O-REC-ANY.thread; picture 41, never drawn:
 * built to the design kit, the tree and the record-frame pattern). `/w/<company>/records/<type>/<id>` opens a record whose own page is
 * not built yet; its six inner tabs became ONE full-page thread and a summary:
 *
 *   band     in the shell's band row (the record frame's look): ‹ Home, "<type> <number>", the ONE state pill (the API's words), the
 *            record it belongs to as a link ("Part of Sales order SO-…"), ⋯ with the Keyboard line (PR-14).
 *   thread   the office's thread full page (~2/3 from 1280 px: 1440 ≈ 860 px, 1920 ≈ 1180 px), its Head ⋯ holding the old tabs'
 *            doors (Add task, Ask a partner to approve, Share with a partner: R-ACT), View › Changes the history, Files the files.
 *   side     the summary (~1/3: 1440 ≈ 430 px, 1920 ≈ 590 px), sticky; below 1280 px behind the band's "Details", an "i" on a phone.
 *
 * The frame is the project page's (B-TH-249, "the generic record page grown"): the same band, columns and phone rule, one thread per
 * page, no page max-width. A record outside the reader's scope (404) reads "You cannot see this record" with the way Home and no
 * thread; a missing right says which; reading and a problem stay inside the page. Draws one view model and fetches nothing: the
 * container passes the thread and the print form.
 */

export interface GenericRecordModel {
  /** `/w/<company code>`. */
  readonly prefix: string
  /** The address's record type and id (the name until the summary is read). */
  readonly recordType: string
  readonly recordId: string
  readonly state: SummaryState
  readonly summary: RecordSummary | null
  /** The opener's terms (`?label=&company=&site=`). */
  readonly opener: Opener
  /** Where the parent opens (company-prefixed); null: no parent the reader may open. */
  readonly parentHref: string | null
}

export interface GenericRecordActions {
  onRetry?: () => void
}

export interface GenericRecordSlots {
  /** The office's thread (OfficeRecordThread docked, outside a RecordFrame: no width menu), once the summary is read. */
  readonly thread?: ReactNode
  /** What the print view shows of the thread (ThreadPrint: the thread for paper, B-TH-280). */
  readonly printThread?: ReactNode
}

export function GenericRecordView({ model, actions, thread, printThread }: { model: GenericRecordModel; actions?: GenericRecordActions } & GenericRecordSlots) {
  return (
    <WithMessages namespaces={[SUMMARY_NS]}>
      <Page model={model} actions={actions} thread={thread} printThread={printThread} />
    </WithMessages>
  )
}

function Page({ model, actions, thread, printThread }: { model: GenericRecordModel; actions?: GenericRecordActions } & GenericRecordSlots) {
  const t = useT(SUMMARY_NS)
  const locale = useLocale()
  const back = <Link href={model.prefix}>{t('band.home')}</Link>
  const name = recordName({ summary: model.summary, opener: model.opener, type: model.recordType, id: model.recordId, locale })
  const threadLabel = t('thread.label', { record: name })

  if (model.state !== 'ready' || !model.summary) {
    const title = model.state === 'missing' ? t('missing.title') : model.state === 'noRight' ? t('noRight.title') : model.state === 'error' ? t('failed.title') : (model.opener.label ?? t('band.reading'))
    return (
      <ProjectFrame band={{ back, title, moreLabel: t('band.moreLabel') }} thread={null} threadLabel={threadLabel} side={null} sideLabel={t('summary.label')}>
        {model.state === 'missing' ? (
          <Card padded>
            <EmptyState
              icon={<FileQuestion size={24} aria-hidden />}
              title={t('missing.title')}
              description={t('missing.body')}
              action={
                <Button asChild variant="primary">
                  <Link href={model.prefix}>{t('missing.home')}</Link>
                </Button>
              }
            />
          </Card>
        ) : model.state === 'noRight' ? (
          <Card padded>
            <EmptyState
              icon={<Lock size={24} aria-hidden />}
              title={t('noRight.title')}
              description={t('noRight.body', { right: rightRef(SUMMARY_RIGHT) })}
              action={
                <Button asChild variant="secondary">
                  <Link href={model.prefix}>{t('missing.home')}</Link>
                </Button>
              }
            />
          </Card>
        ) : model.state === 'error' ? (
          <Card padded>
            <EmptyState
              icon={<AlertCircle size={24} aria-hidden />}
              title={t('failed.title')}
              description={t('failed.body')}
              action={
                <Button variant="primary" onClick={() => actions?.onRetry?.()}>
                  {t('failed.retry')}
                </Button>
              }
            />
          </Card>
        ) : (
          <div className="fw-rsum-reading" role="status" aria-busy="true" aria-label={t('band.reading')}>
            <div className="fw-rsum-reading-thread">
              <Skeleton height={44} />
              <Skeleton height={360} />
            </div>
            <div className="fw-rsum-reading-side">
              <Skeleton height={200} />
            </div>
          </div>
        )}
      </ProjectFrame>
    )
  }

  const summary = model.summary
  const parent = summary.parent
  const status = summary.state ? <Pill tone={stateTone(summary.state.code)}>{wordsIn(summary.state.words, locale)}</Pill> : undefined
  const meta = parent ? (
    <span className="fw-rsum-part">
      {t('band.partOf')} {model.parentHref ? <Link href={model.parentHref}>{linkWords(parent, locale)}</Link> : linkWords(parent, locale)}
    </span>
  ) : undefined
  const side = <RecordSummaryView model={{ summary, parentHref: model.parentHref }} />

  return (
    <ProjectFrame
      band={{ back, title: name, status, meta, moreLabel: t('band.moreLabel') }}
      thread={thread ?? null}
      threadLabel={threadLabel}
      side={side}
      sideLabel={t('summary.label')}
      printThread={printThread}
    >
      {/* No thread (the container had none to give): the summary alone, full width. */}
      {side}
    </ProjectFrame>
  )
}
