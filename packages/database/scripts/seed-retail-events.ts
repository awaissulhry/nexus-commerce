/**
 * F.4 — Starter retail-event calendar seed.
 *
 * Hand-curated set of Amazon Prime Day, Black Friday, Cyber Monday, and
 * EU regional sales periods. Sellers add to this via the admin UI as
 * they hear about category-specific events (EICMA, fashion week, etc.).
 *
 * Idempotent: upserts on (name, startDate). Re-run after schedule
 * announcements drop to update dates.
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const EVENTS = [
  // Amazon-wide
  {
    name: 'Amazon Prime Day 2026',
    startDate: '2026-07-15',
    endDate: '2026-07-16',
    channel: 'AMAZON',
    expectedLift: 3.0,
    prepLeadTimeDays: 30,
    description: 'Annual 48h Prime member sale; demand spikes 3-5x typical.',
    source: 'AMAZON_OFFICIAL',
  },
  // Black Friday + Cyber Monday — global retail spike
  {
    name: 'Black Friday 2026',
    startDate: '2026-11-27',
    endDate: '2026-11-27',
    channel: null,
    expectedLift: 4.0,
    prepLeadTimeDays: 45,
    description: 'Strongest single shopping day of the year for most categories.',
  },
  {
    name: 'Cyber Monday 2026',
    startDate: '2026-11-30',
    endDate: '2026-11-30',
    channel: null,
    expectedLift: 2.5,
    prepLeadTimeDays: 45,
    description: 'Online-focused retail spike, complements Black Friday.',
  },
  // Italian saldi (sales) — winter + summer regional events
  {
    name: 'Saldi Invernali 2027',
    startDate: '2027-01-05',
    endDate: '2027-02-28',
    marketplace: 'IT',
    expectedLift: 1.4,
    prepLeadTimeDays: 30,
    description: 'Winter sales period in Italy. Modest lift across categories.',
  },
  {
    name: 'Saldi Estivi 2026',
    startDate: '2026-07-04',
    endDate: '2026-08-31',
    marketplace: 'IT',
    expectedLift: 1.3,
    prepLeadTimeDays: 30,
    description: 'Summer sales period in Italy.',
  },
  // German equivalents
  {
    name: 'Sommerschlussverkauf 2026',
    startDate: '2026-07-25',
    endDate: '2026-08-08',
    marketplace: 'DE',
    expectedLift: 1.3,
    prepLeadTimeDays: 30,
  },
  {
    name: 'Winterschlussverkauf 2027',
    startDate: '2027-01-26',
    endDate: '2027-02-07',
    marketplace: 'DE',
    expectedLift: 1.3,
    prepLeadTimeDays: 30,
  },
  // Motorcycle-industry specific (Xavia category)
  {
    name: 'EICMA 2026',
    startDate: '2026-11-04',
    endDate: '2026-11-08',
    marketplace: 'IT',
    productType: 'OUTERWEAR',
    expectedLift: 1.3,
    prepLeadTimeDays: 30,
    description: 'Milan motorcycle expo — drives apparel + gear demand IT-wide.',
  },
] as const

async function main() {
  let inserted = 0
  let updated = 0
  for (const e of EVENTS) {
    // No unique key on RetailEvent (hand-curated table); use upsert via
    // findFirst + create/update for idempotency.
    const existing = await prisma.retailEvent.findFirst({
      where: { name: e.name, startDate: new Date(e.startDate) },
    })
    if (existing) {
      await prisma.retailEvent.update({
        where: { id: existing.id },
        data: {
          endDate: new Date(e.endDate),
          channel: (e as any).channel ?? null,
          marketplace: (e as any).marketplace ?? null,
          productType: (e as any).productType ?? null,
          expectedLift: e.expectedLift,
          prepLeadTimeDays: e.prepLeadTimeDays,
          description: (e as any).description ?? null,
          source: (e as any).source ?? null,
          isActive: true,
        },
      })
      updated++
    } else {
      await prisma.retailEvent.create({
        data: {
          name: e.name,
          startDate: new Date(e.startDate),
          endDate: new Date(e.endDate),
          channel: (e as any).channel ?? null,
          marketplace: (e as any).marketplace ?? null,
          productType: (e as any).productType ?? null,
          expectedLift: e.expectedLift,
          prepLeadTimeDays: e.prepLeadTimeDays,
          description: (e as any).description ?? null,
          source: (e as any).source ?? null,
        },
      })
      inserted++
    }
  }
  console.log(`Seeded RetailEvent: ${inserted} new, ${updated} updated`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
