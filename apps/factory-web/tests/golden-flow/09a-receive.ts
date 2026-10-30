import { expect, type Page } from '@playwright/test'
import { scan, scanUntil, signIn, tablet, tile, worker } from './_harness/floor'
import { defineStage } from './_harness/stages'
import { answerOf, press } from './_harness/ui'

/** One hide's area on the receiving pad, key by key (52.5 ft², as the API golden flow receives them). */
async function area(page: Page, value: string): Promise<void> {
  const pad = page.locator('section.fw-receive-pad')
  for (const key of value) await pad.locator(`[data-key="${key === '.' ? 'sep' : key}"]`).click()
}

export default defineStage({
  proves: 'hides received one by one on the floor (the warehouse tablet); the lot in quarantine (Cr VI test), the protectors’ lot held for their PPE certificate',
  async run(flow) {
    const po = flow.state.po as { id: string; number: string }
    const buyer = await flow.desk('buyer')
    const lines = (await flow.read(buyer.page, `/purchasing/orders/${po.id}`)).order.lines as Record<string, any>[]
    const leather = lines.find((line) => /SEED-LEA-100/.test(JSON.stringify(line.item ?? line)))!
    const hides = Number(leather.confirmedQuantity ?? leather.quantity)

    await flow.step('the warehouse tablet is enrolled (Admin › Devices) and its worker made (Admin › Users)', async () => {
      await tablet(flow, 'WH')
      await worker(flow, 'wh')
    })
    const device = await tablet(flow, 'WH')
    const { page } = device

    await flow.step('the warehouse worker signs in: badge, temporary PIN, a PIN of their own, the worker notice', async () => {
      await signIn(flow, device, await worker(flow, 'wh'))
      await flow.shot(page, 'wh-home')
    })

    const receipt = await flow.step(`Receive: the PO, the supplier’s DDT, ${hides} hides one by one, the protectors by the lot; posted`, async () => {
      await tile(page, 'Receive')
      await page.waitForURL(/\/floor\/receive/)
      await scanUntil(page, po.number, page.getByRole('textbox', { name: 'Delivery note number', exact: true }), { field: 'Scan the PO or the delivery note' })
      await expect(page.getByText(po.number, { exact: true }).first()).toBeVisible()
      await expect(page.getByText('Confirmed', { exact: true }).first()).toBeVisible()
      await scan(page, 'DDT-GOLDEN-01', { field: 'Delivery note number' })
      await expect(page.getByText(/Delivery note DDT-GOLDEN-01/).first()).toBeVisible()
      await flow.shot(page, 'receive-lines')

      const bar = page.getByRole('group', { name: 'Receive goods' })
      await page.getByRole('button', { name: /SEED-LEA-100/ }).first().click()
      await expect(page.getByText(/Goes to quality hold/).first()).toBeVisible()
      for (let n = 1; n <= hides; n++) {
        await expect(page.getByText(`Hide ${n}: area`).first()).toBeVisible()
        await area(page, '52.5')
        await press(bar.getByRole('button', { name: 'Save hide' }))
        await expect(page.getByText(new RegExp(`Hide ${n} added: 52[.,]5 ft²`)).first()).toBeVisible()
      }
      await flow.shot(page, 'receive-hides')
      await press(bar.getByRole('button', { name: 'Line done' }))

      await page.getByRole('button', { name: /SEED-PRO-300/ }).first().click()
      await press(page.getByRole('button', { name: 'All to come' }))
      await press(bar.getByRole('button', { name: /^Receive lot · 36 pcs/ }))
      await press(bar.getByRole('button', { name: 'Finish delivery' }))
      await expect(page.getByText('Finish the delivery').first()).toBeVisible()
      await flow.shot(page, 'receive-finish')
      const posted = await answerOf(page, 'POST', /^\/inventory\/receiving\/orders\/[0-9a-f-]+\/receipts$/, () => press(bar.getByRole('button', { name: 'Post the delivery' })))
      await expect(page.getByText(/GR-\d{4}-\d{4}/).first()).toBeVisible()
      await expect(page.getByText('Posted').first()).toBeVisible()
      await flow.shot(page, 'receive-posted')
      const receipt = posted.receipt as Record<string, any>
      return { id: receipt.id as string, number: receipt.number as string }
    })

    const lots = await flow.step('the office reads the receipt: the leather lot in quarantine (Cr VI test), the protectors held for their certificate', async () => {
      const warehouse = await flow.desk('warehouse')
      await warehouse.go(`/warehouse/receipts/${receipt.id}?tab=lots`)
      await expect(warehouse.page.getByText(receipt.number).first()).toBeVisible()
      await flow.shot(warehouse.page, 'receipt-office')
      const read = (await flow.read(warehouse.page, `/inventory/receipts/${receipt.id}/lots`)).lots as Record<string, any>[]
      const leatherLot = read.find((lot) => (lot.hides ?? []).length > 0)!
      const protectorLot = read.find((lot) => lot !== leatherLot)!
      expect(leatherLot).toMatchObject({ qualityStatus: 'QUARANTINE' })
      expect(leatherLot.hides.length).toBe(hides)
      expect(protectorLot).toMatchObject({ qualityStatus: 'QUARANTINE' })
      return {
        leather: { id: leatherLot.id as string, code: leatherLot.code as string, hides: (leatherLot.hides as Record<string, any>[]).map((hide) => hide.code as string) },
        protectors: { id: protectorLot.id as string, code: protectorLot.code as string },
      }
    })
    flow.state.receipt = { ...receipt, lots }
    await flow.settle()
  },
})
