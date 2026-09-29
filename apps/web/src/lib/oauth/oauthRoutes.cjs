// MCP.5 — connecting Claude to Nexus: what the web app adds for the OAuth server in the API
// (apps/api/src/routes/oauth.routes.ts). CommonJS so next.config.js can require it and a Vitest test
// can import it.
//
// The web app is the issuer: Claude reads `<issuer>/.well-known/oauth-authorization-server`. The API
// builds that document; this is an external rewrite to it (a plain proxy, no function — see
// backendRewrite.cjs for why). Not gated on business profiles: while MCP is off the API answers 404,
// and so does this.
//
// The consent page (`/oauth/authorize`) carries an Approve button and Claude's whole request, so it
// may never be framed (clickjacking) or leak its query to another site through the referrer. (No
// Cache-Control here: Next.js replaces it on pages, and the page shell holds nothing private — the
// request lives in the address, and the API's answers are no-store.)

const { apiTarget } = require('../workspaces/backendRewrite.cjs')

function oauthRewrites(env) {
  return [{ source: '/.well-known/oauth-authorization-server', destination: `${apiTarget(env)}/api/oauth/metadata` }]
}

function oauthHeaders() {
  return [{
    source: '/oauth/:path*',
    headers: [
      { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
    ],
  }]
}

module.exports = { oauthRewrites, oauthHeaders }
