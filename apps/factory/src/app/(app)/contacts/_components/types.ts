/** FP5 — shared shapes for the contacts workspace (commercial fields optional: grain-stripped for callers without financials.*). */
export type PartyKind = "BRAND" | "CUSTOMER" | "SUPPLIER";

export type ContactRow = {
  id: string;
  name: string;
  kind: PartyKind;
  currency: string;
  paymentTerms?: string | null;
  depositDefaultPct?: number | null;
  emailCount: number;
  primaryEmail: string | null;
  priceList: { id: string; name: string } | null;
  quoteCount: number;
  orderCount: number;
  measurementCount: number;
  archivedAt: string | null;
  updatedAt: string;
};

export type ContactsResponse = { contacts: ContactRow[]; counts: Partial<Record<PartyKind, number>> };

export type PartyEmail = { id: string; email: string; label: string | null; matchDomain: boolean };

export type MeasurementProfile = {
  id: string;
  name: string;
  garmentType: string;
  fields: Record<string, unknown> | null;
  fitNotes: string | null;
  photos: unknown;
  version: number;
  supersedesId: string | null;
  createdAt: string;
};

export type ContactDetailResponse = {
  contact: {
    id: string;
    name: string;
    kind: PartyKind;
    currency: string;
    paymentTerms?: string | null;
    depositDefaultPct?: number | null;
    notes: string | null;
    priceListId: string | null;
    priceList: { id: string; name: string } | null;
    emails: PartyEmail[];
    measurements: MeasurementProfile[];
    createdAt: string;
    updatedAt: string;
    archivedAt: string | null;
  };
  counts: { quotes: number; orders: number; conversations: number; reviews: number };
  history?: ContactHistoryData;
};

export type ContactHistoryData = {
  conversations: { id: string; subject: string | null; state: string; updatedAt: string }[];
  quotes: { id: string; number: string; state: string; netCents?: number; updatedAt: string }[];
  orders: { id: string; number: string; state: string; netCents?: number; promiseDateAt: string | null }[];
  reviews: { id: string; rating: number; notes: string | null; orderId: string | null; createdAt: string }[];
};

export const KIND_LABEL: Record<PartyKind, string> = { CUSTOMER: "Customer", SUPPLIER: "Supplier", BRAND: "Brand" };
export const KIND_TONE: Record<PartyKind, "info" | "warning" | "neutral"> = { CUSTOMER: "info", SUPPLIER: "warning", BRAND: "neutral" };
