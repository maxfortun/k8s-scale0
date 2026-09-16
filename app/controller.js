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

    const hpaLabelValue = labels[`${this.config.labelPrefix}/hpa`] ||
      annotations[`${this.config.labelPrefix}/hpa`];

    const vsLabelValue = labels[`${this.config.labelPrefix}/virtualservice`] ||
      annotations[`${this.config.labelPrefix}/virtualservice`];

    const serviceSelector = svc.spec?.selector || {};

    // Determine scaling mode: hpa, workload, or pod
    let scaleMode = null;
    let scaleTarget = null;

    // Try HPA first
    if (hpaLabelValue) {
      scaleMode = 'hpa';
      scaleTarget = { name: hpaLabelValue };
    } else {
      const discoveredHpa = await this.k8s.findHPAForService(namespace, name, serviceSelector);
      if (discoveredHpa) {
        scaleMode = 'hpa';
        scaleTarget = { name: discoveredHpa.metadata.name };
        console.log(`Auto-discovered HPA ${namespace}/${scaleTarget.name} for service ${name}`);
      }
    }

    // If no HPA, try workload directly
    if (!scaleMode) {
      const workload = await this.k8s.findWorkloadForService(namespace, serviceSelector);
      if (workload) {
        scaleMode = 'workload';
        scaleTarget = workload;
        console.log(`Auto-discovered ${workload.kind} ${namespace}/${workload.name} for service ${name} (no HPA)`);
      }
    }

    // If no workload, try standalone pods
    if (!scaleMode && Object.keys(serviceSelector).length > 0) {
      const selectorStr = Object.entries(serviceSelector).map(([k, v]) => `${k}=${v}`).join(',');
      const pods = await this.k8s.listPodsWithSelector(namespace, selectorStr);
      if (pods.length > 0) {
        scaleMode = 'pod';
        scaleTarget = { pods: pods.map(p => ({ name: p.metadata.name, spec: p })) };
        console.log(`Found ${pods.length} standalone pod(s) for service ${name}`);
      }
    }

    if (!scaleMode) {
      console.warn(`No scalable resource found for service ${namespace}/${name}, skipping`);
      return;
    }

    // Auto-discover VirtualServices if not explicitly specified
    let vsNames = [];
    if (vsLabelValue) {
      vsNames = vsLabelValue.split(',').map(s => s.trim());
    } else {
      const discoveredVsList = await this.k8s.findVirtualServicesForService(namespace, name);
      if (discoveredVsList.length > 0) {
        vsNames = discoveredVsList.map(vs => vs.metadata.name);
        console.log(`Auto-discovered ${vsNames.length} VirtualService(s) for service ${name}: ${vsNames.join(', ')}`);
      } else {
        console.warn(`No VirtualService found for service ${namespace}/${name}, skipping`);
        return;
      }
    }

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
      await this.scaleDown(namespace, name, scaleMode, scaleTarget, vsNames);
    }
  }

  async scaleDown(namespace, serviceName, scaleMode, scaleTarget, vsNames) {
    try {
      // Get current VirtualService states
      const virtualServices = [];
      for (const vsName of vsNames) {
        const vs = await this.k8s.getVirtualService(namespace, vsName);
        if (vs) {
          virtualServices.push({
            name: vsName,
            spec: JSON.parse(JSON.stringify(vs.spec)),
          });
        } else {
          console.warn(`VirtualService ${namespace}/${vsName} not found, skipping`);
        }
      }

      if (virtualServices.length === 0) {
        console.warn(`No VirtualServices found for service ${namespace}/${serviceName}, skipping scale-down`);
        return;
      }

      // Build original state based on scale mode
      const originalState = { scaleMode, virtualServices };

      if (scaleMode === 'hpa') {
        const hpa = await this.k8s.getHPA(namespace, scaleTarget.name);
        if (!hpa) {
          console.warn(`HPA ${namespace}/${scaleTarget.name} not found, skipping scale-down`);
          return;
        }
        const scaleTargetRef = hpa.spec.scaleTargetRef;
        originalState.hpa = {
          name: scaleTarget.name,
          minReplicas: hpa.spec.minReplicas,
          maxReplicas: hpa.spec.maxReplicas,
        };
        originalState.workload = {
          kind: scaleTargetRef.kind,
          name: scaleTargetRef.name,
          apiVersion: scaleTargetRef.apiVersion,
        };

        // Scale HPA to 0
        await this.k8s.patchHPA(namespace, scaleTarget.name, {
          spec: { minReplicas: 0, maxReplicas: 0 },
        });
        console.log(`Scaled HPA ${namespace}/${scaleTarget.name} to 0`);

      } else if (scaleMode === 'workload') {
        originalState.workload = {
          kind: scaleTarget.kind,
          name: scaleTarget.name,
          replicas: scaleTarget.replicas,
        };

        // Scale workload to 0
        await this.k8s.scaleWorkload(namespace, scaleTarget.kind, scaleTarget.name, 0);
        console.log(`Scaled ${scaleTarget.kind} ${namespace}/${scaleTarget.name} to 0`);

      } else if (scaleMode === 'pod') {
        originalState.pods = scaleTarget.pods.map(p => ({
          name: p.name,
          spec: JSON.parse(JSON.stringify(p.spec)),
        }));

        // Delete pods
        for (const pod of scaleTarget.pods) {
          await this.k8s.deletePod(namespace, pod.name);
          console.log(`Deleted pod ${namespace}/${pod.name}`);
        }
      }

      // Modify all VirtualServices to route to scale0
      for (const vsState of virtualServices) {
        const vs = await this.k8s.getVirtualService(namespace, vsState.name);
        if (vs) {
          const modifiedVs = this.createScale0VirtualService(vs, serviceName);
          await this.k8s.replaceVirtualService(namespace, vsState.name, modifiedVs);
          console.log(`Redirected VirtualService ${namespace}/${vsState.name} to scale0`);
        }
      }

      // Save state
      this.store.saveScaledDownState(namespace, serviceName, originalState);
      const targetDesc = scaleMode === 'pod' ? `${originalState.pods.length} pod(s)` : `${originalState.workload.kind}/${originalState.workload.name}`;
      console.log(`Service ${namespace}/${serviceName} (${targetDesc}) scaled down successfully`);
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
      const scaleMode = state.scaleMode || 'hpa'; // backwards compatibility

      if (scaleMode === 'hpa' && state.hpa) {
        await this.k8s.patchHPA(namespace, state.hpa.name, {
          spec: {
            minReplicas: state.hpa.minReplicas,
            maxReplicas: state.hpa.maxReplicas,
          },
        });
        console.log(`Restored HPA ${namespace}/${state.hpa.name}`);

      } else if (scaleMode === 'workload' && state.workload) {
        await this.k8s.scaleWorkload(
          namespace,
          state.workload.kind,
          state.workload.name,
          state.workload.replicas
        );
        console.log(`Restored ${state.workload.kind} ${namespace}/${state.workload.name} to ${state.workload.replicas} replicas`);

      } else if (scaleMode === 'pod' && state.pods) {
        for (const podState of state.pods) {
          // Clean up spec for recreation
          const newPod = JSON.parse(JSON.stringify(podState.spec));
          delete newPod.metadata.resourceVersion;
          delete newPod.metadata.uid;
          delete newPod.metadata.creationTimestamp;
          delete newPod.status;
          if (newPod.metadata.annotations) {
            delete newPod.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];
          }

          await this.k8s.createPod(namespace, newPod);
          console.log(`Recreated pod ${namespace}/${podState.name}`);
        }
      }

      // Restore all VirtualServices
      const virtualServices = state.virtualServices || (state.virtualService ? [state.virtualService] : []);
      for (const vsState of virtualServices) {
        const currentVs = await this.k8s.getVirtualService(namespace, vsState.name);
        if (currentVs) {
          currentVs.spec = vsState.spec;
          await this.k8s.replaceVirtualService(namespace, vsState.name, currentVs);
          console.log(`Restored VirtualService ${namespace}/${vsState.name}`);
        }
      }

      // Update tracking
      this.store.recordActivity(namespace, serviceName);
      this.store.removeScaledDownState(namespace, serviceName);

      let targetDesc = '';
      if (state.workload) {
        targetDesc = ` (${state.workload.kind}/${state.workload.name})`;
      } else if (state.pods) {
        targetDesc = ` (${state.pods.length} pod(s))`;
      }
      console.log(`Service ${namespace}/${serviceName}${targetDesc} woken up successfully`);
      return true;
    } catch (err) {
      console.error(`Failed to wake up ${namespace}/${serviceName}:`, err.message);
      return false;
    }
  }
}
