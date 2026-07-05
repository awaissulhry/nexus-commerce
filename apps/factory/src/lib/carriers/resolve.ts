/**
 * FP8 — pick the carrier at call time. A connected Sendcloud account ⇒ the real
 * adapter; otherwise (and ALWAYS under FACTORY_FORCE_FAKE_CARRIER on the verify
 * build, so a test can never buy a real label) ⇒ the FakeCarrier. Returns the
 * account's probed caps too, so the pickup panel can gate on them.
 */
import { prisma } from "../db";
import { decryptSecret } from "../vault";
import type { CarrierAdapter, CarrierCaps } from "./types";
import { fakeCarrierAdapter } from "./fake";
import { sendcloudAdapter } from "./sendcloud-adapter";

export type ResolvedCarrier = {
  adapter: CarrierAdapter;
  live: boolean;
  account: { id: string; label: string; caps: CarrierCaps | null } | null;
};

export async function resolveCarrier(): Promise<ResolvedCarrier> {
  const fake: ResolvedCarrier = { adapter: fakeCarrierAdapter, live: false, account: null };
  if (process.env.FACTORY_FORCE_FAKE_CARRIER === "1") return fake;

  const account = await prisma.carrierAccount
    .findFirst({ where: { adapterId: "sendcloud", status: "connected" }, orderBy: { createdAt: "desc" } })
    .catch(() => null);
  if (!account) return fake;

  try {
    const creds = JSON.parse(decryptSecret(account.credentialsEncrypted)) as { publicKey: string; secretKey: string };
    return {
      adapter: sendcloudAdapter(creds.publicKey, creds.secretKey),
      live: true,
      account: { id: account.id, label: account.label, caps: (account.caps as CarrierCaps | null) ?? null },
    };
  } catch {
    return fake; // creds unreadable ⇒ degrade to fake rather than crash the queue
  }
}
