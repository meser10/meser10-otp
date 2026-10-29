# Meser 10 OTP

Send and verify one-time SMS codes (OTP) through the [Meser 10](https://www.meser10.co.il/) API, in Node.js, Python and PHP. No dependencies. Israeli mobile numbers by default.

| Language | Install | Guide |
|---|---|---|
| Node.js 18+ | `npm install @meser10/otp` | [node/README.md](node/README.md) |
| Python 3.8+ | `pip install "git+https://github.com/meser10/meser10-otp#subdirectory=python"` | [python/README.md](python/README.md) |
| PHP 7.4+ | `composer config repositories.meser10-otp vcs https://github.com/meser10/meser10-otp` then `composer require meser10/otp:^1.0` | [php/README.md](php/README.md) |

All three behave the same: a code works once, is stored only as an HMAC, expires (5 minutes by default), locks after too many wrong tries, and a new code to the same number waits for a resend window. Limits are enforced atomically in a store shared by all your servers, so parallel requests cannot get around them.

Using WordPress? There is a plugin: https://www.meser10.co.il/features/wordpress-otp/

The API itself: https://www.meser10.co.il/en/otp/

MIT License, Meser-Eser Ltd.

## עברית

חבילות ל-Node.js, Python ו-PHP לשליחת קוד אימות חד-פעמי ב-SMS דרך חשבון מסר 10, ולבדיקת הקוד. מדריך בעברית: https://www.meser10.co.il/features/otp/
