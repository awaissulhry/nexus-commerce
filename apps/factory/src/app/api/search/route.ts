/**
 * F1 — global search skeleton (⌘K backend): LIKE over parties, quotes,
 * orders, materials, templates and conversations — plenty at factory scale;
 * FTS5 upgrades this in a later cycle. Results are filtered by the CALLER's
 * page permissions: a Worker searching "GALE" sees work-order-side hits only.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { guarded } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/rbac";
import { FEATURES, PAGES } from "@/lib/auth/permissions";

export const permission = FEATURES.searchRun;

type Hit = { label: string; sublabel?: string; href: string };
type Group = { label: string; items: Hit[] };

export const GET = guarded(FEATURES.searchRun, async (req: NextRequest, { resolved }) => {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json({ groups: [] });
  const like = { contains: q };
  const can = (p: string) => hasPermission(resolved!, p);
  const groups: Group[] = [];

  if (can(PAGES.contacts)) {
    const parties = await prisma.party.findMany({
      where: { name: like, archivedAt: null },
      take: 6,
      select: { id: true, name: true, kind: true },
    });
    if (parties.length)
      groups.push({
        label: "Contacts",
        items: parties.map((p) => ({ label: p.name, sublabel: p.kind, href: `/contacts?focus=${p.id}` })),
      });
  }
  if (can(PAGES.quotes)) {
    const quotes = await prisma.quote.findMany({
      where: { OR: [{ number: like }, { party: { name: like } }] },
      take: 6,
      select: { id: true, number: true, state: true, party: { select: { name: true } } },
    });
    if (quotes.length)
      groups.push({
        label: "Quotes",
        items: quotes.map((x) => ({ label: x.number, sublabel: `${x.party.name} · ${x.state}`, href: `/quotes?focus=${x.id}` })),
      });
  }
  if (can(PAGES.orders) || can(PAGES.production)) {
    const orders = await prisma.order.findMany({
      where: { OR: [{ number: like }, { party: { name: like } }] },
      take: 6,
      select: { id: true, number: true, state: true, party: { select: { name: true } } },
    });
    if (orders.length)
      groups.push({
        label: "Orders",
        items: orders.map((x) => ({
          label: x.number,
          sublabel: `${x.party.name} · ${x.state}`,
          href: can(PAGES.orders) ? `/orders?focus=${x.id}` : `/production?focus=${x.id}`,
        })),
      });
  }
  if (can(PAGES.materials)) {
    const materials = await prisma.material.findMany({
      where: { name: like, archivedAt: null },
      take: 6,
      select: { id: true, name: true, unit: true },
    });
    if (materials.length)
      groups.push({
        label: "Materials",
        items: materials.map((m) => ({ label: m.name, sublabel: m.unit, href: `/materials?focus=${m.id}` })),
      });
  }
  if (can(PAGES.products)) {
    const templates = await prisma.productTemplate.findMany({
      where: { name: like, archivedAt: null },
      take: 6,
      select: { id: true, name: true },
    });
    if (templates.length)
      groups.push({
        label: "Products",
        items: templates.map((t) => ({ label: t.name, href: `/products?focus=${t.id}` })),
      });
  }
  if (can(PAGES.inbox)) {
    const conversations = await prisma.conversation.findMany({
      where: { subject: like },
      take: 6,
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
  return NextResponse.json({ groups });
});
