'use client'

import { Search } from 'lucide-react'
import { Banner, EmptyState, Field } from '@nexus/ui/components'
import { Button, CheckboxCard, Input, RadioCard, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../i18n/ds-parts'
import { useT } from '../../../i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { typeKey } from '../../../../areas/search/model'
import { queryReady, relationKey, targetLabel, type OfferedTarget } from '../use-on'

export const USE_ON_NS = 'record-thread-files'

/** What the "Use on another record…" window draws (the container fills it; the API offers and checks the records). */
export interface UseOnModel {
  /** The files that will be copied (one from a Files view row, the chosen ones, or a message's). */
  files: readonly { readonly id: string; readonly name: string }[]
  /** The file's record's customer, when it has one (the picker offers its records and records of none). */
  party: { readonly name: string } | null
  query: string
  /** null: nothing looked up yet (the query too short); else the records offered. */
  targets: readonly OfferedTarget[] | null
  searching: boolean
  /** The chosen record (`targetKey`). */
  chosen: string | null
  /** Also share the copy with the chosen record's customer (files.manage). */
  share: boolean
  canShare: boolean
  busy: boolean
  /** A refusal or a failed look-up, in this namespace's keys. */
  problem: string | null
  /** After a part went: what did not (name and reason key). */
  failed: readonly { readonly name: string; readonly reason: string }[]
  copied: number
}

export interface UseOnActions {
  onQuery: (query: string) => void
  onChoose: (key: string) => void
  onShare: (share: boolean) => void
  onConfirm: () => void
  onClose: () => void
}

/**
 * B-TH-231 — "Use on another record…" (threads plan T9-F05; picture 9's look): a centred window (a sheet on a phone) that finds a
 * record by number or name among those the API offers — the file's own customer's and records of no customer, never another
 * customer's (W25, W26) — says whose each one is, asks once whether the copy is also shared with that record's customer (office
 * only by default), and copies. A refusal says why in words that name no other customer.
 */
export function UseOnDialog({ model, actions }: { model: UseOnModel; actions: UseOnActions }) {
  return (
    <WithMessages namespaces={[USE_ON_NS, 'search']}>
      <View model={model} actions={actions} />
    </WithMessages>
  )
}

function View({ model, actions }: { model: UseOnModel; actions: UseOnActions }) {
  const t = useT(USE_ON_NS)
  const count = model.files.length
  const chosen = model.targets?.find((target) => target.key === model.chosen) ?? null
  const held = model.busy ? t('useOn.busy') : chosen === null ? t('useOn.choose') : null
  return (
    <Modal
      open
      onClose={actions.onClose}
      size="md"
      title={count === 1 ? t('useOn.title', { count, name: model.files[0]!.name }) : t('useOn.title', { count })}
      subtitle={model.party ? t('useOn.subtitle', { party: model.party.name }) : t('useOn.subtitleNone')}
      footer={
        <>
          <Button onClick={actions.onClose}>{t('useOn.cancel')}</Button>
          <Button variant="primary" heldReason={held} onClick={actions.onConfirm}>
            {t('useOn.confirm', { count })}
          </Button>
        </>
      }
    >
      <UseOnBody model={model} actions={actions} />
    </Modal>
  )
}

/** The window's content (the search, the records offered, the share tick, the refusals): drawn inside the Modal, testable alone. */
export function UseOnBody({ model, actions }: { model: UseOnModel; actions: UseOnActions }) {
  const t = useT(USE_ON_NS)
  const ts = useT('search')
  const chosen = model.targets?.find((target) => target.key === model.chosen) ?? null
  const shareable = chosen !== null && chosen.partyId !== null
  return (
    <div className="fw-rtf-useon">
      {model.problem && <Banner tone="danger" title={t(model.problem)} />}
      {model.failed.length > 0 && (
        <Banner tone="warning" title={t('useOn.partial', { copied: model.copied })}>
          <ul className="fw-rtf-useon-failed">
            {model.failed.map((one) => (
              <li key={one.name}>
                <strong>{one.name}</strong>: {t(one.reason)}
              </li>
            ))}
          </ul>
        </Banner>
      )}
      <Field label={t('useOn.search')} hint={t('useOn.searchHint')}>
        <Input type="search" leadingIcon={<Search size={14} aria-hidden />} value={model.query} onChange={(event) => actions.onQuery(event.target.value)} autoFocus />
      </Field>
      {!queryReady(model.query) ? (
        <p className="fw-rtf-useon-hint">{t('useOn.tooShort')}</p>
      ) : model.searching && model.targets === null ? (
        <p className="fw-rtf-useon-hint" role="status">
          <Spinner size={12} /> {t('useOn.searching')}
        </p>
      ) : model.targets !== null && model.targets.length === 0 ? (
        <EmptyState title={t('useOn.empty')} />
      ) : model.targets !== null ? (
        <fieldset className="fw-rtf-useon-list" aria-busy={model.searching || undefined}>
          <legend className="nds-vh">{t('useOn.results')}</legend>
          {model.targets.map((target) => (
            <RadioCard
              key={target.key}
              variant="row"
              name="fw-rtf-useon"
              checked={model.chosen === target.key}
              selected={model.chosen === target.key}
              onChange={() => actions.onChoose(target.key)}
              title={
                <span className="fw-rtf-useon-row">
                  <span>{targetLabel(target)}</span>
                  <Tag tone={target.relation === 'same' ? 'info' : 'neutral'}>{t(relationKey(target.relation))}</Tag>
                </span>
              }
              description={[ts(typeKey(target.recordType)), target.subtitle].filter(Boolean).join(' · ')}
            />
          ))}
        </fieldset>
      ) : null}
      {shareable && (
        <CheckboxCard
          title={t('useOn.share', { party: model.party?.name ?? ts(typeKey('Party')) })}
          description={model.canShare ? t('useOn.shareHint') : t('useOn.shareNoRight')}
          checked={model.share}
          selected={model.share}
          disabled={!model.canShare}
          onChange={(event) => actions.onShare(event.target.checked)}
        />
      )}
    </div>
  )
}
