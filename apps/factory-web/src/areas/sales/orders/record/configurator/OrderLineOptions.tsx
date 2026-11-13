'use client'

import { useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import type { ApiClient } from '../../../../../lib/api/client'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { grainsOf } from '../../../quotes/model'
import { useLineConfigurator } from '../../../quotes/record/configurator/use-configurator'
import { ConfiguratorMessages, useConfiguratorWords } from '../../../quotes/record/configurator/words'
import { ConfiguratorView } from '../../../quotes/record/configurator/view/ConfiguratorView'
import type { Order, OrderLine } from '../../api'

export interface OrderLineOptionsProps {
  api: ApiClient
  order: Pick<Order, 'id' | 'version'>
  line: Pick<OrderLine, 'id' | 'seq' | 'kind'>
  permissions: readonly string[]
  /** The record reads the order again after a write (its version moved). */
  onReload: () => void
}

/**
 * The order line's configurator (B-W2b-340; SAL-133, SAL-139, SAL-140; design order.lines.cards): an "Options" button on each
 * colour line of the order's Lines that opens the line's options in a dialog — copied from the quote line as accepted,
 * changed while the order is open and no work order makes the line (a change of what the options add is held until the
 * person keeps the accepted price), the customer's artwork, the main picture of its colourway. Its own container: the
 * dialog reads only while it is open.
 */
export function OrderLineOptions(props: OrderLineOptionsProps) {
  const [open, setOpen] = useState(false)
  if (props.line.kind === 'FEE') return null
  return (
    <ConfiguratorMessages>
      <Opener {...props} open={open} onOpen={setOpen} />
    </ConfiguratorMessages>
  )
}

function Opener({ open, onOpen, ...props }: OrderLineOptionsProps & { open: boolean; onOpen: (open: boolean) => void }) {
  const { t } = useConfiguratorWords()
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => onOpen(true)}>
        <SlidersHorizontal size={14} aria-hidden /> {t('order.button')}
      </Button>
      {open && (
        <Modal open onClose={() => onOpen(false)} title={t('order.dialog', { seq: props.line.seq })} size="xl">
          <Dialog {...props} />
        </Modal>
      )}
    </>
  )
}

function Dialog({ api, order, line, permissions, onReload }: OrderLineOptionsProps) {
  const { model, actions } = useLineConfigurator({ api, target: { kind: 'ORDER', orderId: order.id, lineId: line.id }, grains: grainsOf(permissions), onOrder: onReload, refreshKey: String(order.version) })
  return <ConfiguratorView model={model} actions={actions} />
}
