import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Tarpit } from '../../tarpit.js';

describe('Tarpit', () => {
  let originalConsoleWarn;

  beforeEach(() => {
    originalConsoleWarn = console.warn;
    console.warn = jest.fn();
  });

  afterEach(() => {
    console.warn = originalConsoleWarn;
  });

  describe('constructor', () => {
    it('should use provided secret', () => {
      const tarpit = new Tarpit({ tarpitSecret: 'my-secret' });
      expect(tarpit.secret).toBe('my-secret');
      expect(tarpit.isEphemeral).toBe(false);
    });

    it('should generate ephemeral secret and warn when not provided', () => {
      const tarpit = new Tarpit({});
      expect(tarpit.secret).toHaveLength(64);
      expect(tarpit.isEphemeral).toBe(true);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('TARPIT_SECRET not configured')
      );
    });

    it('should use default delay of 3 seconds', () => {
      const tarpit = new Tarpit({ tarpitSecret: 'secret' });
      expect(tarpit.delaySeconds).toBe(3);
    });

    it('should accept custom delay', () => {
      const tarpit = new Tarpit({ tarpitSecret: 'secret', tarpitDelaySeconds: 5 });
      expect(tarpit.delaySeconds).toBe(5);
    });

    it('should accept delay of 0', () => {
      const tarpit = new Tarpit({ tarpitSecret: 'secret', tarpitDelaySeconds: 0 });
      expect(tarpit.delaySeconds).toBe(0);
    });

    it('should use default cookie name', () => {
      const tarpit = new Tarpit({ tarpitSecret: 'secret' });
      expect(tarpit.cookieName).toBe('scale0_tarpit');
    });

    it('should accept custom cookie name', () => {
      const tarpit = new Tarpit({ tarpitSecret: 'secret', tarpitCookieName: 'custom_cookie' });
      expect(tarpit.cookieName).toBe('custom_cookie');
    });
  });

  describe('parseCookies', () => {
    let tarpit;

    beforeEach(() => {
      tarpit = new Tarpit({ tarpitSecret: 'secret' });
    });

    it('should parse simple cookies', () => {
      const result = tarpit.parseCookies('foo=bar; baz=qux');
      expect(result).toEqual({ foo: 'bar', baz: 'qux' });
    });

    it('should handle empty cookie header', () => {
      expect(tarpit.parseCookies('')).toEqual({});
      expect(tarpit.parseCookies(null)).toEqual({});
      expect(tarpit.parseCookies(undefined)).toEqual({});
    });

    it('should handle cookies with = in value', () => {
      const result = tarpit.parseCookies('token=abc=def=ghi');
      expect(result).toEqual({ token: 'abc=def=ghi' });
    });

    it('should trim whitespace', () => {
      const result = tarpit.parseCookies('  foo = bar ;  baz = qux  ');
      expect(result).toEqual({ foo: ' bar', baz: ' qux  ' });
    });

    it('should handle cookies without values', () => {
      const result = tarpit.parseCookies('foo=; bar=baz');
      expect(result).toEqual({ foo: '', bar: 'baz' });
    });
  });

  describe('generate', () => {
    let tarpit;

    beforeEach(() => {
      tarpit = new Tarpit({ tarpitSecret: 'test-secret', tarpitDelaySeconds: 3 });
    });

    it('should generate base64-encoded token', () => {
      const token = tarpit.generate();
      expect(typeof token).toBe('string');
      expect(() => Buffer.from(token, 'base64')).not.toThrow();
    });

    it('should include expiration time', () => {
      const before = Date.now();
      const token = tarpit.generate();
      const after = Date.now();

      const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
      expect(decoded.tarpit.exp).toBeGreaterThanOrEqual(before + 3000);
      expect(decoded.tarpit.exp).toBeLessThanOrEqual(after + 3000);
    });

    it('should include nonce', () => {
      const token = tarpit.generate();
      const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
      expect(decoded.tarpit.nonce).toHaveLength(16);
    });

    it('should include signature', () => {
      const token = tarpit.generate();
      const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
      expect(decoded.sig).toHaveLength(64);
    });

    it('should generate unique tokens', () => {
      const token1 = tarpit.generate();
      const token2 = tarpit.generate();
      expect(token1).not.toBe(token2);
    });
  });

  describe('verify', () => {
    let tarpit;

    beforeEach(() => {
      tarpit = new Tarpit({ tarpitSecret: 'test-secret', tarpitDelaySeconds: 3 });
    });

    it('should reject missing token', () => {
      expect(tarpit.verify(null)).toEqual({ valid: false, reason: 'missing' });
      expect(tarpit.verify(undefined)).toEqual({ valid: false, reason: 'missing' });
      expect(tarpit.verify('')).toEqual({ valid: false, reason: 'missing' });
    });

    it('should reject malformed token', () => {
      const result = tarpit.verify('not-valid-base64!!!');
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('parse');
    });

    it('should reject token without tarpit field', () => {
      const token = Buffer.from(JSON.stringify({ sig: 'abc' })).toString('base64');
      expect(tarpit.verify(token)).toEqual({ valid: false, reason: 'malformed' });
    });

    it('should reject token without signature', () => {
      const token = Buffer.from(JSON.stringify({ tarpit: { exp: Date.now() } })).toString('base64');
      expect(tarpit.verify(token)).toEqual({ valid: false, reason: 'malformed' });
    });

    it('should reject token with wrong signature', () => {
      const token = tarpit.generate();
      const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
      decoded.sig = 'a'.repeat(64);
      const tampered = Buffer.from(JSON.stringify(decoded)).toString('base64');
      expect(tarpit.verify(tampered)).toEqual({ valid: false, reason: 'signature' });
    });

    it('should reject token with modified payload', () => {
      const token = tarpit.generate();
      const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
      decoded.tarpit.exp = Date.now() - 10000;
      const tampered = Buffer.from(JSON.stringify(decoded)).toString('base64');
      expect(tarpit.verify(tampered)).toEqual({ valid: false, reason: 'signature' });
    });

    it('should reject early request', () => {
      const token = tarpit.generate();
      const result = tarpit.verify(token);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('early');
      expect(result.remainingMs).toBeGreaterThan(0);
      expect(result.remainingMs).toBeLessThanOrEqual(3000);
    });

    it('should accept valid token after delay', async () => {
      const shortTarpit = new Tarpit({ tarpitSecret: 'secret', tarpitDelaySeconds: 0.1 });
      const token = shortTarpit.generate();

      await new Promise(resolve => setTimeout(resolve, 150));

      const result = shortTarpit.verify(token);
      expect(result).toEqual({ valid: true });
    });

    it('should use timing-safe comparison', () => {
      const token = tarpit.generate();
      const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
      decoded.sig = decoded.sig.slice(0, -1) + (decoded.sig.slice(-1) === 'a' ? 'b' : 'a');
      const almostRight = Buffer.from(JSON.stringify(decoded)).toString('base64');
      expect(tarpit.verify(almostRight)).toEqual({ valid: false, reason: 'signature' });
    });
  });

  describe('getCookieValue', () => {
    let tarpit;

    beforeEach(() => {
      tarpit = new Tarpit({ tarpitSecret: 'secret', tarpitCookieName: 'my_cookie' });
    });

    it('should extract cookie from lowercase header', () => {
      const req = { headers: { cookie: 'my_cookie=value123; other=stuff' } };
      expect(tarpit.getCookieValue(req)).toBe('value123');
    });

    it('should extract cookie from capitalized header', () => {
      const req = { headers: { Cookie: 'my_cookie=value123' } };
      expect(tarpit.getCookieValue(req)).toBe('value123');
    });

    it('should return undefined for missing cookie', () => {
      const req = { headers: { cookie: 'other=value' } };
      expect(tarpit.getCookieValue(req)).toBeUndefined();
    });

    it('should return undefined for no cookie header', () => {
      const req = { headers: {} };
      expect(tarpit.getCookieValue(req)).toBeUndefined();
    });
  });

  describe('setCookieHeader', () => {
    let tarpit;

    beforeEach(() => {
      tarpit = new Tarpit({ tarpitSecret: 'secret', tarpitCookieName: 'my_cookie' });
    });

    it('should return properly formatted Set-Cookie header', () => {
      const header = tarpit.setCookieHeader('token123');
      expect(header).toBe('my_cookie=token123; Path=/; SameSite=None; HttpOnly; Secure; Max-Age=300');
    });

    it('should include security flags', () => {
      const header = tarpit.setCookieHeader('value');
      expect(header).toContain('HttpOnly');
      expect(header).toContain('Secure');
      expect(header).toContain('SameSite=None');
    });
  });

  describe('integration: generate and verify flow', () => {
    it('should complete full flow with immediate verification rejection', () => {
      const tarpit = new Tarpit({ tarpitSecret: 'integration-secret', tarpitDelaySeconds: 5 });
      const token = tarpit.generate();
      const result = tarpit.verify(token);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('early');
    });

    it('should complete full flow with successful verification after delay', async () => {
      const tarpit = new Tarpit({ tarpitSecret: 'integration-secret', tarpitDelaySeconds: 0.05 });
      const token = tarpit.generate();

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(tarpit.verify(token)).toEqual({ valid: true });
    });

    it('should reject tokens from different secret', () => {
      const tarpit1 = new Tarpit({ tarpitSecret: 'secret-1', tarpitDelaySeconds: 0 });
      const tarpit2 = new Tarpit({ tarpitSecret: 'secret-2', tarpitDelaySeconds: 0 });

      const token = tarpit1.generate();
      const result = tarpit2.verify(token);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('signature');
    });
  });
});
