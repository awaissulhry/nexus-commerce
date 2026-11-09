import { defineContract, output } from '@nexus/factory-domain/core/contracts'
import { settingsQuery, settingsView, updateSettingsBody } from '@nexus/factory-domain/product/settings/contracts'

/** The product settings routes' contracts (B-W2b-221): factory-domain's product/settings/contracts. */

const one = { 200: output({ settings: settingsView }) }

export const readSettingsContract = defineContract({ querystring: settingsQuery, response: one })
export const updateSettingsContract = defineContract({ body: updateSettingsBody, response: one })
