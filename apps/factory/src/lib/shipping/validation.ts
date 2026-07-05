/**
 * FP8 — request shapes shared by the rates + buy routes: a destination address
 * and a parcel. Kept in one place so the two endpoints validate identically.
 */
import { z } from "zod";

export const AddressZ = z.object({
  name: z.string().min(1, "Recipient name required"),
  company: z.string().optional(),
  street: z.string().min(1, "Street required"),
  street2: z.string().optional(),
  city: z.string().min(1, "City required"),
  postalCode: z.string().min(1, "Postal code required"),
  country: z.string().length(2, "Country must be a 2-letter code"),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
});

export const ParcelZ = z.object({
  weightGrams: z.number().positive(),
  lengthCm: z.number().positive(),
  widthCm: z.number().positive(),
  heightCm: z.number().positive(),
});

export type AddressInput = z.infer<typeof AddressZ>;
export type ParcelInput = z.infer<typeof ParcelZ>;
