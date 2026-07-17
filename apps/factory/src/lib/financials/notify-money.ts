/**
 * EPF1.7 (D-18 partial, cross-review M3) — the money-event bell contents,
 * pure. EPF owns money notifications; the calls land ONCE in the shared
 * payment/invoice routes via `notifyOwners`, deep-linking `/orders?o=<id>`.
 * Builders are pure so targets/links/wording are unit-pinned; the recipient
 * set (every active OWNER) is EPQ's shipped `notifyOwners` broadcast.
 */

const eur = (cents: number) => `€${(Math.abs(cents) / 100).toFixed(2)}`;

export type MoneyNotice = {
  title: string;
  body?: string;
  entityType: string;
  entityId: string;
  href: string;
  kind: "STATE_CHANGE";
};

export function paymentRecordedNotice(p: {
  orderId: string;
  orderNumber: string;
  paymentId: string;
  amountCents: number;
  kind: string;
  via?: "bank-import";
}): MoneyNotice {
  const refund = p.kind === "REFUND";
  return {
    title: refund
      ? `Refund ${eur(p.amountCents)} recorded on ${p.orderNumber}`
      : `Payment ${eur(p.amountCents)} recorded on ${p.orderNumber}`,
    body: `${refund ? "REFUND" : p.kind}${p.via === "bank-import" ? " · bank import" : ""}`,
    entityType: "payment",
    entityId: p.paymentId,
    href: `/orders?o=${p.orderId}`,
    kind: "STATE_CHANGE",
  };
}

export function invoicePaidNotice(i: {
  orderId: string;
  invoiceId: string;
  invoiceNumber: string;
  amountCents: number;
}): MoneyNotice {
  return {
    title: `Fattura ${i.invoiceNumber} marked paid — ${eur(i.amountCents)}`,
    entityType: "invoice",
    entityId: i.invoiceId,
    href: `/orders?o=${i.orderId}`,
    kind: "STATE_CHANGE",
  };
}
