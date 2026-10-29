import io, json, re, threading, time, unittest, urllib.error
from meser10_otp import Meser10Otp, Meser10Error, normalize_israeli_mobile

SECRET = "test-secret-0123456789"

class Resp(io.BytesIO):
    status = 200
    def __enter__(self): return self
    def __exit__(self, *a): pass

def mock(reply=None):
    calls = []
    def opener(req, timeout=None):
        calls.append(req)
        return Resp(json.dumps(reply if reply is not None else {"ErrorCode": 0, "Result": "", "MessageID": 7}).encode())
    opener.calls = calls
    return opener

def code_of(op):
    return re.search(r"\d{4,8}", json.loads(op.calls[-1].data)["MessageBody"]).group(0)

def mk(op, **kw):
    return Meser10Otp("K", "Shop", SECRET, opener=op, **kw)

def err(fn):
    try:
        fn(); return "none"
    except Meser10Error as e:
        return e.code

class T(unittest.TestCase):
    def test_normalize(self):
        self.assertEqual(normalize_israeli_mobile("+972-54-773-9363"), "0547739363")
        self.assertEqual(normalize_israeli_mobile("03-7440020"), "")
    def test_config(self):
        self.assertEqual(err(lambda: Meser10Otp("K", "S", "")), "config")
        self.assertEqual(err(lambda: mk(mock(), ttl_seconds=0)), "config")
        self.assertEqual(err(lambda: mk(mock(), code_length="six")), "config")
    def test_send_verify_once(self):
        op = mock(); o = mk(op)
        o.send_code("054-773-9363")
        req = op.calls[0]
        self.assertIn("f=SendSingleSmsMessage", req.full_url)
        self.assertEqual(req.get_header("Apikey"), "K")
        self.assertTrue(req.get_header("User-agent").startswith("meser10-otp-python/"))
        c = code_of(op); self.assertEqual(len(c), 6)
        self.assertEqual(err(lambda: o.verify_code("0547739363", c, "other")), "no_code")
        self.assertTrue(o.verify_code("+972547739363", c))
        self.assertEqual(err(lambda: o.verify_code("0547739363", c)), "no_code")
    def test_resend_parallel(self):
        op = mock(); o = mk(op); res = []
        ts = [threading.Thread(target=lambda: res.append(err(lambda: o.send_code("0521111111")))) for _ in range(10)]
        [t.start() for t in ts]; [t.join() for t in ts]
        self.assertEqual(res.count("none"), 1); self.assertEqual(len(op.calls), 1)
    def test_lock_parallel(self):
        op = mock(); o = mk(op, max_attempts=3); o.send_code("0522222222"); c = code_of(op)
        bad = "000000" if c != "000000" else "111111"; res = []
        ts = [threading.Thread(target=lambda: res.append(err(lambda: o.verify_code("0522222222", bad)))) for _ in range(50)]
        [t.start() for t in ts]; [t.join() for t in ts]
        self.assertEqual(res.count("wrong_code"), 2)
        self.assertEqual(err(lambda: o.verify_code("0522222222", c)), "locked")
    def test_correct_once_parallel(self):
        op = mock(); o = mk(op); o.send_code("0525555555"); c = code_of(op); res = []
        ts = [threading.Thread(target=lambda: res.append(err(lambda: o.verify_code("0525555555", c)))) for _ in range(10)]
        [t.start() for t in ts]; [t.join() for t in ts]
        self.assertEqual(res.count("none"), 1)
    def test_resend_longer_than_ttl(self):
        op = mock(); o = mk(op, ttl_seconds=30, resend_seconds=600); o.send_code("0526666666")
        self.assertEqual(err(lambda: o.verify_code("0526666666", "0")), "wrong_code")
        self.assertEqual(err(lambda: o.send_code("0526666666")), "too_soon")
    def test_api_error(self):
        op = mock({"ErrorCode": 4, "Result": "The SMS sender identity is not verified"}); o = mk(op)
        self.assertEqual(err(lambda: o.send_code("0524444444")), "api_error")
        self.assertEqual(err(lambda: o.verify_code("0524444444", "123456")), "no_code")
        self.assertEqual(err(lambda: o.send_code("0524444444")), "api_error")
    def test_http_error_with_json(self):
        def opener(req, timeout=None):
            raise urllib.error.HTTPError(req.full_url, 401, "x", {}, io.BytesIO(b'{"ErrorCode":2,"Result":"Bad key"}'))
        self.assertEqual(err(lambda: mk(opener).send_sms("0541111111", "x")), "api_error")
    def test_list_reply(self):
        self.assertEqual(err(lambda: mk(mock([1, 2])).send_sms("0541111111", "x")), "bad_response")
    def test_network(self):
        def opener(req, timeout=None): raise urllib.error.URLError("down")
        self.assertEqual(err(lambda: mk(opener).send_sms("0541111111", "x")), "network")
    def test_invalid(self):
        op = mock(); o = mk(op)
        self.assertEqual(err(lambda: o.send_code("12345")), "invalid_phone")
        self.assertEqual(err(lambda: o.send_code("0541111111", "a:b")), "config")
        self.assertEqual(len(op.calls), 0)

if __name__ == "__main__":
    unittest.main()
