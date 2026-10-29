"""Send and verify one-time SMS codes through the Meser 10 API."""
import hashlib
import hmac
import json
import re
import secrets
import socket
import threading
import time
import urllib.error
import urllib.request

__version__ = "1.0.0"
__all__ = ["Meser10Otp", "Meser10Error", "MemoryStore", "normalize_israeli_mobile"]

ENDPOINT = "https://heb.mesereser.com/Services/JsonServices.aspx?f=SendSingleSmsMessage"
_CONTEXT = re.compile(r"[A-Za-z0-9_-]{1,40}")


def normalize_israeli_mobile(raw):
    """Return 05XXXXXXXX, or '' when the input is not an Israeli mobile number."""
    d = re.sub(r"[^0-9+]", "", str(raw or ""))
    d = re.sub(r"^\+", "", d)
    d = re.sub(r"^00972", "972", d)
    if d.startswith("972"):
        d = "0" + d[3:]
    return d if re.fullmatch(r"05\d{8}", d) else ""


class Meser10Error(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class MemoryStore:
    """In-process store for a single process. With several workers or servers, pass a shared store.

    Store contract: get(key), set(key, value, ttl_seconds), delete(key), and incr(key, ttl_seconds),
    which must be atomic and set the expiry when it creates the key (Redis: INCR + EXPIRE NX).
    """

    def __init__(self):
        self._d = {}
        self._lock = threading.Lock()
        self._ops = 0

    def _alive(self, key, now):
        e = self._d.get(key)
        if e and e[1] < now:
            del self._d[key]
            return None
        return e

    def _sweep(self, now):
        self._ops += 1
        if self._ops % 500 == 0:
            for k in [k for k, e in self._d.items() if e[1] < now]:
                del self._d[k]

    def get(self, key):
        with self._lock:
            e = self._alive(key, time.time())
            return json.loads(json.dumps(e[0])) if e else None

    def set(self, key, value, ttl_seconds):
        with self._lock:
            now = time.time()
            self._sweep(now)
            self._d[key] = (json.loads(json.dumps(value)), now + ttl_seconds)

    def delete(self, key):
        with self._lock:
            self._d.pop(key, None)

    def incr(self, key, ttl_seconds):
        with self._lock:
            now = time.time()
            self._sweep(now)
            e = self._alive(key, now)
            n = (e[0] if e else 0) + 1
            self._d[key] = (n, e[1] if e else now + ttl_seconds)
            return n


def _int_opt(name, value, lo, hi):
    if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
        raise Meser10Error("config", "%s must be an integer between %d and %d" % (name, lo, hi))
    return value


class Meser10Otp:
    def __init__(self, api_key, sender, secret, message="Your verification code is {code}", code_length=6,
                 ttl_seconds=300, max_attempts=5, resend_seconds=60, timeout=15, store=None,
                 normalize_phone=normalize_israeli_mobile, opener=None):
        if not api_key:
            raise Meser10Error("config", "api_key is required")
        if not sender:
            raise Meser10Error("config", "sender is required")
        if not secret or len(str(secret)) < 16:
            raise Meser10Error("config", "secret is required: a random string of at least 16 characters, the same on every worker")
        self.api_key = str(api_key).strip()
        self.sender = str(sender)
        self.secret = str(secret).encode()
        self.message = str(message)
        self.code_length = _int_opt("code_length", code_length, 4, 8)
        self.ttl = _int_opt("ttl_seconds", ttl_seconds, 30, 3600)
        self.max_attempts = _int_opt("max_attempts", max_attempts, 1, 20)
        self.resend = _int_opt("resend_seconds", resend_seconds, 0, 3600)
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 1 <= timeout <= 120:
            raise Meser10Error("config", "timeout must be a number of seconds between 1 and 120")
        self.timeout = timeout
        self.store = store or MemoryStore()
        for m in ("get", "set", "delete", "incr"):
            if not callable(getattr(self.store, m, None)):
                raise Meser10Error("config", "store must implement %s()" % m)
        self.normalize = normalize_phone
        self._open = opener or urllib.request.urlopen

    def send_sms(self, phone, text):
        """Send one SMS. Returns the Meser 10 message id. Raises Meser10Error."""
        to = self.normalize(phone)
        if not to:
            raise Meser10Error("invalid_phone", "Not a valid mobile number")
        body = json.dumps({"ToPhone": to, "MessageBody": str(text), "FromName": self.sender}, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(ENDPOINT, data=body, method="POST", headers={
            "ApiKey": self.api_key,
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "application/json",
            # Requests without a User-Agent can be refused at the edge before they reach the API.
            "User-Agent": "meser10-otp-python/" + __version__,
        })
        status = 0
        try:
            with self._open(req, timeout=self.timeout) as r:
                raw = r.read()
                status = getattr(r, "status", 200)
        except urllib.error.HTTPError as e:
            raw, status = e.read(), e.code
        except (urllib.error.URLError, socket.timeout, OSError) as e:
            raise Meser10Error("network", "Could not reach Meser 10: %s" % e)
        try:
            data = json.loads(raw.decode("utf-8"))
        except ValueError:
            data = None
        if not isinstance(data, dict) or "ErrorCode" not in data:
            raise Meser10Error("bad_response", "Unexpected reply from Meser 10 (HTTP %s)" % status)
        if str(data.get("ErrorCode")) != "0":
            raise Meser10Error("api_error", "Meser 10 error %s: %s" % (data.get("ErrorCode"), data.get("Result") or "no details"))
        return data.get("MessageID")

    def send_code(self, phone, context="default"):
        ctx = self._ctx(context)
        to = self.normalize(phone)
        if not to:
            raise Meser10Error("invalid_phone", "Not a valid mobile number")
        wait_key = self._k("wait", ctx, to)
        if self.resend > 0 and self.store.incr(wait_key, self.resend) > 1:
            raise Meser10Error("too_soon", "Wait up to %d seconds before asking for a new code" % self.resend)
        code = "".join(str(secrets.randbelow(10)) for _ in range(self.code_length))
        text = self.message.replace("{code}", code) if "{code}" in self.message else self.message + " " + code
        try:
            self.send_sms(to, text)
        except Meser10Error:
            if self.resend > 0:
                self.store.delete(wait_key)  # a failed send does not count against the wait
            raise
        nonce = secrets.token_hex(12)
        self.store.set(self._k("code", ctx, to), {"h": self._hash(to, ctx, nonce, code), "n": nonce, "exp": time.time() + self.ttl}, self.ttl)
        return {"to": to, "expires_in": self.ttl}

    def verify_code(self, phone, code, context="default"):
        """Return True for a correct code, once. Raises Meser10Error: no_code, expired, wrong_code, locked."""
        ctx = self._ctx(context)
        to = self.normalize(phone)
        if not to:
            raise Meser10Error("invalid_phone", "Not a valid mobile number")
        rec = self.store.get(self._k("code", ctx, to))
        if not isinstance(rec, dict) or not rec.get("h") or not rec.get("n"):
            raise Meser10Error("no_code", "Ask for a code first")
        if time.time() > rec["exp"]:
            raise Meser10Error("expired", "The code has expired")
        # Counted atomically before comparing, so parallel guesses cannot exceed the limit.
        tries = self.store.incr(self._k("tries", ctx, to, rec["n"]), self.ttl)
        if tries > self.max_attempts:
            raise Meser10Error("locked", "Too many wrong codes, ask for a new one")
        given = self._hash(to, ctx, rec["n"], re.sub(r"\D", "", "" if code is None else str(code)))
        if hmac.compare_digest(given, str(rec["h"])):
            # Only the first correct verification wins, even if two arrive together.
            if self.store.incr(self._k("used", ctx, to, rec["n"]), self.ttl) > 1:
                raise Meser10Error("no_code", "Ask for a code first")
            self.store.delete(self._k("code", ctx, to))
            return True
        if tries >= self.max_attempts:
            raise Meser10Error("locked", "Too many wrong codes, ask for a new one")
        raise Meser10Error("wrong_code", "Wrong code, %d tries left" % (self.max_attempts - tries))

    @staticmethod
    def _ctx(context):
        c = str(context)
        if not _CONTEXT.fullmatch(c):
            raise Meser10Error("config", "context may contain only letters, digits, _ and - (up to 40)")
        return c

    @staticmethod
    def _k(kind, ctx, to, nonce=None):
        return "meser10otp:%s:%s:%s%s" % (kind, ctx, to, ":" + nonce if nonce else "")

    def _hash(self, to, ctx, nonce, code):
        return hmac.new(self.secret, ("%s|%s|%s|%s" % (ctx, to, nonce, code)).encode(), hashlib.sha256).hexdigest()
