import { Controller } from './controller.js';
import { WakeupServer } from './wakeup-server.js';
import { K8sClient } from './k8s.js';
import { Store } from './store.js';

function parseIntSafe(value, defaultValue, name) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    console.warn(`Invalid value for ${name}: "${value}", using default: ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

function parseOriginAllowlist(value) {
  if (!value) return null;
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

const config = {
  checkIntervalMs: parseIntSafe(process.env.CHECK_INTERVAL_MS, 30000, 'CHECK_INTERVAL_MS'),
  wakeupPort: parseIntSafe(process.env.WAKEUP_PORT, 8080, 'WAKEUP_PORT'),
  scaleInAfterSeconds: parseIntSafe(process.env.SCALE_IN_AFTER_SECONDS, 86400, 'SCALE_IN_AFTER_SECONDS'),
  retryAfterSeconds: parseIntSafe(process.env.RETRY_AFTER_SECONDS, 5, 'RETRY_AFTER_SECONDS'),
  labelPrefix: process.env.LABEL_PREFIX || 'scale0',
  tarpitSecret: process.env.TARPIT_SECRET,
  tarpitDelaySeconds: parseIntSafe(process.env.TARPIT_DELAY_SECONDS, 3, 'TARPIT_DELAY_SECONDS'),
  tarpitCookieName: process.env.TARPIT_COOKIE_NAME || 'scale0_tarpit',
  corsAllowedOrigins: parseOriginAllowlist(process.env.CORS_ALLOWED_ORIGINS),
  corsAllowCredentials: process.env.CORS_ALLOW_CREDENTIALS === 'true',
  wakeupTimeoutMs: parseIntSafe(process.env.WAKEUP_TIMEOUT_MS, 30000, 'WAKEUP_TIMEOUT_MS'),
};

async function main() {
  console.log('Starting k8s-scale0 controller...');
  const safeConfig = {
    ...config,
    tarpitSecret: config.tarpitSecret ? '[REDACTED]' : '(not set - will use ephemeral)',
  };
  console.log('Config:', JSON.stringify(safeConfig, null, 2));

  const k8s = new K8sClient();
  await k8s.init();

  const store = new Store(k8s, config.labelPrefix);

  // Recover state from Service annotations (survives pod restarts)
  const recovered = await store.recoverStateFromServices();
  if (recovered > 0) {
    console.log(`Recovered ${recovered} scaled-down service(s) from annotations`);
  }

  const controller = new Controller(k8s, store, config);
  const wakeupServer = new WakeupServer(k8s, store, config);
  wakeupServer.setController(controller);

  await controller.start();
  await wakeupServer.start();

  const shutdown = async (signal) => {
    console.log(`Received ${signal}, shutting down...`);
    const forceExitTimeout = setTimeout(() => {
      console.error('Graceful shutdown timeout exceeded, forcing exit');
      process.exit(1);
    }, 10000);

    try {
      await controller.stop();
      await wakeupServer.stop();
      clearTimeout(forceExitTimeout);
      process.exit(0);
    } catch (err) {
      console.error('Error during shutdown:', err.message);
      clearTimeout(forceExitTimeout);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
