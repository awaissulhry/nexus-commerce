'use client'

import Link from 'next/link'
import { FileSpreadsheet, Gauge, MoreHorizontal, PencilLine, ShieldOff, Undo2 } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, Tabs, type TabItem } from '@nexus/ui/components'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { ActionConfirm } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { KpiRecord, KpiVersion, OfficeRole } from '../api'
import {
  areaOf,
  kpiHref,
  ownerOf,
  ownerText,
  statusOf,
  statusWords,
  versionsAtHand,
  wordsOf,
  type FormField,
  type KpiAddress,
  type KpisAbilities,
  type KpiTab,
  type VersionDraft,
} from '../model'
import { DefinitionTab } from './DefinitionTab'
import { HistoryTab } from './HistoryTab'
import { UsesTab } from './UsesTab'
import { VersionForm } from './VersionForm'
import '../kpis.css'

/**
 * SCR-470 — a KPI (design home.kpis rec:KPI, `/w/<company>/home/kpis/<key>?tab=…`): the band (‹ KPI library, its name, its
 * area, state and owner, the owner's "New version", ⋯ › Export this definition · Withdraw) and three tabs — Definition (in
 * words beside Now: the value in my scope with 12 periods, as of, the records behind it), Where used (every dashboard,
 * report and alert that reads it) and History (the versions, and two of them compared). Targets is W3: not drawn. The
 * owner (home.kpis.manage) writes a new version from the one in force, edits the draft, puts it in force, deletes it or
 * withdraws the KPI; anyone else reads, and the held "New version" says why. One view model, nothing fetched.
 */

type Loaded<T> = { readonly value: T | null; readonly problem: string | null }

export type KpiConfirm = 'activate' | 'delete' | 'retire' | 'install'

export interface KpiForm {
  readonly mode: 'new' | 'edit'
  readonly base: KpiVersion
  readonly draft: VersionDraft
  readonly problems: Partial<Record<FormField, string>>
  /** Problems are shown after the first Save (never while typing the first time). */
  readonly shown: boolean
  readonly busy: boolean
  /** A refused save in words (a message key). */
  readonly refusal: string | null
}

export interface KpiModel {
  readonly can: KpisAbilities
  readonly prefix: string
  readonly key: string
  readonly address: KpiAddress
  readonly record: Loaded<KpiRecord> & { readonly reading?: boolean }
  /** The office pages that are built (company-free): only those are linked. */
  readonly built: ReadonlySet<string>
  /** A company is named (the address's): the fiscal periods can be read. */
  readonly withCompany: boolean
  /** Alert rule kinds this app names (factory-domain RULE_KINDS). */
  readonly ruleKinds: readonly string[]
  readonly now?: number
  readonly form?: KpiForm | null
  readonly roles?: Loaded<readonly OfficeRole[]>
  readonly confirm?: KpiConfirm | null
  readonly busy?: KpiConfirm | null
  readonly result?: { readonly tone: 'success' | 'danger'; readonly key: string; readonly params?: Readonly<Record<string, string | number>> } | null
}

export interface KpiActions {
  onAddress?: (address: KpiAddress) => void
  onRetry?: () => void
  onExport?: () => void
  onOpen?: (href: string) => void
  onNewVersion?: () => void
  onEditDraft?: () => void
  onForm?: (draft: VersionDraft) => void
  onFormSave?: () => void
  onFormCancel?: () => void
  onAsk?: (confirm: KpiConfirm) => void
  onConfirm?: () => void
  onCancelConfirm?: () => void
  onDismissResult?: () => void
}

export function KpiView({ model, actions }: { model: KpiModel; actions?: KpiActions }) {
  return (
    <WithMessages namespaces={['home-kpis', 'home-reports', 'lists']}>
      <KpiScreen model={model} actions={actions} />
    </WithMessages>
  )
}

function KpiScreen({ model, actions }: { model: KpiModel; actions?: KpiActions }) {
  const t = useT('home-kpis')
  const locale = useLocale()
  const back = <Link href={`${model.prefix}/home/kpis`}>{t('kpi.back')}</Link>
  const record = model.record.value

  if (!model.can.view) {
    return (
      <div className="fw-kpi">
        <Card padded>
          <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('noAccess.title')} description={t('noAccess.body')} />
        </Card>
      </div>
    )
  }
  if (!record) {
    const notFound = model.record.problem === 'error.notFound'
    return (
      <div className="fw-kpi">
        <div className="fw-kpi-recband">
          <DetailHeader backAsChild backLabel={back} title={model.record.problem ? t('kpi.noun') : <Skeleton width={260} height={22} />} />
        </div>
        <Card padded>
          {model.record.problem ? (
            <EmptyState
              icon={<Gauge size={24} aria-hidden />}
              title={t(notFound ? 'kpi.notFound' : 'kpi.failed')}
              description={t(notFound ? 'kpi.notFoundBody' : model.record.problem)}
              action={
                notFound ? (
                  <Button size="sm" asChild>
                    <Link href={`${model.prefix}/home/kpis`}>{t('kpi.back')}</Link>
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => actions?.onRetry?.()}>
                    {t('common.retry')}
                  </Button>
                )
              }
            />
          ) : (
            <p className="fw-kpi-muted" role="status">
              <Spinner size={14} /> {t('common.loading')}
            </p>
          )}
        </Card>
      </div>
    )
  }

  const words = wordsOf(record, locale)
  const status = statusOf(record)
  const statusSaid = statusWords(status, t)
  const hand = versionsAtHand(record)
  const tab: KpiTab = model.address.tab
  const tabs: TabItem[] = [
    { id: 'definition', label: t('tab.definition'), href: kpiHref(model.prefix, model.key, { ...model.address, tab: 'definition' }) },
    { id: 'used-in', label: t('tab.usedIn'), count: record.usedIn.length, href: kpiHref(model.prefix, model.key, { ...model.address, tab: 'used-in' }) },
    { id: 'history', label: t('tab.history'), count: record.versions.length, href: kpiHref(model.prefix, model.key, { ...model.address, tab: 'history' }) },
  ]
  const ownerOnly = model.can.manage ? null : t('held.ownerOnly')
  const newHeld = ownerOnly ?? (hand.base === null ? t('held.notInstalled') : hand.draft ? t('held.draftWaiting', { version: hand.draft.kpiVersion }) : model.busy ? t('held.busy') : null)
  const retireHeld = ownerOnly ?? (hand.inForce === null ? t('held.nothingInForce') : model.busy ? t('held.busy') : null)

  const band = (
    <span className="fw-kpi-actions">
      <Button size="sm" variant={model.can.manage ? 'primary' : 'secondary'} heldReason={newHeld ?? undefined} onClick={() => actions?.onNewVersion?.()}>
        <PencilLine size={14} aria-hidden /> {t('kpi.newVersion')}
      </Button>
      <Menu
        label={<MoreHorizontal size={14} aria-hidden />}
        triggerProps={{ 'aria-label': t('kpi.more') }}
        align="right"
        items={[
          { id: 'export', label: t('kpi.export'), icon: <FileSpreadsheet size={14} aria-hidden />, onSelect: () => actions?.onExport?.() },
          {
            id: 'retire',
            label: t('kpi.retire'),
            icon: <Undo2 size={14} aria-hidden />,
            tone: 'danger',
            disabled: retireHeld !== null,
            description: retireHeld,
            onSelect: () => actions?.onAsk?.('retire'),
          },
        ]}
      />
    </span>
  )

  return (
    <div className="fw-kpi">
      <div className="fw-kpi-recband">
        <DetailHeader backAsChild backLabel={back} title={words.name} actions={band} />
        <div className="fw-kpi-meta">
          <Tag tone="neutral">{t(`area.${areaOf(record.key)}`)}</Tag>
          <Tag tone={statusSaid.tone}>{statusSaid.text}</Tag>
          {hand.draft && status.kind === 'IN_FORCE' && <Tag tone="info">{t('status.draftWaiting', { version: hand.draft.kpiVersion })}</Tag>}
          {record.measuresDiffer && <Tag tone="warning">{t('status.differs')}</Tag>}
          <span className="fw-kpi-muted">{t('kpi.ownedBy', { owner: ownerText(ownerOf(record), t) })}</span>
          {model.record.reading && (
            <span className="fw-kpi-muted" role="status">
              <Spinner size={12} /> {t('common.reading')}
            </span>
          )}
        </div>
        <Tabs ariaLabel={t('tab.label')} tabs={tabs} active={tab} size="sm" overflow="scroll" />
      </div>

      {model.result && (
        <Banner tone={model.result.tone} title={t(model.result.key, model.result.params as Record<string, string | number> | undefined)} onDismiss={() => actions?.onDismissResult?.()} />
      )}
      {model.record.problem && (
        <Banner tone="warning" title={t('kpi.stale')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>}>
          {t(model.record.problem)}
        </Banner>
      )}

      {tab === 'used-in' ? (
        <UsesTab record={record} built={model.built} ruleKinds={model.ruleKinds} prefix={model.prefix} onOpen={actions?.onOpen} />
      ) : tab === 'history' ? (
        <HistoryTab record={record} address={model.address} now={model.now} onAddress={actions?.onAddress} />
      ) : (
        <DefinitionTab model={model} actions={actions} />
      )}

      {model.form && <VersionForm form={model.form} record={record} can={model.can} roles={model.roles ?? { value: null, problem: null }} actions={actions} />}
      {model.confirm && <ConfirmFor which={model.confirm} record={record} actions={actions} />}
    </div>
  )
}

function ConfirmFor({ which, record, actions }: { which: KpiConfirm; record: KpiRecord; actions?: KpiActions }) {
  const t = useT('home-kpis')
  const locale = useLocale()
  const name = wordsOf(record, locale).name
  const hand = versionsAtHand(record)
  const impact =
    which === 'activate' && hand.draft
      ? {
          level: 'confirm' as const,
          title: t('confirm.activate.question', { version: hand.draft.kpiVersion, name }),
          confirmLabel: t('confirm.activate.button', { version: hand.draft.kpiVersion }),
          consequences: [
            ...(hand.inForce ? [t('confirm.activate.supersedes', { version: hand.inForce.kpiVersion })] : []),
            t('confirm.activate.readers', { name, version: hand.draft.kpiVersion }),
          ],
        }
      : which === 'delete' && hand.draft
        ? {
            level: 'confirm' as const,
            title: t('confirm.delete.question', { version: hand.draft.kpiVersion }),
            confirmLabel: t('confirm.delete.button'),
            consequences: [t('confirm.delete.gone', { version: hand.draft.kpiVersion }), t('confirm.delete.kept')],
          }
        : which === 'retire' && hand.inForce
          ? {
              level: 'confirm' as const,
              title: t('confirm.retire.question', { name }),
              confirmLabel: t('confirm.retire.button'),
              consequences: [t('confirm.retire.nothing'), t('confirm.retire.uses', { count: record.usedIn.length }), t('confirm.retire.kept', { version: hand.inForce.kpiVersion })],
            }
          : which === 'install'
            ? {
                level: 'confirm' as const,
                title: t('confirm.install.question', { name }),
                confirmLabel: t('confirm.install.button'),
                consequences: [t('confirm.install.this', { name }), t('confirm.install.others')],
              }
            : null
  if (!impact) return null
  return <ActionConfirm impact={impact} onConfirm={() => actions?.onConfirm?.()} onCancel={() => actions?.onCancelConfirm?.()} />
}
