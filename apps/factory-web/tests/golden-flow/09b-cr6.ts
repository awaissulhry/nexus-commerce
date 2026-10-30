import { expect } from '@playwright/test'
import { defineStage } from './_harness/stages'
import { answerOf, dialog, pdf, pickDate, press } from './_harness/ui'

export default defineStage({
  proves: 'Cr VI evidence accepted under the setting (a lab report on the lot) → lot released by quality (not the receiver) → now counted as usable; the protectors’ PPE certificate → released',
  async run(flow) {
    const inspector = await flow.desk('inspector')
    const { page } = inspector
    const lots = flow.state.receipt.lots as { leather: { id: string; code: string }; protectors: { id: string; code: string } }

    const release = async (code: string) => {
      await press(page.getByRole('button', { name: 'Release lot…' }).first())
      const form = dialog(page)
      await expect(form.getByText(/Every check passes/).first()).toBeVisible()
      await form.getByRole('textbox', { name: /Type the lot code to confirm/ }).fill(code)
      await answerOf(page, 'POST', /^\/quality\/lots\/[0-9a-f-]+\/release$/, () => press(form.getByRole('button', { name: `Release lot ${code}`, exact: true })))
      await expect(page.getByText(`Lot ${code} released: it is usable stock.`).first()).toBeVisible()
    }

    await flow.step('the leather lot’s chromium VI result: EN ISO 17075-1, 1.2 mg/kg, the lab report on file → pass', async () => {
      await inspector.go(`/compliance/tests/${lots.leather.id}`)
      await expect(page.getByRole('heading', { name: `Lot ${lots.leather.code}` }).first()).toBeVisible()
      await press(page.getByRole('button', { name: 'Record result' }).first())
      const form = dialog(page)
      await form.getByRole('combobox', { name: 'Method', exact: true }).selectOption('EN ISO 17075-1')
      await form.getByRole('textbox', { name: 'Measured value', exact: true }).fill('1.2')
      await form.getByRole('textbox', { name: 'Laboratory', exact: true }).fill('Test Lab One (made up)')
      await form.getByRole('textbox', { name: 'Report number', exact: true }).fill('TL-GOLDEN-1')
      await form.locator('input[type=file]').setInputFiles(pdf('Cr VI test report TL-GOLDEN-1'))
      await answerOf(page, 'POST', /^\/quality\/lots\/[0-9a-f-]+\/results$/, () => press(form.getByRole('button', { name: 'Save result' })))
      await expect(page.getByText(`Result saved: lot ${lots.leather.code} passes its chromium VI test.`).first()).toBeVisible()
      await flow.shot(page, 'cr6-pass')
    })

    await flow.step('the inspector releases the leather lot (she did not receive it): it is usable stock', async () => {
      await inspector.go(`/compliance/tests/${lots.leather.id}`)
      await release(lots.leather.code)
      await flow.shot(page, 'leather-released')
    })

    await flow.step('the protectors’ PPE certificate attached (valid to 2030-05-31), then the lot released', async () => {
      await inspector.go(`/compliance/tests/${lots.protectors.id}?act=document`)
      const form = dialog(page)
      await pickDate(form, 'Valid to', '2030-05-31')
      await form.locator('input[type=file]').setInputFiles(pdf('EN 1621-1 certificate of the shoulder protector lot'))
      await answerOf(page, 'POST', /^\/quality\/lots\/[0-9a-f-]+\/documents$/, () => press(form.getByRole('button', { name: 'Attach document' })))
      await expect(page.getByText(`Document attached to lot ${lots.protectors.code}.`).first()).toBeVisible()
      await release(lots.protectors.code)
      await flow.shot(page, 'protectors-released')
    })

    const warehouse = await flow.desk('warehouse')
    for (const lot of [lots.leather, lots.protectors]) {
      expect((await flow.read(warehouse.page, `/inventory/lots/${lot.id}`)).lot).toMatchObject({ qualityStatus: 'RELEASED' })
    }
    await flow.settle()
  },
})
