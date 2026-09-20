import http from 'node:http';
import { Tarpit } from './tarpit.js';

export class WakeupServer {
  constructor(k8s, store, config) {
    this.k8s = k8s;
    this.store = store;
    this.config = config;
    this.server = null;
    this.controller = null;
    this.tarpit = new Tarpit(config);
  }

  setController(controller) {
    this.controller = controller;
  }

  async start() {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      this.server.listen(this.config.wakeupPort, () => {
        console.log(`Wakeup server listening on port ${this.config.wakeupPort}`);
        resolve();
      });
    });
  }

  async stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log('Wakeup server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  getRequestUrl(req) {
    return req.url || '/';
  }

  getAcceptedContentType(req) {
    const accept = req.headers.accept || '';
    if (accept.includes('application/json')) return 'application/json';
    return 'text/html';
  }

  addCorsHeaders(req, headers) {
    const origin = req.headers.origin;
    const allowedOrigins = this.config.corsAllowedOrigins;

    if (allowedOrigins && allowedOrigins.length > 0) {
      if (origin && allowedOrigins.includes(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Access-Control-Allow-Credentials'] = 'true';
      } else {
        headers['Access-Control-Allow-Origin'] = allowedOrigins[0];
      }
    } else {
      headers['Access-Control-Allow-Origin'] = '*';
    }

    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Accept, X-Requested-With';
    headers['Access-Control-Expose-Headers'] = 'Refresh, Retry-After, Set-Cookie';
  }

  sendResponse(req, res, statusCode, statusMessage, body, refreshDelay = 0, setCookie = null) {
    const contentType = this.getAcceptedContentType(req);
    const url = this.getRequestUrl(req);

    const headers = {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    };

    if (setCookie) {
      headers['Set-Cookie'] = setCookie;
    }

    if (refreshDelay > 0) {
      headers['Refresh'] = `${refreshDelay}; url=${url}`;
      headers['Retry-After'] = String(refreshDelay);
    }

    this.addCorsHeaders(req, headers);
    res.writeHead(statusCode, headers);

    if (contentType === 'application/json') {
      res.end(JSON.stringify(body));
    } else {
      res.end(this.renderHtml(statusCode, statusMessage, body, refreshDelay));
    }
  }

  renderHtml(statusCode, statusMessage, body, refreshDelay) {
    const message = body.message || statusMessage;
    const service = body.service || 'unknown';
    const refreshMeta = refreshDelay > 0 ? `<meta http-equiv="refresh" content="${refreshDelay}">` : '';

    if (statusCode === 418) {
      return `<!DOCTYPE html>
<html>
<head><title>${statusCode} ${statusMessage}</title>${refreshMeta}</head>
<body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#fef3c7;">
<div style="text-align:center;padding:2rem;background:white;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,0.1);">
<div style="font-size:4rem;">🫖</div>
<h1 style="color:#92400e;">${statusMessage}</h1>
<p style="color:#666;">${message}</p>
</div>
</body>
</html>`;
    }

    const spinner = statusCode === 503 ? `<div style="border:4px solid #f3f3f3;border-top:4px solid #3498db;border-radius:50%;width:40px;height:40px;animation:spin 1s linear infinite;margin:1rem auto;"></div>
<style>@keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}</style>` : '';

    return `<!DOCTYPE html>
<html>
<head><title>${statusCode} ${statusMessage}</title>${refreshMeta}</head>
<body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f5f5f5;">
<div style="text-align:center;padding:2rem;background:white;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,0.1);">
${spinner}
<h1 style="color:#333;">${statusMessage}</h1>
<p style="color:#666;">${message}</p>
${refreshDelay > 0 ? `<p style="color:#999;font-size:0.9rem;">Retrying in ${refreshDelay} seconds...</p>` : ''}
</div>
</body>
</html>`;
  }

  async handleRequest(req, res) {
    if (req.method === 'OPTIONS') {
      const headers = {};
      this.addCorsHeaders(req, headers);
      res.writeHead(204, headers);
      res.end();
      return;
    }

    if (req.url === '/healthz' || req.url === '/readyz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (req.url === '/status') {
      const status = {
        scaledDown: this.store.getAllScaledDown(),
        tracked: this.store.getAllTracked(),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status, null, 2));
      return;
    }

    const originalService = req.headers['x-scale0-original-service'];
    const originalNamespace = req.headers['x-scale0-original-namespace'];

    if (!originalService || !originalNamespace) {
      console.warn('Request missing original service headers');
      this.sendResponse(req, res, 400, 'Bad Request', {
        message: 'Missing x-scale0-original-service or x-scale0-original-namespace headers',
      });
      return;
    }

    console.log(`Received request for ${originalNamespace}/${originalService}`);

    if (!this.store.isScaledDown(originalNamespace, originalService)) {
      console.warn(`Service ${originalNamespace}/${originalService} is not scaled down`);
      this.sendResponse(req, res, 404, 'Not Found', {
        message: 'Service not found in scaled-down state',
        service: originalService,
      });
      return;
    }

    const tarpitCookie = this.tarpit.getCookieValue(req);
    const tarpitDelay = this.config.tarpitDelaySeconds || 3;
    const retryAfter = this.config.retryAfterSeconds;

    if (!tarpitCookie) {
      console.log(`First request for ${originalNamespace}/${originalService}, setting tarpit cookie`);
      const newCookie = this.tarpit.generate();
      this.sendResponse(req, res, 503, 'Service Unavailable', {
        message: 'Checking client capabilities',
        service: originalService,
        status: 'tarpit_check',
      }, tarpitDelay, this.tarpit.setCookieHeader(newCookie));
      return;
    }

    const verification = this.tarpit.verify(tarpitCookie);

    if (!verification.valid) {
      console.log(`Tarpit verification failed for ${originalNamespace}/${originalService}: ${verification.reason}`);

      if (verification.reason === 'early') {
        const waitSeconds = Math.ceil(verification.remainingMs / 1000);
        this.sendResponse(req, res, 418, "I'm a teapot", {
          message: 'Request arrived too early. Please wait and retry.',
          service: originalService,
          status: 'tarpit_early',
          waitSeconds,
        }, waitSeconds);
        return;
      }

      this.sendResponse(req, res, 418, "I'm a teapot", {
        message: 'Invalid request signature',
        service: originalService,
        status: 'tarpit_invalid',
        reason: verification.reason,
      });
      return;
    }

    console.log(`Tarpit verified, waking up ${originalNamespace}/${originalService}`);

    if (!this.controller) {
      this.sendResponse(req, res, 500, 'Internal Server Error', {
        message: 'Controller not initialized',
        service: originalService,
      });
      return;
    }

    const timeoutMs = this.config.wakeupTimeoutMs || 30000;
    let success = false;

    try {
      success = await Promise.race([
        this.controller.wakeUp(originalNamespace, originalService),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Wakeup timeout')), timeoutMs)
        ),
      ]);
    } catch (err) {
      console.error(`Wakeup error for ${originalNamespace}/${originalService}:`, err.message);
      this.sendResponse(req, res, 504, 'Gateway Timeout', {
        message: 'Wakeup operation timed out',
        service: originalService,
        status: 'wakeup_timeout',
      });
      return;
    }

    if (success) {
      this.sendResponse(req, res, 503, 'Service Starting', {
        message: `Service ${originalService} is waking up`,
        service: originalService,
        status: 'waking_up',
      }, retryAfter);
      console.log(`Sent wakeup response for ${originalNamespace}/${originalService}`);
    } else {
      this.sendResponse(req, res, 500, 'Internal Server Error', {
        message: 'Failed to wake up service',
        service: originalService,
        status: 'wakeup_failed',
      });
    }
  }
}
