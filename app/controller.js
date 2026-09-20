export class Controller {
  constructor(k8s, store, config) {
    this.k8s = k8s;
    this.store = store;
    this.config = config;
    this.intervalId = null;
    this.scale0ServiceName = process.env.SCALE0_SERVICE_NAME || 'scale0';
    this.scale0ServiceNamespace = process.env.SCALE0_SERVICE_NAMESPACE || 'scale0';
    this.wakingUp = new Set();
    this.scalingDown = new Set();
    this.loggedDiscoveries = new Set();
  }

  isWakingUp(namespace, serviceName) {
    return this.wakingUp.has(`${namespace}/${serviceName}`);
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

    let scaleInAfterSeconds = parseInt(
      labels[`${this.config.labelPrefix}/scale-in-after`] ||
      annotations[`${this.config.labelPrefix}/scale-in-after`] ||
      this.config.scaleInAfterSeconds,
      10
    );
    if (Number.isNaN(scaleInAfterSeconds) || scaleInAfterSeconds <= 0) {
      scaleInAfterSeconds = this.config.scaleInAfterSeconds;
    }

    // CORS config from service annotations
    const corsOriginsStr = annotations[`${this.config.labelPrefix}/cors-origins`];
    const corsOrigins = corsOriginsStr
      ? corsOriginsStr.split(',').map(s => s.trim()).filter(Boolean)
      : null;
    const corsCredentials = annotations[`${this.config.labelPrefix}/cors-credentials`] === 'true';

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
        const discoveryKey = `hpa:${namespace}/${name}`;
        if (!this.loggedDiscoveries.has(discoveryKey)) {
          console.log(`Auto-discovered HPA ${namespace}/${scaleTarget.name} for service ${name}`);
          this.loggedDiscoveries.add(discoveryKey);
        }
      }
    }

    // If no HPA, try workload directly
    if (!scaleMode) {
      const workload = await this.k8s.findWorkloadForService(namespace, serviceSelector);
      if (workload) {
        scaleMode = 'workload';
        scaleTarget = workload;
        const discoveryKey = `workload:${namespace}/${name}`;
        if (!this.loggedDiscoveries.has(discoveryKey)) {
          console.log(`Auto-discovered ${workload.kind} ${namespace}/${workload.name} for service ${name} (no HPA)`);
          this.loggedDiscoveries.add(discoveryKey);
        }
      }
    }

    // If no workload, try standalone pods
    if (!scaleMode && Object.keys(serviceSelector).length > 0) {
      const selectorStr = Object.entries(serviceSelector).map(([k, v]) => `${k}=${v}`).join(',');
      const pods = await this.k8s.listPodsWithSelector(namespace, selectorStr);
      if (pods.length > 0) {
        scaleMode = 'pod';
        scaleTarget = { pods: pods.map(p => ({ name: p.metadata.name, spec: p })) };
        const discoveryKey = `pod:${namespace}/${name}`;
        if (!this.loggedDiscoveries.has(discoveryKey)) {
          console.log(`Found ${pods.length} standalone pod(s) for service ${name}`);
          this.loggedDiscoveries.add(discoveryKey);
        }
      }
    }

    if (!scaleMode) {
      console.warn(`No scalable resource found for service ${namespace}/${name}, skipping`);
      return;
    }

    // Auto-discover routing resources (VirtualServices and/or HTTPRoutes)
    const routeLabelValue = labels[`${this.config.labelPrefix}/httproute`] ||
      annotations[`${this.config.labelPrefix}/httproute`];

    let vsNames = [];
    let httpRouteNames = [];

    if (vsLabelValue) {
      vsNames = vsLabelValue.split(',').map(s => s.trim());
    } else {
      const discoveredVsList = await this.k8s.findVirtualServicesForService(namespace, name);
      if (discoveredVsList.length > 0) {
        vsNames = discoveredVsList.map(vs => vs.metadata.name);
        const discoveryKey = `vs:${namespace}/${name}`;
        if (!this.loggedDiscoveries.has(discoveryKey)) {
          console.log(`Auto-discovered ${vsNames.length} VirtualService(s) for service ${name}: ${vsNames.join(', ')}`);
          this.loggedDiscoveries.add(discoveryKey);
        }
      }
    }

    if (routeLabelValue) {
      httpRouteNames = routeLabelValue.split(',').map(s => s.trim());
    } else {
      const discoveredRoutes = await this.k8s.findHTTPRoutesForService(namespace, name);
      if (discoveredRoutes.length > 0) {
        httpRouteNames = discoveredRoutes.map(r => r.metadata.name);
        const discoveryKey = `route:${namespace}/${name}`;
        if (!this.loggedDiscoveries.has(discoveryKey)) {
          console.log(`Auto-discovered ${httpRouteNames.length} HTTPRoute(s) for service ${name}: ${httpRouteNames.join(', ')}`);
          this.loggedDiscoveries.add(discoveryKey);
        }
      }
    }

    if (vsNames.length === 0 && httpRouteNames.length === 0) {
      console.warn(`No VirtualService or HTTPRoute found for service ${namespace}/${name}, skipping`);
      return;
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
      await this.scaleDown(namespace, name, scaleMode, scaleTarget, vsNames, httpRouteNames, { corsOrigins, corsCredentials });
    }
  }

  async scaleDown(namespace, serviceName, scaleMode, scaleTarget, vsNames, httpRouteNames, corsConfig = {}) {
    const lockKey = `${namespace}/${serviceName}`;
    if (this.scalingDown.has(lockKey)) {
      console.log(`Scale-down already in progress for ${lockKey}, skipping`);
      return;
    }

    // Acquire distributed lease (prevents race with other controller replicas)
    const leaseAcquired = await this.k8s.acquireLease(namespace, `scaledown-${serviceName}`, 60);
    if (!leaseAcquired) {
      console.log(`Could not acquire scale-down lease for ${lockKey}, another instance is handling it`);
      return;
    }

    this.scalingDown.add(lockKey);

    try {
      // Get current VirtualService states (minimal - only store routes, not full spec)
      const virtualServices = [];
      for (const vsName of vsNames) {
        const vs = await this.k8s.getVirtualService(namespace, vsName);
        if (vs) {
          // Only store the http routes - that's what we modify
          virtualServices.push({
            name: vsName,
            http: vs.spec?.http ? JSON.parse(JSON.stringify(vs.spec.http)) : [],
          });
        } else {
          console.warn(`VirtualService ${namespace}/${vsName} not found, skipping`);
        }
      }

      // Get current HTTPRoute states (minimal - only store rules, not full spec)
      const httpRoutes = [];
      for (const routeName of httpRouteNames) {
        const route = await this.k8s.getHTTPRoute(namespace, routeName);
        if (route) {
          // Only store the rules - that's what we modify
          httpRoutes.push({
            name: routeName,
            rules: route.spec?.rules ? JSON.parse(JSON.stringify(route.spec.rules)) : [],
          });
        } else {
          console.warn(`HTTPRoute ${namespace}/${routeName} not found, skipping`);
        }
      }

      if (virtualServices.length === 0 && httpRoutes.length === 0) {
        console.warn(`No routing resources found for service ${namespace}/${serviceName}, skipping scale-down`);
        return;
      }

      // Build original state based on scale mode
      const originalState = {
        scaleMode,
        virtualServices,
        httpRoutes,
        corsOrigins: corsConfig.corsOrigins || null,
        corsCredentials: corsConfig.corsCredentials || false,
      };

      if (scaleMode === 'hpa') {
        const hpa = await this.k8s.getHPA(namespace, scaleTarget.name);
        if (!hpa) {
          console.warn(`HPA ${namespace}/${scaleTarget.name} not found, skipping scale-down`);
          return;
        }
        const scaleTargetRef = hpa.spec.scaleTargetRef;
        const workload = await this.k8s.getWorkload(namespace, scaleTargetRef.kind, scaleTargetRef.name);
        const currentReplicas = workload?.spec?.replicas ?? 1;

        originalState.hpa = {
          name: scaleTarget.name,
          minReplicas: hpa.spec.minReplicas,
          maxReplicas: hpa.spec.maxReplicas,
        };
        originalState.workload = {
          kind: scaleTargetRef.kind,
          name: scaleTargetRef.name,
          apiVersion: scaleTargetRef.apiVersion,
          replicas: currentReplicas,
        };

        // Scale workload to 0 (HPA will be ignored when replicas=0)
        await this.k8s.scaleWorkload(namespace, scaleTargetRef.kind, scaleTargetRef.name, 0);
        console.log(`Scaled ${scaleTargetRef.kind} ${namespace}/${scaleTargetRef.name} to 0 (HPA: ${scaleTarget.name})`);

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

      // Modify all HTTPRoutes to route to scale0
      for (const routeState of httpRoutes) {
        const route = await this.k8s.getHTTPRoute(namespace, routeState.name);
        if (route) {
          const modifiedRoute = this.createScale0HTTPRoute(route, serviceName);
          await this.k8s.replaceHTTPRoute(namespace, routeState.name, modifiedRoute);
          console.log(`Redirected HTTPRoute ${namespace}/${routeState.name} to scale0`);
        }
      }

      // Save state (persists to Service annotation)
      await this.store.saveScaledDownState(namespace, serviceName, originalState);
      const targetDesc = scaleMode === 'pod' ? `${originalState.pods.length} pod(s)` : `${originalState.workload.kind}/${originalState.workload.name}`;
      console.log(`Service ${namespace}/${serviceName} (${targetDesc}) scaled down successfully`);
    } catch (err) {
      console.error(`Failed to scale down ${namespace}/${serviceName}:`, err.message);
      if (err.response?.body) {
        console.error('Response body:', JSON.stringify(err.response.body));
      }
    } finally {
      this.scalingDown.delete(`${namespace}/${serviceName}`);
      await this.k8s.releaseLease(namespace, `scaledown-${serviceName}`);
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

  createScale0HTTPRoute(route, originalServiceName) {
    const modified = JSON.parse(JSON.stringify(route));

    // Modify each rule to point to scale0
    if (modified.spec.rules) {
      modified.spec.rules = modified.spec.rules.map((rule) => {
        return {
          ...rule,
          backendRefs: [{
            kind: 'Service',
            name: this.scale0ServiceName,
            namespace: this.scale0ServiceNamespace,
            port: 8080,
            weight: 1,
          }],
          filters: [
            ...(rule.filters || []),
            {
              type: 'RequestHeaderModifier',
              requestHeaderModifier: {
                set: [
                  { name: 'x-scale0-original-service', value: originalServiceName },
                  { name: 'x-scale0-original-namespace', value: route.metadata.namespace },
                ],
              },
            },
          ],
        };
      });
    }

    return modified;
  }

  async wakeUp(namespace, serviceName) {
    const lockKey = `${namespace}/${serviceName}`;

    if (this.wakingUp.has(lockKey)) {
      console.log(`Wakeup already in progress for ${lockKey}`);
      return false;
    }

    // Use async method to check for state saved by another replica
    const state = await this.store.getScaledDownStateAsync(namespace, serviceName);
    if (!state) {
      console.warn(`No saved state for ${namespace}/${serviceName}`);
      return false;
    }

    // Acquire distributed lease (prevents race with other controller replicas)
    const leaseAcquired = await this.k8s.acquireLease(namespace, `wakeup-${serviceName}`, 60);
    if (!leaseAcquired) {
      console.log(`Could not acquire wakeup lease for ${lockKey}, another instance is handling it`);
      return false;
    }

    this.wakingUp.add(lockKey);

    try {
      const scaleMode = state.scaleMode || 'hpa'; // backwards compatibility

      if (scaleMode === 'hpa' && state.workload) {
        // Scale workload back up - HPA will take over once replicas > 0
        const targetReplicas = state.workload.replicas || state.hpa?.minReplicas || 1;
        await this.k8s.scaleWorkload(
          namespace,
          state.workload.kind,
          state.workload.name,
          targetReplicas
        );
        console.log(`Restored ${state.workload.kind} ${namespace}/${state.workload.name} to ${targetReplicas} replicas (HPA: ${state.hpa?.name})`);

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

      // Restore all VirtualServices (minimal state - only http routes stored)
      const virtualServices = state.virtualServices || (state.virtualService ? [state.virtualService] : []);
      for (const vsState of virtualServices) {
        const currentVs = await this.k8s.getVirtualService(namespace, vsState.name);
        if (currentVs) {
          // Support both old (full spec) and new (minimal http) formats
          if (vsState.spec) {
            currentVs.spec = vsState.spec;
          } else if (vsState.http) {
            currentVs.spec.http = vsState.http;
          }
          await this.k8s.replaceVirtualService(namespace, vsState.name, currentVs);
          console.log(`Restored VirtualService ${namespace}/${vsState.name}`);
        }
      }

      // Restore all HTTPRoutes (minimal state - only rules stored)
      const httpRoutes = state.httpRoutes || [];
      for (const routeState of httpRoutes) {
        const currentRoute = await this.k8s.getHTTPRoute(namespace, routeState.name);
        if (currentRoute) {
          // Support both old (full spec) and new (minimal rules) formats
          if (routeState.spec) {
            currentRoute.spec = routeState.spec;
          } else if (routeState.rules) {
            currentRoute.spec.rules = routeState.rules;
          }
          await this.k8s.replaceHTTPRoute(namespace, routeState.name, currentRoute);
          console.log(`Restored HTTPRoute ${namespace}/${routeState.name}`);
        }
      }

      // Update tracking (removes annotation from Service)
      this.store.recordActivity(namespace, serviceName);
      await this.store.removeScaledDownState(namespace, serviceName);

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
    } finally {
      this.wakingUp.delete(`${namespace}/${serviceName}`);
      await this.k8s.releaseLease(namespace, `wakeup-${serviceName}`);
    }
  }
}
