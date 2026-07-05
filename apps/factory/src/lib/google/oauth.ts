/**
 * F1 — Google OAuth for a LOCAL app (FD10 posture): Desktop client + loopback
 * redirect + PKCE. The consent screen must be External + PUBLISHED TO
 * PRODUCTION (unverified is fine <100 users); Testing mode expires refresh
 * tokens every 7 days — the wizard warns about exactly that. Scopes are
 * minimal: gmail.modify (read+send+labels — one restricted scope) +
 * drive.file (app-created files only). The refresh token is Vault-encrypted;
 * client id/secret live in AppSetting (a Desktop client's secret is
 * explicitly non-secret per Google, but we encrypt it anyway).
 */
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { prisma } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/vault";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/drive.file",
];

const CLIENT_KEY = "google.oauthClient";
const PKCE_KEY = "google.pkcePending";

export async function saveOauthClientConfig(clientId: string, clientSecret: string): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: CLIENT_KEY },
    create: { key: CLIENT_KEY, value: { clientId, clientSecretEncrypted: encryptSecret(clientSecret) } },
    update: { value: { clientId, clientSecretEncrypted: encryptSecret(clientSecret) } },
  });
}

export async function getOauthClientConfig(): Promise<{ clientId: string; clientSecret: string } | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: CLIENT_KEY } });
  if (!row) return null;
  const value = row.value as { clientId?: string; clientSecretEncrypted?: string };
  if (!value.clientId || !value.clientSecretEncrypted) return null;
  return { clientId: value.clientId, clientSecret: decryptSecret(value.clientSecretEncrypted) };
}

export async function buildAuthUrl(redirectUri: string): Promise<string | null> {
  const config = await getOauthClientConfig();
  if (!config) return null;
  const client = new google.auth.OAuth2(config.clientId, config.clientSecret, redirectUri);
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const state = Math.random().toString(36).slice(2);
  await prisma.appSetting.upsert({
    where: { key: PKCE_KEY },
    create: { key: PKCE_KEY, value: { codeVerifier, state, redirectUri } },
    update: { value: { codeVerifier, state, redirectUri } },
  });
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // force a refresh token even on re-consent
    scope: GOOGLE_SCOPES,
    code_challenge_method: "S256" as never,
    code_challenge: codeChallenge,
    state,
  });
}

export async function handleCallback(code: string, state: string): Promise<{ email: string }> {
  const config = await getOauthClientConfig();
  const pending = await prisma.appSetting.findUnique({ where: { key: PKCE_KEY } });
  const pkce = pending?.value as { codeVerifier?: string; state?: string; redirectUri?: string } | undefined;
  if (!config || !pkce?.codeVerifier || !pkce.redirectUri) throw new Error("OAuth flow not initialized");
  if (pkce.state !== state) throw new Error("OAuth state mismatch");

  const client = new google.auth.OAuth2(config.clientId, config.clientSecret, pkce.redirectUri);
  const { tokens } = await client.getToken({ code, codeVerifier: pkce.codeVerifier });
  if (!tokens.refresh_token) throw new Error("Google returned no refresh token — remove the app's prior grant at myaccount.google.com/permissions and connect again");
  client.setCredentials(tokens);

  const gmail = google.gmail({ version: "v1", auth: client });
  const profile = await gmail.users.getProfile({ userId: "me" });
  const email = profile.data.emailAddress!;

  await prisma.googleConnection.upsert({
    where: { email },
    create: {
      email,
      scopes: GOOGLE_SCOPES,
      refreshTokenEncrypted: encryptSecret(tokens.refresh_token),
      historyId: profile.data.historyId ? String(profile.data.historyId) : null,
      status: "connected",
    },
    update: {
      scopes: GOOGLE_SCOPES,
      refreshTokenEncrypted: encryptSecret(tokens.refresh_token),
      historyId: profile.data.historyId ? String(profile.data.historyId) : null,
      status: "connected",
      lastError: null,
    },
  });
  await prisma.appSetting.delete({ where: { key: PKCE_KEY } }).catch(() => {});
  return { email };
}

/** Authenticated client from the stored refresh token (worker + routes). */
export async function getAuthedClient(): Promise<{ client: OAuth2Client; email: string } | null> {
  const config = await getOauthClientConfig();
  const connection = await prisma.googleConnection.findFirst({ where: { status: "connected" } });
  if (!config || !connection) return null;
  const client = new google.auth.OAuth2(config.clientId, config.clientSecret);
  client.setCredentials({ refresh_token: decryptSecret(connection.refreshTokenEncrypted) });
  return { client, email: connection.email };
}
