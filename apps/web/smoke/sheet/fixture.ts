import { expect, test as base } from '@playwright/test'
import { installSheetNetworkFence, startSheetDenyProxy } from './networkFence'

export { expect }

/** Every product test, including speed tests, gets its fence before Playwright creates its page. */
export const test = base.extend<{ sheetFence: Awaited<ReturnType<typeof startSheetDenyProxy>> }>({
  sheetFence: async ({}, use, info) => {
    const fence = await startSheetDenyProxy()
    try { await use(fence) }
    finally {
      await fence.close()
      if (fence.blocked.length) await info.attach('blocked-sheet-requests', { body: JSON.stringify(fence.blocked), contentType: 'application/json' })
      expect(fence.blocked, 'The sheet attempted a non-loopback request; all such requests were blocked').toEqual([])
    }
  },
  proxy: async ({ sheetFence }, use) => { await use(sheetFence.proxy) },
  serviceWorkers: 'block',
  context: async ({ context, sheetFence }, use) => {
    await installSheetNetworkFence(context, sheetFence.blocked)
    await use(context)
  },
})
