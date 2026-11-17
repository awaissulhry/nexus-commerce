'use client'

import { ChevronDown, MessageSquareText, Save } from 'lucide-react'
import { Menu, type MenuItemDef } from '@nexus/ui/components'
import { Spinner, Tag } from '@nexus/ui/primitives'
import { formatTime } from '../../../i18n/format'
import { useLocale, useT } from '../../../i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { replyGroups, type LocalDraft, type SavedRepliesModel } from '../model'
import { HELPERS_NS } from './MentionInput'
import '../helpers.css'

/**
 * Saved replies ▾ (B-TH-208, T8-F02; picture 6): the existing saved replies (GET /templates/replies) in two labelled groups
 * — shared with the office, then mine — each line with its language, the customer's language first (th-backend-g step 3: the five
 * message languages, it · en · de · fr · es). Picking one only fills the box: the container asks the API to fill it from THIS record (POST …/fill) and the
 * person reads and changes it; nothing is sent by picking. The blanks the record could not fill are said under the box.
 */
export function SavedReplies({ model, onPick, onRetry }: { model: SavedRepliesModel; onPick?: (replyId: string) => void; onRetry?: () => void }) {
  return (
    <WithMessages namespaces={[HELPERS_NS]}>
      <Replies model={model} onPick={onPick} onRetry={onRetry} />
    </WithMessages>
  )
}

function Replies({ model, onPick, onRetry }: { model: SavedRepliesModel; onPick?: ((replyId: string) => void) | undefined; onRetry?: (() => void) | undefined }) {
  const t = useT(HELPERS_NS)
  const locale = useLocale()
  const items: MenuItemDef[] = []
  if (model.status === 'loading') items.push({ id: 'loading', label: t('replies.loading'), disabled: true, description: t('replies.loadingHint') })
  else if (model.status === 'failed') items.push({ id: 'retry', label: t('replies.failed'), description: t('replies.retry'), onSelect: () => onRetry?.() })
  else if (model.status === 'notForThis') items.push({ id: 'none', label: t('replies.notForThis'), disabled: true, description: t('replies.notForThisHint') })
  else if (model.replies.length === 0) items.push({ id: 'none', label: t('replies.none'), disabled: true, description: t('replies.noneHint') })
  else {
    const groups = replyGroups(model.replies, model.language, locale)
    const line = (reply: (typeof groups.shared)[number]): MenuItemDef => ({
      id: reply.id,
      label: reply.name,
      disabled: !!model.held,
      description: model.held ?? (reply.language === model.language ? t('replies.languageTheirs', { language: t(`language.${reply.language}`) }) : t(`language.${reply.language}`)),
      onSelect: () => onPick?.(reply.id),
    })
    if (groups.shared.length > 0) items.push({ id: 'h-shared', heading: true, label: t('replies.shared') }, ...groups.shared.map(line))
    if (groups.shared.length > 0 && groups.mine.length > 0) items.push({ id: 'sep', separator: true })
    if (groups.mine.length > 0) items.push({ id: 'h-mine', heading: true, label: t('replies.mine') }, ...groups.mine.map(line))
  }
  return (
    <span className="fw-rtm-replies">
      <Menu
        label={
          <>
            {/* B-TH-300: in a narrow dock the word gives way to the icon (the button keeps its name). */}
            <MessageSquareText size={14} aria-hidden /> <span className="fw-rtm-replies-word">{t('replies.label')}</span> <ChevronDown size={14} aria-hidden />
          </>
        }
        items={items}
        triggerProps={{ className: 'nds-btn sm', 'aria-label': t('replies.menu', { language: t(`language.${model.language}`) }) }}
      />
      {model.filling && (
        <span className="fw-rtm-hint" role="status">
          <Spinner size={12} /> {t('replies.filling')}
        </span>
      )}
      {model.missing && model.missing.length > 0 && (
        <span className="fw-rtm-hint is-warning" role="status">
          {t('replies.missing', { count: model.missing.length })}{' '}
          {model.missing.map((name) => (
            <Tag key={name} tone="warning">{`{{${name}}}`}</Tag>
          ))}
        </span>
      )}
    </span>
  )
}

/** "Draft kept on this device · saved 10:42" (T8-F07 until N6): said, so nobody expects it on another computer. */
export function DraftLine({ draft, timeZone }: { draft: LocalDraft | null; timeZone?: string }) {
  return (
    <WithMessages namespaces={[HELPERS_NS]}>
      <Draft draft={draft} timeZone={timeZone} />
    </WithMessages>
  )
}

function Draft({ draft, timeZone }: { draft: LocalDraft | null; timeZone?: string | undefined }) {
  const t = useT(HELPERS_NS)
  const locale = useLocale()
  if (!draft) return null
  return (
    <span className="fw-rtm-hint" role="status">
      <Save size={12} aria-hidden /> {t('draft.kept', { time: formatTime(draft.savedAt, { locale, ...(timeZone ? { timeZone } : {}) }) })}
    </span>
  )
}
