'use client'

import { Hash } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { lineWords, NAMESPACE, type NumberFieldActions, type NumberFieldModel } from '../model'
import { NumberOverrideDialog } from './NumberOverrideDialog'
import '../override.css'

/**
 * A new document's number in its create dialog (B-W2b-24; PLT-125, the W1 gap "no number preview for GR / LOT / PO"): the
 * number the series would give now — said as not reserved — or, for who holds numbering.override, "Type a number for a
 * migrated document…" (the popup) and, once typed, the old system's number with its reason and "Use the series' number".
 */
export function DocumentNumberLine({ model, actions }: { model: NumberFieldModel; actions?: NumberFieldActions }) {
  return (
    <WithMessages namespaces={[NAMESPACE]}>
      <Line model={model} actions={actions} />
      {model.dialog && <NumberOverrideDialog draft={model.dialog} actions={actions} />}
    </WithMessages>
  )
}

function Line({ model, actions }: { model: NumberFieldModel; actions?: NumberFieldActions | undefined }) {
  const t = useT(NAMESPACE)
  const words = lineWords(model)
  return (
    <div className="fw-no-line" role="group" aria-label={t('line.label')}>
      <Hash size={14} aria-hidden />
      <span className="fw-no-line-text">
        <b>{t('line.label')}</b> {t(words.key, words.params)}
      </span>
      {model.canOverride &&
        (model.typed ? (
          <Button size="sm" variant="quiet" onClick={() => actions?.onClear?.()}>
            {t('line.useSeries')}
          </Button>
        ) : (
          <Button size="sm" variant="quiet" onClick={() => actions?.onOpen?.()}>
            {t('line.typeOne')}
          </Button>
        ))}
    </div>
  )
}
