<?php
namespace Meser10\Otp;

class Otp
{
    const ENDPOINT = 'https://heb.mesereser.com/Services/JsonServices.aspx?f=SendSingleSmsMessage';
    const VERSION = '1.0.0';

    private $apiKey; private $sender; private $message; private $codeLength; private $ttl;
    private $maxAttempts; private $resend; private $store; private $secret; private $normalize; private $http; private $timeout;

    /**
     * @param array $opts Required: apiKey, sender, secret (16+ chars, same on every server), store (StoreInterface).
     *                    Optional: message ("{code}"), codeLength (6), ttlSeconds (300), maxAttempts (5),
     *                    resendSeconds (60), timeout (15), normalizePhone (callable), http (callable, for tests).
     */
    public function __construct(array $opts)
    {
        if (empty($opts['apiKey'])) { throw new Meser10Error('config', 'apiKey is required'); }
        if (empty($opts['sender'])) { throw new Meser10Error('config', 'sender is required'); }
        if (empty($opts['secret']) || strlen((string) $opts['secret']) < 16) {
            throw new Meser10Error('config', 'secret is required: a random string of at least 16 characters, the same on every server');
        }
        if (!isset($opts['store']) || !$opts['store'] instanceof StoreInterface) {
            throw new Meser10Error('config', 'store is required: a StoreInterface shared by all servers (e.g. RedisStore)');
        }
        $this->apiKey = trim((string) $opts['apiKey']);
        $this->sender = (string) $opts['sender'];
        $this->secret = (string) $opts['secret'];
        $this->store = $opts['store'];
        $this->message = (string) ($opts['message'] ?? 'Your verification code is {code}');
        $this->codeLength = self::intOpt($opts, 'codeLength', 6, 4, 8);
        $this->ttl = self::intOpt($opts, 'ttlSeconds', 300, 30, 3600);
        $this->maxAttempts = self::intOpt($opts, 'maxAttempts', 5, 1, 20);
        $this->resend = self::intOpt($opts, 'resendSeconds', 60, 0, 3600);
        $this->timeout = self::intOpt($opts, 'timeout', 15, 1, 120);
        $this->normalize = $opts['normalizePhone'] ?? [self::class, 'normalizeIsraeliMobile'];
        $this->http = $opts['http'] ?? [$this, 'curlPost'];
    }

    private static function intOpt(array $opts, string $name, int $def, int $min, int $max): int
    {
        $v = $opts[$name] ?? $def;
        if (!is_int($v) || $v < $min || $v > $max) {
            throw new Meser10Error('config', "$name must be an integer between $min and $max");
        }
        return $v;
    }

    public static function normalizeIsraeliMobile($raw): string
    {
        $d = preg_replace('/[^0-9+]/', '', is_scalar($raw) ? (string) $raw : '');
        $d = preg_replace('/^\+/', '', $d);
        $d = preg_replace('/^00972/', '972', $d);
        if (strpos($d, '972') === 0) { $d = '0' . substr($d, 3); }
        return preg_match('/^05\d{8}$/', $d) ? $d : '';
    }

    /** Sends one SMS and returns the Meser 10 message id. */
    public function sendSms($phone, string $text)
    {
        $to = ($this->normalize)($phone);
        if ($to === '') { throw new Meser10Error('invalid_phone', 'Not a valid mobile number'); }
        $body = json_encode(['ToPhone' => $to, 'MessageBody' => $text, 'FromName' => $this->sender], JSON_UNESCAPED_UNICODE);
        $headers = [
            'ApiKey: ' . $this->apiKey,
            'Content-Type: application/json; charset=utf-8',
            'Accept: application/json',
            // Requests without a User-Agent can be refused at the edge before they reach the API.
            'User-Agent: meser10-otp-php/' . self::VERSION,
        ];
        [$status, $raw] = ($this->http)(self::ENDPOINT, $headers, $body, $this->timeout);
        $data = json_decode((string) $raw, true);
        if (!is_array($data) || !array_key_exists('ErrorCode', $data)) {
            throw new Meser10Error('bad_response', "Unexpected reply from Meser 10 (HTTP $status)");
        }
        if ((string) $data['ErrorCode'] !== '0') {
            $detail = isset($data['Result']) && $data['Result'] !== '' ? (string) $data['Result'] : 'no details';
            throw new Meser10Error('api_error', 'Meser 10 error ' . $data['ErrorCode'] . ': ' . $detail);
        }
        return $data['MessageID'] ?? null;
    }

    /** @return array{to:string,expiresIn:int} */
    public function sendCode($phone, string $context = 'default'): array
    {
        $ctx = self::ctx($context);
        $to = ($this->normalize)($phone);
        if ($to === '') { throw new Meser10Error('invalid_phone', 'Not a valid mobile number'); }
        $waitKey = $this->k('wait', $ctx, $to);
        if ($this->resend > 0 && $this->store->incr($waitKey, $this->resend) > 1) {
            throw new Meser10Error('too_soon', "Wait up to {$this->resend} seconds before asking for a new code");
        }
        $code = '';
        for ($i = 0; $i < $this->codeLength; $i++) { $code .= (string) random_int(0, 9); }
        $text = strpos($this->message, '{code}') !== false ? str_replace('{code}', $code, $this->message) : $this->message . ' ' . $code;
        try {
            $this->sendSms($to, $text);
        } catch (Meser10Error $e) {
            if ($this->resend > 0) { $this->store->delete($waitKey); } // a failed send does not count against the wait
            throw $e;
        }
        $nonce = bin2hex(random_bytes(12));
        $this->store->set($this->k('code', $ctx, $to), ['h' => $this->hash($to, $ctx, $nonce, $code), 'n' => $nonce, 'exp' => time() + $this->ttl], $this->ttl);
        return ['to' => $to, 'expiresIn' => $this->ttl];
    }

    /** Returns true for a correct code, once; throws Meser10Error (no_code, expired, wrong_code, locked). */
    public function verifyCode($phone, $code, string $context = 'default'): bool
    {
        $ctx = self::ctx($context);
        $to = ($this->normalize)($phone);
        if ($to === '') { throw new Meser10Error('invalid_phone', 'Not a valid mobile number'); }
        $rec = $this->store->get($this->k('code', $ctx, $to));
        if (!is_array($rec) || empty($rec['h']) || empty($rec['n'])) { throw new Meser10Error('no_code', 'Ask for a code first'); }
        if (time() > (int) $rec['exp']) { throw new Meser10Error('expired', 'The code has expired'); }
        // Counted atomically before comparing, so parallel guesses cannot exceed the limit.
        $tries = $this->store->incr($this->k('tries', $ctx, $to, $rec['n']), $this->ttl);
        if ($tries > $this->maxAttempts) { throw new Meser10Error('locked', 'Too many wrong codes, ask for a new one'); }
        $given = $this->hash($to, $ctx, $rec['n'], preg_replace('/\D/', '', is_scalar($code) ? (string) $code : ''));
        if (hash_equals((string) $rec['h'], $given)) {
            // Only the first correct verification wins, even if two arrive together.
            if ($this->store->incr($this->k('used', $ctx, $to, $rec['n']), $this->ttl) > 1) {
                throw new Meser10Error('no_code', 'Ask for a code first');
            }
            $this->store->delete($this->k('code', $ctx, $to));
            return true;
        }
        if ($tries >= $this->maxAttempts) { throw new Meser10Error('locked', 'Too many wrong codes, ask for a new one'); }
        throw new Meser10Error('wrong_code', 'Wrong code, ' . ($this->maxAttempts - $tries) . ' tries left');
    }

    private static function ctx(string $context): string
    {
        if (!preg_match('/^[A-Za-z0-9_-]{1,40}$/', $context)) {
            throw new Meser10Error('config', 'context may contain only letters, digits, _ and - (up to 40)');
        }
        return $context;
    }

    private function k(string $kind, string $ctx, string $to, string $nonce = ''): string
    {
        return "meser10otp:$kind:$ctx:$to" . ($nonce !== '' ? ":$nonce" : '');
    }

    private function hash(string $to, string $ctx, string $nonce, string $code): string
    {
        return hash_hmac('sha256', "$ctx|$to|$nonce|$code", $this->secret);
    }

    /** @return array{0:int,1:string} */
    public function curlPost(string $url, array $headers, string $body, int $timeout): array
    {
        $ch = curl_init($url);
        curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body, CURLOPT_HTTPHEADER => $headers, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => $timeout]);
        $raw = curl_exec($ch);
        if ($raw === false) {
            $err = curl_error($ch);
            curl_close($ch);
            throw new Meser10Error('network', "Could not reach Meser 10: $err");
        }
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        return [$status, (string) $raw];
    }
}
