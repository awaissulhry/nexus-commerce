/** F1 — list Gmail labels for the FD3 scope picker. */
import { NextResponse } from "next/server";
import { guarded } from "@/lib/auth/guard";
import { FEATURES } from "@/lib/auth/permissions";
import { listGmailLabels } from "@/lib/google/gmail-sync";

export const permission = FEATURES.integrationsManage;

export const GET = guarded(FEATURES.integrationsManage, async () => {
  const labels = await listGmailLabels();
  if (!labels) return NextResponse.json({ error: "Google not connected" }, { status: 400 });
  return NextResponse.json({ labels });
});
