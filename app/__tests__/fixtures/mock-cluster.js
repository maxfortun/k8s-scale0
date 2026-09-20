export function createMockCluster() {
  const state = {
    services: new Map(),
    hpas: new Map(),
    virtualServices: new Map(),
    httpRoutes: new Map(),
    workloads: new Map(),
    pods: new Map(),
  };

  const api = {
    addService(ns, name, spec = {}) {
      state.services.set(`${ns}/${name}`, {
        metadata: {
          namespace: ns,
          name,
          labels: { 'scale0/enabled': 'true', ...spec.labels },
          annotations: spec.annotations || {},
        },
        spec: { selector: spec.selector || {} },
      });
      return api;
    },

    addHPA(ns, name, spec) {
      state.hpas.set(`${ns}/${name}`, {
        metadata: { namespace: ns, name },
        spec: {
          minReplicas: spec.minReplicas ?? 1,
          maxReplicas: spec.maxReplicas ?? 5,
          scaleTargetRef: spec.scaleTargetRef || { kind: 'Deployment', name },
        },
      });
      return api;
    },

    addVirtualService(ns, name, host) {
      state.virtualServices.set(`${ns}/${name}`, {
        metadata: { namespace: ns, name },
        spec: {
          http: [{
            match: [{ uri: { prefix: '/' } }],
            route: [{ destination: { host, port: { number: 8080 } } }],
          }],
        },
      });
      return api;
    },

    addHTTPRoute(ns, name, serviceName) {
      state.httpRoutes.set(`${ns}/${name}`, {
        metadata: { namespace: ns, name },
        spec: {
          rules: [{
            matches: [{ path: { type: 'PathPrefix', value: '/' } }],
            backendRefs: [{ kind: 'Service', name: serviceName, port: 8080 }],
          }],
        },
      });
      return api;
    },

    addDeployment(ns, name, replicas, selector) {
      state.workloads.set(`${ns}/Deployment/${name}`, {
        kind: 'Deployment',
        metadata: { namespace: ns, name },
        spec: {
          replicas,
          template: { metadata: { labels: selector } },
        },
        status: { readyReplicas: replicas },
      });
      return api;
    },

    addStatefulSet(ns, name, replicas, selector) {
      state.workloads.set(`${ns}/StatefulSet/${name}`, {
        kind: 'StatefulSet',
        metadata: { namespace: ns, name },
        spec: {
          replicas,
          template: { metadata: { labels: selector } },
        },
        status: { readyReplicas: replicas },
      });
      return api;
    },

    addPod(ns, name, labels) {
      state.pods.set(`${ns}/${name}`, {
        metadata: {
          namespace: ns,
          name,
          labels,
        },
        spec: {
          containers: [{ name: 'main', image: 'nginx:1.25' }],
        },
        status: { phase: 'Running' },
      });
      return api;
    },

    getState() {
      return state;
    },

    createK8sClient() {
      return {
        async listServicesWithLabel(selector) {
          return Array.from(state.services.values()).filter(svc => {
            const [key, value] = selector.split('=');
            return svc.metadata.labels?.[key] === value;
          });
        },

        async getHPA(ns, name) {
          return state.hpas.get(`${ns}/${name}`) || null;
        },

        async patchHPA(ns, name, patch) {
          const hpa = state.hpas.get(`${ns}/${name}`);
          if (hpa && patch.spec) {
            Object.assign(hpa.spec, patch.spec);
          }
          return hpa;
        },

        async listHPAs(ns) {
          return Array.from(state.hpas.values())
            .filter(h => h.metadata.namespace === ns);
        },

        async findHPAForService(ns, serviceName) {
          const sameName = state.hpas.get(`${ns}/${serviceName}`);
          if (sameName) return sameName;

          for (const hpa of state.hpas.values()) {
            if (hpa.metadata.namespace === ns &&
                hpa.spec.scaleTargetRef?.name === serviceName) {
              return hpa;
            }
          }
          return null;
        },

        async getVirtualService(ns, name) {
          return state.virtualServices.get(`${ns}/${name}`) || null;
        },

        async replaceVirtualService(ns, name, vs) {
          state.virtualServices.set(`${ns}/${name}`, vs);
          return vs;
        },

        async listVirtualServices(ns) {
          return Array.from(state.virtualServices.values())
            .filter(vs => vs.metadata.namespace === ns);
        },

        async findVirtualServicesForService(ns, serviceName) {
          return Array.from(state.virtualServices.values()).filter(vs => {
            if (vs.metadata.namespace !== ns) return false;
            return (vs.spec?.http || []).some(route =>
              (route.route || []).some(dest => {
                const host = dest.destination?.host;
                return host === serviceName ||
                       host?.startsWith(`${serviceName}.`);
              })
            );
          });
        },

        async getHTTPRoute(ns, name) {
          return state.httpRoutes.get(`${ns}/${name}`) || null;
        },

        async replaceHTTPRoute(ns, name, route) {
          state.httpRoutes.set(`${ns}/${name}`, route);
          return route;
        },

        async listHTTPRoutes(ns) {
          return Array.from(state.httpRoutes.values())
            .filter(r => r.metadata.namespace === ns);
        },

        async findHTTPRoutesForService(ns, serviceName) {
          return Array.from(state.httpRoutes.values()).filter(route => {
            if (route.metadata.namespace !== ns) return false;
            return (route.spec?.rules || []).some(rule =>
              (rule.backendRefs || []).some(ref =>
                ref.kind === 'Service' && ref.name === serviceName
              )
            );
          });
        },

        async findWorkloadForService(ns, selector) {
          if (!selector || Object.keys(selector).length === 0) return null;

          for (const [key, workload] of state.workloads) {
            if (!key.startsWith(`${ns}/`)) continue;
            const podLabels = workload.spec?.template?.metadata?.labels || {};
            const matches = Object.entries(selector)
              .every(([k, v]) => podLabels[k] === v);
            if (matches) {
              return {
                kind: workload.kind,
                name: workload.metadata.name,
                replicas: workload.spec.replicas,
              };
            }
          }
          return null;
        },

        async scaleWorkload(ns, kind, name, replicas) {
          const key = `${ns}/${kind}/${name}`;
          const workload = state.workloads.get(key);
          if (workload) {
            workload.spec.replicas = replicas;
            workload.status.readyReplicas = replicas;
          }
        },

        async getWorkload(ns, kind, name) {
          return state.workloads.get(`${ns}/${kind}/${name}`) || null;
        },

        async getWorkloadReadyReplicas(ns, kind, name) {
          const workload = state.workloads.get(`${ns}/${kind}/${name}`);
          return workload?.status?.readyReplicas || 0;
        },

        async listPodsWithSelector(ns, selectorStr) {
          const selectorParts = selectorStr.split(',')
            .map(p => p.split('='));
          return Array.from(state.pods.values()).filter(pod => {
            if (pod.metadata.namespace !== ns) return false;
            return selectorParts.every(([k, v]) =>
              pod.metadata.labels?.[k] === v
            );
          });
        },

        async getPod(ns, name) {
          return state.pods.get(`${ns}/${name}`) || null;
        },

        async deletePod(ns, name) {
          state.pods.delete(`${ns}/${name}`);
        },

        async createPod(ns, pod) {
          state.pods.set(`${ns}/${pod.metadata.name}`, pod);
          return pod;
        },

        async init() {},
      };
    },
  };

  return api;
}

export const scenarios = {
  simpleHPA() {
    return createMockCluster()
      .addService('demo', 'web-app', {
        selector: { app: 'web' },
        labels: { 'scale0/scale-in-after': '60' },
      })
      .addHPA('demo', 'web-app', {
        minReplicas: 2,
        maxReplicas: 10,
        scaleTargetRef: { kind: 'Deployment', name: 'web-app' },
      })
      .addVirtualService('demo', 'web-app-vs', 'web-app')
      .addDeployment('demo', 'web-app', 2, { app: 'web' });
  },

  workloadWithoutHPA() {
    return createMockCluster()
      .addService('demo', 'worker', {
        selector: { app: 'worker' },
        labels: { 'scale0/scale-in-after': '120' },
      })
      .addVirtualService('demo', 'worker-vs', 'worker')
      .addDeployment('demo', 'worker-deploy', 3, { app: 'worker' });
  },

  gatewayAPI() {
    return createMockCluster()
      .addService('demo', 'api-svc', {
        selector: { app: 'api' },
        labels: { 'scale0/scale-in-after': '180' },
      })
      .addHPA('demo', 'api-svc', {
        minReplicas: 1,
        maxReplicas: 5,
      })
      .addHTTPRoute('demo', 'api-route', 'api-svc')
      .addDeployment('demo', 'api-svc', 1, { app: 'api' });
  },

  multipleRoutes() {
    return createMockCluster()
      .addService('demo', 'multi-app', {
        selector: { app: 'multi' },
        labels: { 'scale0/scale-in-after': '90' },
      })
      .addHPA('demo', 'multi-app', { minReplicas: 1, maxReplicas: 3 })
      .addVirtualService('demo', 'multi-vs-public', 'multi-app')
      .addVirtualService('demo', 'multi-vs-internal', 'multi-app.demo.svc.cluster.local')
      .addHTTPRoute('demo', 'multi-route', 'multi-app')
      .addDeployment('demo', 'multi-app', 1, { app: 'multi' });
  },

  statefulSet() {
    return createMockCluster()
      .addService('demo', 'db', {
        selector: { app: 'database' },
        labels: { 'scale0/scale-in-after': '300' },
      })
      .addHPA('demo', 'db', {
        minReplicas: 1,
        maxReplicas: 3,
        scaleTargetRef: { kind: 'StatefulSet', name: 'db-sts' },
      })
      .addVirtualService('demo', 'db-vs', 'db')
      .addStatefulSet('demo', 'db-sts', 1, { app: 'database' });
  },

  standalonePods() {
    return createMockCluster()
      .addService('demo', 'job-runner', {
        selector: { job: 'processor' },
        labels: { 'scale0/scale-in-after': '60' },
      })
      .addVirtualService('demo', 'job-vs', 'job-runner')
      .addPod('demo', 'job-pod-1', { job: 'processor' })
      .addPod('demo', 'job-pod-2', { job: 'processor' });
  },

  fullStack() {
    return createMockCluster()
      .addService('production', 'frontend', {
        selector: { tier: 'frontend' },
        labels: { 'scale0/scale-in-after': '120' },
      })
      .addService('production', 'backend', {
        selector: { tier: 'backend' },
        labels: { 'scale0/scale-in-after': '180' },
      })
      .addService('production', 'cache', {
        selector: { tier: 'cache' },
        labels: { 'scale0/scale-in-after': '300' },
      })
      .addHPA('production', 'frontend', { minReplicas: 2, maxReplicas: 20 })
      .addHPA('production', 'backend', { minReplicas: 3, maxReplicas: 15 })
      .addHPA('production', 'cache', { minReplicas: 1, maxReplicas: 5 })
      .addVirtualService('production', 'frontend-vs', 'frontend')
      .addVirtualService('production', 'backend-vs', 'backend')
      .addVirtualService('production', 'cache-vs', 'cache')
      .addDeployment('production', 'frontend', 2, { tier: 'frontend' })
      .addDeployment('production', 'backend', 3, { tier: 'backend' })
      .addStatefulSet('production', 'cache', 1, { tier: 'cache' });
  },
};
