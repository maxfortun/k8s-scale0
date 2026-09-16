import k8s from '@kubernetes/client-node';

export class K8sClient {
  constructor() {
    this.kc = new k8s.KubeConfig();
    this.appsApi = null;
    this.autoscalingApi = null;
    this.coreApi = null;
    this.customApi = null;
  }

  async init() {
    try {
      this.kc.loadFromCluster();
      console.log('Loaded in-cluster config');
    } catch {
      this.kc.loadFromDefault();
      console.log('Loaded default kubeconfig');
    }

    this.appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    this.autoscalingApi = this.kc.makeApiClient(k8s.AutoscalingV2Api);
    this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
  }

  async listServicesWithLabel(labelSelector) {
    const { body } = await this.coreApi.listServiceForAllNamespaces({ labelSelector });
    return body.items;
  }

  async getHPA(namespace, name) {
    try {
      const { body } = await this.autoscalingApi.readNamespacedHorizontalPodAutoscaler({ namespace, name });
      return body;
    } catch (err) {
      if (err.response?.statusCode === 404) return null;
      throw err;
    }
  }

  async patchHPA(namespace, name, patch) {
    const { body } = await this.autoscalingApi.patchNamespacedHorizontalPodAutoscaler({
      namespace,
      name,
      body: patch,
    }, {
      headers: { 'Content-Type': 'application/merge-patch+json' },
    });
    return body;
  }

  async getVirtualService(namespace, name) {
    try {
      const { body } = await this.customApi.getNamespacedCustomObject({
        group: 'networking.istio.io',
        version: 'v1beta1',
        namespace,
        plural: 'virtualservices',
        name,
      });
      return body;
    } catch (err) {
      if (err.response?.statusCode === 404) return null;
      throw err;
    }
  }

  async patchVirtualService(namespace, name, patch) {
    const { body } = await this.customApi.patchNamespacedCustomObject({
      group: 'networking.istio.io',
      version: 'v1beta1',
      namespace,
      plural: 'virtualservices',
      name,
      body: patch,
    }, {
      headers: { 'Content-Type': 'application/merge-patch+json' },
    });
    return body;
  }

  async replaceVirtualService(namespace, name, vs) {
    const { body } = await this.customApi.replaceNamespacedCustomObject({
      group: 'networking.istio.io',
      version: 'v1beta1',
      namespace,
      plural: 'virtualservices',
      name,
      body: vs,
    });
    return body;
  }

  async getWorkload(namespace, kind, name) {
    try {
      let body;
      switch (kind) {
        case 'Deployment':
          ({ body } = await this.appsApi.readNamespacedDeployment({ namespace, name }));
          break;
        case 'StatefulSet':
          ({ body } = await this.appsApi.readNamespacedStatefulSet({ namespace, name }));
          break;
        case 'ReplicaSet':
          ({ body } = await this.appsApi.readNamespacedReplicaSet({ namespace, name }));
          break;
        case 'ReplicationController':
          ({ body } = await this.coreApi.readNamespacedReplicationController({ namespace, name }));
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
}
