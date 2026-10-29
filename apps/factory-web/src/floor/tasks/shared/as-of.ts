/**
 * A small lookup memory per tab for the floor task screens (design "offline": a page that works offline opens from what
 * the tablet already knows, with its as-of time). The DS/app has no service worker and no lookup cache yet (B-W0-30 gap
 * 1, PLT-238): this keeps the answers a screen read while online for the rest of the visit, so an action that queues
 * (a report, a cut, a bundle) can still be taken offline on a record the tablet saw, and the screen says as of when.
 * Nothing here is written to storage: a reload offline starts empty and says "Not on this tablet".
 */
export interface Remembered<T> {
  readonly value: T
  /** When it was read from the server (ISO). */
  readonly asOf: string
}

export class AsOfMemory<T> {
  private readonly entries = new Map<string, Remembered<T>>()

  constructor(private readonly max = 200) {}

  keep(key: string, value: T, asOf: Date = new Date()): void {
    this.entries.delete(key)
    this.entries.set(key, { value, asOf: asOf.toISOString() })
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  get(key: string): Remembered<T> | null {
    return this.entries.get(key) ?? null
  }

  forget(key: string): void {
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }
}

/** A scanned code as a memory key (any case, spaces dropped). */
export const codeKey = (code: string): string => code.trim().toUpperCase().replace(/\s+/g, '')
