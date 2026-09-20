import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Store } from '../../store.js';

function createMockK8s() {
  return {
    patchServiceAnnotations: jest.fn().mockResolvedValue({}),
    listServicesWithLabel: jest.fn().mockResolvedValue([]),
    getService: jest.fn().mockResolvedValue(null),
  };
}

describe('Store', () => {
  let store;

  beforeEach(() => {
    store = new Store();
  });

  describe('key generation', () => {
    it('should create unique keys for namespace/name pairs', () => {
      const key1 = store.key('ns1', 'svc1');
      const key2 = store.key('ns1', 'svc2');
      const key3 = store.key('ns2', 'svc1');
      expect(key1).not.toBe(key2);
      expect(key1).not.toBe(key3);
      expect(key2).not.toBe(key3);
    });

    it('should handle names with slashes', () => {
      const key = store.key('namespace', 'service/with/slashes');
      expect(key).toContain('namespace');
      expect(key).toContain('service/with/slashes');
    });
  });

  describe('parseKey', () => {
    it('should correctly parse keys with null delimiter', () => {
      const key = store.key('my-namespace', 'my-service');
      const parsed = store.parseKey(key);
      expect(parsed).toEqual({ namespace: 'my-namespace', name: 'my-service' });
    });

    it('should handle legacy keys with slash delimiter', () => {
      const legacyKey = 'old-namespace/old-service';
      const parsed = store.parseKey(legacyKey);
      expect(parsed).toEqual({ namespace: 'old-namespace', name: 'old-service' });
    });

    it('should handle keys without delimiter', () => {
      const parsed = store.parseKey('justname');
      expect(parsed).toEqual({ namespace: 'default', name: 'justname' });
    });

    it('should handle names with slashes when using null delimiter', () => {
      const key = store.key('namespace', 'service/with/slashes');
      const parsed = store.parseKey(key);
      expect(parsed).toEqual({ namespace: 'namespace', name: 'service/with/slashes' });
    });
  });

  describe('setK8sClient', () => {
    it('should set the K8s client after construction', () => {
      const mockK8s = { test: true };
      store.setK8sClient(mockK8s);
      expect(store.k8s).toBe(mockK8s);
    });
  });

  describe('activity tracking', () => {
    it('should record and retrieve activity', () => {
      const before = Date.now();
      store.recordActivity('ns', 'svc');
      const after = Date.now();

      const lastActivity = store.getLastActivity('ns', 'svc');
      expect(lastActivity).toBeGreaterThanOrEqual(before);
      expect(lastActivity).toBeLessThanOrEqual(after);
    });

    it('should return undefined for untracked services', () => {
      expect(store.getLastActivity('ns', 'unknown')).toBeUndefined();
    });

    it('should update activity on subsequent calls', async () => {
      store.recordActivity('ns', 'svc');
      const first = store.getLastActivity('ns', 'svc');

      await new Promise(resolve => setTimeout(resolve, 10));

      store.recordActivity('ns', 'svc');
      const second = store.getLastActivity('ns', 'svc');

      expect(second).toBeGreaterThan(first);
    });

    it('should stop tracking a service', () => {
      store.recordActivity('ns', 'svc');
      expect(store.getLastActivity('ns', 'svc')).toBeDefined();

      store.stopTracking('ns', 'svc');
      expect(store.getLastActivity('ns', 'svc')).toBeUndefined();
    });

    it('should prune stale tracking entries', () => {
      store.recordActivity('ns1', 'svc1');
      store.recordActivity('ns1', 'svc2');
      store.recordActivity('ns2', 'svc1');

      // Only ns1/svc1 is active
      const activeKeys = [store.key('ns1', 'svc1')];
      store.pruneStaleTracking(activeKeys);

      expect(store.getLastActivity('ns1', 'svc1')).toBeDefined();
      expect(store.getLastActivity('ns1', 'svc2')).toBeUndefined();
      expect(store.getLastActivity('ns2', 'svc1')).toBeUndefined();
    });
  });

  describe('scaled-down state management', () => {
    const sampleState = {
      scaleMode: 'hpa',
      hpa: { name: 'my-hpa', minReplicas: 1, maxReplicas: 5 },
      virtualServices: [{ name: 'my-vs', spec: {} }],
    };

    it('should correctly identify scaled-down services', async () => {
      expect(store.isScaledDown('ns', 'svc')).toBe(false);

      await store.saveScaledDownState('ns', 'svc', sampleState);

      expect(store.isScaledDown('ns', 'svc')).toBe(true);
    });

    it('should save and retrieve state', async () => {
      await store.saveScaledDownState('ns', 'svc', sampleState);

      const retrieved = store.getScaledDownState('ns', 'svc');
      expect(retrieved.scaleMode).toBe('hpa');
      expect(retrieved.hpa).toEqual(sampleState.hpa);
      expect(retrieved.virtualServices).toEqual(sampleState.virtualServices);
    });

    it('should add scaledDownAt timestamp', async () => {
      const before = Date.now();
      await store.saveScaledDownState('ns', 'svc', sampleState);
      const after = Date.now();

      const retrieved = store.getScaledDownState('ns', 'svc');
      expect(retrieved.scaledDownAt).toBeGreaterThanOrEqual(before);
      expect(retrieved.scaledDownAt).toBeLessThanOrEqual(after);
    });

    it('should remove scaled-down state', async () => {
      await store.saveScaledDownState('ns', 'svc', sampleState);
      expect(store.isScaledDown('ns', 'svc')).toBe(true);

      await store.removeScaledDownState('ns', 'svc');
      expect(store.isScaledDown('ns', 'svc')).toBe(false);
      expect(store.getScaledDownState('ns', 'svc')).toBeUndefined();
    });

    it('should handle removal of non-existent state', async () => {
      await expect(store.removeScaledDownState('ns', 'unknown')).resolves.not.toThrow();
    });
  });

  describe('getAllScaledDown', () => {
    it('should return empty array when nothing scaled down', () => {
      expect(store.getAllScaledDown()).toEqual([]);
    });

    it('should return all scaled-down services', async () => {
      await store.saveScaledDownState('ns1', 'svc1', { mode: 'hpa' });
      await store.saveScaledDownState('ns1', 'svc2', { mode: 'workload' });
      await store.saveScaledDownState('ns2', 'svc1', { mode: 'pod' });

      const all = store.getAllScaledDown();
      expect(all).toHaveLength(3);

      const keys = all.map(s => `${s.namespace}/${s.name}`);
      expect(keys).toContain('ns1/svc1');
      expect(keys).toContain('ns1/svc2');
      expect(keys).toContain('ns2/svc1');
    });

    it('should include state data in results', async () => {
      await store.saveScaledDownState('ns', 'svc', { mode: 'test', custom: 'data' });

      const all = store.getAllScaledDown();
      expect(all[0]).toMatchObject({
        namespace: 'ns',
        name: 'svc',
        mode: 'test',
        custom: 'data',
      });
    });
  });

  describe('getAllTracked', () => {
    it('should return empty array when nothing tracked', () => {
      expect(store.getAllTracked()).toEqual([]);
    });

    it('should return all tracked services', () => {
      store.recordActivity('ns1', 'svc1');
      store.recordActivity('ns1', 'svc2');
      store.recordActivity('ns2', 'svc1');

      const all = store.getAllTracked();
      expect(all).toHaveLength(3);

      const keys = all.map(s => `${s.namespace}/${s.name}`);
      expect(keys).toContain('ns1/svc1');
      expect(keys).toContain('ns1/svc2');
      expect(keys).toContain('ns2/svc1');
    });

    it('should include lastActivity timestamp in results', () => {
      store.recordActivity('ns', 'svc');

      const all = store.getAllTracked();
      expect(all[0]).toMatchObject({
        namespace: 'ns',
        name: 'svc',
      });
      expect(typeof all[0].lastActivity).toBe('number');
    });
  });

  describe('clear', () => {
    it('should remove all data', () => {
      store.recordActivity('ns1', 'svc1');
      store.recordActivity('ns1', 'svc2');
      store.saveScaledDownState('ns1', 'svc1', { mode: 'test' });

      store.clear();

      expect(store.getAllTracked()).toEqual([]);
      expect(store.getAllScaledDown()).toEqual([]);
    });
  });

  describe('exportState and importState', () => {
    it('should export and import state correctly', () => {
      store.recordActivity('ns1', 'svc1');
      store.saveScaledDownState('ns1', 'svc1', { mode: 'hpa', data: 'test' });

      const exported = store.exportState();

      const newStore = new Store();
      newStore.importState(exported);

      expect(newStore.getLastActivity('ns1', 'svc1')).toBe(store.getLastActivity('ns1', 'svc1'));
      expect(newStore.getScaledDownState('ns1', 'svc1')).toEqual(store.getScaledDownState('ns1', 'svc1'));
    });

    it('should handle empty import', () => {
      store.recordActivity('ns1', 'svc1');

      store.importState({});

      expect(store.getLastActivity('ns1', 'svc1')).toBeDefined();
    });

    it('should handle partial import', () => {
      const exported = {
        scaledDownApps: [[store.key('ns', 'svc'), { mode: 'test' }]],
      };

      const newStore = new Store();
      newStore.importState(exported);

      expect(newStore.isScaledDown('ns', 'svc')).toBe(true);
      expect(newStore.getAllTracked()).toEqual([]);
    });
  });

  describe('isolation', () => {
    it('should not have cross-contamination between namespaces', async () => {
      store.recordActivity('ns1', 'svc');
      store.recordActivity('ns2', 'svc');
      await store.saveScaledDownState('ns1', 'svc', { mode: 'test1' });

      expect(store.isScaledDown('ns1', 'svc')).toBe(true);
      expect(store.isScaledDown('ns2', 'svc')).toBe(false);
    });

    it('should not have cross-contamination between services', async () => {
      store.recordActivity('ns', 'svc1');
      await store.saveScaledDownState('ns', 'svc2', { mode: 'test' });

      expect(store.getLastActivity('ns', 'svc2')).toBeUndefined();
      expect(store.isScaledDown('ns', 'svc1')).toBe(false);
    });
  });

  describe('K8s persistence', () => {
    let mockK8s;
    let persistentStore;

    beforeEach(() => {
      mockK8s = createMockK8s();
      persistentStore = new Store(mockK8s, 'scale0');
    });

    it('should persist state to Service annotation on save', async () => {
      const state = { scaleMode: 'hpa', hpa: { name: 'test-hpa' } };
      await persistentStore.saveScaledDownState('ns', 'svc', state);

      expect(mockK8s.patchServiceAnnotations).toHaveBeenCalledWith('ns', 'svc', {
        'scale0/scaled-down-state': expect.stringContaining('"scaleMode":"hpa"'),
      });
    });

    it('should remove annotation on state removal', async () => {
      await persistentStore.saveScaledDownState('ns', 'svc', { mode: 'test' });
      await persistentStore.removeScaledDownState('ns', 'svc');

      expect(mockK8s.patchServiceAnnotations).toHaveBeenLastCalledWith('ns', 'svc', {
        'scale0/scaled-down-state': null,
      });
    });

    it('should recover state from Service annotations', async () => {
      const savedState = { scaleMode: 'hpa', hpa: { name: 'recovered-hpa' }, scaledDownAt: Date.now() };
      mockK8s.listServicesWithLabel.mockResolvedValue([
        {
          metadata: {
            namespace: 'ns1',
            name: 'svc1',
            annotations: { 'scale0/scaled-down-state': JSON.stringify(savedState) },
          },
        },
        {
          metadata: {
            namespace: 'ns2',
            name: 'svc2',
            annotations: {},
          },
        },
      ]);

      const recovered = await persistentStore.recoverStateFromServices();

      expect(recovered).toBe(1);
      expect(persistentStore.isScaledDown('ns1', 'svc1')).toBe(true);
      expect(persistentStore.isScaledDown('ns2', 'svc2')).toBe(false);
      expect(persistentStore.getScaledDownState('ns1', 'svc1')).toMatchObject({
        scaleMode: 'hpa',
        hpa: { name: 'recovered-hpa' },
      });
    });

    it('should handle invalid JSON in annotations gracefully', async () => {
      mockK8s.listServicesWithLabel.mockResolvedValue([
        {
          metadata: {
            namespace: 'ns',
            name: 'svc',
            annotations: { 'scale0/scaled-down-state': 'not valid json' },
          },
        },
      ]);

      const recovered = await persistentStore.recoverStateFromServices();

      expect(recovered).toBe(0);
      expect(persistentStore.isScaledDown('ns', 'svc')).toBe(false);
    });

    it('should work without K8s client (test mode)', async () => {
      const localStore = new Store();
      await localStore.saveScaledDownState('ns', 'svc', { mode: 'test' });

      expect(localStore.isScaledDown('ns', 'svc')).toBe(true);
    });

    it('should handle K8s errors gracefully', async () => {
      mockK8s.patchServiceAnnotations.mockRejectedValue(new Error('API error'));

      await expect(persistentStore.saveScaledDownState('ns', 'svc', { mode: 'test' }))
        .resolves.not.toThrow();

      expect(persistentStore.isScaledDown('ns', 'svc')).toBe(true);
    });

    it('should handle removeScaledDownState K8s errors gracefully', async () => {
      await persistentStore.saveScaledDownState('ns', 'svc', { mode: 'test' });
      mockK8s.patchServiceAnnotations.mockRejectedValue(new Error('API error'));

      await expect(persistentStore.removeScaledDownState('ns', 'svc'))
        .resolves.not.toThrow();

      // State should still be removed from memory
      expect(persistentStore.isScaledDown('ns', 'svc')).toBe(false);
    });

    it('should handle recoverStateFromServices with no K8s client', async () => {
      const localStore = new Store();
      const recovered = await localStore.recoverStateFromServices();
      expect(recovered).toBe(0);
    });

    it('should handle recoverStateFromServices K8s errors', async () => {
      mockK8s.listServicesWithLabel.mockRejectedValue(new Error('API error'));

      const recovered = await persistentStore.recoverStateFromServices();
      expect(recovered).toBe(0);
    });

    it('should warn on large annotation size', async () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      // Create a large state object (> 200KB)
      const largeState = { data: 'x'.repeat(250000) };
      await persistentStore.saveScaledDownState('ns', 'svc', largeState);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('approaching K8s annotation limit')
      );
      consoleSpy.mockRestore();
    });

    describe('isScaledDownAsync', () => {
      it('should return true if in memory', async () => {
        await persistentStore.saveScaledDownState('ns', 'svc', { mode: 'test' });
        const result = await persistentStore.isScaledDownAsync('ns', 'svc');
        expect(result).toBe(true);
      });

      it('should check annotation if not in memory', async () => {
        const savedState = { scaleMode: 'hpa', scaledDownAt: Date.now() };
        mockK8s.getService.mockResolvedValue({
          metadata: {
            annotations: { 'scale0/scaled-down-state': JSON.stringify(savedState) },
          },
        });

        const result = await persistentStore.isScaledDownAsync('ns', 'svc');
        expect(result).toBe(true);
        expect(mockK8s.getService).toHaveBeenCalledWith('ns', 'svc');
        // Should also cache the state
        expect(persistentStore.isScaledDown('ns', 'svc')).toBe(true);
      });

      it('should return false if service not found', async () => {
        mockK8s.getService.mockResolvedValue(null);
        const result = await persistentStore.isScaledDownAsync('ns', 'svc');
        expect(result).toBe(false);
      });

      it('should return false if no annotation', async () => {
        mockK8s.getService.mockResolvedValue({
          metadata: { annotations: {} },
        });
        const result = await persistentStore.isScaledDownAsync('ns', 'svc');
        expect(result).toBe(false);
      });

      it('should handle K8s errors gracefully', async () => {
        mockK8s.getService.mockRejectedValue(new Error('API error'));
        const result = await persistentStore.isScaledDownAsync('ns', 'svc');
        expect(result).toBe(false);
      });
    });

    describe('getScaledDownStateAsync', () => {
      it('should return state from memory if available', async () => {
        await persistentStore.saveScaledDownState('ns', 'svc', { mode: 'test' });
        const state = await persistentStore.getScaledDownStateAsync('ns', 'svc');
        expect(state.mode).toBe('test');
      });

      it('should fetch state from annotation if not in memory', async () => {
        const savedState = { scaleMode: 'hpa', scaledDownAt: Date.now() };
        mockK8s.getService.mockResolvedValue({
          metadata: {
            annotations: { 'scale0/scaled-down-state': JSON.stringify(savedState) },
          },
        });

        const state = await persistentStore.getScaledDownStateAsync('ns', 'svc');
        expect(state.scaleMode).toBe('hpa');
        // Should cache it
        expect(persistentStore.getScaledDownState('ns', 'svc')).toEqual(savedState);
      });

      it('should return null if not found anywhere', async () => {
        mockK8s.getService.mockResolvedValue(null);
        const state = await persistentStore.getScaledDownStateAsync('ns', 'svc');
        expect(state).toBeNull();
      });
    });

    describe('fetchStateFromAnnotation', () => {
      it('should return null if service not found', async () => {
        mockK8s.getService.mockResolvedValue(null);
        const state = await persistentStore.fetchStateFromAnnotation('ns', 'svc');
        expect(state).toBeNull();
      });

      it('should return null if no annotation', async () => {
        mockK8s.getService.mockResolvedValue({
          metadata: {},
        });
        const state = await persistentStore.fetchStateFromAnnotation('ns', 'svc');
        expect(state).toBeNull();
      });

      it('should handle corrupted JSON annotation', async () => {
        const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
        mockK8s.getService.mockResolvedValue({
          metadata: {
            annotations: { 'scale0/scaled-down-state': 'not-json' },
          },
        });

        const state = await persistentStore.fetchStateFromAnnotation('ns', 'svc');
        expect(state).toBeNull();
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('Corrupted state annotation'),
          expect.any(String)
        );
        consoleSpy.mockRestore();
      });
    });
  });
});
