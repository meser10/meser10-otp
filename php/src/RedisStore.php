<?php
namespace Meser10\Otp;

/** StoreInterface on a phpredis connection: new RedisStore($redis). */
class RedisStore implements StoreInterface
{
    private $redis;

    public function __construct($redis)
    {
        $this->redis = $redis;
    }

    public function get(string $key)
    {
        $v = $this->redis->get($key);
        return $v === false ? null : json_decode($v, true);
    }

    public function set(string $key, array $value, int $ttlSeconds): void
    {
        $this->redis->setex($key, $ttlSeconds, json_encode($value));
    }

    public function delete(string $key): void
    {
        $this->redis->del($key);
    }

    public function incr(string $key, int $ttlSeconds): int
    {
        // One atomic step: a crash can never leave a counter without an expiry.
        return (int) $this->redis->eval("local n=redis.call('INCR',KEYS[1]) if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end return n", [$key, $ttlSeconds], 1);
    }
}
