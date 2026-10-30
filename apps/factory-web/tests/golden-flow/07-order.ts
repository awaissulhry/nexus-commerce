import { expect } from '@playwright/test'
import { STYLE } from './02-style'
import { SIZES } from './05-quote'
import { defineStage } from './_harness/stages'

export default defineStage({
  proves: 'order from the accepted version: confirmed, lines per size, the deposit paid with its TD02 in the chain; sales sees no cost',
  async run(flow) {
    const sales = await flow.desk('sales')
    const { page } = sales
    const order = flow.state.order as { id: string; number: string }

    await flow.step('sales finds the order by the customer’s reference and opens the studio', async () => {
      await sales.go('/sales/orders?q=RFQ-GOLDEN-1')
      await page.getByRole('link', { name: order.number, exact: true }).first().click()
      await page.waitForURL(new RegExp(`/sales/orders/${order.id}`))
      await expect(page.getByText('Confirmed').first()).toBeVisible()
      await expect(page.getByText('Deposit paid').first()).toBeVisible()
      await expect(page.getByText(new RegExp(`From quote ${flow.state.quote.number}`)).first()).toBeVisible()
      const lines = page.getByRole('table', { name: `${STYLE.code}: Ordered by colour and size` })
      const row = lines.getByRole('row', { name: /RED · Rosso/ })
      await expect(row).toBeVisible()
      expect((await row.getByRole('cell').allInnerTexts()).map((text) => text.trim()).slice(-4)).toEqual(['2', '4', '2', '8'])
      await flow.shot(page, 'order-studio')
    })

    await flow.step('the money tab: the TD02 in the chain, delivered; no cost for sales', async () => {
      await sales.go(`/sales/orders/${order.id}?tab=money`)
      await expect(page.getByText(flow.state.td02.number).first()).toBeVisible()
      await expect(page.getByText('Cost', { exact: true })).toHaveCount(0)
      const read = (await flow.read(page, `/sales/orders/${order.id}`)).order
      expect(read).toMatchObject({ status: 'CONFIRMED', depositRequired: true })
      expect(read.lines[0].sizes.map((size: Record<string, any>) => [size.size, size.quantity])).toEqual(Object.entries(SIZES))
      expect(read.chain.depositRequests.map((request: Record<string, any>) => request.status)).toEqual(['PAID'])
      expect(read).not.toHaveProperty('costAmount')
      expect(read.lines[0]).not.toHaveProperty('unitCost')
      flow.state.order.lineId = read.lines[0].id
    })
  },
})
