/**
 * FP8.2 — advisory rates for a parcel + destination. The buy panel calls this
 * after the operator picks a preset; the client pre-selects the cheapest. Cost
 * is grain-stripped (only a financial caller sees the numbers). No side effects.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { resolveCarrier } from "@/lib/carriers/resolve";
import { AddressZ, ParcelZ } from "@/lib/shipping/validation";
import { cheapestRate } from "@/lib/shipping/shipment-state";

export const permission = FEATURES.labelsPurchase;

const Body = z.object({ orderId: z.string().min(1), to: AddressZ, parcel: ParcelZ });

export const POST = guarded(FEATURES.labelsPurchase, async (req, { resolved }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });

  const order = await prisma.order.findUnique({ where: { id: parsed.data.orderId }, select: { number: true, party: { select: { currency: true } } } });
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  const carrier = await resolveCarrier();
  try {
    const rates = await carrier.adapter.getRates({
      shipmentId: "rate-preview",
      orderNumber: order.number,
      to: parsed.data.to,
      parcel: parsed.data.parcel,
      currency: order.party.currency ?? "EUR",
    });
    return jsonStripped({ rates, cheapestCode: cheapestRate(rates)?.code ?? null, live: carrier.live }, resolved);
  } catch (err) {
    return NextResponse.json({ error: `Could not fetch rates: ${(err as Error).message}` }, { status: 502 });
  }
});
