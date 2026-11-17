'use client'

import { useEffect, useId, useState } from 'react'
import { Bell, BellOff, Eye, EyeOff, UserPlus, Users } from 'lucide-react'
import { Banner, DetailPopover } from '@nexus/ui/components'
import { Button, Select, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import type { PanelFollowers } from '../../model'
import { followReasonKey } from '../model'
import '../tasks.css'

/** B-TH-280: what the control draws — the record's followers (null while read; undefined: no control). */
export interface FollowersControlModel {
  readonly followers: PanelFollowers | null | undefined
}

/** My own follow (follow, unfollow, mute), a colleague added, and Try again after a failed read. */
export interface FollowersControlActions {
  onFollow?: (wanted: { following: boolean; muted: boolean }) => void
  onAddFollower?: (userId: string) => void
  onRetry?: () => void
}

/**
 * Follow and Followers (N) (design shell.panels band "Follow toggle", popup followers "Followers (4)": who follows and why
 * — made it, was given something on it, was mentioned, chose to —; Follow / Unfollow for me; mute; add a person; COL-011).
 * Following brings the record's news (a note, a mail out, a reply in) to the person's notifications; muted keeps the
 * follow without the news (a mention of them still reaches them). Adding a colleague needs threads.post; only people who
 * may read the record are offered.
 */
export function FollowersControl({ model, actions }: { model: FollowersControlModel; actions?: FollowersControlActions }) {
  const t = useT('records')
  const locale = useLocale()
  const followers = model.followers
  // Opened after the first paint (a design case opens it at once): the popover is drawn into <body>, which a server
  // render lacks, so the server and the first client render agree (closed).
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(followers?.open ?? false), [followers?.open])
  const [adding, setAdding] = useState('')
  const pickId = useId()
  if (followers === undefined) return null
  if (followers === null) {
    return (
      <div className="fw-rtask-follow" role="group" aria-label={t('followers.group')}>
        <Button size="sm" variant="secondary" heldReason={t('followers.reading')}>
          <Bell size={14} aria-hidden /> {t('followers.follow')}
        </Button>
      </div>
    )
  }
  const busy = followers.busy ? t('followers.held.busy') : null
  const following = followers.me.following
  const candidates = followers.candidates
  const addHeld = !followers.canAdd ? t('followers.held.noPost') : candidates.length === 0 ? t('followers.held.nobody') : !adding ? t('followers.held.pick') : busy
  return (
    <div className="fw-rtask-follow" role="group" aria-label={t('followers.group')}>
      <Button size="sm" variant={following ? 'tonal' : 'secondary'} aria-pressed={following} heldReason={busy} onClick={() => actions?.onFollow?.({ following: !following, muted: false })}>
        {following ? <BellOff size={14} aria-hidden /> : <Bell size={14} aria-hidden />} {following ? t(followers.me.muted ? 'followers.followingMuted' : 'followers.following') : t('followers.follow')}
      </Button>
      <DetailPopover
        trigger={
          <span className="fw-rtask-follow-trigger">
            <Users size={14} aria-hidden /> {t('followers.count', { count: followers.count })}
          </span>
        }
        triggerLabel={t('followers.open', { count: followers.count })}
        triggerClassName="nds-btn sm"
        label={t('followers.title', { count: followers.count })}
        hoverDelay={0}
        open={open}
        onOpenChange={setOpen}
      >
        <div className="fw-rtask-followers">
          <p className="fw-rtask-followers-title">{t('followers.title', { count: followers.count })}</p>
          <p className="fw-rtask-note">{t('followers.intro')}</p>
          {followers.problem && <Banner tone="danger" title={t(followers.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('panels.retry')}</Button>} />}
          {followers.list.length === 0 ? (
            <p className="fw-rtask-note">{t('followers.none')}</p>
          ) : (
            <ul className="fw-rtask-follower-list" aria-label={t('followers.title', { count: followers.count })}>
              {followers.list.map((follower) => (
                <li key={follower.userId} className="fw-rtask-follower">
                  <span className="fw-rtask-follower-name">{follower.me ? t('followers.you', { name: follower.name }) : follower.name}</span>
                  <span className="fw-rtask-note">
                    {t(followReasonKey(follower.reason))}
                    {follower.addedBy ? ` · ${t('followers.addedBy', { name: follower.addedBy })}` : ''} · {t('followers.since', { date: formatDate(follower.since, { locale }) })}
                  </span>
                  {follower.muted && (
                    <Tag tone="neutral">
                      <EyeOff size={12} aria-hidden /> {t('followers.muted')}
                    </Tag>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="fw-rtask-followers-me">
            {following ? (
              <>
                <Button size="sm" variant="secondary" heldReason={busy} onClick={() => actions?.onFollow?.({ following: false, muted: false })}>
                  <BellOff size={14} aria-hidden /> {t('followers.unfollow')}
                </Button>
                <Button size="sm" variant="secondary" heldReason={busy} onClick={() => actions?.onFollow?.({ following: true, muted: !followers.me.muted })}>
                  {followers.me.muted ? <Eye size={14} aria-hidden /> : <EyeOff size={14} aria-hidden />} {t(followers.me.muted ? 'followers.unmute' : 'followers.mute')}
                </Button>
              </>
            ) : (
              <Button size="sm" variant="primary" heldReason={busy} onClick={() => actions?.onFollow?.({ following: true, muted: false })}>
                <Bell size={14} aria-hidden /> {t('followers.follow')}
              </Button>
            )}
          </div>
          <div className="fw-rtask-followers-add">
            <label className="fw-rtask-legend" htmlFor={pickId}>
              {t('followers.addLabel')}
            </label>
            <span className="fw-rtask-followers-add-row">
              <Select id={pickId} size="sm" value={adding} onChange={(event) => setAdding(event.target.value)} disabled={!followers.canAdd || candidates.length === 0}>
                <option value="">{t('followers.pick')}</option>
                {candidates.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </Select>
              <Button
                size="sm"
                variant="secondary"
                heldReason={addHeld}
                onClick={() => {
                  if (!adding) return
                  actions?.onAddFollower?.(adding)
                  setAdding('')
                }}
              >
                <UserPlus size={14} aria-hidden /> {t('followers.add')}
              </Button>
            </span>
          </div>
        </div>
      </DetailPopover>
    </div>
  )
}
