'use client'

import Link from 'next/link'
import { AlertTriangle, GitMerge, Lock } from 'lucide-react'
import { Banner, Card } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { formatDateTime, formatTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { ageWords, labelOf, personWords } from '../../_shared/model'
import { MachinePill, SymptomText, useWords } from '../../_shared/parts'
import { LOCKS_SHOWN, mergeHeld, mergeDraftOf, targetKey } from '../depth/model'
import type { RequestsListActions, RequestsListModel } from '../view-model'
import '../depth/depth.css'

/**
 * The two W2b sections of Machine requests (B-W2b-140; design plant.requests):
 * - Unsafe machines (`sec:unsafe`, QHS-183): one critical banner per machine locked now — "Clicking press P-03 locked:
 *   guard missing · reported 09:12 by Station C2 · Open" — always the first thing on the page; it stays until a technician
 *   signs the machine safe (GET /plant/requests/locks). Loading: skeleton; none: hidden; a failed read says so with Try
 *   again (never drawn as none).
 * - Possible duplicates (`sec:dupes`, QHS-181): "3 requests on Lockstitch L2-07 in 20 min" with Merge into one (the Merge
 *   requests dialog: every reporter keeps their request and follows the one kept). Hidden when none.
 */

export function UnsafeBanners({ model, actions }: { model: RequestsListModel; actions?: RequestsListActions }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const locks = model.locks
  if (locks.problem) {
    return (
      <Banner
        tone="danger"
        icon={<AlertTriangle size={18} aria-hidden />}
        title={t('locks.failed')}
        action={
          <Button size="sm" onClick={() => actions?.onRetryLocks?.()}>
            {t('common.retry')}
          </Button>
        }
      >
        {t(locks.problem)}
      </Banner>
    )
  }
  if (locks.items === null) {
    return (
      <div className="fw-pd-locks" aria-busy="true">
        <span className="fw-pl-hint" role="status">
          {t('locks.loading')}
        </span>
        <Skeleton height={44} />
      </div>
    )
  }
  if (locks.items.length === 0) return null
  const shown = locks.items.slice(0, LOCKS_SHOWN)
  const more = locks.items.length - shown.length
  return (
    <section className="fw-pd-locks" aria-label={t('locks.label', { count: locks.items.length })}>
      {shown.map((lock) => {
        const request = lock.request
        const what = request.symptom ? labelOf(request.symptom, locale) : request.description?.trim() || t('symptom.none')
        const when = request.ageMinutes < 24 * 60 ? formatTime(request.reportedAt, place) : formatDateTime(request.reportedAt, place)
        return (
          <Banner
            key={lock.machine.id}
            tone="danger"
            icon={<Lock size={18} aria-hidden />}
            title={t('locks.title', { class: labelOf(lock.machine.class, locale), machine: lock.machine.assetNumber, what })}
            action={
              <Button size="sm" onClick={() => actions?.onOpen?.(request.id)} aria-label={t('locks.openFor', { machine: lock.machine.assetNumber })}>
                {t('locks.open')}
              </Button>
            }
          >
            {t('locks.body', { when, who: personWords(t, request.reportedBy), age: ageWords(t, request.ageMinutes) })}
            {' · '}
            {lock.canSignSafe ? t('locks.youSign') : t('locks.technicianSigns')}
          </Banner>
        )
      })}
      {more > 0 && model.address.tile !== 'UNSAFE' && (
        <span className="fw-pl-row">
          <span className="fw-pl-hint">{t('locks.more', { count: more })}</span>
          <Button size="sm" variant="quiet" onClick={() => actions?.onTile?.('UNSAFE')}>
            {t('requests.lockedShow')}
          </Button>
        </span>
      )}
    </section>
  )
}

export function DuplicatesPanel({ model, actions }: { model: RequestsListModel; actions?: RequestsListActions }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const dupes = model.duplicates
  if (dupes.items && dupes.items.length === 0) return null
  return (
    <section className="fw-pl-section" aria-labelledby="pl-dupes">
      <h2 className="fw-pl-h3" id="pl-dupes">
        <GitMerge size={14} aria-hidden /> {t('dupes.title')}
      </h2>
      {dupes.problem ? (
        <Card padded>
          <span className="fw-pl-row">
            <span className="fw-pl-hint" role="alert">
              {t('dupes.failed')} {t(dupes.problem)}
            </span>
            <Button size="sm" onClick={() => actions?.onRetryDuplicates?.()}>
              {t('common.retry')}
            </Button>
          </span>
        </Card>
      ) : dupes.items === null ? (
        <div className="fw-pd-dupes" aria-busy="true">
          <span className="fw-pl-hint" role="status">
            {t('dupes.loading')}
          </span>
          <Skeleton height={96} />
        </div>
      ) : (
        <div className="fw-pd-dupes">
          {dupes.items.map((group) => {
            const held = mergeHeld(group, mergeDraftOf(group), model.can)
            const suggested = group.suggested
            return (
              <Card key={group.machine.id} padded>
                <div className="fw-pl-stack tight">
                  <p className="fw-pl-h3">
                    <Link className="fw-pl-link fw-pl-code" href={`${model.prefix}/plant/machines/${encodeURIComponent(group.machine.id)}`}>
                      {group.machine.assetNumber}
                    </Link>
                    <MachinePill status={group.machine.status} locked={group.requests.some((request) => request.locking)} />
                  </p>
                  <p className="fw-pl-text">{t('dupes.words', { count: group.requests.length, class: labelOf(group.machine.class, locale), machine: group.machine.assetNumber, age: ageWords(t, group.withinMinutes) })}</p>
                  <ul className="fw-pl-plain">
                    {group.requests.map((request) => (
                      <li key={request.id} className="fw-pd-dupe-line">
                        <button type="button" className="fw-pd-linkish" onClick={() => actions?.onOpen?.(request.id)}>
                          <SymptomText symptom={request.symptom} description={request.description} />
                        </button>
                        <span className="fw-pl-sub">
                          {formatTime(request.reportedAt, place)} · {personWords(t, request.reportedBy)}
                        </span>
                        {targetKey(suggested) === `REQUEST:${request.id}` && <Tag tone="info">{t('dupes.kept')}</Tag>}
                        {request.locking && <Tag tone="danger">{t('unsafe.tag')}</Tag>}
                      </li>
                    ))}
                  </ul>
                  <p className="fw-pl-hint">{suggested.kind === 'JOB' ? t('dupes.suggestJob', { number: suggested.number }) : t('dupes.suggestRequest')}</p>
                  <span>
                    <Button size="sm" variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onMergeGroup?.(group)}>
                      <GitMerge size={13} aria-hidden /> {t('dupes.merge')}
                    </Button>
                  </span>
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </section>
  )
}
