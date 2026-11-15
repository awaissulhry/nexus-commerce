import { z } from 'zod'
import { defineEvent } from '../events/define'
import { CARRIER_SERVICES } from '../shipping/services/catalogue'

/**
 * The events of carrier contracts and services (B-W2b-400; LOG-033, LOG-038, LOG-041, LOG-042; apps/factory-api
 * modules/shipping/{carrier-accounts,services}). Context `shipping-contracts`, its own module folder (the shipping events
 * file is W1's). They reach the office's shipping screens (shipping.view); none reaches the floor. No account number (it
 * stays sealed), no money (a declared or insured value, the rule's value: the price grain never travels on a live screen),
 * no person: ids, codes and the kind of change. The customer's carrier account is announced with W1's party.updated.
 *
 *   shipping.carrier_contract_changed   our own contract with a carrier added, its number replaced, "use only our rates"
 *                                       switched, or the contract switched off
 *   shipping.carrier_services_changed   the services the Owner chose for live use on a Sendcloud connection, and the
 *                                       carriers whose own contract Sendcloud knows
 *   shipment.services_changed           a shipment's carrier service, express, who pays the duties or paperless trade
 *   shipment.parcel_values_changed      a parcel's declared or insured value typed, or the site's rule applied
 *   shipping.insurance_rule_changed     the value above which a site insures parcels set or removed
 */
export const events = [
  defineEvent({
    type: 'shipping.carrier_contract_changed',
    context: 'shipping-contracts',
    description: 'Our own contract with a carrier was added, its account number replaced (sealed), "use only our rates" switched, or the contract switched off.',
    payload: z.strictObject({
      contractId: z.uuid(),
      siteId: z.uuid().nullable(),
      carrierCode: z.string(),
      change: z.enum(['ADDED', 'NUMBER_REPLACED', 'RATES_CHANGED', 'SWITCHED_OFF']),
    }),
    live: { permission: 'shipping.view', fields: ['contractId', 'siteId', 'carrierCode', 'change'] },
  }),
  defineEvent({
    type: 'shipping.carrier_services_changed',
    context: 'shipping-contracts',
    description: 'The carrier services chosen for live use on a Sendcloud connection changed (a service not chosen stays on the fake), or the contracts Sendcloud knows.',
    payload: z.strictObject({ accountId: z.uuid(), services: z.array(z.enum(CARRIER_SERVICES)), contractCarriers: z.array(z.string()) }),
    live: { permission: 'shipping.view', fields: ['accountId', 'services', 'contractCarriers'] },
  }),
  defineEvent({
    type: 'shipment.services_changed',
    context: 'shipping-contracts',
    description: "A shipment's carrier service, express, who pays the duties of the export or paperless trade changed (before any label).",
    payload: z.strictObject({
      shipmentId: z.uuid(),
      number: z.string(),
      carrierCode: z.string().nullable(),
      serviceCode: z.string().nullable(),
      express: z.boolean(),
      dutyPayer: z.enum(['SENDER', 'RECEIVER']).nullable(),
      paperless: z.boolean(),
    }),
    live: { permission: 'shipping.view', fields: ['shipmentId', 'number', 'carrierCode', 'serviceCode', 'express', 'dutyPayer', 'paperless'] },
  }),
  defineEvent({
    type: 'shipment.parcel_values_changed',
    context: 'shipping-contracts',
    description: "A shipment's parcels' declared or insured values changed (typed, or by the site's insurance rule); the values stay behind the price grain.",
    payload: z.strictObject({ shipmentId: z.uuid(), number: z.string(), parcelIds: z.array(z.uuid()), byRule: z.boolean() }),
    live: { permission: 'shipping.view', fields: ['shipmentId', 'number', 'parcelIds', 'byRule'] },
  }),
  defineEvent({
    type: 'shipping.insurance_rule_changed',
    context: 'shipping-contracts',
    description: 'The value above which a site insures parcels by rule was set or removed (the value stays behind the price grain).',
    payload: z.strictObject({ siteId: z.uuid(), ruleOn: z.boolean() }),
    live: { permission: 'shipping.view', fields: ['siteId', 'ruleOn'] },
  }),
] as const
