'use client'

import { useEffect, useRef } from 'react'
import { Bookmark, Check, Eye, EyeOff, MessageSquare } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { AsOf } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { ListKeysInfo } from '../../../../../list-frame/ListKeysInfo'
import { WithMessages } from '../../../../../record-panels/i18n'
import { sentenceWords } from '../../../notifications/words'
import { followingKey, type FollowingModel, type FollowingRow } from '../model'
import '../../today.css'
import '../following.css'

export interface FollowingActions {
  onSeen?: (row: FollowingRow) => void
  onUnfollow?: (row: FollowingRow) => void
  onRetry?: () => void
}

/**
 * Today › Changed since you looked (design home.today `following`, W2b; COL-035): what I follow that changed and I have not
 * marked seen, one line per record or saved view — the newest news in my language (its words cut to my grains), "and 2 more",
 * when, the record as a real link; Mark seen (e on the line) and Unfollow. Empty: nothing changed since I last looked. It draws
 * ONE model.
 */
export function FollowingView({ model, actions }: { model: FollowingModel; actions?: FollowingActions }) {
  return (
    <WithMessages namespaces={['home-mywork', 'home-notifications', 'lists']}>
      <Following model={model} actions={actions} />
    </WithMessages>
  )
}

function Following({ model, actions }: { model: FollowingModel; actions?: FollowingActions }) {
  const t = useT('home-mywork')
  const words = useT('home-notifications')
  const locale = useLocale()
  const held = model.held ? t(model.held) : null
  const listRef = useRef<HTMLUListElement>(null)
  const rows = model.rows.status === 'ready' ? model.rows.data.items : []
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const heldRef = useRef(held)
  heldRef.current = held
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || followingKey(event.key, { alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey }) === null) return
      const target = event.target as HTMLElement | null
      if (!target || !listRef.current?.contains(target) || target.closest('input, textarea, select, [role="menu"]')) return
      const key = target.closest<HTMLElement>('[data-following-row]')?.dataset.followingRow
      const row = key ? rowsRef.current.find((entry) => entry.key === key) : undefined
      if (!row || heldRef.current) return
      event.preventDefault()
      actionsRef.current?.onSeen?.(row)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <section className="fw-today-section" aria-labelledby="fw-mywork-following">
      <div className="fw-today-head">
        <h2 id="fw-mywork-following" className="fw-today-h">
          {t('following.title')}
        </h2>
        {model.rows.status === 'ready' && <AsOf at={model.rows.data.asOf} now={model.now} />}
      </div>
      {model.notice && <Banner tone={model.notice.tone} title={t(model.notice.key, model.notice.params)} />}
      {model.rows.status === 'loading' ? (
        <div className="fw-mywork-following-skeleton" aria-busy="true">
          <p className="fw-today-muted" role="status">
            {t('loading')}
          </p>
          <Skeleton height={20} />
          <Skeleton height={20} />
        </div>
      ) : model.rows.status === 'error' ? (
        <Banner tone="danger" title={t('following.error')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('retry')}</Button>}>
          {t(model.rows.problem)}
        </Banner>
      ) : rows.length === 0 ? (
        <EmptyState icon={<Eye size={22} aria-hidden />} title={t('following.empty.title')} description={t('following.empty.body')} />
      ) : (
        <>
          <ul ref={listRef} className="fw-mywork-following" aria-label={t('following.title')}>
            {rows.map((row) => {
              const sentence = sentenceWords(row, words, locale)
              // B-TH-239 (O-HOME-TODAY.changed-F01): with the reader's own new messages the line says "SO-0042: 3 new messages" and opens
              // the first unread one (its news stays under it); without a count it reads the news as before — never a made-up number.
              const fresh = row.newMessages !== undefined && row.newMessages > 0 ? row.newMessages : 0
              const label = fresh > 0 ? t('following.newMessages', { record: row.record.label, count: fresh }) : sentence
              return (
                <li key={row.key} data-following-row={row.key} className="fw-mywork-following-row">
                  {row.view ? <Bookmark size={16} className="fw-mywork-following-icon" aria-hidden /> : fresh > 0 ? <MessageSquare size={16} className="fw-mywork-following-icon" aria-hidden /> : <Eye size={16} className="fw-mywork-following-icon" aria-hidden />}
                  <span className="fw-mywork-following-text">
                    {row.href ? (
                      <a className="fw-mywork-following-link" href={row.href} title={fresh > 0 ? t('following.newMessagesHint') : undefined}>
                        {label}
                      </a>
                    ) : (
                      <span title={t('following.notBuilt')}>{label}</span>
                    )}
                    <span className="fw-today-muted">
                      {fresh > 0 ? `${sentence} · ` : ''}
                      {formatDateTime(row.at, { locale })}
                      {row.count > 1 ? ` · ${t('following.more', { count: row.count - 1 })}` : ''}
                    </span>
                  </span>
                  <span className="fw-mywork-following-actions">
                    <Button size="sm" variant="secondary" heldReason={held} aria-label={t('following.seenOn', { record: row.record.label })} onClick={() => actions?.onSeen?.(row)}>
                      <Check size={13} aria-hidden /> {t('following.seen')}
                    </Button>
                    <Button size="sm" variant="quiet" heldReason={held} aria-label={t(row.view ? 'following.unpinOn' : 'following.unfollowOn', { record: row.record.label })} onClick={() => actions?.onUnfollow?.(row)}>
                      <EyeOff size={13} aria-hidden /> {t(row.view ? 'following.unpin' : 'following.unfollow')}
                    </Button>
                  </span>
                </li>
              )
            })}
          </ul>
          <div className="fw-today-queue-foot">
            {!model.rows.data.complete && <span className="fw-today-muted">{t('following.partial')}</span>}
            <ListKeysInfo keys={[{ keys: ['Tab'], does: t('following.keys.move') }, { keys: ['e'], does: t('following.keys.seen') }, { keys: ['↵'], does: 'keys.open' }]} />
          </div>
        </>
      )}
    </section>
  )
}
