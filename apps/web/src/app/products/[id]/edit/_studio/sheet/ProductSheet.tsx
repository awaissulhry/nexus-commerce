'use client'

import { ThemeChangePlanHost } from '../variants/channel/ThemeChangePlanHost'

import { ProductSheetSurface } from './ProductSheetSurface'
import { useMasterSheetAdapter, type MasterSheetProps } from './master/useMasterSheetAdapter'
import { useChannelSheetAdapter, type ChannelSheetProps } from './channel/useChannelSheetAdapter'

export type ProductSheetProps =
  | ({ scope: 'master' } & MasterSheetProps)
  | ({ scope: 'channel' } & ChannelSheetProps)

function SharedProductAdapter(props: MasterSheetProps) {
  return <ProductSheetSurface {...useMasterSheetAdapter(props)} />
}

function ListingAdapter(props: ChannelSheetProps) {
  return (
    <>
      <ProductSheetSurface {...useChannelSheetAdapter(props)} />
      {/**
        * VT.2c — the host for VT.4's dry-run theme-change plan (design §3.5's locked-commit rule): a
        * SET change on a LIVE coordinate writes nothing and opens the plan instead.
        *
        * 🔴 It is HERE, in the CHANNEL adapter, and the placement was MEASURED rather than reasoned.
        * It was first mounted in `ChannelSheet.tsx` — which reads like the channel sheet's entry point
        * and is DEAD for the studio: `ProductSheetTab` renders `<ProductSheet scope="channel">`
        * directly, so on a real locked commit the plan was asked for and nobody was listening. The
        * browser said "no modal, no request", which is exactly what "the wiring does not work" looks
        * like — `reference_could_not_measure_vs_measured_empty` in a mount point.
        *
        * The MASTER adapter has none, because master has no locked coordinate (`variation-rules.service`
        * returns `locked: null` there), and two hosts would open two modals for one commit.
        */}
      <ThemeChangePlanHost />
    </>
  )
}

/** The scope selects a data adapter. Both adapters use the same sheet renderer. */
export function ProductSheet(props: ProductSheetProps) {
  const key = props.scope === 'master'
    ? JSON.stringify(['master', props.productId, props.market, props.locale])
    : JSON.stringify(['channel', props.productId, props.channel, props.marketplace, props.accountId, props.locale])
  return props.scope === 'master'
    ? <SharedProductAdapter key={key} {...props} />
    : <ListingAdapter key={key} {...props} />
}
