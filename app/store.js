const KEY_DELIMITER = '\x00';
const STATE_ANNOTATION = 'scale0/scaled-down-state';

export class Store {
  constructor(k8s = null, labelPrefix = 'scale0') {
    this.k8s = k8s;
    this.labelPrefix = labelPrefix;
    this.scaledDownApps = new Map();
    this.lastActivity = new Map();
  }

  setK8sClient(k8s) {
    this.k8s = k8s;
  }

  key(namespace, name) {
    return `${namespace}${KEY_DELIMITER}${name}`;
  }

  parseKey(key) {
    const idx = key.indexOf(KEY_DELIMITER);
    if (idx === -1) {
      const slashIdx = key.indexOf('/');
      if (slashIdx === -1) return { namespace: 'default', name: key };
      return { namespace: key.slice(0, slashIdx), name: key.slice(slashIdx + 1) };
    }
    return { namespace: key.slice(0, idx), name: key.slice(idx + 1) };
  }

  recordActivity(namespace, name) {
    this.lastActivity.set(this.key(namespace, name), Date.now());
  }

  getLastActivity(namespace, name) {
    return this.lastActivity.get(this.key(namespace, name));
  }

  isScaledDown(namespace, name) {
    return this.scaledDownApps.has(this.key(namespace, name));
  }

  async isScaledDownAsync(namespace, name) {
    if (this.scaledDownApps.has(this.key(namespace, name))) {
      return true;
    }
    // Check Service annotation for state saved by another replica
    if (this.k8s) {
      try {
        const state = await this.fetchStateFromAnnotation(namespace, name);
        if (state) {
          this.scaledDownApps.set(this.key(namespace, name), state);
          return true;
        }
      } catch (err) {
        // Ignore - service might not exist or have no annotation
      }
    }
    return false;
  }

  async fetchStateFromAnnotation(namespace, name) {
    const service = await this.k8s.getService(namespace, name);
    if (!service) return null;
    const stateJson = service.metadata?.annotations?.[STATE_ANNOTATION];
    if (!stateJson) return null;
    try {
      return JSON.parse(stateJson);
    } catch (err) {
      console.warn(`Corrupted state annotation on ${namespace}/${name}:`, err.message);
      return null;
    }
  }

  async saveScaledDownState(namespace, name, state) {
    const stateWithTimestamp = {
      ...state,
      scaledDownAt: Date.now(),
    };

    this.scaledDownApps.set(this.key(namespace, name), stateWithTimestamp);

    if (this.k8s) {
      try {
        const stateJson = JSON.stringify(stateWithTimestamp);
        await this.k8s.patchServiceAnnotations(namespace, name, {
          [STATE_ANNOTATION]: stateJson,
        });
      } catch (err) {
        console.error(`Failed to persist state to Service ${namespace}/${name}:`, err.message);
      }
    }
  }

  getScaledDownState(namespace, name) {
    return this.scaledDownApps.get(this.key(namespace, name));
  }

  async getScaledDownStateAsync(namespace, name) {
    let state = this.scaledDownApps.get(this.key(namespace, name));
    if (state) return state;

    // Check Service annotation for state saved by another replica
    if (this.k8s) {
      state = await this.fetchStateFromAnnotation(namespace, name);
      if (state) {
        this.scaledDownApps.set(this.key(namespace, name), state);
      }
    }
    return state;
  }

  async removeScaledDownState(namespace, name) {
    this.scaledDownApps.delete(this.key(namespace, name));

    if (this.k8s) {
      try {
        await this.k8s.patchServiceAnnotations(namespace, name, {
          [STATE_ANNOTATION]: null,
        });
      } catch (err) {
        console.error(`Failed to remove state from Service ${namespace}/${name}:`, err.message);
      }
    }
  }

  async recoverStateFromServices() {
    if (!this.k8s) {
      console.log('No K8s client, skipping state recovery');
      return 0;
    }

    try {
      const labelSelector = `${this.labelPrefix}/enabled=true`;
      const services = await this.k8s.listServicesWithLabel(labelSelector);
      let recovered = 0;

      for (const svc of services) {
        const { namespace, name } = svc.metadata;
        const annotations = svc.metadata.annotations || {};
        const stateJson = annotations[STATE_ANNOTATION];

        if (stateJson) {
          try {
            const state = JSON.parse(stateJson);
            this.scaledDownApps.set(this.key(namespace, name), state);
            console.log(`Recovered scaled-down state for ${namespace}/${name}`);
            recovered++;
          } catch (parseErr) {
            console.warn(`Invalid state annotation on ${namespace}/${name}:`, parseErr.message);
          }
        }
      }

      if (recovered > 0) {
        console.log(`Recovered state for ${recovered} scaled-down service(s)`);
      }

      return recovered;
    } catch (err) {
      console.error('Failed to recover state from services:', err.message);
      return 0;
    }
  }

  getAllScaledDown() {
    return Array.from(this.scaledDownApps.entries()).map(([key, state]) => {
      const { namespace, name } = this.parseKey(key);
      return { namespace, name, ...state };
    });
  }

  getAllTracked() {
    return Array.from(this.lastActivity.entries()).map(([key, timestamp]) => {
      const { namespace, name } = this.parseKey(key);
      return { namespace, name, lastActivity: timestamp };
    });
  }

  clear() {
    this.scaledDownApps.clear();
    this.lastActivity.clear();
  }

  exportState() {
    return {
      scaledDownApps: Array.from(this.scaledDownApps.entries()),
      lastActivity: Array.from(this.lastActivity.entries()),
    };
  }

  importState(state) {
    if (state.scaledDownApps) {
      this.scaledDownApps = new Map(state.scaledDownApps);
    }
    if (state.lastActivity) {
      this.lastActivity = new Map(state.lastActivity);
    }
  }
}
