/**
 * Google Ads programme 2, G1 (2026-10-15) — google-ads-query's guard: only one SELECT, only this account, at most 1,000
 * rows (a LIMIT added or lowered, never one inside a quoted value), and Google's date rule for a selected date segment.
 */
import { describe, expect, it } from 'vitest'
import { checkedQuery } from './live-query.js'

const OWN = '1234567890'
const ok = (q: string, limit?: number) => {
  const out = checkedQuery(q, OWN, limit)
  if ('refusal' in out) throw new Error(out.refusal)
  return out
}
const refusal = (q: string) => {
  const out = checkedQuery(q, OWN)
  return 'refusal' in out ? out.refusal : null
}

describe('google-ads-query guard', () => {
  it('refuses anything that is not one SELECT', () => {
    expect(refusal('')).toMatch(/Give one GAQL query/)
    expect(refusal('DELETE FROM campaign')).toMatch(/Only a SELECT query reads/)
    expect(refusal('mutate campaign set status = PAUSED')).toMatch(/Only a SELECT query reads/)
    expect(refusal('SELECT campaign.id FROM campaign; SELECT ad_group.id FROM ad_group')).toMatch(/One query only/)
    expect(refusal('SELECT campaign.id, campaign.name')).toMatch(/no FROM/)
    expect(refusal("SELECT campaign.id FROM campaign WHERE campaign.name = 'open")).toMatch(/not closed/)
    for (const r of [refusal('DELETE FROM campaign'), refusal('')]) expect(r).toMatch(/Nothing was sent\.$/)
  })

  it('refuses another customer id, in a resource name or a customer.id condition; this account is fine', () => {
    expect(refusal("SELECT campaign.id FROM campaign WHERE campaign.resource_name = 'customers/999/campaigns/21'")).toMatch(/another Google Ads account \(999\)/)
    expect(refusal('SELECT customer.id FROM customer WHERE customer.id = 999')).toMatch(/another Google Ads account \(999\)/)
    expect(refusal(`SELECT customer.id FROM customer WHERE customer.id IN (${OWN}, 555)`)).toMatch(/another Google Ads account \(555\)/)
    expect(ok(`SELECT campaign.id FROM campaign WHERE campaign.resource_name = 'customers/${OWN}/campaigns/21'`).query).toContain(`customers/${OWN}/campaigns/21`)
    expect(ok(`SELECT customer.id FROM customer WHERE customer.id = ${OWN}`).from).toBe('customer')
  })

  it('accepts link fields that name a linked account; refuses another account\'s resources and its customer resource name', () => {
    expect(ok("SELECT conversion_action.id FROM conversion_action WHERE conversion_action.owner_customer = 'customers/999'").from).toBe('conversion_action')
    expect(ok("SELECT customer_manager_link.status FROM customer_manager_link WHERE customer_manager_link.manager_customer = 'customers/999'").from).toBe('customer_manager_link')
    expect(ok("SELECT product_link.product_link_id FROM product_link WHERE product_link.google_ads.customer = 'customers/999'").from).toBe('product_link')
    expect(refusal("SELECT ad_group.id FROM ad_group WHERE ad_group.campaign = 'customers/999/campaigns/21'")).toMatch(/another Google Ads account \(999\)/)
    expect(refusal("SELECT customer.id FROM customer WHERE customer.resource_name = 'customers/999'")).toMatch(/another Google Ads account \(999\)/)
    expect(refusal("SELECT customer.id FROM customer WHERE customer.resource_name IN ('customers/1234567890', 'customers/555')")).toMatch(/another Google Ads account \(555\)/)
    expect(ok("SELECT customer.id FROM customer WHERE customer.resource_name = 'customers/1234567890'").needs).toEqual({})
  })

  it('names what needs more than the tool\'s permissions: people\'s data, cost of goods, gross profit, revenue', () => {
    expect(ok("SELECT change_event.user_email FROM change_event WHERE change_event.change_date_time >= '2026-10-10' LIMIT 10").needs).toEqual({ people: ['change_event.user_email'] })
    expect(ok("SELECT change_event.client_type FROM change_event WHERE change_event.change_date_time >= '2026-10-10' LIMIT 10").needs).toEqual({})
    expect(ok('SELECT customer_user_access.email_address FROM customer_user_access').needs).toEqual({ people: ['customer_user_access.email_address'] })
    expect(ok('SELECT customer.id FROM customer_user_access_invitation').needs).toEqual({ people: ['customer_user_access_invitation'] })
    expect(ok('SELECT lead_form_submission_data.lead_form_submission_fields FROM lead_form_submission_data').needs.people).toEqual(['lead_form_submission_data.lead_form_submission_fields'])
    expect(ok('SELECT local_services_lead_conversation.message_details.text FROM local_services_lead_conversation').needs.people).toEqual(['local_services_lead_conversation.message_details.text'])
    expect(ok('SELECT local_services_lead.contact_details FROM local_services_lead').needs.people).toEqual(['local_services_lead.contact_details'])
    expect(ok("SELECT campaign.id, metrics.cost_of_goods_sold_micros, metrics.all_gross_profit_margin, metrics.gross_profit_micros, metrics.lead_revenue_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS").needs)
      .toEqual({ costs: ['metrics.cost_of_goods_sold_micros'], margins: ['metrics.all_gross_profit_margin', 'metrics.gross_profit_micros'], revenue: ['metrics.lead_revenue_micros'] })
    // A field name inside a quoted value is not a field.
    expect(ok("SELECT campaign.id FROM campaign WHERE campaign.name = 'metrics.revenue_micros change_event.user_email'").needs).toEqual({})
  })

  it('forces a LIMIT: adds one, lowers one above 1,000, keeps a smaller one, puts it before PARAMETERS', () => {
    expect(ok('SELECT campaign.id FROM campaign')).toMatchObject({ query: 'SELECT campaign.id FROM campaign LIMIT 200', limit: 200, notes: ['LIMIT 200 added.'] })
    expect(ok('SELECT campaign.id FROM campaign', 50).query).toBe('SELECT campaign.id FROM campaign LIMIT 50')
    expect(ok('SELECT campaign.id FROM campaign', 5000).limit).toBe(1000)
    expect(ok('SELECT campaign.id FROM campaign ORDER BY campaign.id LIMIT 5000')).toMatchObject({ query: 'SELECT campaign.id FROM campaign ORDER BY campaign.id LIMIT 1000', limit: 1000 })
    expect(ok('select campaign.id from campaign limit 20')).toMatchObject({ query: 'select campaign.id from campaign limit 20', limit: 20, notes: [] })
    expect(ok('SELECT campaign.id FROM campaign PARAMETERS include_drafts=true').query).toBe('SELECT campaign.id FROM campaign LIMIT 200 PARAMETERS include_drafts=true')
    // A LIMIT inside a quoted value is not the query's LIMIT.
    expect(ok("SELECT campaign.id FROM campaign WHERE campaign.name = 'LIMIT 5000'").query).toBe("SELECT campaign.id FROM campaign WHERE campaign.name = 'LIMIT 5000' LIMIT 200")
    expect(refusal('SELECT campaign.id FROM campaign LIMIT 0')).toMatch(/LIMIT is 1 or more/)
  })

  it('a selected date segment needs a finite date range (Google\'s rule); a filter alone is fine', () => {
    expect(refusal('SELECT campaign.id, segments.date, metrics.clicks FROM campaign')).toMatch(/finite range/)
    expect(refusal("SELECT campaign.id, segments.month, metrics.clicks FROM campaign WHERE segments.date >= '2026-10-01'")).toMatch(/finite range/)
    expect(ok("SELECT campaign.id, segments.date, metrics.clicks FROM campaign WHERE segments.date BETWEEN '2026-10-01' AND '2026-10-15'").limit).toBe(200)
    expect(ok('SELECT campaign.id, segments.date FROM campaign WHERE segments.date DURING LAST_7_DAYS').limit).toBe(200)
    expect(ok("SELECT campaign.id, segments.week FROM campaign WHERE segments.date >= '2026-10-01' AND segments.date <= '2026-10-15'").limit).toBe(200)
    expect(ok("SELECT campaign.id, metrics.clicks FROM campaign WHERE segments.date >= '2026-10-01'").limit).toBe(200)
  })
})
