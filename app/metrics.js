import client from 'prom-client';

// Create a Registry
const register = new client.Registry();

// Add default metrics (process CPU, memory, etc.)
client.collectDefaultMetrics({ register });

// Counters
const scaledownsTotal = new client.Counter({
  name: 'scale0_scaledowns_total',
  help: 'Total number of successful scale-down operations',
  labelNames: ['namespace', 'service', 'mode'],
  registers: [register],
});

const wakeupsTotal = new client.Counter({
  name: 'scale0_wakeups_total',
  help: 'Total number of successful wakeup operations',
  labelNames: ['namespace', 'service', 'mode'],
  registers: [register],
});

const scaledownErrorsTotal = new client.Counter({
  name: 'scale0_scaledown_errors_total',
  help: 'Total number of failed scale-down operations',
  labelNames: ['namespace', 'service'],
  registers: [register],
});

const wakeupErrorsTotal = new client.Counter({
  name: 'scale0_wakeup_errors_total',
  help: 'Total number of failed wakeup operations',
  labelNames: ['namespace', 'service'],
  registers: [register],
});

const tarpitChecksTotal = new client.Counter({
  name: 'scale0_tarpit_checks_total',
  help: 'Total number of tarpit verification attempts',
  labelNames: ['result'],
  registers: [register],
});

const wakeupRequestsTotal = new client.Counter({
  name: 'scale0_wakeup_requests_total',
  help: 'Total number of wakeup HTTP requests',
  labelNames: ['status_code'],
  registers: [register],
});

// Gauges
const servicesTracked = new client.Gauge({
  name: 'scale0_services_tracked',
  help: 'Number of services currently being monitored',
  registers: [register],
});

const servicesScaledDown = new client.Gauge({
  name: 'scale0_services_scaled_down',
  help: 'Number of services currently in scaled-down state',
  registers: [register],
});

const activeLeases = new client.Gauge({
  name: 'scale0_active_leases',
  help: 'Number of currently held distributed leases',
  registers: [register],
});

// Histograms
const scaledownDuration = new client.Histogram({
  name: 'scale0_scaledown_duration_seconds',
  help: 'Duration of scale-down operations in seconds',
  labelNames: ['namespace', 'service', 'mode'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [register],
});

const wakeupDuration = new client.Histogram({
  name: 'scale0_wakeup_duration_seconds',
  help: 'Duration of wakeup operations in seconds',
  labelNames: ['namespace', 'service', 'mode'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [register],
});

const reconcileDuration = new client.Histogram({
  name: 'scale0_reconcile_duration_seconds',
  help: 'Duration of reconciliation loop iterations in seconds',
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

export const metrics = {
  // Counters
  scaledownsTotal,
  wakeupsTotal,
  scaledownErrorsTotal,
  wakeupErrorsTotal,
  tarpitChecksTotal,
  wakeupRequestsTotal,

  // Gauges
  servicesTracked,
  servicesScaledDown,
  activeLeases,

  // Histograms
  scaledownDuration,
  wakeupDuration,
  reconcileDuration,

  // Registry
  register,

  // Helper to get metrics output
  async getMetrics() {
    return register.metrics();
  },

  // Helper to get content type
  getContentType() {
    return register.contentType;
  },
};
