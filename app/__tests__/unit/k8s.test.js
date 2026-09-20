import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

const mockKubeConfig = {
  loadFromCluster: jest.fn(),
  loadFromDefault: jest.fn(),
  makeApiClient: jest.fn(),
};

const mockAppsApi = {
  readNamespacedDeployment: jest.fn(),
  readNamespacedStatefulSet: jest.fn(),
  readNamespacedReplicaSet: jest.fn(),
  patchNamespacedDeployment: jest.fn(),
  patchNamespacedStatefulSet: jest.fn(),
  patchNamespacedReplicaSet: jest.fn(),
  listNamespacedDeployment: jest.fn(),
  listNamespacedStatefulSet: jest.fn(),
  listNamespacedReplicaSet: jest.fn(),
};

const mockCoreApi = {
  listServiceForAllNamespaces: jest.fn(),
  readNamespacedPod: jest.fn(),
  listNamespacedPod: jest.fn(),
  deleteNamespacedPod: jest.fn(),
  createNamespacedPod: jest.fn(),
  readNamespacedReplicationController: jest.fn(),
  patchNamespacedReplicationController: jest.fn(),
};

const mockAutoscalingApi = {
  readNamespacedHorizontalPodAutoscaler: jest.fn(),
  patchNamespacedHorizontalPodAutoscaler: jest.fn(),
  listNamespacedHorizontalPodAutoscaler: jest.fn(),
};

const mockCustomApi = {
  getNamespacedCustomObject: jest.fn(),
  patchNamespacedCustomObject: jest.fn(),
  replaceNamespacedCustomObject: jest.fn(),
  listNamespacedCustomObject: jest.fn(),
};

const mockCoordinationApi = {
  readNamespacedLease: jest.fn(),
  createNamespacedLease: jest.fn(),
  replaceNamespacedLease: jest.fn(),
  deleteNamespacedLease: jest.fn(),
};

let mockExistsSync = jest.fn();

jest.unstable_mockModule('node:fs', () => ({
  default: {
    existsSync: mockExistsSync,
  },
  existsSync: mockExistsSync,
}));

jest.unstable_mockModule('@kubernetes/client-node', () => ({
  default: {
    KubeConfig: jest.fn(() => mockKubeConfig),
    AppsV1Api: class {},
    AutoscalingV2Api: class {},
    CoreV1Api: class {},
    CustomObjectsApi: class {},
    CoordinationV1Api: class {},
  },
}));

const { K8sClient } = await import('../../k8s.js');

describe('K8sClient', () => {
  let k8s;
  let originalConsoleLog;
  let originalConsoleWarn;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Default to not in-cluster for most tests
    mockExistsSync.mockReturnValue(false);

    mockKubeConfig.makeApiClient.mockImplementation((ApiClass) => {
      if (ApiClass.name === 'AppsV1Api' || ApiClass === mockAppsApi.constructor) return mockAppsApi;
      if (ApiClass.name === 'AutoscalingV2Api') return mockAutoscalingApi;
      if (ApiClass.name === 'CoreV1Api') return mockCoreApi;
      if (ApiClass.name === 'CustomObjectsApi') return mockCustomApi;
      if (ApiClass.name === 'CoordinationV1Api') return mockCoordinationApi;
      return mockAppsApi;
    });

    k8s = new K8sClient();

    originalConsoleLog = console.log;
    originalConsoleWarn = console.warn;
    console.log = jest.fn();
    console.warn = jest.fn();
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
  });

  describe('init', () => {
    it('should try in-cluster config first', async () => {
      mockExistsSync.mockReturnValue(true);
      mockKubeConfig.loadFromCluster.mockImplementation(() => {});

      await k8s.init();

      expect(mockKubeConfig.loadFromCluster).toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith('Loaded in-cluster config');
    });

    it('should fall back to default config', async () => {
      mockExistsSync.mockReturnValue(false);

      await k8s.init();

      expect(mockKubeConfig.loadFromDefault).toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith('Loaded default kubeconfig');
    });

    it('should initialize all API clients', async () => {
      await k8s.init();

      expect(mockKubeConfig.makeApiClient).toHaveBeenCalledTimes(5);
      expect(k8s.appsApi).toBeDefined();
      expect(k8s.coreApi).toBeDefined();
      expect(k8s.autoscalingApi).toBeDefined();
      expect(k8s.customApi).toBeDefined();
      expect(k8s.coordinationApi).toBeDefined();
    });
  });

  describe('listServicesWithLabel', () => {
    beforeEach(async () => {
      await k8s.init();
    });

    it('should list services with label selector', async () => {
      const mockServices = [
        { metadata: { name: 'svc1' } },
        { metadata: { name: 'svc2' } },
      ];
      mockCoreApi.listServiceForAllNamespaces.mockResolvedValue({ body: { items: mockServices } });

      const result = await k8s.listServicesWithLabel('scale0/enabled=true');

      // K8s client uses positional params: (allowWatchBookmarks, _continue, fieldSelector, labelSelector)
      expect(mockCoreApi.listServiceForAllNamespaces).toHaveBeenCalledWith(undefined, undefined, undefined, 'scale0/enabled=true');
      expect(result).toEqual(mockServices);
    });
  });

  describe('HPA operations', () => {
    beforeEach(async () => {
      await k8s.init();
    });

    it('getHPA should return HPA when found', async () => {
      const mockHPA = { metadata: { name: 'hpa' }, spec: { minReplicas: 1 } };
      mockAutoscalingApi.readNamespacedHorizontalPodAutoscaler.mockResolvedValue({ body: mockHPA });

      const result = await k8s.getHPA('ns', 'hpa');

      expect(result).toEqual(mockHPA);
      // K8s client uses positional params: (name, namespace)
      expect(mockAutoscalingApi.readNamespacedHorizontalPodAutoscaler).toHaveBeenCalledWith('hpa', 'ns');
    });

    it('getHPA should return null when not found', async () => {
      mockAutoscalingApi.readNamespacedHorizontalPodAutoscaler.mockRejectedValue({ response: { statusCode: 404 } });

      const result = await k8s.getHPA('ns', 'hpa');

      expect(result).toBeNull();
    });

    it('getHPA should throw on other errors', async () => {
      mockAutoscalingApi.readNamespacedHorizontalPodAutoscaler.mockRejectedValue(new Error('Connection refused'));

      await expect(k8s.getHPA('ns', 'hpa')).rejects.toThrow('Connection refused');
    });

    it('patchHPA should patch HPA', async () => {
      mockAutoscalingApi.patchNamespacedHorizontalPodAutoscaler.mockResolvedValue({ body: {} });

      await k8s.patchHPA('ns', 'hpa', { spec: { minReplicas: 0 } });

      // K8s client uses positional params: (name, namespace, body, ...opts, { headers })
      expect(mockAutoscalingApi.patchNamespacedHorizontalPodAutoscaler).toHaveBeenCalledWith(
        'hpa',
        'ns',
        { spec: { minReplicas: 0 } },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/merge-patch+json' } }
      );
    });

    it('listHPAs should return HPAs in namespace', async () => {
      const mockHPAs = [{ metadata: { name: 'hpa1' } }, { metadata: { name: 'hpa2' } }];
      mockAutoscalingApi.listNamespacedHorizontalPodAutoscaler.mockResolvedValue({ body: { items: mockHPAs } });

      const result = await k8s.listHPAs('ns');

      expect(result).toEqual(mockHPAs);
    });
  });

  describe('VirtualService operations', () => {
    beforeEach(async () => {
      await k8s.init();
    });

    it('getVirtualService should return VS when found', async () => {
      const mockVS = { metadata: { name: 'vs' }, spec: { http: [] } };
      mockCustomApi.getNamespacedCustomObject.mockResolvedValue({ body: mockVS });

      const result = await k8s.getVirtualService('ns', 'vs');

      expect(result).toEqual(mockVS);
      // K8s client uses positional params: (group, version, namespace, plural, name)
      expect(mockCustomApi.getNamespacedCustomObject).toHaveBeenCalledWith(
        'networking.istio.io',
        'v1beta1',
        'ns',
        'virtualservices',
        'vs'
      );
    });

    it('getVirtualService should return null when not found', async () => {
      mockCustomApi.getNamespacedCustomObject.mockRejectedValue({ response: { statusCode: 404 } });

      const result = await k8s.getVirtualService('ns', 'vs');

      expect(result).toBeNull();
    });

    it('replaceVirtualService should replace VS', async () => {
      mockCustomApi.replaceNamespacedCustomObject.mockResolvedValue({ body: {} });
      const vs = { metadata: { name: 'vs' }, spec: {} };

      await k8s.replaceVirtualService('ns', 'vs', vs);

      // K8s client uses positional params: (group, version, namespace, plural, name, body)
      expect(mockCustomApi.replaceNamespacedCustomObject).toHaveBeenCalledWith(
        'networking.istio.io',
        'v1beta1',
        'ns',
        'virtualservices',
        'vs',
        vs
      );
    });

    it('listVirtualServices should return all VS in namespace', async () => {
      const mockVSs = [{ metadata: { name: 'vs1' } }, { metadata: { name: 'vs2' } }];
      mockCustomApi.listNamespacedCustomObject.mockResolvedValue({ body: { items: mockVSs } });

      const result = await k8s.listVirtualServices('ns');

      expect(result).toEqual(mockVSs);
    });
  });

  describe('HTTPRoute operations', () => {
    beforeEach(async () => {
      await k8s.init();
    });

    it('getHTTPRoute should return route when found', async () => {
      const mockRoute = { metadata: { name: 'route' }, spec: { rules: [] } };
      mockCustomApi.getNamespacedCustomObject.mockResolvedValue({ body: mockRoute });

      const result = await k8s.getHTTPRoute('ns', 'route');

      expect(result).toEqual(mockRoute);
      // K8s client uses positional params: (group, version, namespace, plural, name)
      expect(mockCustomApi.getNamespacedCustomObject).toHaveBeenCalledWith(
        'gateway.networking.k8s.io',
        'v1',
        'ns',
        'httproutes',
        'route'
      );
    });

    it('listHTTPRoutes should return empty array when not found', async () => {
      mockCustomApi.listNamespacedCustomObject.mockRejectedValue({ response: { statusCode: 404 } });

      const result = await k8s.listHTTPRoutes('ns');

      expect(result).toEqual([]);
    });
  });

  describe('Workload operations', () => {
    beforeEach(async () => {
      await k8s.init();
    });

    it('getWorkload should return Deployment', async () => {
      const mockDeploy = { metadata: { name: 'deploy' }, spec: { replicas: 2 }, status: { readyReplicas: 2 } };
      mockAppsApi.readNamespacedDeployment.mockResolvedValue({ body: mockDeploy });

      const result = await k8s.getWorkload('ns', 'Deployment', 'deploy');

      expect(result).toEqual(mockDeploy);
    });

    it('getWorkload should return StatefulSet', async () => {
      const mockSts = { metadata: { name: 'sts' }, spec: { replicas: 3 } };
      mockAppsApi.readNamespacedStatefulSet.mockResolvedValue({ body: mockSts });

      const result = await k8s.getWorkload('ns', 'StatefulSet', 'sts');

      expect(result).toEqual(mockSts);
    });

    it('getWorkload should return null for unknown kind', async () => {
      const result = await k8s.getWorkload('ns', 'UnknownKind', 'name');

      expect(result).toBeNull();
      expect(console.warn).toHaveBeenCalledWith('Unknown workload kind: UnknownKind');
    });

    it('getWorkloadReadyReplicas should return ready replica count', async () => {
      mockAppsApi.readNamespacedDeployment.mockResolvedValue({
        body: { status: { readyReplicas: 5 } },
      });

      const result = await k8s.getWorkloadReadyReplicas('ns', 'Deployment', 'deploy');

      expect(result).toBe(5);
    });

    it('getWorkloadReadyReplicas should return 0 when workload not found', async () => {
      mockAppsApi.readNamespacedDeployment.mockRejectedValue({ response: { statusCode: 404 } });

      const result = await k8s.getWorkloadReadyReplicas('ns', 'Deployment', 'deploy');

      expect(result).toBe(0);
    });

    it('scaleWorkload should scale Deployment', async () => {
      mockAppsApi.patchNamespacedDeployment.mockResolvedValue({ body: {} });

      await k8s.scaleWorkload('ns', 'Deployment', 'deploy', 3);

      // K8s client uses positional params: (name, namespace, body, ...opts, { headers })
      expect(mockAppsApi.patchNamespacedDeployment).toHaveBeenCalledWith(
        'deploy',
        'ns',
        { spec: { replicas: 3 } },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/merge-patch+json' } }
      );
    });

    it('scaleWorkload should throw for unknown kind', async () => {
      await expect(k8s.scaleWorkload('ns', 'UnknownKind', 'name', 1))
        .rejects.toThrow('Cannot scale workload kind: UnknownKind');
    });
  });

  describe('Pod operations', () => {
    beforeEach(async () => {
      await k8s.init();
    });

    it('getPod should return pod when found', async () => {
      const mockPod = { metadata: { name: 'pod' } };
      mockCoreApi.readNamespacedPod.mockResolvedValue({ body: mockPod });

      const result = await k8s.getPod('ns', 'pod');

      expect(result).toEqual(mockPod);
    });

    it('listPodsWithSelector should return matching pods', async () => {
      const mockPods = [{ metadata: { name: 'pod1' } }, { metadata: { name: 'pod2' } }];
      mockCoreApi.listNamespacedPod.mockResolvedValue({ body: { items: mockPods } });

      const result = await k8s.listPodsWithSelector('ns', 'app=test');

      expect(result).toEqual(mockPods);
      // K8s client uses positional params: (namespace, pretty, allowWatchBookmarks, _continue, fieldSelector, labelSelector)
      expect(mockCoreApi.listNamespacedPod).toHaveBeenCalledWith('ns', undefined, undefined, undefined, undefined, 'app=test');
    });

    it('deletePod should delete pod', async () => {
      mockCoreApi.deleteNamespacedPod.mockResolvedValue({});

      await k8s.deletePod('ns', 'pod');

      // K8s client uses positional params: (name, namespace)
      expect(mockCoreApi.deleteNamespacedPod).toHaveBeenCalledWith('pod', 'ns');
    });

    it('createPod should create pod', async () => {
      const mockPod = { metadata: { name: 'pod' }, spec: {} };
      mockCoreApi.createNamespacedPod.mockResolvedValue({ body: mockPod });

      const result = await k8s.createPod('ns', mockPod);

      expect(result).toEqual(mockPod);
      // K8s client uses positional params: (namespace, body)
      expect(mockCoreApi.createNamespacedPod).toHaveBeenCalledWith('ns', mockPod);
    });
  });

  describe('findHPAForService', () => {
    beforeEach(async () => {
      await k8s.init();
    });

    it('should find HPA with same name as service', async () => {
      const mockHPA = { metadata: { name: 'my-service' }, spec: { scaleTargetRef: {} } };
      mockAutoscalingApi.readNamespacedHorizontalPodAutoscaler.mockResolvedValue({ body: mockHPA });

      const result = await k8s.findHPAForService('ns', 'my-service', {});

      expect(result).toEqual(mockHPA);
    });

    it('should find HPA by scaleTargetRef name', async () => {
      mockAutoscalingApi.readNamespacedHorizontalPodAutoscaler.mockRejectedValue({ response: { statusCode: 404 } });
      const mockHPAs = [
        { metadata: { name: 'hpa1' }, spec: { scaleTargetRef: { name: 'other' } } },
        { metadata: { name: 'hpa2' }, spec: { scaleTargetRef: { name: 'my-service' } } },
      ];
      mockAutoscalingApi.listNamespacedHorizontalPodAutoscaler.mockResolvedValue({ body: { items: mockHPAs } });

      const result = await k8s.findHPAForService('ns', 'my-service', {});

      expect(result).toEqual(mockHPAs[1]);
    });

    it('should find HPA by workload selector match', async () => {
      mockAutoscalingApi.readNamespacedHorizontalPodAutoscaler.mockRejectedValue({ response: { statusCode: 404 } });
      const mockHPAs = [
        { metadata: { name: 'hpa' }, spec: { scaleTargetRef: { kind: 'Deployment', name: 'deploy' } } },
      ];
      mockAutoscalingApi.listNamespacedHorizontalPodAutoscaler.mockResolvedValue({ body: { items: mockHPAs } });
      mockAppsApi.readNamespacedDeployment.mockResolvedValue({
        body: { spec: { template: { metadata: { labels: { app: 'test', tier: 'web' } } } } },
      });

      const result = await k8s.findHPAForService('ns', 'svc', { app: 'test', tier: 'web' });

      expect(result).toEqual(mockHPAs[0]);
    });

    it('should return null when no HPA found', async () => {
      mockAutoscalingApi.readNamespacedHorizontalPodAutoscaler.mockRejectedValue({ response: { statusCode: 404 } });
      mockAutoscalingApi.listNamespacedHorizontalPodAutoscaler.mockResolvedValue({ body: { items: [] } });

      const result = await k8s.findHPAForService('ns', 'svc', {});

      expect(result).toBeNull();
    });
  });

  describe('findWorkloadForService', () => {
    beforeEach(async () => {
      await k8s.init();
    });

    it('should return null for empty selector', async () => {
      const result = await k8s.findWorkloadForService('ns', {});
      expect(result).toBeNull();

      const result2 = await k8s.findWorkloadForService('ns', null);
      expect(result2).toBeNull();
    });

    it('should find Deployment matching selector', async () => {
      const mockDeploys = [
        { metadata: { name: 'deploy1' }, spec: { replicas: 2, template: { metadata: { labels: { app: 'other' } } } } },
        { metadata: { name: 'deploy2' }, spec: { replicas: 3, template: { metadata: { labels: { app: 'test' } } } } },
      ];
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ body: { items: mockDeploys } });
      mockAppsApi.listNamespacedStatefulSet.mockResolvedValue({ body: { items: [] } });
      mockAppsApi.listNamespacedReplicaSet.mockResolvedValue({ body: { items: [] } });

      const result = await k8s.findWorkloadForService('ns', { app: 'test' });

      expect(result).toEqual({ kind: 'Deployment', name: 'deploy2', replicas: 3 });
    });

    it('should find StatefulSet when no Deployment matches', async () => {
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ body: { items: [] } });
      const mockSts = [
        { metadata: { name: 'sts' }, spec: { replicas: 1, template: { metadata: { labels: { app: 'test' } } } } },
      ];
      mockAppsApi.listNamespacedStatefulSet.mockResolvedValue({ body: { items: mockSts } });
      mockAppsApi.listNamespacedReplicaSet.mockResolvedValue({ body: { items: [] } });

      const result = await k8s.findWorkloadForService('ns', { app: 'test' });

      expect(result).toEqual({ kind: 'StatefulSet', name: 'sts', replicas: 1 });
    });
  });

  describe('findVirtualServicesForService', () => {
    beforeEach(async () => {
      await k8s.init();
    });

    it('should find VS with matching short host', async () => {
      const mockVSs = [
        { metadata: { name: 'vs' }, spec: { http: [{ route: [{ destination: { host: 'my-service' } }] }] } },
      ];
      mockCustomApi.listNamespacedCustomObject.mockResolvedValue({ body: { items: mockVSs } });

      const result = await k8s.findVirtualServicesForService('ns', 'my-service');

      expect(result).toEqual(mockVSs);
    });

    it('should find VS with matching FQDN host', async () => {
      const mockVSs = [
        { metadata: { name: 'vs' }, spec: { http: [{ route: [{ destination: { host: 'svc.ns.svc.cluster.local' } }] }] } },
      ];
      mockCustomApi.listNamespacedCustomObject.mockResolvedValue({ body: { items: mockVSs } });

      const result = await k8s.findVirtualServicesForService('ns', 'svc');

      expect(result).toEqual(mockVSs);
    });

    it('should return empty array when no match', async () => {
      const mockVSs = [
        { metadata: { name: 'vs' }, spec: { http: [{ route: [{ destination: { host: 'other-service' } }] }] } },
      ];
      mockCustomApi.listNamespacedCustomObject.mockResolvedValue({ body: { items: mockVSs } });

      const result = await k8s.findVirtualServicesForService('ns', 'my-service');

      expect(result).toEqual([]);
    });
  });

  describe('findHTTPRoutesForService', () => {
    beforeEach(async () => {
      await k8s.init();
    });

    it('should find HTTPRoute with matching backendRef', async () => {
      const mockRoutes = [
        {
          metadata: { name: 'route' },
          spec: { rules: [{ backendRefs: [{ kind: 'Service', name: 'my-service' }] }] },
        },
      ];
      mockCustomApi.listNamespacedCustomObject.mockResolvedValue({ body: { items: mockRoutes } });

      const result = await k8s.findHTTPRoutesForService('ns', 'my-service');

      expect(result).toEqual(mockRoutes);
    });

    it('should not match non-Service backendRefs', async () => {
      const mockRoutes = [
        {
          metadata: { name: 'route' },
          spec: { rules: [{ backendRefs: [{ kind: 'Backend', name: 'my-service' }] }] },
        },
      ];
      mockCustomApi.listNamespacedCustomObject.mockResolvedValue({ body: { items: mockRoutes } });

      const result = await k8s.findHTTPRoutesForService('ns', 'my-service');

      expect(result).toEqual([]);
    });
  });

  describe('Lease operations', () => {
    beforeEach(async () => {
      await k8s.init();
    });

    describe('acquireLease', () => {
      it('should create new lease when none exists', async () => {
        mockCoordinationApi.readNamespacedLease.mockRejectedValue({ response: { statusCode: 404 } });
        mockCoordinationApi.createNamespacedLease.mockResolvedValue({ body: {} });

        const result = await k8s.acquireLease('ns', 'test-service', 30);

        expect(result).toBe(true);
        expect(mockCoordinationApi.createNamespacedLease).toHaveBeenCalledWith(
          'ns',
          expect.objectContaining({
            metadata: { name: 'scale0-test-service', namespace: 'ns' },
            spec: expect.objectContaining({
              holderIdentity: k8s.holderIdentity,
              leaseDurationSeconds: 30,
            }),
          })
        );
      });

      it('should renew lease when we already hold it', async () => {
        const existingLease = {
          metadata: { name: 'scale0-test-service', namespace: 'ns' },
          spec: {
            holderIdentity: k8s.holderIdentity,
            leaseDurationSeconds: 30,
            renewTime: new Date().toISOString(),
          },
        };
        mockCoordinationApi.readNamespacedLease.mockResolvedValue({ body: existingLease });
        mockCoordinationApi.replaceNamespacedLease.mockResolvedValue({ body: {} });

        const result = await k8s.acquireLease('ns', 'test-service', 30);

        expect(result).toBe(true);
        expect(mockCoordinationApi.replaceNamespacedLease).toHaveBeenCalled();
      });

      it('should take over expired lease from another holder', async () => {
        const expiredTime = new Date(Date.now() - 120000).toISOString(); // 2 minutes ago
        const existingLease = {
          metadata: { name: 'scale0-test-service', namespace: 'ns' },
          spec: {
            holderIdentity: 'other-holder',
            leaseDurationSeconds: 30,
            renewTime: expiredTime,
          },
        };
        mockCoordinationApi.readNamespacedLease.mockResolvedValue({ body: existingLease });
        mockCoordinationApi.replaceNamespacedLease.mockResolvedValue({ body: {} });

        const result = await k8s.acquireLease('ns', 'test-service', 30);

        expect(result).toBe(true);
        expect(mockCoordinationApi.replaceNamespacedLease).toHaveBeenCalledWith(
          'scale0-test-service',
          'ns',
          expect.objectContaining({
            spec: expect.objectContaining({
              holderIdentity: k8s.holderIdentity,
            }),
          })
        );
      });

      it('should fail to acquire lease held by another (not expired)', async () => {
        const recentTime = new Date().toISOString();
        const existingLease = {
          metadata: { name: 'scale0-test-service', namespace: 'ns' },
          spec: {
            holderIdentity: 'other-holder',
            leaseDurationSeconds: 60,
            renewTime: recentTime,
          },
        };
        mockCoordinationApi.readNamespacedLease.mockResolvedValue({ body: existingLease });

        const result = await k8s.acquireLease('ns', 'test-service', 30);

        expect(result).toBe(false);
        expect(mockCoordinationApi.replaceNamespacedLease).not.toHaveBeenCalled();
      });

      it('should return false on conflict (409)', async () => {
        mockCoordinationApi.readNamespacedLease.mockRejectedValue({ response: { statusCode: 404 } });
        mockCoordinationApi.createNamespacedLease.mockRejectedValue({ response: { statusCode: 409 } });

        const result = await k8s.acquireLease('ns', 'test-service', 30);

        expect(result).toBe(false);
      });
    });

    describe('releaseLease', () => {
      it('should delete lease when we hold it', async () => {
        const existingLease = {
          spec: { holderIdentity: k8s.holderIdentity },
        };
        mockCoordinationApi.readNamespacedLease.mockResolvedValue({ body: existingLease });
        mockCoordinationApi.deleteNamespacedLease.mockResolvedValue({});

        await k8s.releaseLease('ns', 'test-service');

        expect(mockCoordinationApi.deleteNamespacedLease).toHaveBeenCalledWith('scale0-test-service', 'ns');
      });

      it('should not delete lease held by another', async () => {
        const existingLease = {
          spec: { holderIdentity: 'other-holder' },
        };
        mockCoordinationApi.readNamespacedLease.mockResolvedValue({ body: existingLease });

        await k8s.releaseLease('ns', 'test-service');

        expect(mockCoordinationApi.deleteNamespacedLease).not.toHaveBeenCalled();
      });

      it('should handle 404 gracefully', async () => {
        mockCoordinationApi.readNamespacedLease.mockRejectedValue({ response: { statusCode: 404 } });

        await expect(k8s.releaseLease('ns', 'test-service')).resolves.not.toThrow();
      });
    });

    describe('getLease', () => {
      it('should return lease when found', async () => {
        const mockLease = { metadata: { name: 'scale0-test' }, spec: {} };
        mockCoordinationApi.readNamespacedLease.mockResolvedValue({ body: mockLease });

        const result = await k8s.getLease('ns', 'scale0-test');

        expect(result).toEqual(mockLease);
      });

      it('should return null when not found', async () => {
        mockCoordinationApi.readNamespacedLease.mockRejectedValue({ response: { statusCode: 404 } });

        const result = await k8s.getLease('ns', 'scale0-test');

        expect(result).toBeNull();
      });
    });
  });
});
