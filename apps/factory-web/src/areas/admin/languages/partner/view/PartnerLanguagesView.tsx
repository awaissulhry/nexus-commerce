'use client'

import { useMemo, type MouseEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { Languages } from 'lucide-react'
import { Banner, Card } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Select } from '@nexus/ui/primitives'
import { useLocale } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { WithMessages } from '../../../../../record-panels/i18n'
import { useKeysHelp, useLatest, useSelection } from '../../../kit/list'
import { BulkButton, FrameState, ListSearch } from '../../../shared/view/parts'
import type { ContactLanguage } from '../api'
import { changeHeld, languageName, OWN_CHOICES, ownChoice, setReach, type OwnChoice, type PartnerModel } from '../model'
import '../../../documents/template-editor/templates.css'
import '../../languages.css'
import { useTplWords } from '../../../documents/template-editor/view/words'

/**
 * SCR-634 — Admin › Languages › per partner contact (B-W2b-432; design admin.languages sec:documents "per partner contact";
 * PLT-131): the partner contacts on the shared list frame — who, which organisation, their own language (changed in the
 * row), and the language their documents and mails go out in with why (their own, their party's, the company's; one we do
 * not write is said with the one they read). Select several to give them Italian, English or their party's language at
 * once. Without the right to see customers and suppliers the part says so (the administrator template does not hold it).
 * Draws one view model; PartnerLanguagesSection.tsx reads and writes.
 */

export interface PartnerActions {
  onQuery?: (query: string) => void
  onSelect?: (ids: string[]) => void
  onRetry?: () => void
  onMore?: () => void
  onSet?: (rows: readonly ContactLanguage[], to: OwnChoice) => void
  onDismissNotice?: () => void
}

export const PARTNER_NAMESPACES = ['admin', 'records', 'admin-templates'] as const

export function PartnerLanguagesView({ model, actions }: { model: PartnerModel; actions?: PartnerActions }) {
  return (
    <WithMessages namespaces={PARTNER_NAMESPACES}>
      <Card padded className="fw-adm-langs-wide">
        {/* The page is a form (the companies' languages, ⌘S): Enter in this part's search never submits it. */}
        <section
          className="fw-adm-langs-section"
          aria-labelledby="langs-partners"
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') event.preventDefault()
          }}
        >
          <PartnerHead />
          {model.canView ? <Partners model={model} actions={actions} /> : <HeldLine />}
        </section>
      </Card>
    </WithMessages>
  )
}

function PartnerHead() {
  const t = useTplWords()
  return (
    <div className="fw-adm-head-text">
      <h2 id="langs-partners" className="fw-adm-langs-h2">
        {t('tpl.partner.title')}
      </h2>
      <p className="fw-adm-intro">{t('tpl.partner.intro')}</p>
    </div>
  )
}

/** Without parties.view: what the part needs, in words (never a locked box). */
function HeldLine() {
  const t = useTplWords()
  return <p className="fw-adm-hint">{t('tpl.partner.held.view')}</p>
}

function Partners({ model, actions }: { model: PartnerModel; actions?: PartnerActions }) {
  const t = useTplWords()
  const locale = useLocale()
  const rows = useMemo(() => (model.read.status === 'ready' ? model.read.contacts : []), [model.read])
  const { selected, onChange } = useSelection(model.selected, actions?.onSelect, rows.map((row) => row.contactId))
  const latest = useLatest({ model, actions })
  const { onHelp, help } = useKeysHelp([], true)
  const language = (code: string) => (code === 'it' || code === 'en' ? t(`tpl.language.${code}`) : languageName(code, locale))

  const columns = useMemo<ColDef<ContactLanguage>[]>(() => {
    const stop = (event: MouseEvent) => event.stopPropagation()
    return [
      {
        colId: 'contact',
        headerName: t('tpl.partner.col.contact'),
        flex: 1.4,
        minWidth: 190,
        cellRenderer: ({ data }: ICellRendererParams<ContactLanguage>) =>
          data ? (
            <span className="fw-tpl-cell">
              <span className="fw-adm-name">{data.name}</span>
              <span className="fw-adm-hint">{data.email ?? t('tpl.partner.noEmail')}</span>
            </span>
          ) : null,
      },
      {
        colId: 'party',
        headerName: t('tpl.partner.col.party'),
        flex: 1.4,
        minWidth: 190,
        cellRenderer: ({ data }: ICellRendererParams<ContactLanguage>) =>
          data ? (
            <span className="fw-tpl-cell">
              <Link className="fw-adm-docs-link" href={`${latest.current.model.prefix}/sales/customers/${encodeURIComponent(data.party.id)}?tab=contacts`} onClick={stop}>
                {data.party.name}
              </Link>
              <span className="fw-adm-hint">
                {data.party.code} · {t('tpl.partner.partyLanguage', { language: language(data.party.language) })}
              </span>
            </span>
          ) : null,
      },
      {
        colId: 'own',
        headerName: t('tpl.partner.col.own'),
        flex: 1.2,
        minWidth: 190,
        cellRenderer: ({ data }: ICellRendererParams<ContactLanguage>) => {
          if (!data) return null
          const { model: now, actions: act } = latest.current
          const saving = (now.saving ?? []).includes(data.contactId)
          const held = changeHeld(now, saving)
          const current = ownChoice(data)
          if (held === 'tpl.partner.held.manage') return <span>{current ? language(current) : t('tpl.partner.ownNone')}</span>
          const options = (OWN_CHOICES as readonly string[]).includes(current) ? OWN_CHOICES : [...OWN_CHOICES, current]
          return (
            <span onClick={stop}>
              <Select
                size="sm"
                aria-label={t('tpl.partner.ownFor', { name: data.name })}
                value={current}
                disabled={saving}
                title={held ? t(held) : undefined}
                onChange={(event) => act?.onSet?.([data], event.target.value as OwnChoice)}
              >
                {options.map((choice) => (
                  <option key={choice || 'party'} value={choice}>
                    {choice ? language(choice) : t('tpl.partner.ownNone')}
                  </option>
                ))}
              </Select>
            </span>
          )
        },
      },
      {
        colId: 'out',
        headerName: t('tpl.partner.col.out'),
        flex: 1.6,
        minWidth: 230,
        cellRenderer: ({ data }: ICellRendererParams<ContactLanguage>) =>
          data ? (
            <span className="fw-tpl-cell">
              <span>
                <Pill tone={data.notOffered ? 'warning' : 'neutral'}>{t(`tpl.language.${data.language}`)}</Pill>
              </span>
              <span className="fw-adm-hint">{data.notOffered ? t('tpl.partner.notOffered', { language: language(data.notOffered) }) : t(`tpl.source.${data.source}`)}</span>
            </span>
          ) : null,
      },
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, locale])

  const chosen = rows.filter((row) => selected.includes(row.contactId))
  const busy = (model.saving ?? []).length > 0
  const held = changeHeld(model, busy)
  const bulk = (to: OwnChoice, icon: ReactNode, key: string) => {
    const reach = setReach(chosen, to)
    const why = held ?? (reach.applies.length === 0 ? 'tpl.partner.left.none' : null)
    return <BulkButton key={to || 'party'} icon={icon} label={t(key, { count: reach.applies.length })} held={why ? t(why) : null} onClick={() => actions?.onSet?.(reach.applies, to)} />
  }
  const read = model.read
  const state: ReactNode =
    read.status === 'failed' ? (
      <FrameState problem={read.problem} onRetry={actions?.onRetry} />
    ) : read.status === 'ready' && rows.length === 0 ? (
      model.query.trim() ? <FrameState noMatch={{ onClear: () => actions?.onQuery?.(''), clearLabel: t('tpl.partner.clear') }} /> : <FrameState empty={{ icon: <Languages size={24} aria-hidden />, title: t('tpl.partner.emptyTitle'), body: t('tpl.partner.empty') }} />
    ) : undefined

  return (
    <div className="fw-adm-stack">
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('tpl.dismiss')}
            </Button>
          }
        >
          {model.notice.refused && model.notice.refused.length > 0 && (
            <ul className="fw-adm-list">
              {model.notice.refused.map((entry) => (
                <li key={entry.id}>
                  {rows.find((row) => row.contactId === entry.id)?.name ?? '—'}: {t(entry.said.key, entry.said.params)}
                </li>
              ))}
            </ul>
          )}
        </Banner>
      )}
      <ListFrame<ContactLanguage>
        label={t('tpl.partner.label')}
        listKey="admin.languages.partners"
        rows={read.status === 'loading' ? null : state ? [] : rows}
        rowId={(row) => row.contactId}
        columns={columns}
        count={read.status === 'ready' ? t(read.more ? 'tpl.partner.countMore' : 'tpl.partner.count', { count: rows.length }) : '—'}
        search={<ListSearch label={t('tpl.partner.search')} value={model.query} onChange={actions?.onQuery} />}
        selection={{
          selected,
          onChange,
          actions: (
            <>
              {bulk('it', <Languages size={13} aria-hidden />, 'tpl.partner.bulk.it')}
              {bulk('en', <Languages size={13} aria-hidden />, 'tpl.partner.bulk.en')}
              {bulk('', <Languages size={13} aria-hidden />, 'tpl.partner.bulk.party')}
            </>
          ),
        }}
        isRowSelectable={() => (held === 'tpl.partner.held.manage' ? t(held) : null)}
        more={read.status === 'ready' && read.more ? { label: t('tpl.partner.more'), onMore: () => actions?.onMore?.(), held: model.loadingMore ? t('tpl.held.busy') : null } : null}
        onHelp={onHelp}
        state={state}
      />
      {help}
    </div>
  )
}
