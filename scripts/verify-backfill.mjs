import dotenv from 'dotenv'
import pg from 'pg'
dotenv.config({ path: '/Users/awais/nexus-commerce/.env' })

const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

const o = await c.query(`
  SELECT channel, count(*) AS orders, count(DISTINCT marketplace) AS markets,
         min("purchaseDate")::date AS earliest, max("purchaseDate")::date AS latest,
         SUM("totalPrice")::numeric(14,2) AS gross
  FROM "Order" GROUP BY channel ORDER BY count(*) DESC
`)
console.log('--- Orders by channel ---')
console.table(o.rows)

const m = await c.query(`
  SELECT to_char("purchaseDate", 'YYYY-MM') AS month,
         count(*) AS orders,
         SUM("totalPrice")::numeric(12,2) AS revenue
  FROM "Order" WHERE channel='AMAZON'
  GROUP BY to_char("purchaseDate", 'YYYY-MM') ORDER BY month
`)
console.log('--- Amazon orders by month ---')
console.table(m.rows)

const t = await c.query(`
  SELECT
    (SELECT count(*) FROM "OrderItem") AS order_items,
    (SELECT count(*) FROM "Customer") AS customers,
    (SELECT count(*) FROM "FxRate") AS fx_rates,
    (SELECT count(*) FROM "FinancialTransaction") AS financial_tx,
    (SELECT count(*) FROM "SettlementReport") AS settlement_reports,
    (SELECT count(*) FROM "Product") AS products,
    (SELECT count(*) FROM "ChannelListing") AS listings,
    (SELECT count(*) FROM "ChannelConnection") AS channel_connections
`)
console.log('--- Other tables ---')
console.table(t.rows)

await c.end()
