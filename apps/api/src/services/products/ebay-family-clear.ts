/** Internal evidence for one bulk-save attempt. Nothing here comes from an HTTP receipt. */
export interface EbayFamilyScope {
  parentId: string
  accountId: string | null
  marketplace: string
  aliasKey: string
  locale?: string
}
export interface EbayListingVersion { id: string; version: number }
type OwnerProof = { before: number; after: number } | null
const scopeKey = (scope: EbayFamilyScope) => JSON.stringify([
  scope.parentId, scope.accountId, scope.marketplace, scope.aliasKey, scope.locale ?? null,
])
const fieldKey = (scope: EbayFamilyScope, path: string[]) => JSON.stringify([scopeKey(scope), path])

/**
 * A unit writes a delta. Its caller publishes that delta only after the real savepoint succeeds.
 * The parent never reads a pending unit, and a transaction retry constructs a new root object.
 */
export class EbayFamilyClearOperation {
  private readonly owners = new Map<string, OwnerProof>()
  private readonly clears = new Map<string, string | null>()
  /** Successful pin CAS spans in this unit only; they do not start operation-wide clear proof. */
  private readonly pinSpans = new Map<string, { before: number; after: number }>()

  constructor(private readonly parent?: EbayFamilyClearOperation) {}

  /** The canonical row read identifies the owner of this unit's reply; never inferred from a label. */
  answerListingId?: string

  fork(): EbayFamilyClearOperation { return new EbayFamilyClearOperation(this) }

  commit(unit: EbayFamilyClearOperation): void {
    if (unit.parent !== this) throw new Error('A family-clear unit belongs to another operation')
    for (const [key, proof] of unit.owners) this.owners.set(key, proof)
    for (const [key, target] of unit.clears) this.clears.set(key, target)
  }

  get hasEffects(): boolean { return this.owners.size > 0 || !!this.parent?.hasEffects }

  affectedListingIds(): string[] { return [...this.owners.keys()] }

  needsPinSpan(id: string): boolean { return this.owner(id) !== undefined || this.pinSpans.has(id) }

  private owner(id: string): OwnerProof | undefined {
    return this.owners.has(id) ? this.owners.get(id) : this.parent?.owner(id)
  }

  /** A post-clear number alone is never proof that this caller saw the pre-clear row. */
  expectedVersion(row: EbayListingVersion, supplied: number): number | 'conflict' | undefined {
    const owner = this.owner(row.id)
    const proof = owner === undefined ? this.pinSpans.get(row.id) : owner
    if (proof === undefined) return undefined
    if (!proof || supplied !== proof.before || row.version !== proof.after) return 'conflict'
    return proof.after
  }

  /** Only the canonical successful PIN writer may attest this span. Compare with the immutable parent boundary:
   * facts in this same unit may already have advanced its pending delta beyond the pin's original CAS. */
  rememberPinSpan(id: string, before: number, after: number): void {
    if (after === before) return
    const parent = this.parent?.owner(id), pending = this.owners.get(id), span = this.pinSpans.get(id)
    const boundary = parent === undefined ? span?.before ?? pending?.before ?? before : parent?.after
    if (parent === null || pending === null || before !== boundary || after < before) {
      throw new Error('A completed pin write did not continue this unit\'s listing owner')
    }
    this.pinSpans.set(id, { before, after })
    if (parent !== undefined || this.owners.has(id)) this.owners.set(id, { before: parent?.before ?? pending?.before ?? before, after })
  }

  /** Actual snapshots only; a gap invalidates proof instead of adopting an unseen owner advance. */
  rememberOwners(before: Iterable<EbayListingVersion>, after: Iterable<EbayListingVersion>, includeNew: boolean): void {
    const prior = new Map([...before].map(row => [row.id, row.version]))
    for (const row of after) {
      const version = prior.get(row.id)
      if (version === undefined || row.version === version) continue
      const tracked = this.owner(row.id)
      if (tracked === undefined && !includeNew) continue
      const known = tracked === undefined ? this.pinSpans.get(row.id) : tracked
      this.owners.set(row.id, known === null || known && known.after !== version
        ? null : { before: known?.before ?? version, after: row.version })
    }
  }

  cleared(scope: EbayFamilyScope, path: string[], destination: string): boolean {
    const key = fieldKey(scope, path)
    return (this.clears.has(key) ? this.clears.get(key) : this.parent?.clearTarget(key)) === destination
  }

  private clearTarget(key: string): string | null | undefined {
    return this.clears.has(key) ? this.clears.get(key) : this.parent?.clearTarget(key)
  }

  /** A successful set/reset invalidates the old clear; a new clear records its physical SET destination. */
  rememberField(scope: EbayFamilyScope, path: string[], destination: string | null): void {
    this.clears.set(fieldKey(scope, path), destination)
  }
}
