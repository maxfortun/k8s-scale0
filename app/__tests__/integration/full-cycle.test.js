import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import http from 'node:http';
import { Controller } from '../../controller.js';
import { WakeupServer } from '../../wakeup-server.js';
import { Store } from '../../store.js';
import { Tarpit } from '../../tarpit.js';

function createMockK8s() {
  const services = new Map();
  const hpas = new Map();
  const virtualServices = new Map();
  const httpRoutes = new Map();
  const workloads = new Map();
  const pods = new Map();

  return {
    _services: services,
    _hpas: hpas,
    _virtualServices: virtualServices,
    _httpRoutes: httpRoutes,
    _workloads: workloads,
    _pods: pods,

    addService: (ns, name, spec, labels = {}) => {
      services.set(`${ns}/${name}`, {
        metadata: { namespace: ns, name, labels: { 'scale0/enabled': 'true', ...labels }, annotations: {} },
        spec: { selector: spec.selector || {} },
      });
    },

    addHPA: (ns, name, spec) => {
      hpas.set(`${ns}/${name}`, {
        metadata: { namespace: ns, name },
        spec,
      });
    },

    addVirtualService: (ns, name, spec) => {
      virtualServices.set(`${ns}/${name}`, {
        metadata: { namespace: ns, name },
        spec,
      });
    },

    addHTTPRoute: (ns, name, spec) => {
      httpRoutes.set(`${ns}/${name}`, {
        metadata: { namespace: ns, name },
        spec,
      });
    },

    addWorkload: (ns, kind, name, replicas, selector) => {
      workloads.set(`${ns}/${kind}/${name}`, {
        metadata: { namespace: ns, name },
        spec: {
          replicas,
          template: { metadata: { labels: selector } },
        },
        status: { readyReplicas: replicas },
      });
    },

    addPod: (ns, name, labels) => {
      pods.set(`${ns}/${name}`, {
        metadata: { namespace: ns, name, labels },
        spec: { containers: [{ name: 'main', image: 'nginx:latest' }] },
        status: { phase: 'Running' },
      });
    },

    listServicesWithLabel: jest.fn(async (selector) => {
      return Array.from(services.values()).filter(svc => {
        const labels = svc.metadata.labels || {};
        const [key, value] = selector.split('=');
        return labels[key] === value;
      });
    }),

    getHPA: jest.fn(async (ns, name) => hpas.get(`${ns}/${name}`) || null),

    patchHPA: jest.fn(async (ns, name, patch) => {
      const hpa = hpas.get(`${ns}/${name}`);
      if (hpa && patch.spec) {
        Object.assign(hpa.spec, patch.spec);
      }
      return hpa;
    }),

    listHPAs: jest.fn(async (ns) => {
      return Array.from(hpas.values()).filter(h => h.metadata.namespace === ns);
    }),

    findHPAForService: jest.fn(async (ns, serviceName, selector) => {
      const sameName = hpas.get(`${ns}/${serviceName}`);
      if (sameName) return sameName;

      for (const hpa of hpas.values()) {
        if (hpa.metadata.namespace === ns && hpa.spec.scaleTargetRef?.name === serviceName) {
          return hpa;
        }
      }
      return null;
    }),

    getVirtualService: jest.fn(async (ns, name) => virtualServices.get(`${ns}/${name}`) || null),

    replaceVirtualService: jest.fn(async (ns, name, vs) => {
      virtualServices.set(`${ns}/${name}`, vs);
      return vs;
    }),

    listVirtualServices: jest.fn(async (ns) => {
      return Array.from(virtualServices.values()).filter(vs => vs.metadata.namespace === ns);
    }),

    findVirtualServicesForService: jest.fn(async (ns, serviceName) => {
      return Array.from(virtualServices.values()).filter(vs => {
        if (vs.metadata.namespace !== ns) return false;
        const routes = vs.spec?.http || [];
        return routes.some(route =>
          (route.route || []).some(dest => {
            const host = dest.destination?.host;
            return host === serviceName ||
                   host === `${serviceName}.${ns}` ||
                   host === `${serviceName}.${ns}.svc.cluster.local`;
          })
        );
      });
    }),

    getHTTPRoute: jest.fn(async (ns, name) => httpRoutes.get(`${ns}/${name}`) || null),

    replaceHTTPRoute: jest.fn(async (ns, name, route) => {
      httpRoutes.set(`${ns}/${name}`, route);
      return route;
    }),

    listHTTPRoutes: jest.fn(async (ns) => {
      return Array.from(httpRoutes.values()).filter(r => r.metadata.namespace === ns);
    }),

    findHTTPRoutesForService: jest.fn(async (ns, serviceName) => {
      return Array.from(httpRoutes.values()).filter(route => {
        if (route.metadata.namespace !== ns) return false;
        const rules = route.spec?.rules || [];
        return rules.some(rule =>
          (rule.backendRefs || []).some(ref => ref.kind === 'Service' && ref.name === serviceName)
        );
      });
    }),

    findWorkloadForService: jest.fn(async (ns, selector) => {
      if (!selector || Object.keys(selector).length === 0) return null;
      for (const [key, workload] of workloads.entries()) {
        if (!key.startsWith(`${ns}/`)) continue;
        const podLabels = workload.spec?.template?.metadata?.labels || {};
        const matches = Object.entries(selector).every(([k, v]) => podLabels[k] === v);
        if (matches) {
          const [, kind, name] = key.split('/');
          return { kind, name, replicas: workload.spec.replicas };
        }
      }
      return null;
    }),

    scaleWorkload: jest.fn(async (ns, kind, name, replicas) => {
      const key = `${ns}/${kind}/${name}`;
      const workload = workloads.get(key);
      if (workload) {
        workload.spec.replicas = replicas;
        workload.status.readyReplicas = replicas;
      }
    }),

    getWorkload: jest.fn(async (ns, kind, name) => workloads.get(`${ns}/${kind}/${name}`) || null),

    getWorkloadReadyReplicas: jest.fn(async (ns, kind, name) => {
      const workload = workloads.get(`${ns}/${kind}/${name}`);
      return workload?.status?.readyReplicas || 0;
    }),

    listPodsWithSelector: jest.fn(async (ns, selectorStr) => {
      const selectorParts = selectorStr.split(',').map(p => p.split('='));
      return Array.from(pods.values()).filter(pod => {
        if (pod.metadata.namespace !== ns) return false;
        return selectorParts.every(([k, v]) => pod.metadata.labels?.[k] === v);
      });
    }),

    getPod: jest.fn(async (ns, name) => pods.get(`${ns}/${name}`) || null),

    deletePod: jest.fn(async (ns, name) => {
      pods.delete(`${ns}/${name}`);
    }),

    createPod: jest.fn(async (ns, pod) => {
      pods.set(`${ns}/${pod.metadata.name}`, pod);
      return pod;
    }),
  };
}

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

describe('Full Scale-Down/Wake-Up Cycle', () => {
  let mockK8s;
  let store;
  let controller;
  let wakeupServer;
  let originalConsoleLog;
  let originalConsoleWarn;
  let originalConsoleError;

  const config = {
    checkIntervalMs: 100,
    wakeupPort: 0,
    scaleInAfterSeconds: 1,
    retryAfterSeconds: 1,
    labelPrefix: 'scale0',
    tarpitSecret: 'test-secret',
    tarpitDelaySeconds: 0.05,
    tarpitCookieName: 'scale0_tarpit',
    wakeupTimeoutMs: 5000,
  };

  beforeEach(async () => {
    mockK8s = createMockK8s();
    store = new Store();
    controller = new Controller(mockK8s, store, config);
    wakeupServer = new WakeupServer(mockK8s, store, config);
    wakeupServer.setController(controller);

    originalConsoleLog = console.log;
    originalConsoleWarn = console.warn;
    originalConsoleError = console.error;
    console.log = jest.fn();
    console.warn = jest.fn();
    console.error = jest.fn();

    await wakeupServer.start();
  });

  afterEach(async () => {
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;
    await controller.stop();
    await wakeupServer.stop();
  });

  describe('HPA mode full cycle', () => {
    beforeEach(() => {
      mockK8s.addService('test-ns', 'my-app', { selector: { app: 'my-app' } });
      mockK8s.addHPA('test-ns', 'my-app', {
        minReplicas: 2,
        maxReplicas: 10,
        scaleTargetRef: { kind: 'Deployment', name: 'my-app', apiVersion: 'apps/v1' },
      });
      mockK8s.addVirtualService('test-ns', 'my-app-vs', {
        http: [{ route: [{ destination: { host: 'my-app', port: { number: 8080 } } }] }],
      });
      mockK8s.addWorkload('test-ns', 'Deployment', 'my-app', 2, { app: 'my-app' });
    });

    it('should scale down idle service and wake up on request', async () => {
      await controller.reconcile();
      expect(store.getLastActivity('test-ns', 'my-app')).toBeDefined();
      expect(store.isScaledDown('test-ns', 'my-app')).toBe(false);

      store.lastActivity.set(store.key('test-ns', 'my-app'), Date.now() - 2000);
      await controller.reconcile();

      expect(store.isScaledDown('test-ns', 'my-app')).toBe(true);
      const hpa = await mockK8s.getHPA('test-ns', 'my-app');
      expect(hpa.spec.minReplicas).toBe(0);
      expect(hpa.spec.maxReplicas).toBe(0);

      const vs = await mockK8s.getVirtualService('test-ns', 'my-app-vs');
      expect(vs.spec.http[0].route[0].destination.host).toContain('scale0');

      const res1 = await makeRequest(wakeupServer, {
        headers: {
          'x-scale0-original-service': 'my-app',
          'x-scale0-original-namespace': 'test-ns',
          Accept: 'application/json',
        },
      });
      expect(res1.statusCode).toBe(503);
      expect(res1.headers['set-cookie']).toBeDefined();

      const cookie = res1.headers['set-cookie'][0].split(';')[0];
      await new Promise(r => setTimeout(r, 100));

      const res2 = await makeRequest(wakeupServer, {
        headers: {
          'x-scale0-original-service': 'my-app',
          'x-scale0-original-namespace': 'test-ns',
          Cookie: cookie,
          Accept: 'application/json',
        },
      });
      expect(res2.statusCode).toBe(503);
      expect(res2.json().status).toBe('waking_up');

      expect(store.isScaledDown('test-ns', 'my-app')).toBe(false);
      const restoredHpa = await mockK8s.getHPA('test-ns', 'my-app');
      expect(restoredHpa.spec.minReplicas).toBe(2);
      expect(restoredHpa.spec.maxReplicas).toBe(10);

      const restoredVs = await mockK8s.getVirtualService('test-ns', 'my-app-vs');
      expect(restoredVs.spec.http[0].route[0].destination.host).toBe('my-app');
    });
  });

  describe('Workload mode (no HPA) full cycle', () => {
    beforeEach(() => {
      mockK8s.addService('test-ns', 'simple-app', { selector: { app: 'simple' } });
      mockK8s.addVirtualService('test-ns', 'simple-vs', {
        http: [{ route: [{ destination: { host: 'simple-app' } }] }],
      });
      mockK8s.addWorkload('test-ns', 'Deployment', 'simple-deploy', 3, { app: 'simple' });
    });

    it('should scale workload directly without HPA', async () => {
      await controller.reconcile();
      expect(store.getLastActivity('test-ns', 'simple-app')).toBeDefined();

      store.lastActivity.set(store.key('test-ns', 'simple-app'), Date.now() - 2000);
      await controller.reconcile();

      expect(store.isScaledDown('test-ns', 'simple-app')).toBe(true);
      expect(mockK8s.scaleWorkload).toHaveBeenCalledWith('test-ns', 'Deployment', 'simple-deploy', 0);

      const tarpit = new Tarpit(config);
      const token = tarpit.generate();
      await new Promise(r => setTimeout(r, 100));

      await makeRequest(wakeupServer, {
        headers: {
          'x-scale0-original-service': 'simple-app',
          'x-scale0-original-namespace': 'test-ns',
          Cookie: `${config.tarpitCookieName}=${token}`,
        },
      });

      expect(mockK8s.scaleWorkload).toHaveBeenCalledWith('test-ns', 'Deployment', 'simple-deploy', 3);
    });
  });

  describe('Gateway API HTTPRoute full cycle', () => {
    beforeEach(() => {
      mockK8s.addService('test-ns', 'gw-app', { selector: { app: 'gateway' } });
      mockK8s.addHPA('test-ns', 'gw-app', {
        minReplicas: 1,
        maxReplicas: 5,
        scaleTargetRef: { kind: 'Deployment', name: 'gw-app' },
      });
      mockK8s.addHTTPRoute('test-ns', 'gw-route', {
        rules: [{
          matches: [{ path: { type: 'PathPrefix', value: '/' } }],
          backendRefs: [{ kind: 'Service', name: 'gw-app', port: 8080 }],
        }],
      });
      mockK8s.addWorkload('test-ns', 'Deployment', 'gw-app', 1, { app: 'gateway' });
    });

    it('should redirect HTTPRoute to scale0 and restore on wakeup', async () => {
      await controller.reconcile();
      store.lastActivity.set(store.key('test-ns', 'gw-app'), Date.now() - 2000);
      await controller.reconcile();

      expect(store.isScaledDown('test-ns', 'gw-app')).toBe(true);

      const route = await mockK8s.getHTTPRoute('test-ns', 'gw-route');
      expect(route.spec.rules[0].backendRefs[0].name).toBe('scale0');
      expect(route.spec.rules[0].filters.some(f => f.type === 'RequestHeaderModifier')).toBe(true);

      const tarpit = new Tarpit(config);
      const token = tarpit.generate();
      await new Promise(r => setTimeout(r, 100));

      await makeRequest(wakeupServer, {
        headers: {
          'x-scale0-original-service': 'gw-app',
          'x-scale0-original-namespace': 'test-ns',
          Cookie: `${config.tarpitCookieName}=${token}`,
        },
      });

      const restoredRoute = await mockK8s.getHTTPRoute('test-ns', 'gw-route');
      expect(restoredRoute.spec.rules[0].backendRefs[0].name).toBe('gw-app');
    });
  });

  describe('Multiple routing resources', () => {
    beforeEach(() => {
      mockK8s.addService('test-ns', 'multi-route-app', { selector: { app: 'multi' } });
      mockK8s.addHPA('test-ns', 'multi-route-app', {
        minReplicas: 1,
        maxReplicas: 3,
        scaleTargetRef: { kind: 'Deployment', name: 'multi-deploy' },
      });
      mockK8s.addVirtualService('test-ns', 'vs1', {
        http: [{ route: [{ destination: { host: 'multi-route-app' } }] }],
      });
      mockK8s.addVirtualService('test-ns', 'vs2', {
        http: [{ route: [{ destination: { host: 'multi-route-app.test-ns.svc.cluster.local' } }] }],
      });
      mockK8s.addHTTPRoute('test-ns', 'route1', {
        rules: [{ backendRefs: [{ kind: 'Service', name: 'multi-route-app', port: 80 }] }],
      });
      mockK8s.addWorkload('test-ns', 'Deployment', 'multi-deploy', 1, { app: 'multi' });
    });

    it('should redirect and restore all routing resources', async () => {
      await controller.reconcile();
      store.lastActivity.set(store.key('test-ns', 'multi-route-app'), Date.now() - 2000);
      await controller.reconcile();

      const vs1 = await mockK8s.getVirtualService('test-ns', 'vs1');
      const vs2 = await mockK8s.getVirtualService('test-ns', 'vs2');
      const route1 = await mockK8s.getHTTPRoute('test-ns', 'route1');

      expect(vs1.spec.http[0].route[0].destination.host).toContain('scale0');
      expect(vs2.spec.http[0].route[0].destination.host).toContain('scale0');
      expect(route1.spec.rules[0].backendRefs[0].name).toBe('scale0');

      const tarpit = new Tarpit(config);
      const token = tarpit.generate();
      await new Promise(r => setTimeout(r, 100));

      await makeRequest(wakeupServer, {
        headers: {
          'x-scale0-original-service': 'multi-route-app',
          'x-scale0-original-namespace': 'test-ns',
          Cookie: `${config.tarpitCookieName}=${token}`,
        },
      });

      const restoredVs1 = await mockK8s.getVirtualService('test-ns', 'vs1');
      const restoredVs2 = await mockK8s.getVirtualService('test-ns', 'vs2');
      const restoredRoute1 = await mockK8s.getHTTPRoute('test-ns', 'route1');

      expect(restoredVs1.spec.http[0].route[0].destination.host).toBe('multi-route-app');
      expect(restoredVs2.spec.http[0].route[0].destination.host).toBe('multi-route-app.test-ns.svc.cluster.local');
      expect(restoredRoute1.spec.rules[0].backendRefs[0].name).toBe('multi-route-app');
    });
  });

  describe('Concurrent requests', () => {
    beforeEach(() => {
      mockK8s.addService('test-ns', 'concurrent-app', { selector: { app: 'concurrent' } });
      mockK8s.addHPA('test-ns', 'concurrent-app', {
        minReplicas: 1,
        maxReplicas: 5,
        scaleTargetRef: { kind: 'Deployment', name: 'concurrent-app' },
      });
      mockK8s.addVirtualService('test-ns', 'concurrent-vs', {
        http: [{ route: [{ destination: { host: 'concurrent-app' } }] }],
      });
      mockK8s.addWorkload('test-ns', 'Deployment', 'concurrent-app', 1, { app: 'concurrent' });
    });

    it('should handle multiple concurrent wakeup requests', async () => {
      await controller.reconcile();
      store.lastActivity.set(store.key('test-ns', 'concurrent-app'), Date.now() - 2000);
      await controller.reconcile();

      const tarpit = new Tarpit(config);
      const tokens = Array(5).fill(null).map(() => tarpit.generate());
      await new Promise(r => setTimeout(r, 100));

      const requests = tokens.map(token =>
        makeRequest(wakeupServer, {
          headers: {
            'x-scale0-original-service': 'concurrent-app',
            'x-scale0-original-namespace': 'test-ns',
            Cookie: `${config.tarpitCookieName}=${token}`,
            Accept: 'application/json',
          },
        })
      );

      const responses = await Promise.all(requests);

      const wakingUp = responses.filter(r => r.json()?.status === 'waking_up');
      const notFound = responses.filter(r => r.statusCode === 404);
      const successful = responses.filter(r => r.statusCode === 503 || r.statusCode === 404);

      expect(successful.length).toBe(5);
      expect(wakingUp.length + notFound.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Bot protection (tarpit)', () => {
    beforeEach(async () => {
      mockK8s.addService('test-ns', 'protected-app', { selector: { app: 'protected' } });
      mockK8s.addHPA('test-ns', 'protected-app', {
        minReplicas: 1,
        maxReplicas: 3,
        scaleTargetRef: { kind: 'Deployment', name: 'protected-app' },
      });
      mockK8s.addVirtualService('test-ns', 'protected-vs', {
        http: [{ route: [{ destination: { host: 'protected-app' } }] }],
      });
      mockK8s.addWorkload('test-ns', 'Deployment', 'protected-app', 1, { app: 'protected' });

      await store.saveScaledDownState('test-ns', 'protected-app', { scaleMode: 'hpa' });
    });

    it('should block requests without cookies', async () => {
      const res = await makeRequest(wakeupServer, {
        headers: {
          'x-scale0-original-service': 'protected-app',
          'x-scale0-original-namespace': 'test-ns',
          Accept: 'application/json',
        },
      });

      expect(res.statusCode).toBe(503);
      expect(res.json().status).toBe('tarpit_check');
      expect(res.headers['set-cookie']).toBeDefined();
    });

    it('should block requests with forged cookies', async () => {
      const res = await makeRequest(wakeupServer, {
        headers: {
          'x-scale0-original-service': 'protected-app',
          'x-scale0-original-namespace': 'test-ns',
          Cookie: `${config.tarpitCookieName}=forged-token`,
          Accept: 'application/json',
        },
      });

      expect(res.statusCode).toBe(418);
      expect(res.json().status).toBe('tarpit_invalid');
    });

    it('should block requests arriving too early', async () => {
      const tarpit = new Tarpit({ ...config, tarpitDelaySeconds: 10 });
      const token = tarpit.generate();

      const res = await makeRequest(wakeupServer, {
        headers: {
          'x-scale0-original-service': 'protected-app',
          'x-scale0-original-namespace': 'test-ns',
          Cookie: `${config.tarpitCookieName}=${token}`,
          Accept: 'application/json',
        },
      });

      expect(res.statusCode).toBe(418);
      const json = res.json();
      expect(json.status).toBe('tarpit_early');
      expect(json.waitSeconds).toBeGreaterThan(0);
    });
  });

  describe('Status endpoint', () => {
    it('should report scaled-down services', async () => {
      mockK8s.addService('ns1', 'svc1', { selector: { app: 'test1' } });
      mockK8s.addService('ns2', 'svc2', { selector: { app: 'test2' } });
      mockK8s.addHPA('ns1', 'svc1', { minReplicas: 1, maxReplicas: 3, scaleTargetRef: { kind: 'Deployment', name: 'svc1' } });
      mockK8s.addHPA('ns2', 'svc2', { minReplicas: 1, maxReplicas: 3, scaleTargetRef: { kind: 'Deployment', name: 'svc2' } });
      mockK8s.addVirtualService('ns1', 'vs1', { http: [{ route: [{ destination: { host: 'svc1' } }] }] });
      mockK8s.addVirtualService('ns2', 'vs2', { http: [{ route: [{ destination: { host: 'svc2' } }] }] });
      mockK8s.addWorkload('ns1', 'Deployment', 'svc1', 1, { app: 'test1' });
      mockK8s.addWorkload('ns2', 'Deployment', 'svc2', 1, { app: 'test2' });

      await controller.reconcile();

      store.lastActivity.set(store.key('ns1', 'svc1'), Date.now() - 2000);
      await controller.reconcile();

      const res = await makeRequest(wakeupServer, { path: '/status' });
      const status = res.json();

      expect(status.tracked).toHaveLength(2);
      expect(status.scaledDown).toHaveLength(1);
      expect(status.scaledDown[0]).toMatchObject({ namespace: 'ns1', name: 'svc1' });
    });
  });
});

describe('Timing-based tests (configurable scale-in)', () => {
  let mockK8s;
  let store;
  let controller;

  beforeEach(() => {
    mockK8s = createMockK8s();
    store = new Store();

    console.log = jest.fn();
    console.warn = jest.fn();
    console.error = jest.fn();
  });

  afterEach(async () => {
    await controller?.stop();
  });

  it('should respect custom scale-in-after from label (seconds not days)', async () => {
    const quickConfig = {
      checkIntervalMs: 50,
      scaleInAfterSeconds: 300,
      labelPrefix: 'scale0',
    };
    controller = new Controller(mockK8s, store, quickConfig);

    mockK8s.addService('test', 'fast-scale', { selector: { app: 'fast' } }, { 'scale0/scale-in-after': '1' });
    mockK8s.addHPA('test', 'fast-scale', { minReplicas: 1, maxReplicas: 3, scaleTargetRef: { kind: 'Deployment', name: 'fast' } });
    mockK8s.addVirtualService('test', 'fast-vs', { http: [{ route: [{ destination: { host: 'fast-scale' } }] }] });
    mockK8s.addWorkload('test', 'Deployment', 'fast', 1, { app: 'fast' });

    await controller.reconcile();
    expect(store.isScaledDown('test', 'fast-scale')).toBe(false);

    await new Promise(r => setTimeout(r, 1100));
    await controller.reconcile();

    expect(store.isScaledDown('test', 'fast-scale')).toBe(true);
  });

  it('should not scale down if activity recorded within threshold', async () => {
    const config = {
      checkIntervalMs: 50,
      scaleInAfterSeconds: 2,
      labelPrefix: 'scale0',
    };
    controller = new Controller(mockK8s, store, config);

    mockK8s.addService('test', 'active-svc', { selector: { app: 'active' } });
    mockK8s.addHPA('test', 'active-svc', { minReplicas: 1, maxReplicas: 3, scaleTargetRef: { kind: 'Deployment', name: 'active' } });
    mockK8s.addVirtualService('test', 'active-vs', { http: [{ route: [{ destination: { host: 'active-svc' } }] }] });
    mockK8s.addWorkload('test', 'Deployment', 'active', 1, { app: 'active' });

    await controller.reconcile();

    await new Promise(r => setTimeout(r, 500));
    store.recordActivity('test', 'active-svc');
    await controller.reconcile();

    expect(store.isScaledDown('test', 'active-svc')).toBe(false);

    await new Promise(r => setTimeout(r, 500));
    store.recordActivity('test', 'active-svc');
    await controller.reconcile();

    expect(store.isScaledDown('test', 'active-svc')).toBe(false);
  });
});
