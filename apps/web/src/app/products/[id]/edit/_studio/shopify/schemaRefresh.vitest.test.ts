import { describe, expect, it, vi } from 'vitest'
import { createSchemaRefresh } from './schemaRefresh'

describe('live Shopify schema refresh', () => {
  it('re-reads an event arriving during discovery and accepts only the final schema', async () => {
    const resolvers: ((value: string[]) => void)[] = [], accepted = vi.fn()
    const load = vi.fn(() => new Promise<string[]>(resolve => resolvers.push(resolve)))
    const reader = createSchemaRefresh(load, accepted, vi.fn())
    const pending = reader.refresh()
    void reader.refresh(); void reader.refresh()
    expect(load).toHaveBeenCalledTimes(1)
    resolvers[0](['deleted-field']); await Promise.resolve()
    expect(accepted).not.toHaveBeenCalled()
    expect(load).toHaveBeenCalledTimes(2)
    resolvers[1](['new-field']); await pending
    expect(accepted).toHaveBeenCalledExactlyOnceWith(['new-field'])
  })
  it('never applies an old store response after switching account', async () => {
    let resolve!: (value: string) => void
    const accept = vi.fn(), fail = vi.fn()
    const reader = createSchemaRefresh(() => new Promise<string>(r => { resolve = r }), accept, fail)
    const pending = reader.refresh(); reader.dispose(); resolve('store-A')
    await pending; await reader.refresh()
    expect(accept).not.toHaveBeenCalled(); expect(fail).not.toHaveBeenCalled()
  })
  it('reports failures without replacing the last good schema and recovers on retry', async () => {
    const accept = vi.fn(), fail = vi.fn()
    const load = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(['new'])
    const reader = createSchemaRefresh(load, accept, fail)
    await reader.refresh()
    expect(fail).toHaveBeenCalledOnce(); expect(accept).not.toHaveBeenCalled()
    await reader.refresh()
    expect(accept).toHaveBeenCalledExactlyOnceWith(['new'])
  })
})
