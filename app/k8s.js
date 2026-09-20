import k8s from '@kubernetes/client-node';
import fs from 'node:fs';

export class K8sClient {
  constructor() {
    this.kc = new k8s.KubeConfig();
    this.appsApi = null;
    this.autoscalingApi = null;
    this.coreApi = null;
    this.customApi = null;
  }

  async init() {
    const inClusterTokenPath = '/var/run/secrets/kubernetes.io/serviceaccount/token';
    if (fs.existsSync(inClusterTokenPath)) {
      this.kc.loadFromCluster();
      console.log('Loaded in-cluster config');
    } else {
      this.kc.loadFromDefault();
      console.log('Loaded default kubeconfig');
    }

    this.appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    this.autoscalingApi = this.kc.makeApiClient(k8s.AutoscalingV2Api);
    this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
  }

  async listServicesWithLabel(labelSelector) {
    const { body } = await this.coreApi.listServiceForAllNamespaces(undefined, undefined, undefined, labelSelector);
    return body.items;
  }

  async getService(namespace, name) {
    try {
      const { body } = await this.coreApi.readNamespacedService(name, namespace);
      return body;
    } catch (err) {
      if (err.response?.statusCode === 404) return null;
      throw err;
    }
  }

  async patchServiceAnnotations(namespace, name, annotations) {
    const { body } = await this.coreApi.patchNamespacedService(
      name,
      namespace,
      { metadata: { annotations } },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );
    return body;
  }

  async getHPA(namespace, name) {
    try {
      const { body } = await this.autoscalingApi.readNamespacedHorizontalPodAutoscaler(name, namespace);
      return body;
    } catch (err) {
      if (err.response?.statusCode === 404) return null;
      throw err;
    }
  }

  async patchHPA(namespace, name, patch) {
    const { body } = await this.autoscalingApi.patchNamespacedHorizontalPodAutoscaler(
      name,
      namespace,
      patch,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );
    return body;
  }

  async getVirtualService(namespace, name) {
    try {
      const { body } = await this.customApi.getNamespacedCustomObject(
        'networking.istio.io',
        'v1beta1',
        namespace,
        'virtualservices',
        name
      );
      return body;
    } catch (err) {
      if (err.response?.statusCode === 404) return null;
      throw err;
    }
  }

  async patchVirtualService(namespace, name, patch) {
    const { body } = await this.customApi.patchNamespacedCustomObject(
      'networking.istio.io',
      'v1beta1',
      namespace,
      'virtualservices',
      name,
      patch,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );
    return body;
  }

  async replaceVirtualService(namespace, name, vs) {
    const { body } = await this.customApi.replaceNamespacedCustomObject(
      'networking.istio.io',
      'v1beta1',
      namespace,
      'virtualservices',
      name,
      vs
    );
    return body;
  }

  async getWorkload(namespace, kind, name) {
    try {
      let body;
      switch (kind) {
        case 'Deployment':
          ({ body } = await this.appsApi.readNamespacedDeployment(name, namespace));
          break;
        case 'StatefulSet':
          ({ body } = await this.appsApi.readNamespacedStatefulSet(name, namespace));
          break;
        case 'ReplicaSet':
          ({ body } = await this.appsApi.readNamespacedReplicaSet(name, namespace));
          break;
        case 'ReplicationController':
          ({ body } = await this.coreApi.readNamespacedReplicationController(name, namespace));
          break;
        default:
          console.warn(`Unknown workload kind: ${kind}`);
          return null;
      }
      return body;
    } catch (err) {
      if (err.response?.statusCode === 404) return null;
      throw err;
    }
  }

  async getWorkloadReadyReplicas(namespace, kind, name) {
    const workload = await this.getWorkload(namespace, kind, name);
    if (!workload) return 0;
    return workload.status?.readyReplicas || 0;
  }

  async scaleWorkload(namespace, kind, name, replicas) {
    const patch = { spec: { replicas } };
    const opts = { headers: { 'Content-Type': 'application/merge-patch+json' } };

    switch (kind) {
      case 'Deployment':
        await this.appsApi.patchNamespacedDeployment(name, namespace, patch, undefined, undefined, undefined, undefined, undefined, opts);
        break;
      case 'StatefulSet':
        await this.appsApi.patchNamespacedStatefulSet(name, namespace, patch, undefined, undefined, undefined, undefined, undefined, opts);
        break;
      case 'ReplicaSet':
        await this.appsApi.patchNamespacedReplicaSet(name, namespace, patch, undefined, undefined, undefined, undefined, undefined, opts);
        break;
      case 'ReplicationController':
        await this.coreApi.patchNamespacedReplicationController(name, namespace, patch, undefined, undefined, undefined, undefined, undefined, opts);
        break;
      default:
        throw new Error(`Cannot scale workload kind: ${kind}`);
    }
  }

  async findWorkloadForService(namespace, serviceSelector) {
    if (!serviceSelector || Object.keys(serviceSelector).length === 0) {
      return null;
    }

    const kinds = ['Deployment', 'StatefulSet', 'ReplicaSet'];
    for (const kind of kinds) {
      try {
        let items = [];
        switch (kind) {
          case 'Deployment':
            items = (await this.appsApi.listNamespacedDeployment(namespace)).body.items;
            break;
          case 'StatefulSet':
            items = (await this.appsApi.listNamespacedStatefulSet(namespace)).body.items;
            break;
          case 'ReplicaSet':
            items = (await this.appsApi.listNamespacedReplicaSet(namespace)).body.items;
            break;
        }

        for (const workload of items) {
          const podLabels = workload.spec?.template?.metadata?.labels || {};
          const matches = Object.entries(serviceSelector).every(
            ([key, value]) => podLabels[key] === value
          );
          if (matches) {
            return { kind, name: workload.metadata.name, replicas: workload.spec?.replicas ?? 1 };
          }
        }
      } catch (err) {
        console.warn(`Error listing ${kind}:`, err.message);
      }
    }

    return null;
  }

  async getPod(namespace, name) {
    try {
      const { body } = await this.coreApi.readNamespacedPod(name, namespace);
      return body;
    } catch (err) {
      if (err.response?.statusCode === 404) return null;
      throw err;
    }
  }

  async listPodsWithSelector(namespace, labelSelector) {
    const { body } = await this.coreApi.listNamespacedPod(namespace, undefined, undefined, undefined, undefined, labelSelector);
    return body.items;
  }

  async deletePod(namespace, name) {
    await this.coreApi.deleteNamespacedPod(name, namespace);
  }

  async createPod(namespace, pod) {
    const { body } = await this.coreApi.createNamespacedPod(namespace, pod);
    return body;
  }

  async listHPAs(namespace) {
    const { body } = await this.autoscalingApi.listNamespacedHorizontalPodAutoscaler(namespace);
    return body.items;
  }

  // Gateway API HTTPRoute methods
  async getHTTPRoute(namespace, name) {
    try {
      const { body } = await this.customApi.getNamespacedCustomObject(
        'gateway.networking.k8s.io',
        'v1',
        namespace,
        'httproutes',
        name
      );
      return body;
    } catch (err) {
      if (err.response?.statusCode === 404) return null;
      throw err;
    }
  }

  async listHTTPRoutes(namespace) {
    try {
      const { body } = await this.customApi.listNamespacedCustomObject(
        'gateway.networking.k8s.io',
        'v1',
        namespace,
        'httproutes'
      );
      return body.items || [];
    } catch (err) {
      if (err.response?.statusCode === 404) return [];
      throw err;
    }
  }

  async replaceHTTPRoute(namespace, name, route) {
    const { body } = await this.customApi.replaceNamespacedCustomObject(
      'gateway.networking.k8s.io',
      'v1',
      namespace,
      'httproutes',
      name,
      route
    );
    return body;
  }

  async findHTTPRoutesForService(namespace, serviceName) {
    const found = [];
    const routes = await this.listHTTPRoutes(namespace);

    for (const route of routes) {
      const rules = route.spec?.rules || [];
      for (const rule of rules) {
        const backendRefs = rule.backendRefs || [];
        for (const ref of backendRefs) {
          if (ref.kind === 'Service' && ref.name === serviceName) {
            found.push(route);
            break;
          }
        }
        if (found.includes(route)) break;
      }
    }

    return found;
  }

  async listVirtualServices(namespace) {
    try {
      const { body } = await this.customApi.listNamespacedCustomObject(
        'networking.istio.io',
        'v1beta1',
        namespace,
        'virtualservices'
      );
      return body.items || [];
    } catch (err) {
      if (err.response?.statusCode === 404) return [];
      throw err;
    }
  }

  async findVirtualServicesForService(namespace, serviceName) {
    const found = [];
    const virtualServices = await this.listVirtualServices(namespace);

    for (const vs of virtualServices) {
      const routes = vs.spec?.http || [];
      for (const route of routes) {
        const destinations = route.route || [];
        for (const dest of destinations) {
          const host = dest.destination?.host;
          if (host === serviceName ||
              host === `${serviceName}.${namespace}` ||
              host === `${serviceName}.${namespace}.svc` ||
              host === `${serviceName}.${namespace}.svc.cluster.local`) {
            found.push(vs);
            break;
          }
        }
        if (found.includes(vs)) break;
      }
    }

    return found;
  }

  async findHPAForService(namespace, serviceName, serviceSelector) {
    // Strategy 1: Try HPA with same name as service
    const sameName = await this.getHPA(namespace, serviceName);
    if (sameName) {
      return sameName;
    }

    // Strategy 2: List all HPAs and find one whose scaleTargetRef.name matches service name
    const hpas = await this.listHPAs(namespace);
    const byTargetName = hpas.find(hpa => hpa.spec.scaleTargetRef?.name === serviceName);
    if (byTargetName) {
      return byTargetName;
    }

    // Strategy 3: Find workload matching service selector, then find HPA targeting it
    if (serviceSelector && Object.keys(serviceSelector).length > 0) {
      for (const hpa of hpas) {
        const ref = hpa.spec.scaleTargetRef;
        if (!ref) continue;

        const workload = await this.getWorkload(namespace, ref.kind, ref.name);
        if (!workload) continue;

        const podLabels = workload.spec?.template?.metadata?.labels || {};
        const matches = Object.entries(serviceSelector).every(
          ([key, value]) => podLabels[key] === value
        );

        if (matches) {
          return hpa;
        }
      }
    }

    return null;
  }
}
