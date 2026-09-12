import type { MarketplaceLite } from './types'

type Account = NonNullable<MarketplaceLite['accounts']>[number]

/** UI default only. The API independently validates every read/write destination. */
export function primaryStudioAccount(accounts: readonly Account[]): Account | undefined {
  if (accounts.length === 1) return accounts[0]
  const primaries = accounts.filter(account => account.primary)
  return primaries.length === 1 ? primaries[0] : undefined
}

export function studioAccountAccess(accounts: readonly Account[], accountId: string | undefined) {
  const primary = primaryStudioAccount(accounts)
  const selected = accounts.find(account => account.id === accountId)
  return { primary, selected, supportsPrimaryTools: !!primary && primary.id === selected?.id }
}
