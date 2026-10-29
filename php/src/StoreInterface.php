<?php
namespace Meser10\Otp;

/**
 * Where codes are kept between "send" and "verify". It must be shared by every
 * PHP worker and server that handles your requests (Redis, Memcached, a database),
 * and must not live in anything the visitor controls, such as the session.
 */
interface StoreInterface
{
    /** @return array|null */
    public function get(string $key);

    public function set(string $key, array $value, int $ttlSeconds): void;

    public function delete(string $key): void;

    /** Atomic increment. Creates the key at 1 with the given expiry when it does not exist. */
    public function incr(string $key, int $ttlSeconds): int;
}
