/** Bounded hot copies of immutable database revisions; authorization stays in the repository. */
export interface SearchNode { externalId: string; parentId: string | null; name: string; path: string; assignable: boolean }
export interface SearchInput { query?: string; parentId?: string; page?: number; assignableOnly?: boolean }
type Page = { items: SearchNode[]; total: number; page: number; pages: number }
type Entry = { rows: SearchNode[]; text: { path: string; id: string }[]; bytes: number; expires: number; pages: Map<string, Page> }

export class TaxonomySearchCache {
  private entries = new Map<string, Entry>()
  private pending = new Map<string, Promise<Entry>>()
  private bytes = 0
  private loads = 0
  private waiting: (() => void)[] = []
  constructor(private readonly maxBytes = 128 * 1024 * 1024, private readonly maxEntries = 32) {}

  clear() { this.entries.clear(); this.bytes = 0 }

  private async loadRows(load: () => Promise<SearchNode[]>) {
    if (this.loads >= 2) await new Promise<void>(resolve => this.waiting.push(resolve))
    else this.loads++
    try { return await load() }
    finally { const next = this.waiting.shift(); if (next) next(); else this.loads-- }
  }

  async search(key: string, input: SearchInput, load: () => Promise<SearchNode[]>): Promise<Page> {
    let entry = this.entries.get(key)
    if (entry && entry.expires < Date.now()) { this.entries.delete(key); this.bytes -= entry.bytes; entry = undefined }
    if (!entry) {
      let pending = this.pending.get(key)
      if (!pending) {
        pending = this.loadRows(load).then(rows => {
          const text = rows.map(row => ({ path: row.path.toLowerCase(), id: row.externalId.toLowerCase() }))
          // Account conservatively for strings, normalized copies, object/array overhead,
          // and at most 64 cached pages of 50 references each.
          const bytes = rows.reduce((sum, row, i) => sum + 256 + 2 * (row.path.length + row.name.length + row.externalId.length + (row.parentId?.length ?? 0) + text[i].path.length + text[i].id.length), 128_000)
          const next: Entry = { rows, text, bytes, expires: Date.now() + 600_000, pages: new Map() }
          if (bytes <= this.maxBytes) {
            while (this.entries.size && (this.bytes + bytes > this.maxBytes || this.entries.size >= this.maxEntries)) {
              const oldest = this.entries.keys().next().value!
              this.bytes -= this.entries.get(oldest)!.bytes; this.entries.delete(oldest)
            }
            this.entries.set(key, next); this.bytes += bytes
          }
          return next
        }).finally(() => { this.pending.delete(key) })
        this.pending.set(key, pending)
      }
      entry = await pending
    }
    // LRU order: activity keeps the currently edited channel hot.
    if (this.entries.has(key)) { entry.expires = Date.now() + 600_000; this.entries.delete(key); this.entries.set(key, entry) }
    const terms = (input.query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 12)
    const page = Math.max(1, Math.floor(input.page ?? 1))
    const pageKey = JSON.stringify([terms, input.parentId ?? null, input.parentId !== undefined, !!input.assignableOnly, page])
    let result = entry.pages.get(pageKey)
    if (!result) {
      const items: SearchNode[] = []
      let total = 0
      for (let i = 0; i < entry.rows.length; i++) {
        const row = entry.rows[i], text = entry.text[i]
        if (input.assignableOnly && !row.assignable) continue
        if (input.parentId !== undefined && row.parentId !== (input.parentId || null)) continue
        if (!terms.every(term => text.path.includes(term) || text.id.includes(term))) continue
        if (total >= (page - 1) * 50 && items.length < 50) items.push(row)
        total++
      }
      result = { items, total, page, pages: Math.ceil(total / 50) }
      if (entry.pages.size >= 64) entry.pages.delete(entry.pages.keys().next().value!)
      entry.pages.set(pageKey, result)
    }
    return structuredClone(result)
  }
}

export const taxonomySearchCache = new TaxonomySearchCache()
