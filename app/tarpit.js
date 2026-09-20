import crypto from 'node:crypto';

export class Tarpit {
  constructor(config) {
    const providedSecret = config.tarpitSecret || process.env.TARPIT_SECRET;
    if (!providedSecret) {
      console.warn(
        'WARNING: TARPIT_SECRET not configured. Using ephemeral secret. ' +
        'Tarpit cookies will become invalid on pod restart. ' +
        'Set TARPIT_SECRET env var for production use.'
      );
      this.secret = crypto.randomBytes(32).toString('hex');
      this.isEphemeral = true;
    } else {
      this.secret = providedSecret;
      this.isEphemeral = false;
    }
    this.delaySeconds = config.tarpitDelaySeconds ?? 3;
    this.cookieName = config.tarpitCookieName || 'scale0_tarpit';
  }

  parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader) return cookies;

    cookieHeader.split(/\s*;\s*/).forEach((cookie) => {
      const [key, ...rest] = cookie.split('=');
      if (key) cookies[key.trim()] = rest.join('=');
    });
    return cookies;
  }

  generate() {
    const tarpit = {
      exp: Date.now() + this.delaySeconds * 1000,
      nonce: crypto.randomBytes(8).toString('hex'),
    };

    const payload = JSON.stringify(tarpit);
    const sig = crypto.createHmac('sha256', this.secret).update(payload).digest('hex');

    const signed = { tarpit, sig };
    return Buffer.from(JSON.stringify(signed)).toString('base64');
  }

  verify(encoded) {
    if (!encoded) return { valid: false, reason: 'missing' };

    try {
      const signed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      const { tarpit, sig } = signed;

      if (!tarpit || !sig) {
        return { valid: false, reason: 'malformed' };
      }

      const payload = JSON.stringify(tarpit);
      const expectedSig = crypto.createHmac('sha256', this.secret).update(payload).digest('hex');

      const sigBuffer = Buffer.from(sig, 'hex');
      const expectedBuffer = Buffer.from(expectedSig, 'hex');

      if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
        return { valid: false, reason: 'signature' };
      }

      const now = Date.now();
      if (now < tarpit.exp) {
        const remainingMs = tarpit.exp - now;
        return { valid: false, reason: 'early', remainingMs };
      }

      return { valid: true };
    } catch (err) {
      return { valid: false, reason: 'parse', error: err.message };
    }
  }

  getCookieValue(req) {
    const cookieHeader = req.headers.cookie || req.headers.Cookie;
    const cookies = this.parseCookies(cookieHeader);
    return cookies[this.cookieName];
  }

  setCookieHeader(value) {
    return `${this.cookieName}=${value}; Path=/; SameSite=None; HttpOnly; Secure; Max-Age=300`;
  }
}
