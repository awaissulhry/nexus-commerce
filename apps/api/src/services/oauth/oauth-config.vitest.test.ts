/**
 * MCP.5 — the fixed rules of the OAuth server: which redirects match, which may be registered,
 * what the metadata promises, and that it is off unless switched on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  authorizationServerMetadata,
  mcpEnabled,
  mcpResource,
  parseScopes,
  redirectMatches,
  redirectUriAllowed,
} from './oauth-config.js'

afterEach(() => vi.unstubAllEnvs())

describe('MCP.5 — redirects', () => {
  it('match exactly, except loopback, which matches on any port', () => {
    expect(redirectMatches('https://claude.ai/api/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback')).toBe(true)
    expect(redirectMatches('https://claude.ai/api/mcp/auth_callback', 'https://claude.ai:8443/api/mcp/auth_callback')).toBe(false)
    expect(redirectMatches('http://localhost/callback', 'http://localhost:53682/callback')).toBe(true)
    expect(redirectMatches('http://127.0.0.1/callback', 'http://127.0.0.1:1/callback')).toBe(true)
  })

  it('loopback does not stretch to another host, path, query or scheme', () => {
    expect(redirectMatches('http://localhost/callback', 'http://127.0.0.1:5000/callback')).toBe(false)
    expect(redirectMatches('http://localhost/callback', 'http://localhost:5000/other')).toBe(false)
    expect(redirectMatches('http://localhost/callback', 'http://localhost:5000/callback?x=1')).toBe(false)
    expect(redirectMatches('http://localhost/callback', 'https://localhost:5000/callback')).toBe(false)
    expect(redirectMatches('http://localhost/callback', 'http://user@localhost:5000/callback')).toBe(false)
  })

  it('only Claude’s callbacks, and ones the Owner adds, may be registered', () => {
    expect(redirectUriAllowed('https://claude.ai/api/mcp/auth_callback')).toBe(true)
    expect(redirectUriAllowed('http://localhost:7777/callback')).toBe(true)
    expect(redirectUriAllowed('https://evil.example/callback')).toBe(false)
    vi.stubEnv('NEXUS_OAUTH_REDIRECT_URIS', 'https://inspector.example.test/cb')
    expect(redirectUriAllowed('https://inspector.example.test/cb')).toBe(true)
  })
})

describe('MCP.5 — metadata and switches', () => {
  it('is off unless NEXUS_MCP_ENABLED=1', () => {
    expect(mcpEnabled()).toBe(false)
    vi.stubEnv('NEXUS_MCP_ENABLED', '1')
    expect(mcpEnabled()).toBe(true)
  })

  it('advertises exactly what Claude needs: PKCE S256, public clients, CIMD and iss', () => {
    vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test/')
    vi.stubEnv('NEXUS_OAUTH_API_ORIGIN', 'https://api.example.test')
    expect(authorizationServerMetadata()).toMatchObject({
      issuer: 'https://web.example.test',
      authorization_endpoint: 'https://web.example.test/oauth/authorize',
      token_endpoint: 'https://api.example.test/api/oauth/token',
      registration_endpoint: 'https://api.example.test/api/oauth/register',
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      scopes_supported: ['nexus.read', 'nexus.write'],
    })
    expect(mcpResource()).toBe('https://api.example.test/mcp')
  })

  it('refuses an issuer that is not https', () => {
    vi.stubEnv('NEXUS_OAUTH_ISSUER', 'http://web.example.test')
    expect(() => authorizationServerMetadata()).toThrow('https')
  })

  it('scopes: known ones only; none asked = all', () => {
    expect(parseScopes(undefined)).toEqual(['nexus.read', 'nexus.write'])
    expect(parseScopes('nexus.read offline_access')).toEqual(['nexus.read'])
    expect(parseScopes('admin')).toEqual([])
  })
})
