'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Card, EmptyState } from '@nexus/ui/components'
import type { ColDef } from '@nexus/ui/grid'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import type { Locale } from '../../../../lib/i18n/locales'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { cellOf } from '../../shared/view/cells'
import { ListKeysHelp } from '../../shared/view/parts'
import type { Attention, AttentionItem } from '../api'
import type { Read } from '../model'
import { SecurityMessages } from './SecurityView'

/** One attention row in words (exported: a test draws it in both languages). */
export function attentionWords(item: AttentionItem, t: Translate, locale: Locale): string {
  const subject = item.subject ?? '—'
  switch (item.kind) {
    case 'integrationFailing':
      return item.since ? t('sec.attention.kind.integrationFailing', { subject, since: formatDateTime(item.since, { locale }) }) : t('sec.attention.kind.integrationFailingNoTime', { subject })
    case 'mailDomain':
      return t('sec.attention.kind.mailDomain', { subject })
    case 'tabletUnseen':
      return item.days === null ? t('sec.attention.kind.tabletNever', { subject }) : t('sec.attention.kind.tabletUnseen', { subject, days: item.days })
    case 'drill':
      return t(`sec.attention.drill.${item.state ?? 'none'}`, { days: Math.abs(item.days ?? 0) })
    case 'jobsFailed':
      return t('sec.attention.kind.jobsFailed', { count: item.count ?? 0 })
    case 'twoFactorMissing':
      return t('sec.attention.kind.twoFactorMissing', { count: item.count ?? 0 })
  }
}

const rowId = (item: AttentionItem) => `${item.kind}:${item.href}:${item.subject ?? ''}`

export function attentionColumns(ctx: { t: Translate; locale: Locale; prefix: string }): ColDef<AttentionItem>[] {
  const { t, locale, prefix } = ctx
  return [
    {
      colId: 'what',
      headerName: t('sec.attention.col.what'),
      valueGetter: ({ data }) => (data ? attentionWords(data, t, locale) : ''),
      flex: 3,
      minWidth: 260,
      cellRenderer: cellOf<AttentionItem>((item) => (
        <span className="fw-sec-fact">
          <Pill tone={item.severity === 'critical' ? 'danger' : 'warning'}>{t(item.severity === 'critical' ? 'sec.state.failing' : 'sec.state.warning')}</Pill>
          <span>{attentionWords(item, t, locale)}</span>
        </span>
      )),
    },
    {
      colId: 'since',
      headerName: t('sec.attention.col.since'),
      valueGetter: ({ data }) => (data?.since ? (data.since.length === 10 ? formatDate(data.since, { locale, timeZone: 'UTC' }) : formatDateTime(data.since, { locale })) : '—'),
      width: 170,
    },
    {
      colId: 'fix',
      headerName: '',
      width: 120,
      sortable: false,
      cellRenderer: cellOf<AttentionItem>((item) => (
        <Button size="sm" variant="quiet" asChild>
          <Link href={`${prefix}${item.href}`}>
            {t('sec.attention.fix')}
            <span className="fw-adm-sr"> {attentionWords(item, t, locale)}</span>
          </Link>
        </Button>
      )),
    },
  ]
}

/**
 * All settings › Needs attention (design admin.overview sec:attention, W2a; B-W2a-36): set-up facts that went wrong
 * since, in one place, each → the page that fixes it (GET /admin/security/attention: each kind only where the person
 * may read it; the kinds left out are said so). Enter on a row opens its page.
 */
export function AttentionSection({ attention, prefix, onRetry, onOpen }: { attention: Read<Attention>; prefix: string; onRetry?: () => void; onOpen?: (href: string) => void }) {
  return (
    <SecurityMessages>
      <Section attention={attention} prefix={prefix} onRetry={onRetry} onOpen={onOpen} />
    </SecurityMessages>
  )
}

function Section({ attention, prefix, onRetry, onOpen }: { attention: Read<Attention>; prefix: string; onRetry?: () => void; onOpen?: (href: string) => void }) {
  const t = useT('admin-security')
  const locale = useLocale()
  const [help, setHelp] = useState(false)
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (attention.state !== 'loading') return
    const timer = setTimeout(() => setSlow(true), 1000)
    return () => clearTimeout(timer)
  }, [attention.state])
  const columns = useMemo(() => attentionColumns({ t, locale, prefix }), [t, locale, prefix])
  if (attention.state === 'no-right') return null
  const value = attention.state === 'ok' ? attention.value : null
  return (
    <section id="attention" aria-labelledby="sec-attention">
      <Card header={<span id="sec-attention">{t('sec.attention.title')}</span>} description={t('sec.attention.hint')} headingLevel={2} padded>
        {attention.state === 'loading' ? (
          <div className="fw-adm-skeleton" aria-busy="true">
            {slow && (
              <p className="fw-adm-loading" role="status">
                {t('sec.stillLoading')}
              </p>
            )}
            <Skeleton height={20} />
            <Skeleton height={20} />
          </div>
        ) : attention.state === 'failed' ? (
          <EmptyState title={t('sec.failed.title')} description={t('sec.failed.body')} action={<Button size="sm" onClick={() => onRetry?.()}>{t('sec.retry')}</Button>} />
        ) : (
          <div className="fw-adm-stack">
            <ListFrame<AttentionItem>
              label={t('sec.attention.title')}
              listKey={null}
              rows={value!.items}
              rowId={rowId}
              columns={columns}
              count={t('sec.attention.count', { count: value!.items.length })}
              onOpen={(item) => onOpen?.(`${prefix}${item.href}`)}
              onHelp={() => setHelp(true)}
              state={value!.items.length === 0 ? <EmptyState title={t('sec.attention.empty')} /> : undefined}
            />
            {value!.unread.length > 0 && <p className="fw-adm-hint">{t('sec.attention.unread', { count: value!.unread.length })}</p>}
            <ListKeysHelp open={help} onClose={() => setHelp(false)} keys={[]} selection={false} />
          </div>
        )}
      </Card>
    </section>
  )
}
