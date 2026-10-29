# meser10/otp

Send and verify one-time SMS codes (OTP) through the [Meser 10](https://www.meser10.co.il/) API. No dependencies beyond ext-json and ext-curl, PHP 7.4+.

```bash
composer config repositories.meser10-otp vcs https://github.com/meser10/meser10-otp
composer require meser10/otp:^1.0
```

```php
use Meser10\Otp\Otp;
use Meser10\Otp\RedisStore;
use Meser10\Otp\Meser10Error;

$redis = new Redis();
$redis->connect('127.0.0.1');

$otp = new Otp([
    'apiKey'  => getenv('MESER10_API_KEY'),
    'sender'  => 'MyShop',                      // approved sender name or verified mobile
    'secret'  => getenv('OTP_SECRET'),          // random, 16+ characters, the same on every server
    'store'   => new RedisStore($redis),        // shared by all servers, never the session
    'message' => 'Your MyShop code is {code}',
]);

$otp->sendCode('054-123-4567');
try {
    $otp->verifyCode('054-123-4567', $_POST['code'] ?? ''); // true
} catch (Meser10Error $e) {
    echo $e->errorCode;                                      // wrong_code, expired, locked...
}
```

The store must be shared by every PHP worker and server, and must not be the visitor's session: a visitor can drop the session and reset the limits. `RedisStore` works with phpredis; for Laravel Cache, Memcached or a database, implement `StoreInterface` (`get`, `set`, `delete` and an atomic `incr`).

Just the SMS, without code handling: `$otp->sendSms('0541234567', 'Any text')`.

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
