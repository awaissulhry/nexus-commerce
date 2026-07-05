/**
 * FP1.1 — sender → party matching (pure; unit-tested). Exact PartyEmail
 * first, then domain rows (PartyEmail.matchDomain=true) compared by the
 * sender's domain — the B2B reality where orders@, sales@ and three humans
 * @brand.it are all one party.
 */

export type EmailRow = { email: string; partyId: string; matchDomain?: boolean };

export const domainOf = (email: string): string | null => {
  const at = email.lastIndexOf("@");
  return at > 0 ? email.slice(at + 1).toLowerCase() : null;
};

export function matchPartyId(fromEmail: string, rows: EmailRow[]): string | null {
  const from = fromEmail.trim().toLowerCase();
  const exact = rows.find((r) => r.email.toLowerCase() === from);
  if (exact) return exact.partyId;
  const fromDomain = domainOf(from);
  if (!fromDomain) return null;
  const domainRow = rows.find((r) => r.matchDomain && domainOf(r.email) === fromDomain);
  return domainRow?.partyId ?? null;
}
