/**
 * F1 — global search (⌘K backend), FS5 — rewired from LIKE scans to the FTS5
 * substrate (S-13): parties match by name OR email, quotes/orders by number
 * OR customer name, conversations by subject OR message text (subject hits
 * ranked first). Response shape, group order, hrefs and the take-6-per-group
 * contract are unchanged — the CommandPalette client needs no edit. Results
 * are filtered by the CALLER's page permissions: a Worker searching "GALE"
 * sees work-order-side hits only.
 *
 * Materials and product templates stay on bounded Prisma `contains` — small
 * catalog tables, out of the FTS substrate's scope.
 *
 * Fallback: until the `fs5_fts` migration is applied (authored, not applied —
 * playbook 6b), `ftsAvailable()` is false and the pre-FS5 LIKE path below
 * answers, so ⌘K keeps working across the merge window; an FTS error also
 * degrades to LIKE instead of a 500.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/rbac";
import { FEATURES, PAGES } from "@/lib/auth/permissions";
import {
  ftsAvailable,
  searchConversationIds,
  searchMessageConversationIds,
  searchOrderIds,
  searchPartyIds,
  searchQuoteIds,
  sortByIdOrder,
} from "@/lib/search-fts";

export const permission = FEATURES.searchRun;

type Hit = { label: string; sublabel?: string; href: string };
type Group = { label: string; items: Hit[] };
type Can = (p: string) => boolean;

const TAKE = 6;

export const GET = guarded(FEATURES.searchRun, async (req: NextRequest, { resolved }) => {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json({ groups: [] });
  const can: Can = (p) => hasPermission(resolved!, p);

  if (await ftsAvailable()) {
    try {
      return NextResponse.json({ groups: await ftsGroups(q, can) });
    } catch (err) {
      console.error("[search] FTS path failed — serving the LIKE fallback:", (err as Error).message);
    }
  }
  return NextResponse.json({ groups: await likeGroups(q, can) });
});

/** FS5 — the FTS-backed path: id lookups first, Prisma hydration second. */
async function ftsGroups(q: string, can: Can): Promise<Group[]> {
  const groups: Group[] = [];
  // One party lookup feeds the Contacts group AND the customer-name reach of
  // quotes/orders (the LIKE path's `party: { name: contains }` semantics).
  const partyIds = await searchPartyIds(q, 12);

  if (can(PAGES.contacts) && partyIds.length) {
    const parties = await prisma.party.findMany({
      where: { id: { in: partyIds }, archivedAt: null },
      take: TAKE,
      select: { id: true, name: true, kind: true },
    });
    if (parties.length)
      groups.push({
        label: "Contacts",
        // EPO.3 (C5) — pages read their OWN param (?c=/?q=/?o=), not ?focus=
        items: sortByIdOrder(parties, partyIds).map((p) => ({ label: p.name, sublabel: p.kind, href: `/contacts?c=${p.id}` })),
      });
  }
  if (can(PAGES.quotes)) {
    const quoteIds = await searchQuoteIds(q, TAKE);
    if (quoteIds.length || partyIds.length) {
      const quotes = await prisma.quote.findMany({
        where: { OR: [{ id: { in: quoteIds } }, { partyId: { in: partyIds } }] },
        take: TAKE,
        select: { id: true, number: true, state: true, party: { select: { name: true } } },
      });
      if (quotes.length)
        groups.push({
          label: "Quotes",
          items: sortByIdOrder(quotes, quoteIds).map((x) => ({ label: x.number, sublabel: `${x.party.name} · ${x.state}`, href: `/quotes?q=${x.id}` })),
        });
    }
  }
  if (can(PAGES.orders) || can(PAGES.production)) {
    const orderIds = await searchOrderIds(q, TAKE);
    if (orderIds.length || partyIds.length) {
      const orders = await prisma.order.findMany({
        where: { OR: [{ id: { in: orderIds } }, { partyId: { in: partyIds } }] },
        take: TAKE,
        select: { id: true, number: true, state: true, party: { select: { name: true } } },
      });
      if (orders.length)
        groups.push({
          label: "Orders",
          items: sortByIdOrder(orders, orderIds).map((x) => ({
            label: x.number,
            sublabel: `${x.party.name} · ${x.state}`,
            // Workers land on the production board page-level (no per-order drill there)
            href: can(PAGES.orders) ? `/orders?o=${x.id}` : "/production",
          })),
        });
    }
  }
  if (can(PAGES.materials)) {
    const materials = await prisma.material.findMany({
      where: { name: { contains: q }, archivedAt: null },
      take: TAKE,
      select: { id: true, name: true, unit: true },
    });
    if (materials.length)
      groups.push({
        label: "Materials",
        items: materials.map((m) => ({ label: m.name, sublabel: m.unit, href: "/materials" })), // no entity reader yet (EPM)
      });
  }
  if (can(PAGES.products)) {
    const templates = await prisma.productTemplate.findMany({
      where: { name: { contains: q }, archivedAt: null },
      take: TAKE,
      select: { id: true, name: true },
    });
    if (templates.length)
      groups.push({
        label: "Products",
        items: templates.map((t) => ({ label: t.name, href: "/products" })), // honors ?tab= only; entity reader = EPD
      });
  }
  if (can(PAGES.inbox)) {
    // Subject hits lead; message-text hits (the substrate's new reach) fill
    // the remaining slots — same group, same shape, take 6 total.
    const subjectIds = await searchConversationIds(q, TAKE);
    const bodyIds = subjectIds.length >= TAKE ? [] : await searchMessageConversationIds(q, TAKE);
    const convIds = [...new Set([...subjectIds, ...bodyIds])].slice(0, TAKE);
    if (convIds.length) {
      const conversations = await prisma.conversation.findMany({
        where: { id: { in: convIds } },
        take: TAKE,
        select: { id: true, subject: true, party: { select: { name: true } } },
      });
      groups.push({
        label: "Conversations",
        items: sortByIdOrder(conversations, convIds).map((c) => ({
          label: c.subject ?? "(no subject)",
          sublabel: c.party?.name,
          href: `/inbox?focus=${c.id}`,
        })),
      });
    }
  }
  return groups;
}

/** The pre-FS5 LIKE path, kept verbatim as the pre-migration fallback. */
async function likeGroups(q: string, can: Can): Promise<Group[]> {
  const like = { contains: q };
  const groups: Group[] = [];

  if (can(PAGES.contacts)) {
    const parties = await prisma.party.findMany({
      where: { name: like, archivedAt: null },
      take: TAKE,
      select: { id: true, name: true, kind: true },
    });
    if (parties.length)
      groups.push({
        label: "Contacts",
        items: parties.map((p) => ({ label: p.name, sublabel: p.kind, href: `/contacts?c=${p.id}` })),
      });
  }
  if (can(PAGES.quotes)) {
    const quotes = await prisma.quote.findMany({
      where: { OR: [{ number: like }, { party: { name: like } }] },
      take: TAKE,
      select: { id: true, number: true, state: true, party: { select: { name: true } } },
    });
    if (quotes.length)
      groups.push({
        label: "Quotes",
        items: quotes.map((x) => ({ label: x.number, sublabel: `${x.party.name} · ${x.state}`, href: `/quotes?q=${x.id}` })),
      });
  }
  if (can(PAGES.orders) || can(PAGES.production)) {
    const orders = await prisma.order.findMany({
      where: { OR: [{ number: like }, { party: { name: like } }] },
      take: TAKE,
      select: { id: true, number: true, state: true, party: { select: { name: true } } },
    });
    if (orders.length)
      groups.push({
        label: "Orders",
        items: orders.map((x) => ({
          label: x.number,
          sublabel: `${x.party.name} · ${x.state}`,
          href: can(PAGES.orders) ? `/orders?o=${x.id}` : "/production",
        })),
      });
  }
  if (can(PAGES.materials)) {
    const materials = await prisma.material.findMany({
      where: { name: like, archivedAt: null },
      take: TAKE,
      select: { id: true, name: true, unit: true },
    });
    if (materials.length)
      groups.push({
        label: "Materials",
        items: materials.map((m) => ({ label: m.name, sublabel: m.unit, href: "/materials" })),
      });
  }
  if (can(PAGES.products)) {
    const templates = await prisma.productTemplate.findMany({
      where: { name: like, archivedAt: null },
      take: TAKE,
      select: { id: true, name: true },
    });
    if (templates.length)
      groups.push({
        label: "Products",
        items: templates.map((t) => ({ label: t.name, href: "/products" })),
      });
  }
  if (can(PAGES.inbox)) {
    const conversations = await prisma.conversation.findMany({
      where: { subject: like },
      take: TAKE,
      select: { id: true, subject: true, party: { select: { name: true } } },
    });
    if (conversations.length)
      groups.push({
        label: "Conversations",
        items: conversations.map((c) => ({
          label: c.subject ?? "(no subject)",
          sublabel: c.party?.name,
          href: `/inbox?focus=${c.id}`,
        })),
      });
  }
  return groups;
}
