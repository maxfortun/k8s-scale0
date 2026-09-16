export class Controller {
  constructor(k8s, store, config) {
    this.k8s = k8s;
    this.store = store;
    this.config = config;
    this.intervalId = null;
    this.scale0ServiceName = process.env.SCALE0_SERVICE_NAME || 'scale0';
    this.scale0ServiceNamespace = process.env.SCALE0_SERVICE_NAMESPACE || 'scale0';
  }

  async start() {
    console.log('Controller starting...');
    await this.reconcile();
    this.intervalId = setInterval(() => this.reconcile(), this.config.checkIntervalMs);
    console.log(`Controller running, checking every ${this.config.checkIntervalMs}ms`);
  }

  async stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log('Controller stopped');
  }

  async reconcile() {
    try {
      const labelSelector = `${this.config.labelPrefix}/enabled=true`;
      const services = await this.k8s.listServicesWithLabel(labelSelector);

      for (const svc of services) {
        await this.processService(svc);
      }
    } catch (err) {
      console.error('Reconcile error:', err.message);
    }
  }

  async processService(svc) {
    const { namespace, name } = svc.metadata;
    const labels = svc.metadata.labels || {};
    const annotations = svc.metadata.annotations || {};

    const scaleInAfterSeconds = parseInt(
      labels[`${this.config.labelPrefix}/scale-in-after`] ||
      annotations[`${this.config.labelPrefix}/scale-in-after`] ||
      this.config.scaleInAfterSeconds,
      10
    );

    const hpaName = labels[`${this.config.labelPrefix}/hpa`] ||
      annotations[`${this.config.labelPrefix}/hpa`] ||
      name;

    const vsName = labels[`${this.config.labelPrefix}/virtualservice`] ||
      annotations[`${this.config.labelPrefix}/virtualservice`] ||
      name;

    // Initialize tracking if not already
    if (!this.store.getLastActivity(namespace, name)) {
      this.store.recordActivity(namespace, name);
      console.log(`Started tracking ${namespace}/${name}`);
    }

    const lastActivity = this.store.getLastActivity(namespace, name);
    const idleMs = Date.now() - lastActivity;
    const scaleInThresholdMs = scaleInAfterSeconds * 1000;

    if (this.store.isScaledDown(namespace, name)) {
      // Already scaled down, nothing to do
      return;
    }

    if (idleMs >= scaleInThresholdMs) {
      console.log(`Service ${namespace}/${name} idle for ${Math.round(idleMs / 1000)}s, scaling down...`);
      await this.scaleDown(namespace, name, hpaName, vsName);
    }
  }

  async scaleDown(namespace, serviceName, hpaName, vsName) {
    try {
      // Get current HPA state
      const hpa = await this.k8s.getHPA(namespace, hpaName);
      if (!hpa) {
        console.warn(`HPA ${namespace}/${hpaName} not found, skipping scale-down`);
        return;
      }

      // Get current VirtualService state
      const vs = await this.k8s.getVirtualService(namespace, vsName);
      if (!vs) {
        console.warn(`VirtualService ${namespace}/${vsName} not found, skipping scale-down`);
        return;
      }

      // Save original state
      const originalState = {
        hpa: {
          name: hpaName,
          minReplicas: hpa.spec.minReplicas,
          maxReplicas: hpa.spec.maxReplicas,
        },
        virtualService: {
          name: vsName,
          spec: JSON.parse(JSON.stringify(vs.spec)),
        },
      };

      // Scale HPA to 0
      await this.k8s.patchHPA(namespace, hpaName, {
        spec: {
          minReplicas: 0,
          maxReplicas: 0,
        },
      });
      console.log(`Scaled HPA ${namespace}/${hpaName} to 0`);

      // Modify VirtualService to route to scale0
      const modifiedVs = this.createScale0VirtualService(vs, serviceName);
      await this.k8s.replaceVirtualService(namespace, vsName, modifiedVs);
      console.log(`Redirected VirtualService ${namespace}/${vsName} to scale0`);

      // Save state
      this.store.saveScaledDownState(namespace, serviceName, originalState);
      console.log(`Service ${namespace}/${serviceName} scaled down successfully`);
    } catch (err) {
      console.error(`Failed to scale down ${namespace}/${serviceName}:`, err.message);
    }
  }

  createScale0VirtualService(vs, originalServiceName) {
    const modified = JSON.parse(JSON.stringify(vs));

    // Modify each HTTP route to point to scale0
    if (modified.spec.http) {
      modified.spec.http = modified.spec.http.map((route) => {
        // Add header to identify the original service
        const scale0Route = {
          destination: {
            host: `${this.scale0ServiceName}.${this.scale0ServiceNamespace}.svc.cluster.local`,
            port: { number: 8080 },
          },
          weight: 100,
          headers: {
            request: {
              set: {
                'x-scale0-original-service': originalServiceName,
                'x-scale0-original-namespace': vs.metadata.namespace,
              },
            },
          },
        };

        return {
          ...route,
          route: [scale0Route],
        };
      });
    }

    return modified;
  }

  async wakeUp(namespace, serviceName) {
    const state = this.store.getScaledDownState(namespace, serviceName);
    if (!state) {
      console.warn(`No saved state for ${namespace}/${serviceName}`);
      return false;
    }

    try {
      // Restore HPA
      await this.k8s.patchHPA(namespace, state.hpa.name, {
        spec: {
          minReplicas: state.hpa.minReplicas,
          maxReplicas: state.hpa.maxReplicas,
        },
      });
      console.log(`Restored HPA ${namespace}/${state.hpa.name}`);

      // Restore VirtualService
      const currentVs = await this.k8s.getVirtualService(namespace, state.virtualService.name);
      if (currentVs) {
        currentVs.spec = state.virtualService.spec;
        await this.k8s.replaceVirtualService(namespace, state.virtualService.name, currentVs);
        console.log(`Restored VirtualService ${namespace}/${state.virtualService.name}`);
      }

      // Update tracking
      this.store.recordActivity(namespace, serviceName);
      this.store.removeScaledDownState(namespace, serviceName);

      console.log(`Service ${namespace}/${serviceName} woken up successfully`);
      return true;
    } catch (err) {
      console.error(`Failed to wake up ${namespace}/${serviceName}:`, err.message);
      return false;
    }
  }
}
