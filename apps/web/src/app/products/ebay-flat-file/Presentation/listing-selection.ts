interface ListingRow {
  id: string
  aliasId?: string | null
  listing: { id: string; externalListingId?: string | null } | null
}

/** Resolve only within the loaded family/account/market. An explicit unknown or ambiguous
 * identifier never selects Primary while a deep link is being resolved. */
export function presentationListing<Row extends ListingRow>(rows: Row[], rootId: string | undefined, selected: string | null): Row | undefined {
  const roots = rows.filter(row => row.id === rootId)
  const matches = roots.filter(row => selected
    ? row.aliasId === selected || row.listing?.id === selected || row.listing?.externalListingId === selected
    : !row.aliasId)
  return matches.length === 1 ? matches[0] : undefined
}
