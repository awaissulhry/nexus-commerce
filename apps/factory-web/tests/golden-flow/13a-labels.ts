import { expect } from '@playwright/test'
import { CERTIFICATE } from './03-certificate'
import { STYLE } from './02-style'
import { quiet, scanUntil, signIn, tablet, tile, worker } from './_harness/floor'
import { defineStage } from './_harness/stages'
import { answerOf, dialog, pickDate, press } from './_harness/ui'

export default defineStage({
  proves:
    'batch number and garment label at the packing bench; refused while the certificate does not cover (the office’s lapse check: once it expires the gate refuses every garment; on the tablet: the certificate suspended → no label prints, reinstated → it prints)',
  blocked:
    'an EXPIRED certificate cannot be made on purpose: a registered certificate’s dates are frozen (…_product_guards) and the server clock is real. The office lapse check shows the refusal on a date after the certificate ends; the tablet’s refusal is shown with the certificate suspended (the same gate and the same words on the floor), then reinstated',
  async run(flow) {
    const workOrder = flow.state.workOrder as { id: string; number: string }
    const certificateId = flow.state.certificate.id as string

    await flow.step('the admin adds the 100×100 mm garment label printer at A1 (the seeded one is 100×50)', async () => {
      const admin = await flow.desk('admin')
      const { page } = admin
      await admin.go('/admin/devices?mode=printers')
      await press(page.getByRole('button', { name: 'Add printer' }).first())
      const form = dialog(page)
      await form.getByRole('combobox', { name: 'Site', exact: true }).selectOption({ label: 'Seed plant A1' })
      await form.getByRole('textbox', { name: 'Code', exact: true }).fill('LBL-GF')
      await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Golden garment label printer')
      await form.getByRole('textbox', { name: 'Where the relay reaches it', exact: true }).fill('golden-label:9100')
      await form.getByRole('textbox', { name: 'Label width', exact: true }).fill('100')
      await form.getByRole('textbox', { name: 'Label height', exact: true }).fill('100')
      await answerOf(page, 'POST', /^\/print\/printers$/, () => press(form.getByRole('button', { name: 'Save printer' })))
      await expect(page.getByText('Printer added.').first()).toBeVisible()
    })

    await flow.step('the office lapse check: on the day after the certificate ends, the gate refuses the garments', async () => {
      const inspector = await flow.desk('inspector')
      const { page } = inspector
      await inspector.go(`/compliance/certificates/${certificateId}?tab=coverage`)
      await expect(page.getByText('What it blocks when it lapses').first()).toBeVisible()
      await pickDate(page, page.locator('#fw-ce-lapse-date'), '2031-01-15')
      await press(page.getByRole('button', { name: /^Check \d+ garments?$/ }).first())
      await expect(page.getByText(/^On .* the gate would refuse \d+ of \d+ garments/).first()).toBeVisible()
      await flow.shot(page, 'lapse-check')
    })

    await flow.step(`the inspector marks ${CERTIFICATE.number} suspended (the notified body’s words)`, async () => {
      const inspector = await flow.desk('inspector')
      const { page } = inspector
      await inspector.go(`/compliance/certificates/${certificateId}`)
      await page.getByRole('button', { name: 'More actions' }).first().click()
      await page.getByRole('menuitem', { name: 'Mark suspended…' }).click()
      const form = dialog(page)
      await form.getByRole('textbox', { name: "The notified body's words" }).or(form.getByRole('textbox', { name: 'The notified body’s words' })).first().fill('Suspended for a check of the test house (made up)')
      await answerOf(page, 'POST', /\/suspend$/, () => press(form.getByRole('button', { name: 'Mark suspended' })))
      await expect(page.getByText(`${CERTIFICATE.number} is suspended: the gate refuses what it covered.`).first()).toBeVisible()
    })

    const device = await tablet(flow, 'PACK')
    const { page } = device
    const open = async () => {
      await signIn(flow, device, await worker(flow, 'packer'))
      await tile(page, 'Garment labels')
      await scanUntil(page, workOrder.number, page.getByRole('radio', { name: /^50\b/ }))
      await page.getByRole('radio', { name: /^50\b/ }).first().click()
      await quiet(page)
    }

    await flow.step('on the packing tablet: no garment label prints while no valid certificate covers the size', async () => {
      await open()
      await expect(page.getByText(`No valid certificate covers size 50 of ${STYLE.name}`).first()).toBeVisible()
      await expect(page.getByText('Labels cannot print. Tell quality.').first()).toBeVisible()
      await expect(page.getByRole('button', { name: /^Print 2 labels · RED 50/ })).toBeDisabled()
      await flow.shot(page, 'labels-refused')
    })

    await flow.step(`the inspector reinstates ${CERTIFICATE.number}`, async () => {
      const inspector = await flow.desk('inspector')
      await inspector.go(`/compliance/certificates/${certificateId}`)
      await press(inspector.page.getByRole('button', { name: 'Reinstate…' }).first())
      await answerOf(inspector.page, 'POST', /\/reinstate$/, () => press(dialog(inspector.page).getByRole('button', { name: 'Reinstate', exact: true })))
      await expect(inspector.page.getByText(`${CERTIFICATE.number} is valid again.`).first()).toBeVisible()
    })

    await flow.step('the packer prints every garment label: the batch number on each, the certificate in force', async () => {
      await open()
      await expect(page.getByText(new RegExp(`certificate ${CERTIFICATE.number} valid until`)).first()).toBeVisible()
      await expect(page.getByText(new RegExp(`batch ${flow.state.workOrder.batch}`)).first()).toBeVisible()
      const printer = page.getByRole('radiogroup', { name: 'Which label printer?' })
      if (await printer.isVisible()) await printer.getByRole('radio', { name: /LBL-GF/ }).click()
      const printed = await answerOf(page, 'POST', /^\/production\/serials\/work-orders\/[0-9a-f-]+\/labels$/, () => press(page.getByRole('button', { name: /^Print all \(8\)/ })))
      expect(printed).toMatchObject({ tracking: 'BATCH', refused: [] })
      await expect(page.getByText(/^Sent to the printer: 8 labels/).first()).toBeVisible()
      await flow.shot(page, 'labels-printed')
    })
    await flow.settle()
  },
})
