'use client'

import { useEffect, type ReactNode } from 'react'
import { Lock, MoreHorizontal, Plus } from 'lucide-react'
import { Banner, Menu, type MenuItemDef } from '@nexus/ui/components'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { isPageKey } from '../../../library/model'
import { KeysDialog, RecordFrame, RecordState, SaveWords } from '../../../library/parts'
import { effectsInOrder, OPTION_TABS, STATUS_TONE, type GroupRecord, type OptionTab } from '../../model'
import type { GroupRecordActions, GroupRecordModel } from '../../view-model'
import { GroupFormDialog } from '../../view/GroupFormDialog'
import { ResultBanner, useSay } from '../../view/parts'
import { RecordDialogs } from './RecordDialogs'
import { EffectsTab } from './EffectsTab'
import { OptionsTab } from './OptionsTab'
import { RulesTab } from './RulesTab'
import { StylesTab } from './StylesTab'
import '../../../library/library.css'
import '../../options.css'

export type { GroupRecordModel, GroupRecordActions } from '../../view-model'

/** The record's catalogues: its own words, the libraries' (problems, common, record), the list frame's. */
export function RecordMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={['products-options', 'library', 'lists']}>{children}</WithMessages>
}

/**
 * SCR-114-record — an option group (design products.options rec "Option group"): the band (‹ Options & rules, "<code> ·
 * <name>", its kind, picks and company, its state, the tab's primary action, ⋯ Edit group, Archive / Restore, Copy code,
 * Keys) and the tabs Options (autosave per cell: code, name, the price surcharge with the price grain, a free-text value
 * and its length and pattern, outside the certificate), Rules (RuleBuilder; the set saved with the EditModeBar), Price &
 * BOM effects (autosave per cell; quantities per size with SizeColumns) and Styles (the styles that offer it, their own
 * minimum and maximum; Add styles). Read-only (archived, no right, offline) = text with the reason. It fetches nothing.
 */
export function GroupRecordView({ model, actions }: { model: GroupRecordModel; actions?: GroupRecordActions }) {
  return (
    <RecordMessages>
      <Record model={model} actions={actions} />
    </RecordMessages>
  )
}

function Record({ model, actions }: { model: GroupRecordModel; actions?: GroupRecordActions }) {
  const t = useT('products-options')
  const back = { href: `${model.prefix}/products/options`, label: t('record.back') }
  if (model.group.status === 'ready') return <Ready group={model.group.value} model={model} actions={actions} />
  return <RecordState back={back} state={model.group.status} problem={model.group.status === 'error' ? model.group.problem : null} onRetry={() => actions?.onRetry?.()} />
}

/** Why the library's cells, rules and effects may not change now (null: they may). */
export function manageHeld(group: GroupRecord, model: Pick<GroupRecordModel, 'can' | 'offline' | 'busy'>, t: (key: string) => string): string | null {
  if (group.status === 'ARCHIVED') return t('held.archived')
  if (!group.may.manage || !model.can.manage) return t('held.noManage')
  if (model.offline) return t('held.offline')
  return null
}

function Ready({ group, model, actions }: { group: GroupRecord; model: GroupRecordModel; actions?: GroupRecordActions }) {
  const t = useT('products-options')
  const tl = useT('library')
  const locale = useLocale()
  const say = useSay()
  const href = `${model.prefix}/products/options/${group.id}`
  const archived = group.status === 'ARCHIVED'
  const held = manageHeld(group, model, t)
  const offerHeld = archived ? t('held.archived') : !model.can.offer ? t('held.noOffer') : model.offline ? t('held.offline') : null
  const primary: { label: string; held: string | null; open: () => void } | null =
    model.tab === 'options'
      ? { label: t('options.add'), held: held ?? (model.busy ? tl('held.busy') : null), open: () => actions?.onDialog?.({ kind: 'addValue', draft: { code: '', name: '', freeText: group.kind === 'FREE_TEXT', maxLength: group.kind === 'FREE_TEXT' ? '30' : '', pattern: '' }, busy: false, problem: null, refused: [], messages: [] }) }
      : model.tab === 'effects'
        ? {
            label: t('effects.add'),
            held: held ?? (group.values.every((value) => value.status !== 'ACTIVE') ? t('effects.held.noOptions') : null),
            open: () => {
              const first = group.values.find((value) => value.status === 'ACTIVE')
              if (first) actions?.onDialog?.({ kind: 'effect', mode: 'new', effectId: null, draft: { valueId: first.id, kind: 'BOM_ADD', item: null, target: null, qty: '', uom: '', section: '', operation: null, minutes: '', note: '' }, material: { q: '', results: null }, target: { q: '', results: null }, operation: { q: '', results: null }, busy: false, problem: null, refused: [], messages: [] })
            },
          }
        : model.tab === 'styles'
          ? { label: t('styles.add'), held: offerHeld, open: () => actions?.onDialog?.({ kind: 'styles', q: '', results: null, picked: [], busy: false, outcome: null }) }
          : null

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || model.dialog) return
      if (event.key === 'n' && primary && !primary.held) {
        event.preventDefault()
        primary.open()
      } else if (event.key === '?') {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'help' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const manageRight = model.can.manage && group.may.manage !== false
  const more: MenuItemDef[] = [
    { id: 'edit', label: t('record.edit'), disabled: !!held, description: held ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'edit', form: { mode: 'edit', draft: { companyId: group.companyId ?? '', code: group.code, name: group.name, description: group.description ?? '', kind: group.kind, minPicks: String(group.minPicks), maxPicks: group.maxPicks === null ? '' : String(group.maxPicks) }, companies: [], everyCompany: false, busy: false, problem: null, refused: [], messages: [] } }) },
    archived
      ? { id: 'restore', label: t('record.restore'), disabled: !model.can.manage, description: model.can.manage ? undefined : t('held.noManage'), onSelect: () => actions?.onDialog?.({ kind: 'restore' }) }
      : { id: 'archive', label: t('record.archive'), tone: 'danger', disabled: !manageRight, description: manageRight ? undefined : t('held.noManage'), onSelect: () => actions?.onDialog?.({ kind: 'archive' }) },
    {
      id: 'copy',
      label: tl('list.copyCode'),
      onSelect: () => {
        void navigator.clipboard?.writeText(group.code).catch(() => undefined)
      },
    },
    { id: 'keys', label: tl('keys.menu'), onSelect: () => actions?.onDialog?.({ kind: 'help' }) },
  ]
  const effects = effectsInOrder(group)
  const counts: Record<OptionTab, number> = { options: group.values.filter((value) => value.status === 'ACTIVE').length, rules: group.counts.rules, effects: effects.length + group.effects.filter((effect) => effect.kind === 'PRICE').length, styles: group.counts.styles }
  const dialog = model.dialog

  return (
    <RecordFrame
      back={{ href: `${model.prefix}/products/options`, label: t('record.back') }}
      title={
        <span className="fw-lib-title">
          {group.code} <span className="fw-lib-title-name">· {group.name}</span>
        </span>
      }
      meta={[t(`kind.${group.kind}`), t('record.picks', { picks: say(group.picks) }), group.companyId ? (model.companyName ?? t('record.ownCompany')) : t('list.everyCompany')].join(' · ')}
      actions={
        <>
          {primary && (
            <Button size="sm" variant="primary" heldReason={primary.held} onClick={primary.open} aria-keyshortcuts="n">
              <Plus size={14} aria-hidden /> {primary.label}
            </Button>
          )}
          <Menu label={<MoreHorizontal size={16} aria-label={tl('record.more')} />} items={more} align="right" triggerProps={{ 'aria-label': tl('record.more') }} />
        </>
      }
      facts={
        <>
          <span className="fw-lib-tags">
            <Pill tone={STATUS_TONE[group.status]}>{tl(`status.${group.status}`)}</Pill>
            {group.outsideCertificate > 0 && <Tag tone="warning">{t('record.outside', { count: group.outsideCertificate })}</Tag>}
            {group.description && <span className="fw-lib-hint">{group.description}</span>}
          </span>
          <SaveWords state={model.save.state} at={model.save.at} />
        </>
      }
      tabs={OPTION_TABS.map((tab) => ({ id: tab, label: t(`tab.${tab}`), count: counts[tab] }))}
      active={model.tab}
      tabHref={(tab) => `${href}?tab=${tab}`}
    >
      {model.changed && (
        <Banner
          tone="info"
          title={tl('record.changed', { time: formatTime(model.changed.at, { locale }) })}
          action={
            <Button size="sm" onClick={() => actions?.onReload?.()}>
              {tl('record.reload')}
            </Button>
          }
        />
      )}
      {model.offline && <Banner tone="warning" title={t('offline.title')}>{t('offline.record')}</Banner>}
      <ResultBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
      {model.refused && model.refused.messages.length > 0 && model.notice?.tone === 'danger' && (
        <Banner tone="warning" title={t('refused.title')}>
          <ul className="fw-lib-list">
            {model.refused.messages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </Banner>
      )}
      {archived && <Banner tone="info" title={<span className="fw-lib-inline"><Lock size={14} aria-hidden /> {t('record.archivedBanner')}</span>} />}
      {model.tab === 'rules' ? (
        <RulesTab group={group} model={model} actions={actions} />
      ) : model.tab === 'effects' ? (
        <EffectsTab group={group} model={model} actions={actions} />
      ) : model.tab === 'styles' ? (
        <StylesTab group={group} model={model} actions={actions} />
      ) : (
        <OptionsTab group={group} model={model} actions={actions} />
      )}
      {dialog?.kind === 'edit' && <GroupFormDialog form={dialog.form} onDraft={actions?.onGroupDraft} onSave={actions?.onSaveGroup} onClose={() => actions?.onDialog?.(null)} />}
      {dialog?.kind === 'help' && (
        <KeysDialog
          keys={[
            { keys: ['n'], does: t('keys.add') },
            { keys: ['⌘', 'S'], does: tl('keys.save') },
            { keys: ['?'], does: tl('keys.help') },
          ]}
          onClose={() => actions?.onDialog?.(null)}
        />
      )}
      <RecordDialogs group={group} model={model} actions={actions} />
    </RecordFrame>
  )
}
