# meser10-otp

Send and verify one-time SMS codes (OTP) through the [Meser 10](https://www.meser10.co.il/) API. No dependencies, Python 3.8+.

```bash
pip install "git+https://github.com/meser10/meser10-otp#subdirectory=python"
```

```python
import os
from meser10_otp import Meser10Otp, Meser10Error

otp = Meser10Otp(
    os.environ["MESER10_API_KEY"],
    sender="MyShop",                    # approved sender name or verified mobile
    secret=os.environ["OTP_SECRET"],     # random, 16+ characters, the same on every worker
    message="Your MyShop code is {code}",
)

otp.send_code("054-123-4567")
try:
    otp.verify_code("054-123-4567", "123456")   # True
except Meser10Error as e:
    print(e.code)                              # wrong_code, expired, locked...
```

## Django / Flask

The default `MemoryStore` lives in one process. With several workers (gunicorn, uwsgi) or servers, pass a store shared by all of them. It needs `get`, `set`, `delete` and an atomic `incr`, which keeps the wrong-try limit and the resend wait correct under parallel requests. With redis-py:

```python
import json, redis

class RedisStore:
    def __init__(self, r): self.r = r
    def get(self, k):
        v = self.r.get(k); return json.loads(v) if v else None
    def set(self, k, v, ttl): self.r.set(k, json.dumps(v), ex=ttl)
    def delete(self, k): self.r.delete(k)
    def incr(self, k, ttl):
        # INCR and EXPIRE in one atomic step, so a counter can never be left without an expiry.
        return self.r.eval("local n=redis.call('INCR',KEYS[1]) if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end return n", 1, k, ttl)

otp = Meser10Otp(api_key, sender="MyShop", secret=SECRET, store=RedisStore(redis.Redis()))
```

Just the SMS, without code handling: `otp.send_sms("0541234567", "Any text")`.

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
