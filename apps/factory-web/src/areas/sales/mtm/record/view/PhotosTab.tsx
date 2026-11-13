'use client'

import { CalendarX2, Image as ImageIcon, Upload } from 'lucide-react'
import { Card, EmptyState } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { ReadState, Section } from '../../../../quality/_shared/parts'
import type { ProfileRecord } from '../../api'
import { photoSets, rightHeld, type Phrase } from '../../model'
import { useWords } from '../../parts'
import type { ProfileRecordActions, ProfileRecordModel } from '../view-model'

/**
 * The rider profile's Photos tab (design rider.photos, SAL-286; personal data, office only): the front, side and back photos each
 * revision came with by the measurement link (B-W2b-171), when and by whom, the consent (the privacy notice ticked and when), the
 * day they are deleted; Open shows the stripped copy (location removed; the opening is recorded); "Set the deletion day" (with why,
 * logged) is the delete the platform has. Upload from the office has no route yet: held with the reason (photos come by the link).
 */
export function PhotosTab({ model, record, actions }: { model: ProfileRecordModel; record: ProfileRecord; actions?: ProfileRecordActions }) {
  const { t, say, day, when } = useWords()
  const offline = model.live === 'offline'
  const sent = model.sent
  const linkHeld: Phrase | null = !model.can.link ? rightHeld('link') : offline ? { key: 'held.offline' } : null
  const deleteHeld: Phrase | null = !model.can.link ? rightHeld('link') : offline ? { key: 'held.offline' } : null
  const uploadHeld = t('photos.uploadHeld')
  const sets = sent.items ? photoSets(sent.items.revisions) : []
  const head = (
    <div className="fw-mtm-head">
      <p className="fw-mtm-hint">{t('photos.intro')}</p>
      <div className="fw-mtm-actions">
        <Button size="sm" variant="secondary" heldReason={uploadHeld} onClick={() => undefined}>
          <Upload size={14} aria-hidden /> {t('photos.upload')}
        </Button>
        <Button size="sm" variant="primary" heldReason={say(linkHeld)} onClick={() => actions?.onOpenLink?.()}>
          {t('photos.askByLink')}
        </Button>
      </div>
    </div>
  )
  if (sent.problem || sent.items === null)
    return (
      <div className="fw-mtm-stack">
        {head}
        <ReadState problem={sent.problem} loading={sent.items === null && !sent.problem} onRetry={() => actions?.onRetry?.()} failedTitle={t('photos.failed')} />
      </div>
    )
  return (
    <div className="fw-mtm-stack">
      {head}
      {sets.length === 0 ? (
        <Card padded>
          <EmptyState icon={<ImageIcon size={20} aria-hidden />} title={t('photos.none')} description={t('photos.noneBody', { rider: record.riderName })} />
        </Card>
      ) : (
        sets.map((set) => (
          <Section
            key={set.revision.id}
            id={`photos-${set.revision.id}`}
            title={t('photos.revision', { revision: set.revision.revision })}
            sub={t('photos.sent', { when: when(set.revision.submittedAt), by: set.revision.takenBy })}
            actions={
              <Button size="sm" variant="secondary" heldReason={say(deleteHeld)} onClick={() => actions?.onOpenDeleteDay?.(set.revision.id, set.revision.revision)}>
                <CalendarX2 size={14} aria-hidden /> {t('photos.deleteDay')}
              </Button>
            }
          >
            <p className="fw-mtm-row fw-mtm-hint">
              <span>{t('photos.consent', { notice: set.revision.notice.label, when: when(set.revision.notice.at) })}</span>
              <span>{set.revision.photosDeleteAfter ? t('photos.deletedOn', { date: day(set.revision.photosDeleteAfter) }) : t('photos.keptUntilShipped')}</span>
            </p>
            <div className="fw-mtm-photos">
              {set.views.map((entry) => (
                <div key={entry.view} className="fw-mtm-photo">
                  <span className="fw-mtm-row">
                    <strong>{t(`photos.view.${entry.view}`)}</strong>
                    {entry.status && entry.status !== 'AVAILABLE' && <Tag tone="warning">{t('photos.notAvailable')}</Tag>}
                  </span>
                  {entry.fileId ? (
                    <Button size="sm" variant="secondary" heldReason={entry.status !== 'AVAILABLE' ? t('photos.notAvailable') : null} onClick={() => entry.fileId && actions?.onOpenPhoto?.(set.revision.id, entry.fileId, entry.view)}>
                      <ImageIcon size={14} aria-hidden /> {t('photos.open')}
                    </Button>
                  ) : (
                    <span className="fw-mtm-hint">{t('photos.missing')}</span>
                  )}
                </div>
              ))}
            </div>
          </Section>
        ))
      )}
      {sent.items.links.length > 0 && (
        <Section id="photos-links" title={t('photos.links')}>
          <ul className="fw-mtm-lines">
            {sent.items.links.map((link) => (
              <li key={link.id}>{t(link.revoked ? 'photos.linkRevoked' : link.uses >= link.maxUses ? 'photos.linkUsed' : 'photos.linkOpen', { email: link.email ?? t('link.theContact'), made: day(link.createdAt), until: day(link.expiresAt), photos: t(link.photos === 'REQUIRED' ? 'link.photosRequired' : 'link.photosOptional') })}</li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}
