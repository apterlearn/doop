import { describe, expect, it } from 'vitest'
import { parseAuthCode } from '../server/modelAccounts.ts'

/**
 * Connecting a model account can end with a dead page instead of a redirect,
 * so the browser flow lets the user paste the whole failed-redirect URL back.
 * These pin what that paste accepts and how it reports a refusal.
 */

describe('ChatGPT redirect parsing', () => {
  it('accepts the whole pasted redirect URL', () => {
    expect(parseAuthCode('http://localhost:1455/auth/callback?code=abc123&state=xyz')).toEqual({
      code: 'abc123',
      state: 'xyz',
    })
  })

  it('accepts a bare code', () => {
    expect(parseAuthCode('  abc123 ')).toEqual({ code: 'abc123' })
  })

  it('reports [OI] refusing the connection', () => {
    expect(() =>
      parseAuthCode('http://localhost:1455/auth/callback?error=access_denied&error_description=User+said+no'),
    ).toThrow(/User said no/)
  })

  it('rejects a redirect URL with no code', () => {
    expect(() => parseAuthCode('http://localhost:1455/auth/callback')).toThrow(/no \?code=/)
  })
})
