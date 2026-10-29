# @meser10/otp

Send and verify one-time SMS codes (OTP) through the [Meser 10](https://www.meser10.co.il/) API. Zero dependencies, Node 18+.

```bash
npm install @meser10/otp
```

```js
const { Meser10Otp } = require('@meser10/otp');

const otp = new Meser10Otp({
  apiKey: process.env.MESER10_API_KEY,
  sender: 'MyShop',                       // approved sender name or verified mobile
  secret: process.env.OTP_SECRET,         // random, 16+ characters, the same on every instance
  message: 'Your MyShop code is {code}',
});

await otp.sendCode('054-123-4567');        // sends the SMS
await otp.verifyCode('054-123-4567', '123456'); // true, or throws Meser10Error
```

## Next.js route handler

```js
// app/api/otp/route.js
import { Meser10Otp, Meser10Error } from '@meser10/otp';
import { redisStore } from '@/lib/otp-store'; // see "Shared store" below

const otp = new Meser10Otp({ apiKey: process.env.MESER10_API_KEY, sender: 'MyShop', store: redisStore, secret: process.env.OTP_SECRET });

export async function POST(req) {
  const { phone, code } = await req.json();
  try {
    if (code) return Response.json({ ok: await otp.verifyCode(phone, code) });
    await otp.sendCode(phone);
    return Response.json({ sent: true });
  } catch (e) {
    if (e instanceof Meser10Error) return Response.json({ error: e.code }, { status: 400 });
    throw e;
  }
}
```

## Shared store

The default store keeps codes in memory, which only works in a single long-running process. On serverless or with several instances, pass a store shared by all of them. It needs `get`, `set`, `delete` and an atomic `incr`, which is what keeps the wrong-try limit and the resend wait correct under parallel requests. With ioredis:

```js
// lib/otp-store.js
import Redis from 'ioredis';
const redis = new Redis(process.env.REDIS_URL);
export const redisStore = {
  async get(k) { const v = await redis.get(k); return v && JSON.parse(v); },
  async set(k, v, ttl) { await redis.set(k, JSON.stringify(v), 'EX', ttl); },
  async delete(k) { await redis.del(k); },
  // INCR and EXPIRE in one atomic step, so a counter can never be left without an expiry.
  async incr(k, ttl) { return redis.eval("local n=redis.call('INCR',KEYS[1]) if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end return n", 1, k, ttl); },
};
```

Just the SMS, without code handling: `await otp.sendSms('0541234567', 'Any text')`.

## What you need

A Meser 10 account with an SMS balance, an API key (User Settings > API key) and an approved sender: up to 11 Latin letters or digits, or a mobile number verified in the account. Every code is one SMS from your balance. Open an account at https://www.meser10.co.il/

## How it behaves

- Codes come from a cryptographically secure generator and are stored only as an HMAC, never in plain text.
- A code is tied to one number and one context, works once, expires (5 minutes by default) and is cancelled after too many wrong tries (5 by default).
- A new code to the same number can be requested only after a wait (60 seconds by default).
- Numbers are accepted in Israeli mobile format by default (05X, +972, 00972). Pass your own normalizer to accept others.
- Add your own rate limits per IP and per account on top: every code is a paid SMS.
- Anyone who knows a number can cancel its current code with wrong guesses; the owner then asks for a new one after the wait. Keep the wait short and rate-limit verify attempts per IP.
- Errors carry a code: `config`, `invalid_phone`, `network`, `bad_response`, `api_error`, `too_soon`, `no_code`, `expired`, `wrong_code`, `locked`.

## Links

- OTP over the Meser 10 API: https://www.meser10.co.il/en/otp/
- JSON API reference: https://www.meser10.co.il/en/json-api/
- WordPress plugin: https://www.meser10.co.il/features/wordpress-otp/

## עברית

חבילה לשליחת קוד אימות חד-פעמי ב-SMS דרך חשבון מסר 10, ולבדיקת הקוד שהמשתמש הקליד. מדריך מלא בעברית: https://www.meser10.co.il/features/otp/

MIT License, Meser-Eser Ltd.
