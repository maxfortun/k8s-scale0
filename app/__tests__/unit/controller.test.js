import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Controller } from '../../controller.js';
import { Store } from '../../store.js';

function createMockK8s() {
  return {
    listServicesWithLabel: jest.fn().mockResolvedValue([]),
    getService: jest.fn().mockResolvedValue(null),
    getHPA: jest.fn().mockResolvedValue(null),
    patchHPA: jest.fn().mockResolvedValue({}),
    getVirtualService: jest.fn().mockResolvedValue(null),
    replaceVirtualService: jest.fn().mockResolvedValue({}),
    getHTTPRoute: jest.fn().mockResolvedValue(null),
    replaceHTTPRoute: jest.fn().mockResolvedValue({}),
    findHPAForService: jest.fn().mockResolvedValue(null),
    findWorkloadForService: jest.fn().mockResolvedValue(null),
    findVirtualServicesForService: jest.fn().mockResolvedValue([]),
    findHTTPRoutesForService: jest.fn().mockResolvedValue([]),
    listPodsWithSelector: jest.fn().mockResolvedValue([]),
    deletePod: jest.fn().mockResolvedValue({}),
    createPod: jest.fn().mockResolvedValue({}),
    scaleWorkload: jest.fn().mockResolvedValue({}),
    getWorkload: jest.fn().mockResolvedValue({ spec: { replicas: 1 } }),
    getWorkloadReadyReplicas: jest.fn().mockResolvedValue(0),
    acquireLease: jest.fn().mockResolvedValue(true),
    releaseLease: jest.fn().mockResolvedValue(),
  };
}

const defaultConfig = {
  checkIntervalMs: 1000,
  scaleInAfterSeconds: 60,
  labelPrefix: 'scale0',
  retryAfterSeconds: 5,
};

describe('Controller', () => {
  let controller;
  let mockK8s;
  let store;
  let originalConsoleLog;
  let originalConsoleWarn;
  let originalConsoleError;

  beforeEach(() => {
    mockK8s = createMockK8s();
    store = new Store();
    controller = new Controller(mockK8s, store, defaultConfig);

    originalConsoleLog = console.log;
    originalConsoleWarn = console.warn;
    originalConsoleError = console.error;
    console.log = jest.fn();
    console.warn = jest.fn();
    console.error = jest.fn();
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;
    if (controller.intervalId) {
      controller.stop();
    }
  });

  describe('start and stop', () => {
    it('should start reconciliation loop', async () => {
      await controller.start();
      expect(controller.intervalId).toBeDefined();
      expect(mockK8s.listServicesWithLabel).toHaveBeenCalled();
    });

    it('should stop reconciliation loop', async () => {
      await controller.start();
      await controller.stop();
      expect(controller.intervalId).toBeNull();
    });

    it('should handle stop when not started', async () => {
      await expect(controller.stop()).resolves.not.toThrow();
    });
  });

  describe('reconcile', () => {
    it('should list services with correct label selector', async () => {
      await controller.reconcile();
      expect(mockK8s.listServicesWithLabel).toHaveBeenCalledWith('scale0/enabled=true');
    });

    it('should use custom label prefix', async () => {
      controller = new Controller(mockK8s, store, { ...defaultConfig, labelPrefix: 'custom' });
      await controller.reconcile();
      expect(mockK8s.listServicesWithLabel).toHaveBeenCalledWith('custom/enabled=true');
    });

    it('should handle API errors gracefully', async () => {
      mockK8s.listServicesWithLabel.mockRejectedValue(new Error('API unavailable'));
      await expect(controller.reconcile()).resolves.not.toThrow();
      expect(console.error).toHaveBeenCalledWith('Reconcile error:', 'API unavailable');
    });

    it('should process each service', async () => {
      const services = [
        { metadata: { namespace: 'ns1', name: 'svc1', labels: {}, annotations: {} }, spec: { selector: {} } },
        { metadata: { namespace: 'ns2', name: 'svc2', labels: {}, annotations: {} }, spec: { selector: {} } },
      ];
      mockK8s.listServicesWithLabel.mockResolvedValue(services);

      await controller.reconcile();

      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('No scalable resource found'));
    });
  });

  describe('processService', () => {
    const createService = (namespace, name, labels = {}, annotations = {}, selector = { app: 'test' }) => ({
      metadata: { namespace, name, labels, annotations },
      spec: { selector },
    });

    describe('HPA mode', () => {
      it('should use explicitly specified HPA', async () => {
        const svc = createService('ns', 'svc', { 'scale0/hpa': 'my-hpa' });
        mockK8s.findVirtualServicesForService.mockResolvedValue([{ metadata: { name: 'my-vs' } }]);

        await controller.processService(svc);

        expect(mockK8s.findHPAForService).not.toHaveBeenCalled();
        expect(store.getLastActivity('ns', 'svc')).toBeDefined();
      });

      it('should auto-discover HPA', async () => {
        const svc = createService('ns', 'svc');
        const mockHPA = { metadata: { name: 'discovered-hpa' }, spec: { scaleTargetRef: { kind: 'Deployment', name: 'my-deploy' } } };
        mockK8s.findHPAForService.mockResolvedValue(mockHPA);
        mockK8s.findVirtualServicesForService.mockResolvedValue([{ metadata: { name: 'my-vs' } }]);

        await controller.processService(svc);

        expect(mockK8s.findHPAForService).toHaveBeenCalledWith('ns', 'svc', { app: 'test' });
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Auto-discovered HPA'));
      });
    });

    describe('Workload mode', () => {
      it('should fall back to workload when no HPA', async () => {
        const svc = createService('ns', 'svc');
        mockK8s.findHPAForService.mockResolvedValue(null);
        mockK8s.findWorkloadForService.mockResolvedValue({ kind: 'Deployment', name: 'my-deploy', replicas: 2 });
        mockK8s.findVirtualServicesForService.mockResolvedValue([{ metadata: { name: 'my-vs' } }]);

        await controller.processService(svc);

        expect(mockK8s.findWorkloadForService).toHaveBeenCalledWith('ns', { app: 'test' });
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Auto-discovered Deployment'));
      });
    });

    describe('Pod mode', () => {
      it('should fall back to pods when no HPA or workload', async () => {
        const svc = createService('ns', 'svc');
        mockK8s.findHPAForService.mockResolvedValue(null);
        mockK8s.findWorkloadForService.mockResolvedValue(null);
        mockK8s.listPodsWithSelector.mockResolvedValue([
          { metadata: { name: 'pod-1' } },
          { metadata: { name: 'pod-2' } },
        ]);
        mockK8s.findVirtualServicesForService.mockResolvedValue([{ metadata: { name: 'my-vs' } }]);

        await controller.processService(svc);

        expect(mockK8s.listPodsWithSelector).toHaveBeenCalledWith('ns', 'app=test');
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('2 standalone pod'));
      });
    });

    describe('Route discovery', () => {
      it('should use explicitly specified VirtualService', async () => {
        const svc = createService('ns', 'svc', { 'scale0/virtualservice': 'explicit-vs' });
        mockK8s.findHPAForService.mockResolvedValue({ metadata: { name: 'hpa' }, spec: { scaleTargetRef: {} } });

        await controller.processService(svc);

        expect(mockK8s.findVirtualServicesForService).not.toHaveBeenCalled();
      });

      it('should auto-discover multiple VirtualServices', async () => {
        const svc = createService('ns', 'svc');
        mockK8s.findHPAForService.mockResolvedValue({ metadata: { name: 'hpa' }, spec: { scaleTargetRef: {} } });
        mockK8s.findVirtualServicesForService.mockResolvedValue([
          { metadata: { name: 'vs-1' } },
          { metadata: { name: 'vs-2' } },
        ]);

        await controller.processService(svc);

        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Auto-discovered 2 VirtualService'));
      });

      it('should auto-discover HTTPRoutes', async () => {
        const svc = createService('ns', 'svc');
        mockK8s.findHPAForService.mockResolvedValue({ metadata: { name: 'hpa' }, spec: { scaleTargetRef: {} } });
        mockK8s.findHTTPRoutesForService.mockResolvedValue([{ metadata: { name: 'route-1' } }]);

        await controller.processService(svc);

        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Auto-discovered 1 HTTPRoute'));
      });

      it('should skip if no routing resources found', async () => {
        const svc = createService('ns', 'svc');
        mockK8s.findHPAForService.mockResolvedValue({ metadata: { name: 'hpa' }, spec: { scaleTargetRef: {} } });
        mockK8s.findVirtualServicesForService.mockResolvedValue([]);
        mockK8s.findHTTPRoutesForService.mockResolvedValue([]);

        await controller.processService(svc);

        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('No VirtualService or HTTPRoute'));
      });
    });

    describe('Scale-in timeout', () => {
      it('should use label for scale-in-after', async () => {
        const svc = createService('ns', 'svc', { 'scale0/scale-in-after': '120' });
        mockK8s.findHPAForService.mockResolvedValue({ metadata: { name: 'hpa' }, spec: { scaleTargetRef: {} } });
        mockK8s.findVirtualServicesForService.mockResolvedValue([{ metadata: { name: 'vs' } }]);

        await controller.processService(svc);

        expect(store.getLastActivity('ns', 'svc')).toBeDefined();
      });

      it('should use annotation for scale-in-after', async () => {
        const svc = createService('ns', 'svc', {}, { 'scale0/scale-in-after': '180' });
        mockK8s.findHPAForService.mockResolvedValue({ metadata: { name: 'hpa' }, spec: { scaleTargetRef: {} } });
        mockK8s.findVirtualServicesForService.mockResolvedValue([{ metadata: { name: 'vs' } }]);

        await controller.processService(svc);

        expect(store.getLastActivity('ns', 'svc')).toBeDefined();
      });
    });

    describe('Idle detection', () => {
      it('should not scale down recently active service', async () => {
        const svc = createService('ns', 'svc');
        mockK8s.findHPAForService.mockResolvedValue({ metadata: { name: 'hpa' }, spec: { scaleTargetRef: {} } });
        mockK8s.findVirtualServicesForService.mockResolvedValue([{ metadata: { name: 'vs' } }]);

        store.recordActivity('ns', 'svc');
        await controller.processService(svc);

        expect(mockK8s.patchHPA).not.toHaveBeenCalled();
      });

      it('should scale down idle service', async () => {
        const svc = createService('ns', 'svc');
        const mockHPA = {
          metadata: { name: 'hpa' },
          spec: { scaleTargetRef: { kind: 'Deployment', name: 'deploy', apiVersion: 'apps/v1' }, minReplicas: 1, maxReplicas: 5 },
        };
        mockK8s.findHPAForService.mockResolvedValue(mockHPA);
        mockK8s.getHPA.mockResolvedValue(mockHPA);
        mockK8s.getWorkload.mockResolvedValue({ spec: { replicas: 2 } });
        mockK8s.findVirtualServicesForService.mockResolvedValue([{ metadata: { name: 'vs', namespace: 'ns' }, spec: { http: [] } }]);
        mockK8s.getVirtualService.mockResolvedValue({ metadata: { name: 'vs', namespace: 'ns' }, spec: { http: [{ route: [] }] } });

        store.recordActivity('ns', 'svc');
        store.lastActivity.set(store.key('ns', 'svc'), Date.now() - 120000);

        await controller.processService(svc);

        // Workload is scaled to 0 (HPA ignored when replicas=0)
        expect(mockK8s.scaleWorkload).toHaveBeenCalledWith('ns', 'Deployment', 'deploy', 0);
        expect(store.isScaledDown('ns', 'svc')).toBe(true);
      });

      it('should not re-process already scaled-down service', async () => {
        const svc = createService('ns', 'svc');
        mockK8s.findHPAForService.mockResolvedValue({ metadata: { name: 'hpa' }, spec: { scaleTargetRef: {} } });
        mockK8s.findVirtualServicesForService.mockResolvedValue([{ metadata: { name: 'vs' } }]);

        store.recordActivity('ns', 'svc');
        await store.saveScaledDownState('ns', 'svc', { mode: 'hpa' });

        await controller.processService(svc);

        expect(mockK8s.patchHPA).not.toHaveBeenCalled();
      });
    });
  });

  describe('scaleDown', () => {
    describe('HPA mode', () => {
      it('should scale workload to 0 and save state', async () => {
        const mockHPA = {
          spec: {
            minReplicas: 1,
            maxReplicas: 5,
            scaleTargetRef: { kind: 'Deployment', name: 'deploy', apiVersion: 'apps/v1' },
          },
        };
        const mockVS = {
          metadata: { namespace: 'ns' },
          spec: { http: [{ route: [{ destination: { host: 'svc' } }] }] },
        };

        mockK8s.getHPA.mockResolvedValue(mockHPA);
        mockK8s.getWorkload.mockResolvedValue({ spec: { replicas: 2 } });
        mockK8s.getVirtualService.mockResolvedValue(mockVS);

        await controller.scaleDown('ns', 'svc', 'hpa', { name: 'hpa' }, ['vs'], []);

        // Workload is scaled to 0 (HPA ignored when replicas=0)
        expect(mockK8s.scaleWorkload).toHaveBeenCalledWith('ns', 'Deployment', 'deploy', 0);

        const state = store.getScaledDownState('ns', 'svc');
        expect(state.hpa).toEqual({ name: 'hpa', minReplicas: 1, maxReplicas: 5 });
        expect(state.scaleMode).toBe('hpa');
      });

      it('should skip if HPA not found', async () => {
        mockK8s.getHPA.mockResolvedValue(null);
        mockK8s.getVirtualService.mockResolvedValue({ metadata: { namespace: 'ns' }, spec: {} });

        await controller.scaleDown('ns', 'svc', 'hpa', { name: 'hpa' }, ['vs'], []);

        expect(mockK8s.patchHPA).not.toHaveBeenCalled();
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('HPA ns/hpa not found'));
      });
    });

    describe('Workload mode', () => {
      it('should scale workload to 0 directly', async () => {
        const mockVS = {
          metadata: { namespace: 'ns' },
          spec: { http: [{ route: [] }] },
        };
        mockK8s.getVirtualService.mockResolvedValue(mockVS);

        await controller.scaleDown('ns', 'svc', 'workload', { kind: 'Deployment', name: 'deploy', replicas: 3 }, ['vs'], []);

        expect(mockK8s.scaleWorkload).toHaveBeenCalledWith('ns', 'Deployment', 'deploy', 0);

        const state = store.getScaledDownState('ns', 'svc');
        expect(state.workload).toEqual({ kind: 'Deployment', name: 'deploy', replicas: 3 });
      });
    });

    describe('Pod mode', () => {
      it('should delete pods', async () => {
        const mockVS = {
          metadata: { namespace: 'ns' },
          spec: { http: [{ route: [] }] },
        };
        mockK8s.getVirtualService.mockResolvedValue(mockVS);

        const pods = [
          { name: 'pod-1', spec: { metadata: { name: 'pod-1' } } },
          { name: 'pod-2', spec: { metadata: { name: 'pod-2' } } },
        ];

        await controller.scaleDown('ns', 'svc', 'pod', { pods }, ['vs'], []);

        expect(mockK8s.deletePod).toHaveBeenCalledWith('ns', 'pod-1');
        expect(mockK8s.deletePod).toHaveBeenCalledWith('ns', 'pod-2');

        const state = store.getScaledDownState('ns', 'svc');
        expect(state.pods).toHaveLength(2);
      });
    });

    describe('Route redirection', () => {
      it('should redirect VirtualService to scale0', async () => {
        const mockVS = {
          metadata: { namespace: 'ns', name: 'vs' },
          spec: {
            http: [{
              match: [{ uri: { prefix: '/' } }],
              route: [{ destination: { host: 'original-svc', port: { number: 80 } } }],
            }],
          },
        };
        mockK8s.getVirtualService.mockResolvedValue(mockVS);
        mockK8s.getHPA.mockResolvedValue({
          spec: { scaleTargetRef: { kind: 'Deployment', name: 'd' }, minReplicas: 1, maxReplicas: 2 },
        });
        mockK8s.getWorkload.mockResolvedValue({ spec: { replicas: 2 } });

        await controller.scaleDown('ns', 'svc', 'hpa', { name: 'hpa' }, ['vs'], []);

        expect(mockK8s.replaceVirtualService).toHaveBeenCalled();
        const replacedVS = mockK8s.replaceVirtualService.mock.calls[0][2];
        expect(replacedVS.spec.http[0].route[0].destination.host).toContain('scale0');
        expect(replacedVS.spec.http[0].route[0].headers.request.set['x-scale0-original-service']).toBe('svc');
      });

      it('should redirect HTTPRoute to scale0', async () => {
        const mockRoute = {
          metadata: { namespace: 'ns', name: 'route' },
          spec: {
            rules: [{
              matches: [{ path: { type: 'PathPrefix', value: '/' } }],
              backendRefs: [{ kind: 'Service', name: 'original-svc', port: 80 }],
            }],
          },
        };
        mockK8s.getHTTPRoute.mockResolvedValue(mockRoute);
        mockK8s.getHPA.mockResolvedValue({
          spec: { scaleTargetRef: { kind: 'Deployment', name: 'd' }, minReplicas: 1, maxReplicas: 2 },
        });
        mockK8s.getWorkload.mockResolvedValue({ spec: { replicas: 2 } });

        await controller.scaleDown('ns', 'svc', 'hpa', { name: 'hpa' }, [], ['route']);

        expect(mockK8s.replaceHTTPRoute).toHaveBeenCalled();
        const replacedRoute = mockK8s.replaceHTTPRoute.mock.calls[0][2];
        expect(replacedRoute.spec.rules[0].backendRefs[0].name).toBe('scale0');
      });
    });
  });

  describe('wakeUp', () => {
    it('should return false if no saved state', async () => {
      const result = await controller.wakeUp('ns', 'unknown');
      expect(result).toBe(false);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('No saved state'));
    });

    describe('HPA mode', () => {
      it('should restore workload replicas', async () => {
        await store.saveScaledDownState('ns', 'svc', {
          scaleMode: 'hpa',
          hpa: { name: 'my-hpa', minReplicas: 2, maxReplicas: 10 },
          workload: { kind: 'Deployment', name: 'my-deploy', replicas: 2 },
          virtualServices: [{ name: 'vs', spec: { http: [] } }],
        });
        mockK8s.getVirtualService.mockResolvedValue({ metadata: { name: 'vs' }, spec: {} });

        const result = await controller.wakeUp('ns', 'svc');

        expect(result).toBe(true);
        // Workload replicas restored (HPA takes over once replicas > 0)
        expect(mockK8s.scaleWorkload).toHaveBeenCalledWith('ns', 'Deployment', 'my-deploy', 2);
        expect(store.isScaledDown('ns', 'svc')).toBe(false);
        expect(store.getLastActivity('ns', 'svc')).toBeDefined();
      });
    });

    describe('Workload mode', () => {
      it('should restore workload replicas', async () => {
        await store.saveScaledDownState('ns', 'svc', {
          scaleMode: 'workload',
          workload: { kind: 'StatefulSet', name: 'sts', replicas: 3 },
          virtualServices: [{ name: 'vs', spec: {} }],
        });
        mockK8s.getVirtualService.mockResolvedValue({ metadata: { name: 'vs' }, spec: {} });

        const result = await controller.wakeUp('ns', 'svc');

        expect(result).toBe(true);
        expect(mockK8s.scaleWorkload).toHaveBeenCalledWith('ns', 'StatefulSet', 'sts', 3);
      });
    });

    describe('Pod mode', () => {
      it('should recreate pods', async () => {
        const podSpec = {
          metadata: {
            name: 'pod-1',
            resourceVersion: '123',
            uid: 'uid-1',
            creationTimestamp: '2024-01-01',
            annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{}' },
          },
          spec: { containers: [{ name: 'main', image: 'nginx' }] },
        };
        await store.saveScaledDownState('ns', 'svc', {
          scaleMode: 'pod',
          pods: [{ name: 'pod-1', spec: podSpec }],
          virtualServices: [{ name: 'vs', spec: {} }],
        });
        mockK8s.getVirtualService.mockResolvedValue({ metadata: { name: 'vs' }, spec: {} });

        const result = await controller.wakeUp('ns', 'svc');

        expect(result).toBe(true);
        expect(mockK8s.createPod).toHaveBeenCalled();
        const createdPod = mockK8s.createPod.mock.calls[0][1];
        expect(createdPod.metadata.resourceVersion).toBeUndefined();
        expect(createdPod.metadata.uid).toBeUndefined();
        expect(createdPod.metadata.annotations?.['kubectl.kubernetes.io/last-applied-configuration']).toBeUndefined();
      });
    });

    describe('Route restoration', () => {
      it('should restore VirtualService spec', async () => {
        const originalSpec = { http: [{ route: [{ destination: { host: 'original' } }] }] };
        await store.saveScaledDownState('ns', 'svc', {
          scaleMode: 'hpa',
          hpa: { name: 'hpa', minReplicas: 1, maxReplicas: 5 },
          virtualServices: [{ name: 'vs', spec: originalSpec }],
        });
        mockK8s.getVirtualService.mockResolvedValue({
          metadata: { name: 'vs' },
          spec: { http: [{ route: [{ destination: { host: 'scale0' } }] }] },
        });

        await controller.wakeUp('ns', 'svc');

        expect(mockK8s.replaceVirtualService).toHaveBeenCalled();
        const restored = mockK8s.replaceVirtualService.mock.calls[0][2];
        expect(restored.spec).toEqual(originalSpec);
      });

      it('should restore HTTPRoute spec', async () => {
        const originalSpec = { rules: [{ backendRefs: [{ name: 'original' }] }] };
        await store.saveScaledDownState('ns', 'svc', {
          scaleMode: 'hpa',
          hpa: { name: 'hpa', minReplicas: 1, maxReplicas: 5 },
          virtualServices: [],
          httpRoutes: [{ name: 'route', spec: originalSpec }],
        });
        mockK8s.getHTTPRoute.mockResolvedValue({
          metadata: { name: 'route' },
          spec: { rules: [{ backendRefs: [{ name: 'scale0' }] }] },
        });

        await controller.wakeUp('ns', 'svc');

        expect(mockK8s.replaceHTTPRoute).toHaveBeenCalled();
        const restored = mockK8s.replaceHTTPRoute.mock.calls[0][2];
        expect(restored.spec).toEqual(originalSpec);
      });

      it('should handle legacy single VirtualService format', async () => {
        await store.saveScaledDownState('ns', 'svc', {
          scaleMode: 'hpa',
          hpa: { name: 'hpa', minReplicas: 1, maxReplicas: 5 },
          virtualService: { name: 'vs', spec: { http: [] } },
        });
        mockK8s.getVirtualService.mockResolvedValue({ metadata: { name: 'vs' }, spec: {} });

        await controller.wakeUp('ns', 'svc');

        expect(mockK8s.replaceVirtualService).toHaveBeenCalled();
      });

      it('should restore VirtualService using minimal http format', async () => {
        const originalHttp = [{ route: [{ destination: { host: 'original', port: { number: 80 } } }] }];
        await store.saveScaledDownState('ns', 'svc', {
          scaleMode: 'hpa',
          hpa: { name: 'hpa', minReplicas: 1, maxReplicas: 5 },
          workload: { kind: 'Deployment', name: 'd', replicas: 2 },
          virtualServices: [{ name: 'vs', http: originalHttp }],
        });
        mockK8s.getVirtualService.mockResolvedValue({
          metadata: { name: 'vs' },
          spec: { hosts: ['example.com'], http: [{ route: [{ destination: { host: 'scale0' } }] }] },
        });

        await controller.wakeUp('ns', 'svc');

        expect(mockK8s.replaceVirtualService).toHaveBeenCalled();
        const restored = mockK8s.replaceVirtualService.mock.calls[0][2];
        expect(restored.spec.http).toEqual(originalHttp);
        expect(restored.spec.hosts).toEqual(['example.com']); // Other spec fields preserved
      });

      it('should restore HTTPRoute using minimal rules format', async () => {
        const originalRules = [{ backendRefs: [{ name: 'original', port: 80 }] }];
        await store.saveScaledDownState('ns', 'svc', {
          scaleMode: 'hpa',
          hpa: { name: 'hpa', minReplicas: 1, maxReplicas: 5 },
          workload: { kind: 'Deployment', name: 'd', replicas: 2 },
          virtualServices: [],
          httpRoutes: [{ name: 'route', rules: originalRules }],
        });
        mockK8s.getHTTPRoute.mockResolvedValue({
          metadata: { name: 'route' },
          spec: { hostnames: ['example.com'], rules: [{ backendRefs: [{ name: 'scale0' }] }] },
        });

        await controller.wakeUp('ns', 'svc');

        expect(mockK8s.replaceHTTPRoute).toHaveBeenCalled();
        const restored = mockK8s.replaceHTTPRoute.mock.calls[0][2];
        expect(restored.spec.rules).toEqual(originalRules);
        expect(restored.spec.hostnames).toEqual(['example.com']); // Other spec fields preserved
      });
    });

    it('should handle errors gracefully', async () => {
      await store.saveScaledDownState('ns', 'svc', {
        scaleMode: 'hpa',
        hpa: { name: 'hpa', minReplicas: 1, maxReplicas: 5 },
        workload: { kind: 'Deployment', name: 'deploy', replicas: 2 },
        virtualServices: [],
      });
      mockK8s.scaleWorkload.mockRejectedValue(new Error('API error'));

      const result = await controller.wakeUp('ns', 'svc');

      expect(result).toBe(false);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to wake up'), 'API error');
    });
  });

  describe('createScale0VirtualService', () => {
    it('should preserve match conditions while changing route', () => {
      const original = {
        metadata: { namespace: 'test-ns' },
        spec: {
          http: [{
            match: [{ uri: { prefix: '/api' } }, { headers: { 'x-custom': { exact: 'value' } } }],
            timeout: '30s',
            retries: { attempts: 3 },
            route: [{ destination: { host: 'original-svc', port: { number: 8080 } }, weight: 100 }],
          }],
        },
      };

      const modified = controller.createScale0VirtualService(original, 'original-svc');

      expect(modified.spec.http[0].match).toEqual(original.spec.http[0].match);
      expect(modified.spec.http[0].timeout).toBe('30s');
      expect(modified.spec.http[0].route[0].destination.host).toContain('scale0');
      expect(modified.spec.http[0].route[0].headers.request.set['x-scale0-original-service']).toBe('original-svc');
      expect(modified.spec.http[0].route[0].headers.request.set['x-scale0-original-namespace']).toBe('test-ns');
    });
  });

  describe('createScale0HTTPRoute', () => {
    it('should add header modifier filter', () => {
      const original = {
        metadata: { namespace: 'test-ns' },
        spec: {
          rules: [{
            matches: [{ path: { type: 'PathPrefix', value: '/api' } }],
            backendRefs: [{ kind: 'Service', name: 'original-svc', port: 8080 }],
            filters: [{ type: 'RequestRedirect', requestRedirect: { port: 443 } }],
          }],
        },
      };

      const modified = controller.createScale0HTTPRoute(original, 'original-svc');

      expect(modified.spec.rules[0].matches).toEqual(original.spec.rules[0].matches);
      expect(modified.spec.rules[0].backendRefs[0].name).toBe('scale0');
      expect(modified.spec.rules[0].filters).toContainEqual(expect.objectContaining({
        type: 'RequestHeaderModifier',
      }));
      expect(modified.spec.rules[0].filters.find(f => f.type === 'RequestRedirect')).toBeDefined();
    });
  });
});
