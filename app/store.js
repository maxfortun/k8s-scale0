export class Store {
  constructor() {
    // Map of "namespace/service-name" -> state
    this.scaledDownApps = new Map();
    // Map of "namespace/service-name" -> last activity timestamp
    this.lastActivity = new Map();
  }

  key(namespace, name) {
    return `${namespace}/${name}`;
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

  saveScaledDownState(namespace, name, state) {
    this.scaledDownApps.set(this.key(namespace, name), {
      ...state,
      scaledDownAt: Date.now(),
    });
  }

  getScaledDownState(namespace, name) {
    return this.scaledDownApps.get(this.key(namespace, name));
  }

  removeScaledDownState(namespace, name) {
    this.scaledDownApps.delete(this.key(namespace, name));
  }

  getAllScaledDown() {
    return Array.from(this.scaledDownApps.entries()).map(([key, state]) => {
      const [namespace, name] = key.split('/');
      return { namespace, name, ...state };
    });
  }

  getAllTracked() {
    return Array.from(this.lastActivity.entries()).map(([key, timestamp]) => {
      const [namespace, name] = key.split('/');
      return { namespace, name, lastActivity: timestamp };
    });
  }
}
