'use client'

import Link from 'next/link'
import { Mail, Plus, Trash2 } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Skeleton } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { useWords } from '../../parts'
import { addHeld, doorLine, INQUIRY_ADDRESS_LIMIT, rowProblem, saveHeld, scopeWords, type AddressesModel } from '../model'

/**
 * B-TH-285 (threads plan TH-8; O-SAL-INQ-LIST.band-F04, picture 12's ⋯): "Inquiry addresses" — the addresses whose mail becomes a
 * request by itself, said plainly (unknown senders included: they arrive as prospects), for the company's own list or the tenant-wide
 * list it shares; who may change them (sales settings) edits, everyone else reads. At most 20, each at one of the company's receiving
 * domains, each once — in words before Save; a refused save names its rows; a version clash reads again. The door's state on top.
 */
export interface AddressesActions {
  onAdding?: (value: string) => void
  onAdd?: () => void
  onChange?: (index: number, value: string) => void
  onRemove?: (index: number) => void
  onSave?: () => void
  onRetry?: () => void
  onClose?: () => void
}

export function AddressesDialog({ model, prefix, actions }: { model: AddressesModel; prefix: string; actions?: AddressesActions }) {
  const { t, say } = useWords()
  const close = () => actions?.onClose?.()
  const scope = model.loaded.status === 'ready' ? model.loaded.value : null
  const editable = !!scope?.answer.mayManage
  const held = saveHeld(model)
  const adding = addHeld(model.draft, model.adding, model.domains)
  const door = doorLine(scope?.answer.addresses ?? null, model.live, model.domains)
  return (
    <Modal
      open
      onClose={close}
      size="md"
      title={t('addresses.title')}
      subtitle={scope ? (say(scopeWords(scope)) ?? undefined) : undefined}
      footer={
        <span className="fw-inq-buttons">
          <Button variant="secondary" onClick={close}>
            {editable ? t('common.cancel') : t('addresses.close')}
          </Button>
          {editable && (
            <Button variant="primary" heldReason={say(held)} onClick={() => actions?.onSave?.()}>
              {t('addresses.save')}
            </Button>
          )}
        </span>
      }
    >
      <div className="fw-inq-dialog">
        <p className="fw-inq-text">{t('addresses.intro')}</p>
        {door && (
          <Banner tone="warning" title={say(door)} action={door.key === 'addresses.door.noDomain' ? <Button size="sm" variant="quiet" asChild><Link href={`${prefix}/admin/connections`}>{t('addresses.door.setUp')}</Link></Button> : undefined}>
            {door.key === 'addresses.door.notLive' ? t('addresses.door.notLiveBody') : null}
          </Banner>
        )}
        {model.saved && <Banner tone="success" title={t('addresses.saved')} />}
        {model.problem && (
          <Banner tone="danger" title={say(model.problem.phrase)}>
            {Object.keys(model.problem.rows).length > 0 ? (
              <ul className="fw-inq-lines">
                {Object.entries(model.problem.rows).map(([index, phrase]) => (
                  <li key={index}>{t('addresses.problem.at', { n: Number(index) + 1, problem: say(phrase) ?? '' })}</li>
                ))}
              </ul>
            ) : null}
          </Banner>
        )}
        {model.loaded.status === 'loading' && <Skeleton height={96} />}
        {model.loaded.status === 'error' && (
          <Banner
            tone="danger"
            title={t('addresses.failed')}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {t('common.retry')}
              </Button>
            }
          >
            {t(model.loaded.problem)}
          </Banner>
        )}
        {scope && (
          <>
            {model.draft.length === 0 && <p className="fw-inq-hint">{t('addresses.none')}</p>}
            <ul className="fw-inq-stack" aria-label={t('addresses.listLabel')}>
              {model.draft.map((address, index) => {
                const problem = say(rowProblem(model.draft, index, model.domains)) ?? (model.problem?.rows[index] ? say(model.problem.rows[index]) : null)
                return (
                  <li key={index} className="fw-inq-row">
                    <Mail size={14} aria-hidden />
                    {editable ? (
                      <Field label={t('addresses.rowLabel', { n: index + 1 })} error={problem ?? undefined}>
                        <Input size="sm" type="email" value={address} maxLength={254} onChange={(event) => actions?.onChange?.(index, event.target.value)} />
                      </Field>
                    ) : (
                      <span className="fw-inq-value">{address}</span>
                    )}
                    {editable && (
                      <Button size="sm" variant="quiet" aria-label={t('addresses.remove', { address })} onClick={() => actions?.onRemove?.(index)}>
                        <Trash2 size={14} aria-hidden />
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
            {editable && (
              <Field label={t('addresses.add')} hint={say(model.adding.trim() ? adding : null) ?? t('addresses.addHint', { max: INQUIRY_ADDRESS_LIMIT, domains: model.domains && model.domains.length > 0 ? model.domains.join(', ') : t('addresses.domainsUnknown') })}>
                <span className="fw-inq-row">
                  <Input
                    size="sm"
                    type="email"
                    value={model.adding}
                    maxLength={254}
                    placeholder={model.domains?.[0] ? `orders@${model.domains[0]}` : undefined}
                    onChange={(event) => actions?.onAdding?.(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !adding) {
                        event.preventDefault()
                        actions?.onAdd?.()
                      }
                    }}
                  />
                  <Button size="sm" heldReason={say(adding)} onClick={() => actions?.onAdd?.()}>
                    <Plus size={14} aria-hidden /> {t('addresses.addGo')}
                  </Button>
                </span>
              </Field>
            )}
            {!editable && <p className="fw-inq-hint">{t('addresses.readOnly')}</p>}
            <p className="fw-inq-hint">{t('addresses.belongs')}</p>
          </>
        )}
      </div>
    </Modal>
  )
}
