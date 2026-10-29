'use strict';

const crypto = require('node:crypto');

const ENDPOINT = 'https://heb.mesereser.com/Services/JsonServices.aspx?f=SendSingleSmsMessage';
const VERSION = '1.0.0';

/**
 * Reads an Israeli mobile number from what a user typed: 05X..., +972 or 00972.
 * Returns 05XXXXXXXX, or '' when it is not an Israeli mobile number.
 */
function normalizeIsraeliMobile(raw) {
  let d = String(raw || '').replace(/[^0-9+]/g, '').replace(/^\+/, '').replace(/^00972/, '972');
  if (d.startsWith('972')) d = '0' + d.slice(3);
  return /^05\d{8}$/.test(d) ? d : '';
}

class Meser10Error extends Error {
  constructor(code, message) { super(message); this.name = 'Meser10Error'; this.code = code; }
}

/**
 * In-process store, for a single long-running process only. With several
 * processes, servers or serverless functions, pass a shared store (see README).
 * Store contract: get/set/delete, and incr(key, ttlSeconds) which must be atomic
 * and set the expiry when it creates the key.
 */
class MemoryStore {
  constructor() { this.map = new Map(); this.ops = 0; }
  _alive(key) {
    const e = this.map.get(key);
    if (e && e.expires < Date.now()) { this.map.delete(key); return null; }
    return e || null;
  }
  _sweep() {
    if (++this.ops % 500) return;
    const now = Date.now();
    for (const [k, e] of this.map) if (e.expires < now) this.map.delete(k);
  }
  async get(key) { const e = this._alive(key); return e ? e.value : null; }
  async set(key, value, ttlSeconds) { this._sweep(); this.map.set(key, { value, expires: Date.now() + ttlSeconds * 1000 }); }
  async delete(key) { this.map.delete(key); }
  async incr(key, ttlSeconds) {
    this._sweep();
    const e = this._alive(key);
    if (!e) { this.map.set(key, { value: 1, expires: Date.now() + ttlSeconds * 1000 }); return 1; }
    e.value += 1;
    return e.value;
  }
}

function intOption(opts, name, def, min, max) {
  const v = opts[name] === undefined ? def : opts[name];
  if (!Number.isInteger(v) || v < min || v > max) throw new Meser10Error('config', `${name} must be an integer between ${min} and ${max}`);
  return v;
}

class Meser10Otp {
  /**
   * @param {object} opts see README: apiKey, sender, secret (required); message, codeLength, ttlSeconds,
   *   maxAttempts, resendSeconds, timeoutMs, store, normalizePhone, fetch.
   */
  constructor(opts = {}) {
    if (!opts.apiKey) throw new Meser10Error('config', 'apiKey is required');
    if (!opts.sender) throw new Meser10Error('config', 'sender is required');
    if (!opts.secret || String(opts.secret).length < 16) throw new Meser10Error('config', 'secret is required: a random string of at least 16 characters, the same on every instance');
    this.apiKey = String(opts.apiKey).trim();
    this.sender = String(opts.sender);
    this.secret = String(opts.secret);
    this.message = String(opts.message || 'Your verification code is {code}');
    this.codeLength = intOption(opts, 'codeLength', 6, 4, 8);
    this.ttl = intOption(opts, 'ttlSeconds', 300, 30, 3600);
    this.maxAttempts = intOption(opts, 'maxAttempts', 5, 1, 20);
    this.resend = intOption(opts, 'resendSeconds', 60, 0, 3600);
    this.timeoutMs = intOption(opts, 'timeoutMs', 15000, 1000, 120000);
    this.store = opts.store || new MemoryStore();
    for (const m of ['get', 'set', 'delete', 'incr']) {
      if (typeof this.store[m] !== 'function') throw new Meser10Error('config', `store must implement ${m}()`);
    }
    this.normalize = opts.normalizePhone || normalizeIsraeliMobile;
    this.fetch = opts.fetch || globalThis.fetch;
  }

  /** Sends one SMS. Returns { messageId }. Throws Meser10Error. */
  async sendSms(phone, text) {
    const to = this.normalize(phone);
    if (!to) throw new Meser10Error('invalid_phone', 'Not a valid mobile number');
    let res;
    try {
      res = await this.fetch(ENDPOINT, {
        method: 'POST',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          ApiKey: this.apiKey,
          'Content-Type': 'application/json; charset=utf-8',
          Accept: 'application/json',
          // Requests without a User-Agent can be refused at the edge before they reach the API.
          'User-Agent': `meser10-otp-node/${VERSION}`,
        },
        body: JSON.stringify({ ToPhone: to, MessageBody: String(text), FromName: this.sender }),
      });
    } catch (e) {
      throw new Meser10Error('network', `Could not reach Meser 10: ${e.message}`);
    }
    let data;
    try { data = await res.json(); } catch { data = null; }
    if (!data || typeof data !== 'object' || Array.isArray(data) || !('ErrorCode' in data)) {
      throw new Meser10Error('bad_response', `Unexpected reply from Meser 10 (HTTP ${res.status})`);
    }
    if (String(data.ErrorCode) !== '0') {
      throw new Meser10Error('api_error', `Meser 10 error ${data.ErrorCode}: ${data.Result || 'no details'}`);
    }
    return { messageId: data.MessageID };
  }

  /** Generates a code, sends it, and remembers only its HMAC. Returns { to, expiresIn }. */
  async sendCode(phone, context = 'default') {
    const ctx = checkContext(context);
    const to = this.normalize(phone);
    if (!to) throw new Meser10Error('invalid_phone', 'Not a valid mobile number');
    if (this.resend > 0 && (await this.store.incr(this._k('wait', ctx, to), this.resend)) > 1) {
      throw new Meser10Error('too_soon', `Wait up to ${this.resend} seconds before asking for a new code`);
    }
    let code = '';
    for (let i = 0; i < this.codeLength; i++) code += crypto.randomInt(0, 10);
    const text = this.message.includes('{code}') ? this.message.split('{code}').join(code) : `${this.message} ${code}`;
    try {
      await this.sendSms(to, text);
    } catch (e) {
      // A failed send does not count against the resend wait.
      if (this.resend > 0) await this.store.delete(this._k('wait', ctx, to));
      throw e;
    }
    const nonce = crypto.randomBytes(12).toString('hex');
    await this.store.set(this._k('code', ctx, to), { h: this._hash(to, ctx, nonce, code), n: nonce, exp: Date.now() + this.ttl * 1000 }, this.ttl);
    return { to, expiresIn: this.ttl };
  }

  /** Returns true for a correct code, once. Throws Meser10Error: no_code, expired, wrong_code, locked. */
  async verifyCode(phone, code, context = 'default') {
    const ctx = checkContext(context);
    const to = this.normalize(phone);
    if (!to) throw new Meser10Error('invalid_phone', 'Not a valid mobile number');
    const rec = await this.store.get(this._k('code', ctx, to));
    if (!rec || typeof rec.h !== 'string' || !rec.n) throw new Meser10Error('no_code', 'Ask for a code first');
    if (Date.now() > rec.exp) throw new Meser10Error('expired', 'The code has expired');
    // Counted atomically before comparing, so parallel guesses cannot exceed the limit.
    const tries = await this.store.incr(this._k('tries', ctx, to, rec.n), this.ttl);
    if (tries > this.maxAttempts) throw new Meser10Error('locked', 'Too many wrong codes, ask for a new one');
    const given = this._hash(to, ctx, rec.n, String(code == null ? '' : code).replace(/\D/g, ''));
    const a = Buffer.from(given, 'hex');
    const b = Buffer.from(rec.h, 'hex');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      // Only the first correct verification wins, even if two arrive together.
      if ((await this.store.incr(this._k('used', ctx, to, rec.n), this.ttl)) > 1) throw new Meser10Error('no_code', 'Ask for a code first');
      await this.store.delete(this._k('code', ctx, to));
      return true;
    }
    if (tries >= this.maxAttempts) throw new Meser10Error('locked', 'Too many wrong codes, ask for a new one');
    throw new Meser10Error('wrong_code', `Wrong code, ${this.maxAttempts - tries} tries left`);
  }

  _k(kind, ctx, to, nonce) { return `meser10otp:${kind}:${ctx}:${to}${nonce ? ':' + nonce : ''}`; }
  _hash(to, ctx, nonce, code) { return crypto.createHmac('sha256', this.secret).update(`${ctx}|${to}|${nonce}|${code}`).digest('hex'); }
}

function checkContext(ctx) {
  const c = String(ctx);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(c)) throw new Meser10Error('config', 'context may contain only letters, digits, _ and - (up to 40)');
  return c;
}

module.exports = { Meser10Otp, Meser10Error, MemoryStore, normalizeIsraeliMobile };
