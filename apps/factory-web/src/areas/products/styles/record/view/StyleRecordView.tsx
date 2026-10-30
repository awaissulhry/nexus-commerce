'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { FileX, Lock, MessageSquare, MoreHorizontal, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, Modal, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Kbd, Pill, Select, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { RecordPanelsView } from '../../../../../record-panels/view/RecordPanelsView'
import type { BomView, StyleView } from '../../api'
import { DuplicateDialog } from '../../duplicate/view/DuplicateDialog'
import { draftOf, editableRevision, nextRevisionNumber, releaseHeld, releasedOf, revisionInView, startRevisionHeld, STATUS_TONE, stepRevision, tabsFor, type StyleTab } from '../../model'
import type { StyleRecordActions, StyleRecordViewModel } from '../record-model'
import { StyleDialogs } from './Dialogs'
import { OverviewTab } from './OverviewTab'
import { TabBody } from './TabBody'
import { VariantsTab } from './VariantsTab'
import '../../styles.css'

export type { StyleRecordViewModel, StyleRecordActions } from '../record-model'

/**
 * SCR-041 … SCR-045 — the Style studio (design products.styles "Record: Style"; 00 §2.2 record studio; Owner L1: the
 * tabs always in view in the band). The band: ‹ Styles, "<code> · <name>", the lifecycle, the revision in view (a scope
 * picker: `[` / `]` step through the revisions), the PPE tag, the save words, the next step as the primary — Release
 * revision N, held with the count of what blocks it (`r` opens the check anyway) — the thread (⌘J) and ⋯ (Start
 * revision N, Abandon the draft, Archive / Reactivate, Copy code, Keyboard shortcuts). The tabs: Overview, Colourways &
 * sizes, Materials (BOM), Operations (routing), Cost, Compliance, Activity — each shown only to a person whose role
 * reads it. A released revision is frozen: its tabs say so and offer the draft (or Start revision N). It draws one view
 * model and fetches nothing (StyleRecord.tsx loads it).
 */
export function StyleRecordView({ model, actions, panels }: { model: StyleRecordViewModel; actions?: StyleRecordActions; panels?: ReactNode }) {
  return (
    <WithMessages namespaces={['products', 'records', 'lists']}>
      <StyleRecord model={model} actions={actions} panels={panels} />
    </WithMessages>
  )
}

function StyleRecord({ model, actions, panels }: { model: StyleRecordViewModel; actions?: StyleRecordActions; panels?: ReactNode }) {
  const t = useT('products')
  const listHref = `${model.prefix}/products/styles`
  const loaded = model.style

  if (loaded.status !== 'ready') {
    return (
      <div className="fw-st">
        <div className="fw-st-band">
          <DetailHeader backAsChild backLabel={<Link href={listHref}>{t('record.back')}</Link>} title={loaded.status === 'loading' ? <Skeleton width={240} height={22} /> : t('record.title')} />
        </div>
        {loaded.status === 'loading' ? (
          <Card padded aria-busy="true">
            <p className="fw-st-hint" role="status">
              <Spinner size={14} /> {t('record.loading')}
            </p>
            <div className="fw-st-skeleton">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} height={22} />
              ))}
            </div>
          </Card>
        ) : (
          <Card padded>
            <EmptyState
              icon={loaded.status === 'forbidden' ? <ShieldOff size={24} aria-hidden /> : <FileX size={24} aria-hidden />}
              title={t(`record.state.${loaded.status}.title`)}
              description={loaded.status === 'error' ? t(loaded.problem) : t(`record.state.${loaded.status}.body`)}
              action={
                loaded.status === 'error' ? (
                  <Button size="sm" onClick={() => actions?.onRetry?.()}>
                    {t('common.retry')}
                  </Button>
                ) : (
                  <Button size="sm" asChild>
                    <Link href={listHref}>{t('record.backToList')}</Link>
                  </Button>
                )
              }
            />
          </Card>
        )}
      </div>
    )
  }
  return <ReadyRecord style={loaded.value} model={model} actions={actions} panels={panels} />
}

function ReadyRecord({ style, model, actions, panels }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions; panels?: ReactNode }) {
  const t = useT('products')
  const locale = useLocale()
  const recordHref = `${model.prefix}/products/styles/${style.id}`
  const revision = revisionInView(style.revisions, model.revisionId)
  const draft = draftOf(style.revisions)
  const released = releasedOf(style.revisions)
  const bom = model.bom.status === 'ready' ? model.bom.value : null
  const held = releaseHeld(style, revision, bom, model.can)
  const startHeld = startRevisionHeld(style, model.can)
  const next = nextRevisionNumber(style.revisions)
  const tabs = tabsFor(model.can)
  const tabHref = (tab: StyleTab) => `${recordHref}?tab=${tab}${model.revisionId ? `&rev=${model.revisionId}` : ''}`

  // Keys (00 §3.17 + the page's own): r the release check, [ ] the revisions, ⌘J the thread, ? the keys — never while typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = !!target && (!!target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable)
      const inDialog = !!target?.closest('[role="dialog"]')
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        actions?.onDock?.()
        return
      }
      if (typing || inDialog || model.dialog || model.duplicate || model.bomImport || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'r' && revision?.status === 'DRAFT') {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'release' })
      } else if (event.key === '[' || event.key === ']') {
        const to = stepRevision(style.revisions, revision?.id ?? null, event.key === '[' ? -1 : 1)
        if (to) {
          event.preventDefault()
          actions?.onRevision?.(to.id)
        }
      } else if (event.key === '?') {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'help' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const issueCount = bom && revision?.status === 'DRAFT' ? bom.issues.length : 0
  const tabItems: TabItem[] = tabs.map((tab) => ({
    id: tab,
    href: tabHref(tab),
    label:
      (tab === 'bom' || tab === 'routing') && issueCount > 0 && countFor(tab, bom) > 0 ? (
        <span className="fw-st-tablabel">
          {t(`tab.${tab}`)}
          <span className="fw-st-dot" aria-label={t('tab.problems', { count: countFor(tab, bom) })} role="img" />
        </span>
      ) : (
        t(`tab.${tab}`)
      ),
    count: tab === 'variants' ? style.skuCount : tab === 'bom' && bom ? bom.lines.length : null,
  }))

  const primary =
    revision && revision.status === 'DRAFT' ? (
      <Button size="sm" variant="primary" heldReason={held ? t(held.key, held.params) : model.busy ? t('held.busy') : null} onClick={() => actions?.onDialog?.({ kind: 'release' })} aria-keyshortcuts="r">
        {t('action.release', { revision: revision.revision })}
      </Button>
    ) : (
      <Button size="sm" variant={revision ? 'secondary' : 'primary'} heldReason={startHeld ? t(startHeld, { revision: draft?.revision ?? next }) : model.busy ? t('held.busy') : null} onClick={() => actions?.onDialog?.({ kind: 'startRevision' })}>
        {t('action.startRevision', { revision: next })}
      </Button>
    )

  const more: MenuItemDef[] = [
    ...(revision?.status === 'DRAFT' && draft
      ? [{ id: 'abandon', label: t('action.abandon', { revision: draft.revision }), disabled: !model.can.bomManage, description: model.can.bomManage ? undefined : t('held.noManage'), onSelect: () => actions?.onDialog?.({ kind: 'abandon' }) }]
      : []),
    ...(revision && revision.status !== 'DRAFT' && !startHeld ? [{ id: 'start', label: t('action.startRevision', { revision: next }), onSelect: () => actions?.onDialog?.({ kind: 'startRevision' }) }] : []),
    ...(style.status === 'ARCHIVED'
      ? [{ id: 'reactivate', label: t('action.reactivate'), disabled: !model.can.manage, description: model.can.manage ? undefined : t('held.noManage'), onSelect: () => actions?.onReactivate?.() }]
      : [{ id: 'archive', label: t('action.archive'), tone: 'danger' as const, disabled: !model.can.manage, description: model.can.manage ? undefined : t('held.noManage'), onSelect: () => actions?.onDialog?.({ kind: 'archive' }) }]),
    { id: 'duplicate', label: t('action.duplicate'), disabled: !model.can.manage, description: model.can.manage ? undefined : t('held.noManage'), onSelect: () => actions?.onDuplicate?.() },
    {
      id: 'copy',
      label: t('action.copyCode'),
      onSelect: () => {
        void navigator.clipboard?.writeText(style.code).catch(() => undefined)
      },
    },
    { id: 'keys', label: t('action.keys'), onSelect: () => actions?.onDialog?.({ kind: 'help' }) },
  ]

  const saveWords =
    model.save.state === 'saving' ? (
      <span className="fw-st-save" role="status">
        <Spinner size={12} /> {t('save.saving')}
      </span>
    ) : model.save.state === 'failed' ? (
      <span className="fw-st-save is-failed" role="status">
        {t('save.failed')}
      </span>
    ) : model.save.at ? (
      <span className="fw-st-save" role="status">
        {t('save.saved', { time: formatTime(model.save.at, { locale }) })}
      </span>
    ) : (
      <span className="fw-st-save" role="status" />
    )

  const activity = panels ?? (model.panelsPreview ? <RecordPanelsView model={model.panelsPreview} /> : null)
  const showDock = model.dockOpen && model.tab !== 'activity' && !!activity
  const frozenTab = (model.tab === 'bom' || model.tab === 'routing' || model.tab === 'compliance') && revision && !editableRevision(style, revision)
  const ppe = style.ppeCategory !== 'NOT_PPE'

  return (
    <div className="fw-st">
      <div className="fw-st-band">
        <DetailHeader
          backAsChild
          backLabel={<Link href={`${model.prefix}/products/styles`}>{t('record.back')}</Link>}
          title={
            <span className="fw-st-title">
              {style.code} <span className="fw-st-title-name">· {style.name}</span>
            </span>
          }
          actions={
            <span className="fw-st-actions">
              {primary}
              {activity && (
                <Button size="sm" variant={model.dockOpen ? 'tonal' : 'secondary'} active={model.dockOpen} aria-pressed={model.dockOpen} onClick={() => actions?.onDock?.()} title={t('record.dockHint')}>
                  <MessageSquare size={14} aria-hidden /> <span className="fw-st-hide-phone">{t('record.dock')}</span>
                  <span className="fw-st-keys" aria-hidden>
                    <Kbd>⌘</Kbd>
                    <Kbd>J</Kbd>
                  </span>
                </Button>
              )}
              <Menu label={<MoreHorizontal size={16} aria-label={t('record.more')} />} items={more} align="right" triggerProps={{ 'aria-label': t('record.more') }} />
            </span>
          }
        />
        <div className="fw-st-meta-row">
          <span className="fw-st-meta">
            <Pill tone={STATUS_TONE[style.status]}>{t(`status.${style.status}`)}</Pill>
            {style.revisions.length > 0 ? (
              <label className="fw-st-scope">
                <span className="fw-st-hint">{t('record.viewing')}</span>
                <Select size="sm" aria-label={t('record.revisionPicker')} value={revision?.id ?? ''} onChange={(event) => actions?.onRevision?.(event.target.value)}>
                  {[...style.revisions]
                    .sort((a, b) => b.revision - a.revision)
                    .map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {t('record.revisionOption', { revision: entry.revision, status: t(`revisionStatus.${entry.status}`) })}
                      </option>
                    ))}
                </Select>
              </label>
            ) : (
              <Tag tone="warning">{t('record.noRevision')}</Tag>
            )}
            {released && revision?.id !== released.id && <Tag tone="neutral">{t('record.releasedIs', { revision: released.revision })}</Tag>}
            {ppe ? <Tag tone="info">{[t(`ppe.short.${style.ppeCategory}`), style.ppeStandard, style.ppeClass].filter(Boolean).join(' · ')}</Tag> : <Tag tone="neutral">{t('ppe.short.NOT_PPE')}</Tag>}
            {revision?.status === 'DRAFT' && bom && (
              <Tag tone={bom.issues.length > 0 ? 'warning' : 'success'}>{bom.issues.length > 0 ? t('record.thingsBefore', { count: bom.issues.length }) : t('record.readyToRelease')}</Tag>
            )}
          </span>
          {saveWords}
        </div>
        <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabItems} active={tabs.includes(model.tab) ? model.tab : 'overview'} size="sm" overflow="scroll" />
      </div>

      {model.changed && (
        <Banner
          tone="info"
          title={t('record.changed', { time: formatTime(model.changed.at, { locale }) })}
          action={
            <Button size="sm" onClick={() => actions?.onReload?.()}>
              {t('record.reload')}
            </Button>
          }
        />
      )}
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('common.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}
      {style.status === 'ARCHIVED' && <Banner tone="info" title={<span className="fw-st-inline"><Lock size={14} aria-hidden /> {t('record.archivedBanner')}</span>} />}
      {frozenTab && revision && (
        <Banner
          tone="info"
          title={<span className="fw-st-inline"><Lock size={14} aria-hidden /> {t(revision.status === 'RELEASED' ? 'record.frozenReleased' : 'record.frozenObsolete', { revision: revision.revision })}</span>}
          action={
            draft && draft.id !== revision.id ? (
              <Button size="sm" onClick={() => actions?.onRevision?.(draft.id)}>
                {t('record.goToDraft', { revision: draft.revision })}
              </Button>
            ) : !startHeld ? (
              <Button size="sm" onClick={() => actions?.onDialog?.({ kind: 'startRevision' })}>
                {t('action.startRevision', { revision: next })}
              </Button>
            ) : undefined
          }
        />
      )}

      <div className={showDock ? 'fw-st-body has-dock' : 'fw-st-body'}>
        <div className="fw-st-main">
          {model.tab === 'overview' || !tabs.includes(model.tab) ? (
            <OverviewTab style={style} model={model} actions={actions} />
          ) : model.tab === 'variants' ? (
            <VariantsTab style={style} model={model} actions={actions} />
          ) : model.tab === 'activity' ? (
            (activity ?? <p className="fw-st-hint">{t('record.noPanels')}</p>)
          ) : (
            <TabBody tab={model.tab} style={style} model={model} actions={actions} />
          )}
        </div>
        {showDock && (
          <aside className="fw-st-dock" aria-label={t('record.dockLabel')}>
            {activity}
          </aside>
        )}
      </div>

      <StyleDialogs style={style} model={model} actions={actions} />
      {model.duplicate && <DuplicateDialog model={model.duplicate} can={model.can} prefix={model.prefix} actions={actions?.duplicate} />}
      {model.dialog?.kind === 'help' && <KeysDialog onClose={() => actions?.onDialog?.(null)} />}
    </div>
  )
}

/** The problem dot of a tab: the release check's findings that belong to it. */
function countFor(tab: 'bom' | 'routing', bom: BomView | null): number {
  if (!bom) return 0
  const routing = (code: string) => ['NO_STEPS', 'MINUTES_NOT_POSITIVE', 'NO_SCAN_POINT'].includes(code)
  return bom.issues.filter((issue) => (tab === 'routing' ? routing(issue.code) : !routing(issue.code) && issue.code !== 'NO_SIZE_RANGE' && issue.code !== 'NO_ACTIVE_COLOURWAY')).length
}

const KEYS: Array<{ keys: string[]; does: string }> = [
  { keys: ['r'], does: 'keys.release' },
  { keys: ['['], does: 'keys.prevRevision' },
  { keys: [']'], does: 'keys.nextRevision' },
  { keys: ['⌘', 'J'], does: 'keys.thread' },
  { keys: ['⌘', 'S'], does: 'keys.save' },
  { keys: ['n'], does: 'keys.add' },
  { keys: ['v'], does: 'keys.bomView' },
  { keys: ['Space'], does: 'keys.skuCell' },
  { keys: ['⇧', 'Space'], does: 'keys.skuRow' },
  { keys: ['Alt', '↑'], does: 'keys.moveUp' },
  { keys: ['Alt', '↓'], does: 'keys.moveDown' },
  { keys: ['?'], does: 'keys.help' },
]

function KeysDialog({ onClose }: { onClose: () => void }) {
  const t = useT('products')
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <dl className="fw-st-keymap">
        {KEYS.map((entry) => (
          <div key={entry.does} className="fw-st-keymap-row">
            <dt>
              {entry.keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </dt>
            <dd>{t(entry.does)}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}
