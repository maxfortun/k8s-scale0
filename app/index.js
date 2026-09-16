import { Controller } from './controller.js';
import { WakeupServer } from './wakeup-server.js';
import { K8sClient } from './k8s.js';
import { Store } from './store.js';

const config = {
  checkIntervalMs: parseInt(process.env.CHECK_INTERVAL_MS || '30000', 10),
  wakeupPort: parseInt(process.env.WAKEUP_PORT || '8080', 10),
  scaleInAfterSeconds: parseInt(process.env.SCALE_IN_AFTER_SECONDS || '86400', 10),
  retryAfterSeconds: parseInt(process.env.RETRY_AFTER_SECONDS || '5', 10),
  labelPrefix: process.env.LABEL_PREFIX || 'scale0.io',
  tarpitSecret: process.env.TARPIT_SECRET,
  tarpitDelaySeconds: parseInt(process.env.TARPIT_DELAY_SECONDS || '3', 10),
  tarpitCookieName: process.env.TARPIT_COOKIE_NAME || 'scale0_tarpit',
};

async function main() {
  console.log('Starting k8s-scale0 controller...');
  console.log('Config:', JSON.stringify(config, null, 2));

  const k8s = new K8sClient();
  await k8s.init();

  const store = new Store();

  const controller = new Controller(k8s, store, config);
  const wakeupServer = new WakeupServer(k8s, store, config);
  wakeupServer.setController(controller);

  await controller.start();
  await wakeupServer.start();

  const shutdown = async (signal) => {
    console.log(`Received ${signal}, shutting down...`);
    await controller.stop();
    await wakeupServer.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
