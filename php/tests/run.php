<?php
spl_autoload_register(function ($c) { $f = __DIR__ . '/../src/' . substr(strrchr($c, '\\'), 1) . '.php'; if (is_file($f)) require $f; });
use Meser10\Otp\{Otp, Meser10Error, StoreInterface};
class Mem implements StoreInterface {
  public $d = [];
  function get(string $k) { $e = $this->d[$k] ?? null; if (!$e || $e[1] < time()) return null; return $e[0]; }
  function set(string $k, array $v, int $t): void { $this->d[$k] = [$v, time() + $t]; }
  function delete(string $k): void { unset($this->d[$k]); }
  function incr(string $k, int $t): int { $e = $this->d[$k] ?? null; if (!$e || $e[1] < time()) { $this->d[$k] = [1, time() + $t]; return 1; } $this->d[$k][0]++; return $this->d[$k][0]; }
}
$calls = []; $reply = ['ErrorCode' => 0, 'Result' => '', 'MessageID' => 7];
$http = function ($u, $h, $b) use (&$calls, &$reply) { $calls[] = [$u, $h, json_decode($b, true)]; return [200, json_encode($reply)]; };
$code = function () use (&$calls) { preg_match('/\d{4,8}/', end($calls)[2]['MessageBody'], $m); return $m[0]; };
$fail = 0; $ok = function ($c, $l) use (&$fail) { echo ($c ? 'ok' : 'FAIL') . ": $l\n"; if (!$c) $fail++; };
$err = function ($fn) { try { $fn(); return 'none'; } catch (Meser10Error $e) { return $e->errorCode; } };
$mk = function ($o = []) use ($http) { return new Otp($o + ['apiKey' => 'K', 'sender' => 'Shop', 'secret' => 'test-secret-0123456789', 'store' => new Mem(), 'http' => $http]); };
$ok($err(function () { new Otp(['apiKey' => 'K', 'sender' => 'S', 'secret' => 'test-secret-0123456789']); }) === 'config', 'store required');
$ok($err(function () use ($mk) { $mk(['codeLength' => 'six']); }) === 'config', 'int options validated');
$o = $mk();
$ok(Otp::normalizeIsraeliMobile('+972-54-773-9363') === '0547739363', 'normalize');
$o->sendCode('054-773-9363'); $c = $code();
$ok(strpos($calls[0][0], 'f=SendSingleSmsMessage') !== false && in_array('ApiKey: K', $calls[0][1], true), 'endpoint + key');
$ok(strlen($c) === 6, 'code length');
$ok($err(function () use ($o, $c) { $o->verifyCode('0547739363', $c, 'other'); }) === 'no_code', 'context bound');
$ok($o->verifyCode('+972547739363', $c) === true, 'verify');
$ok($err(function () use ($o, $c) { $o->verifyCode('0547739363', $c); }) === 'no_code', 'works once');
$ok($err(function () use ($o) { $o->sendCode('0547739363'); }) === 'too_soon', 'resend wait');
$o2 = $mk(['maxAttempts' => 2]);
$o2->sendCode('0522222222'); $c2 = $code(); $bad = $c2 === '000000' ? '111111' : '000000';
$ok($err(function () use ($o2, $bad) { $o2->verifyCode('0522222222', $bad); }) === 'wrong_code', 'wrong');
$ok($err(function () use ($o2, $bad) { $o2->verifyCode('0522222222', $bad); }) === 'locked', 'locked');
$ok($err(function () use ($o2, $c2) { $o2->verifyCode('0522222222', $c2); }) === 'locked', 'right code after lock rejected');
$ok($err(function () use ($o2) { $o2->verifyCode('0522222222', ['x']); }) === 'locked', 'array code does not crash');
$o3 = $mk(['ttlSeconds' => 30, 'resendSeconds' => 600]); $o3->sendCode('0526666666');
$err(function () use ($o3) { $o3->verifyCode('0526666666', '0'); });
$ok($err(function () use ($o3) { $o3->sendCode('0526666666'); }) === 'too_soon', 'resend longer than ttl holds');
$reply = ['ErrorCode' => 4];
$ok($err(function () use ($o) { $o->sendCode('0524444444'); }) === 'api_error', 'api error without Result');
$ok($err(function () use ($o) { $o->verifyCode('0524444444', '123456'); }) === 'no_code', 'no code stored after failure');
$ok($err(function () use ($o) { $o->sendCode('0524444444'); }) === 'api_error', 'failed send frees resend wait');
$n = count($calls); $ok($err(function () use ($o) { $o->sendCode('123'); }) === 'invalid_phone' && count($calls) === $n, 'invalid phone, no API call');
$ok($err(function () use ($o) { $o->sendCode('0541111111', 'a:b'); }) === 'config', 'context validated');
echo $fail ? "FAILED $fail\n" : "ALL OK\n";
