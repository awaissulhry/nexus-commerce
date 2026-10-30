'use client'

import { GitBranch, Search } from 'lucide-react'
import { Banner, Field, Modal } from '@nexus/ui/components'
import { Button, Input, Spinner } from '@nexus/ui/primitives'
import type { TraceFind } from '../../stock/daily/api'
import { useWords } from '../shared/parts'
import type { TraceFindModel } from './model'

export interface TraceFindActions {
  onCode?: (code: string) => void
  onFind?: () => void
  onPick?: (match: TraceFind['matches'][number]) => void
  onClose?: () => void
}

/**
 * Trace (design warehouse.lots pop:lt-trace): ONE field — scan or type any code (a garment serial, a batch or work order
 * number, a bundle ticket, a hide tag, a lot, a shipment or DDT number) — and Trace. One record found opens its trace (a
 * lot on its record's Trace tab, anything else on the trace page); several: the person picks one (the kind and how the
 * code matched, in our words); none: said in our words, and why when the code is a label the trace does not take.
 */
export function TraceDialog({ model, actions }: { model: TraceFindModel; actions?: TraceFindActions }) {
  const t = useWords()
  const held = model.state === 'finding' ? t('lt.find.finding') : model.code.trim() === '' ? t('lt.find.heldEmpty') : null
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      size="md"
      title={t('lt.find.title')}
      subtitle={t('lt.find.subtitle')}
      footer={
        <>
          <Button size="sm" onClick={() => actions?.onClose?.()}>
            {t('stock:common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onFind?.()}>
            {model.state === 'finding' ? <Spinner size={12} /> : <GitBranch size={13} aria-hidden />} {t('lt.find.go')}
          </Button>
        </>
      }
    >
      <div className="fw-wl-stack tight">
        <Field label={t('lt.find.field')} hint={t('lt.find.hint')}>
          <Input
            type="search"
            autoFocus
            leadingIcon={<Search size={13} aria-hidden />}
            value={model.code}
            onChange={(event) => actions?.onCode?.(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !held) {
                event.preventDefault()
                actions?.onFind?.()
              }
            }}
          />
        </Field>
        {model.state === 'none' && <Banner tone="info" title={t('lt.find.none', { code: model.code.trim() })} />}
        {model.state === 'unreadable' && <Banner tone="warning" title={t('lt.find.unreadable', { code: model.code.trim() })} />}
        {model.state === 'error' && <Banner tone="danger" title={t('lt.find.failed')}>{model.problem ? t(`stock:${model.problem}`) : null}</Banner>}
        {model.state === 'several' && (
          <div className="fw-wl-stack tight">
            <p className="fw-wl-text">{t('lt.find.several', { count: model.matches.length, code: model.code.trim() })}</p>
            <ul className="fw-wl-checks" aria-label={t('lt.find.matches')}>
              {model.matches.map((match) => (
                <li key={`${match.kind}:${match.id}`}>
                  <Button size="sm" variant="link" onClick={() => actions?.onPick?.(match)}>
                    {t(`lt.find.kind.${match.kind}`)} <span className="fw-wl-code">{match.code}</span>
                  </Button>{' '}
                  <span className="fw-st-sub">{t(`lt.find.matchedBy.${match.matchedBy}`)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  )
}
