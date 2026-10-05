'use client'

import { ThemeChangePlanHost } from '../variants/channel/ThemeChangePlanHost'

import { ProductSheetSurface } from './ProductSheetSurface'
import { useMasterSheetAdapter, type MasterSheetProps } from './master/useMasterSheetAdapter'
import { useChannelSheetAdapter, type ChannelSheetProps } from './channel/useChannelSheetAdapter'
import { ChannelIdControlProvider } from './channel/channelIdControl'

export type ProductSheetProps =
  | ({ scope: 'master' } & MasterSheetProps)
  | ({ scope: 'channel' } & ChannelSheetProps)

function SharedProductAdapter(props: MasterSheetProps) {
  return <ProductSheetSurface {...useMasterSheetAdapter(props)} />
}

function ListingAdapter(props: ChannelSheetProps) {
  return (
    /**
      * The Item ID / Listing ID / Product ID / ASIN control (docs/sheet-ids-sku-rows A2, steps I1–I4) wraps the CHANNEL
      * sheet here, for the same reason as the plan host below: the studio renders `<ProductSheet scope="channel">`
      * from `ProductSheetTab`, never `ChannelSheet.tsx`. Mounted there first, every id cell found no control and showed
      * only Copy and Open (browser check 2026-10-05). The Shared scope has no channel id cell, so it gets none.
      */
    <ChannelIdControlProvider channel={props.channel} marketplace={props.marketplace}>
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
    </ChannelIdControlProvider>
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
