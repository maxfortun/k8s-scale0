import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import http from 'node:http';
import { WakeupServer } from '../../wakeup-server.js';
import { Store } from '../../store.js';
import { Tarpit } from '../../tarpit.js';

function createMockK8s() {
  return {};
}

function createMockController() {
  return {
    wakeUp: jest.fn().mockResolvedValue(true),
    isWakingUp: jest.fn().mockReturnValue(false),
  };
}

const defaultConfig = {
  wakeupPort: 0,
  retryAfterSeconds: 5,
  tarpitSecret: 'test-secret',
  tarpitDelaySeconds: 0.1,
  tarpitCookieName: 'test_tarpit',
  corsAllowedOrigins: null,
  wakeupTimeoutMs: 5000,
};

function makeRequest(server, options = {}) {
  return new Promise((resolve, reject) => {
    const port = server.server.address().port;
    const req = http.request({
      hostname: 'localhost',
      port,
      path: options.path || '/',
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
          json: () => {
            try { return JSON.parse(body); } catch { return null; }
          },
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('WakeupServer', () => {
  let server;
  let store;
  let mockK8s;
  let mockController;
  let originalConsoleLog;
  let originalConsoleWarn;
  let originalConsoleError;

  beforeEach(async () => {
    mockK8s = createMockK8s();
    store = new Store();
    server = new WakeupServer(mockK8s, store, defaultConfig);
    mockController = createMockController();
    server.setController(mockController);

    originalConsoleLog = console.log;
    originalConsoleWarn = console.warn;
    originalConsoleError = console.error;
    console.log = jest.fn();
    console.warn = jest.fn();
    console.error = jest.fn();

    await server.start();
  });

  afterEach(async () => {
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;
    await server.stop();
  });

  describe('health endpoints', () => {
    it('GET /healthz should return 200 ok', async () => {
      const res = await makeRequest(server, { path: '/healthz' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('ok');
    });

    it('GET /readyz should return 200 ok', async () => {
      const res = await makeRequest(server, { path: '/readyz' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('ok');
    });
  });

  describe('GET /status', () => {
    it('should return empty status when nothing tracked', async () => {
      const res = await makeRequest(server, { path: '/status' });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.scaledDown).toEqual([]);
      expect(json.tracked).toEqual([]);
    });

    it('should return tracked and scaled-down services', async () => {
      store.recordActivity('ns1', 'svc1');
      await store.saveScaledDownState('ns2', 'svc2', { mode: 'hpa' });

      const res = await makeRequest(server, { path: '/status' });
      const json = res.json();

      expect(json.tracked).toHaveLength(1);
      expect(json.tracked[0]).toMatchObject({ namespace: 'ns1', name: 'svc1' });
      expect(json.scaledDown).toHaveLength(1);
      expect(json.scaledDown[0]).toMatchObject({ namespace: 'ns2', name: 'svc2' });
    });
  });

  describe('OPTIONS requests', () => {
    it('should return 204 with CORS headers', async () => {
      const res = await makeRequest(server, {
        method: 'OPTIONS',
        headers: { Origin: 'http://example.com' },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-methods']).toBe('GET, POST, OPTIONS');
    });
  });

  describe('CORS handling', () => {
    it('should allow any origin when corsAllowedOrigins not set', async () => {
      await store.saveScaledDownState('test-ns', 'test-svc', { mode: 'hpa' });
      const res = await makeRequest(server, {
        headers: {
          Origin: 'http://malicious.com',
          'x-scale0-original-service': 'test-svc',
          'x-scale0-original-namespace': 'test-ns',
          Accept: 'application/json',
        },
      });
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('should restrict origin when corsAllowedOrigins is set', async () => {
      await server.stop();
      const restrictedConfig = { ...defaultConfig, corsAllowedOrigins: ['http://allowed.com', 'http://also-allowed.com'] };
      server = new WakeupServer(mockK8s, store, restrictedConfig);
      server.setController(mockController);
      await server.start();

      await store.saveScaledDownState('test-ns', 'test-svc', { mode: 'hpa' });
      const res = await makeRequest(server, {
        headers: {
          Origin: 'http://allowed.com',
          'x-scale0-original-service': 'test-svc',
          'x-scale0-original-namespace': 'test-ns',
          Accept: 'application/json',
        },
      });
      expect(res.headers['access-control-allow-origin']).toBe('http://allowed.com');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('should return first allowed origin when request origin not in list', async () => {
      await server.stop();
      const restrictedConfig = { ...defaultConfig, corsAllowedOrigins: ['http://allowed.com'] };
      server = new WakeupServer(mockK8s, store, restrictedConfig);
      server.setController(mockController);
      await server.start();

      await store.saveScaledDownState('test-ns', 'test-svc', { mode: 'hpa' });
      const res = await makeRequest(server, {
        headers: {
          Origin: 'http://not-allowed.com',
          'x-scale0-original-service': 'test-svc',
          'x-scale0-original-namespace': 'test-ns',
          Accept: 'application/json',
        },
      });
      expect(res.headers['access-control-allow-origin']).toBe('http://allowed.com');
    });
  });

  describe('wakeup requests', () => {
    describe('missing headers', () => {
      it('should return 400 when x-scale0-original-service missing', async () => {
        const res = await makeRequest(server, {
          headers: { 'x-scale0-original-namespace': 'ns', Accept: 'application/json' },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toContain('Missing');
      });

      it('should return 400 when x-scale0-original-namespace missing', async () => {
        const res = await makeRequest(server, {
          headers: { 'x-scale0-original-service': 'svc', Accept: 'application/json' },
        });
        expect(res.statusCode).toBe(400);
      });
    });

    describe('service not scaled down', () => {
      it('should return 404 when service not in scaled-down state', async () => {
        const res = await makeRequest(server, {
          headers: {
            'x-scale0-original-service': 'unknown-svc',
            'x-scale0-original-namespace': 'ns',
            Accept: 'application/json',
          },
        });
        expect(res.statusCode).toBe(404);
        expect(res.json().message).toContain('not found in scaled-down state');
      });
    });

    describe('tarpit flow', () => {
      beforeEach(async () => {
        await store.saveScaledDownState('ns', 'svc', { mode: 'hpa' });
      });

      it('should set tarpit cookie on first request', async () => {
        const res = await makeRequest(server, {
          headers: {
            'x-scale0-original-service': 'svc',
            'x-scale0-original-namespace': 'ns',
            Accept: 'application/json',
          },
        });

        expect(res.statusCode).toBe(503);
        expect(res.headers['set-cookie']).toBeDefined();
        expect(res.headers['set-cookie'][0]).toContain('test_tarpit=');
        expect(res.json().status).toBe('tarpit_check');
      });

      it('should return 418 for early retry', async () => {
        const tarpit = new Tarpit({ tarpitSecret: 'test-secret', tarpitDelaySeconds: 10, tarpitCookieName: 'test_tarpit' });
        const token = tarpit.generate();

        const res = await makeRequest(server, {
          headers: {
            'x-scale0-original-service': 'svc',
            'x-scale0-original-namespace': 'ns',
            Cookie: `test_tarpit=${token}`,
            Accept: 'application/json',
          },
        });

        expect(res.statusCode).toBe(418);
        expect(res.json().status).toBe('tarpit_early');
      });

      it('should return 418 for invalid signature', async () => {
        const res = await makeRequest(server, {
          headers: {
            'x-scale0-original-service': 'svc',
            'x-scale0-original-namespace': 'ns',
            Cookie: 'test_tarpit=invalid-token',
            Accept: 'application/json',
          },
        });

        expect(res.statusCode).toBe(418);
        expect(res.json().status).toBe('tarpit_invalid');
      });

      it('should trigger async wakeup after valid tarpit delay', async () => {
        const tarpit = new Tarpit({ tarpitSecret: 'test-secret', tarpitDelaySeconds: 0, tarpitCookieName: 'test_tarpit' });
        const token = tarpit.generate();

        await new Promise(r => setTimeout(r, 50));

        const res = await makeRequest(server, {
          headers: {
            'x-scale0-original-service': 'svc',
            'x-scale0-original-namespace': 'ns',
            Cookie: `test_tarpit=${token}`,
            Accept: 'application/json',
          },
        });

        // Returns immediately with 503 - wakeup runs async
        expect(res.statusCode).toBe(503);
        expect(res.json().status).toBe('waking_up');
        expect(mockController.wakeUp).toHaveBeenCalledWith('ns', 'svc');
      });

      it('should return 503 without re-triggering when wakeup already in progress', async () => {
        mockController.isWakingUp.mockReturnValue(true);

        const tarpit = new Tarpit({ tarpitSecret: 'test-secret', tarpitDelaySeconds: 0, tarpitCookieName: 'test_tarpit' });
        const token = tarpit.generate();

        await new Promise(r => setTimeout(r, 50));

        const res = await makeRequest(server, {
          headers: {
            'x-scale0-original-service': 'svc',
            'x-scale0-original-namespace': 'ns',
            Cookie: `test_tarpit=${token}`,
            Accept: 'application/json',
          },
        });

        expect(res.statusCode).toBe(503);
        expect(res.json().status).toBe('waking_up');
        // Should NOT call wakeUp again - it's already in progress
        expect(mockController.wakeUp).not.toHaveBeenCalled();
      });

      it('should handle wakeup errors gracefully (async)', async () => {
        mockController.wakeUp.mockRejectedValue(new Error('K8s error'));

        const tarpit = new Tarpit({ tarpitSecret: 'test-secret', tarpitDelaySeconds: 0, tarpitCookieName: 'test_tarpit' });
        const token = tarpit.generate();

        await new Promise(r => setTimeout(r, 50));

        const res = await makeRequest(server, {
          headers: {
            'x-scale0-original-service': 'svc',
            'x-scale0-original-namespace': 'ns',
            Cookie: `test_tarpit=${token}`,
            Accept: 'application/json',
          },
        });

        // Still returns 503 immediately - error is logged async
        expect(res.statusCode).toBe(503);
        expect(res.json().status).toBe('waking_up');
      });

      it('should return 500 when controller not set', async () => {
        await server.stop();
        server = new WakeupServer(mockK8s, store, defaultConfig);
        await server.start();

        await store.saveScaledDownState('ns', 'svc', { mode: 'hpa' });

        const tarpit = new Tarpit({ tarpitSecret: 'test-secret', tarpitDelaySeconds: 0, tarpitCookieName: 'test_tarpit' });
        const token = tarpit.generate();

        const res = await makeRequest(server, {
          headers: {
            'x-scale0-original-service': 'svc',
            'x-scale0-original-namespace': 'ns',
            Cookie: `test_tarpit=${token}`,
            Accept: 'application/json',
          },
        });

        expect(res.statusCode).toBe(500);
        expect(res.json().message).toBe('Controller not initialized');
      });
    });
  });

  describe('content negotiation', () => {
    beforeEach(async () => {
      await store.saveScaledDownState('ns', 'svc', { mode: 'hpa' });
    });

    it('should return JSON when Accept header includes application/json', async () => {
      const res = await makeRequest(server, {
        headers: {
          'x-scale0-original-service': 'svc',
          'x-scale0-original-namespace': 'ns',
          Accept: 'application/json',
        },
      });

      expect(res.headers['content-type']).toBe('application/json');
      expect(res.json()).toBeDefined();
    });

    it('should return HTML by default', async () => {
      const res = await makeRequest(server, {
        headers: {
          'x-scale0-original-service': 'svc',
          'x-scale0-original-namespace': 'ns',
          Accept: 'text/html',
        },
      });

      expect(res.headers['content-type']).toBe('text/html');
      expect(res.body).toContain('<!DOCTYPE html>');
    });

    it('should include spinner in 503 HTML response', async () => {
      const res = await makeRequest(server, {
        headers: {
          'x-scale0-original-service': 'svc',
          'x-scale0-original-namespace': 'ns',
        },
      });

      expect(res.statusCode).toBe(503);
      expect(res.body).toContain('@keyframes spin');
    });

    it('should include teapot emoji in 418 HTML response', async () => {
      const res = await makeRequest(server, {
        headers: {
          'x-scale0-original-service': 'svc',
          'x-scale0-original-namespace': 'ns',
          Cookie: 'test_tarpit=invalid',
        },
      });

      expect(res.statusCode).toBe(418);
      expect(res.body).toContain('🫖');
    });
  });

  describe('response headers', () => {
    beforeEach(async () => {
      await store.saveScaledDownState('ns', 'svc', { mode: 'hpa' });
    });

    it('should include Cache-Control header', async () => {
      const res = await makeRequest(server, {
        headers: {
          'x-scale0-original-service': 'svc',
          'x-scale0-original-namespace': 'ns',
        },
      });

      expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    });

    it('should include Refresh header with delay', async () => {
      const res = await makeRequest(server, {
        headers: {
          'x-scale0-original-service': 'svc',
          'x-scale0-original-namespace': 'ns',
        },
      });

      expect(res.headers['refresh']).toMatch(/^[\d.]+;/);
      expect(res.headers['retry-after']).toBeDefined();
    });
  });

  describe('server lifecycle', () => {
    it('should handle stop when not started', async () => {
      const newServer = new WakeupServer(mockK8s, store, defaultConfig);
      await expect(newServer.stop()).resolves.not.toThrow();
    });

    it('should handle multiple stops', async () => {
      await server.stop();
      await expect(server.stop()).resolves.not.toThrow();
    });
  });

  describe('XSS protection', () => {
    it('should escape HTML in error messages', () => {
      const html = server.renderHtml(500, '<script>alert(1)</script>', {
        message: '<img onerror="alert(1)" src=x>',
        service: '"><script>xss</script>',
      }, 0);

      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).not.toContain('<img onerror');
      expect(html).not.toContain('"><script>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).toContain('&lt;img');
    });

    it('should escape special characters', () => {
      expect(server.escapeHtml('<>&"\'')).toBe('&lt;&gt;&amp;&quot;&#39;');
    });
  });
});
