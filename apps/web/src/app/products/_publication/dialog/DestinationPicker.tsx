'use client'

/**
 * The Publish window's compact destination row: Channel · Account (only when the channel has two or more) · Markets,
 * with each chosen market as a removable chip. The same controls as the sheet's own top bar (`StudioBar`): a `Listbox`
 * per single choice and a `MultiSelect` with type-to-search (and its own "Select all") for the markets.
 *
 * Once a publish has started the destinations are fixed, so the row turns into one plain line saying where it goes.
 */
import { Listbox, MultiSelect } from '@/design-system/components'
import { TokenChip } from '@/design-system/primitives'
import { channelLabel } from '@nexus/shared/channel-label'
import type { PublicationDestinationOption } from './model'
import { changeAccount, changeChannel, changeMarkets, marketOptionLabel, pickerAccounts, pickerChannels, pickerMarkets, removeMarket, type PickerChoice } from './pickers'
import styles from './publication.module.css'

export interface DestinationPickerProps {
  options: readonly PublicationDestinationOption[]
  choice: PickerChoice
  onChange(next: PickerChoice): void
  /** A publish has started: show where it goes, without controls. */
  locked?: boolean
  /** The many-product window checks every product: its markets read "Markets to check". */
  marketsLabel?: string
}

export function DestinationPicker({ options, choice, onChange, locked = false, marketsLabel = 'Markets' }: DestinationPickerProps) {
  const channels = pickerChannels(options)
  const accounts = pickerAccounts(options, choice.channel)
  const markets = pickerMarkets(options, choice.channel, choice.accountId)
  const byKey = new Map(markets.map(o => [o.key, o]))
  const chosen = choice.keys.map(key => byKey.get(key)).filter((o): o is PublicationDestinationOption => !!o)
  const accountName = accounts.find(a => a.value === choice.accountId)?.label

  if (locked) {
    return <p className={styles.destinationLine}>
      <strong>{choice.channel ? channelLabel(choice.channel) : 'No channel'}</strong>
      {accounts.length > 1 && accountName ? ` · ${accountName}` : ''}
      {chosen.length ? ` · ${chosen.map(o => o.scope.marketplace).join(', ')}` : ''}
    </p>
  }

  return <div className={styles.picker}>
    <div className={styles.pickerControls}>
      <Listbox size="sm" width="auto" ariaLabel="Channel" placeholder="Channel" value={choice.channel ?? undefined}
        options={channels} onChange={channel => onChange(changeChannel(options, choice, channel))} />
      {accounts.length > 1 && <Listbox size="sm" width="auto" ariaLabel="Account" placeholder="Account" value={choice.accountId ?? undefined}
        options={accounts} onChange={accountId => onChange(changeAccount(options, choice, accountId))} />}
      <MultiSelect size="sm" width="auto" searchable ariaLabel={marketsLabel} placeholder={`${marketsLabel}: none`} searchPlaceholder="Type a market, e.g. de"
        options={markets.map(o => ({ value: o.key, label: marketOptionLabel(o) }))} value={choice.keys}
        formatLabel={value => `${marketsLabel}: ${value.length.toLocaleString('en')}`}
        onChange={keys => onChange(changeMarkets(options, choice, keys))} />
    </div>
    {chosen.length > 0 && <ul className={styles.chips} aria-label={`Chosen ${marketsLabel.toLowerCase()}`}>
      {chosen.map(o => <li key={o.key}>
        <TokenChip onRemove={() => onChange(removeMarket(choice, o.key))} removeLabel={`Remove ${marketOptionLabel(o)}`}>{marketOptionLabel(o)}</TokenChip>
      </li>)}
    </ul>}
  </div>
}
