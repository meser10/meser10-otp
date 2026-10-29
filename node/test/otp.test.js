const test = require('node:test');
const assert = require('node:assert');
const { Meser10Otp, MemoryStore, normalizeIsraeliMobile } = require('../src');

const SECRET = 'test-secret-0123456789';
function mockFetch(reply = { ErrorCode: 0, Result: '', MessageID: 7 }) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return { status: 200, json: async () => reply }; };
  f.calls = calls; return f;
}
const codeFrom = (f) => f.calls.at(-1).body.MessageBody.match(/\d{4,8}/)[0];
const mk = (o = {}) => new Meser10Otp({ apiKey: 'K', sender: 'Shop', secret: SECRET, ...o });
// a store that hands out copies, like Redis would
class CopyStore extends MemoryStore { async get(k) { const v = await super.get(k); return v && JSON.parse(JSON.stringify(v)); } }

test('normalize', () => {
  assert.equal(normalizeIsraeliMobile('+972-54-773-9363'), '0547739363');
  assert.equal(normalizeIsraeliMobile('00972547739363'), '0547739363');
  assert.equal(normalizeIsraeliMobile('03-7440020'), '');
});
test('config validation', () => {
  assert.throws(() => new Meser10Otp({ apiKey: 'K', sender: 'S' }), { code: 'config' });
  assert.throws(() => mk({ codeLength: 'six' }), { code: 'config' });
  assert.throws(() => mk({ ttlSeconds: 0 }), { code: 'config' });
  assert.throws(() => mk({ store: { get() {} } }), { code: 'config' });
});
test('send + verify once', async () => {
  const f = mockFetch(); const o = mk({ fetch: f });
  await o.sendCode('054-773-9363');
  const c = f.calls[0];
  assert.match(c.url, /f=SendSingleSmsMessage/);
  assert.equal(c.init.headers.ApiKey, 'K');
  assert.match(c.init.headers['User-Agent'], /^meser10-otp-node\//);
  assert.deepEqual(Object.keys(c.body), ['ToPhone', 'MessageBody', 'FromName']);
  const code = codeFrom(f);
  assert.equal(code.length, 6);
  await assert.rejects(o.verifyCode('0547739363', code, 'other'), { code: 'no_code' });
  assert.equal(await o.verifyCode('+972547739363', code), true);
  await assert.rejects(o.verifyCode('0547739363', code), { code: 'no_code' });
});
test('resend wait, also in parallel', async () => {
  const f = mockFetch(); const o = mk({ fetch: f });
  const r = await Promise.allSettled([1, 2, 3, 4, 5].map(() => o.sendCode('0521111111')));
  assert.equal(r.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(f.calls.length, 1);
});
test('lock after attempts, also in parallel with a copying store', async () => {
  const f = mockFetch(); const o = mk({ fetch: f, maxAttempts: 3, store: new CopyStore() });
  await o.sendCode('0522222222'); const code = codeFrom(f);
  const bad = code === '000000' ? '111111' : '000000';
  const r = await Promise.allSettled(Array.from({ length: 50 }, () => o.verifyCode('0522222222', bad)));
  assert.equal(r.filter(x => x.reason && x.reason.code === 'wrong_code').length, 2);
  await assert.rejects(o.verifyCode('0522222222', code), { code: 'locked' });
});
test('correct code accepted once even in parallel', async () => {
  const f = mockFetch(); const o = mk({ fetch: f, store: new CopyStore() });
  await o.sendCode('0525555555'); const code = codeFrom(f);
  const r = await Promise.allSettled(Array.from({ length: 10 }, () => o.verifyCode('0525555555', code)));
  assert.equal(r.filter(x => x.status === 'fulfilled').length, 1);
});
test('resend wait longer than ttl still holds', async () => {
  const f = mockFetch(); const o = mk({ fetch: f, ttlSeconds: 30, resendSeconds: 600 });
  await o.sendCode('0526666666');
  await assert.rejects(o.verifyCode('0526666666', '0'), { code: 'wrong_code' });
  await assert.rejects(o.sendCode('0526666666'), { code: 'too_soon' });
});
test('api error does not store code and frees resend', async () => {
  const f = mockFetch({ ErrorCode: 4, Result: 'The SMS sender identity is not verified' });
  const o = mk({ fetch: f });
  await assert.rejects(o.sendCode('0524444444'), (e) => e.code === 'api_error' && /not verified/.test(e.message));
  await assert.rejects(o.verifyCode('0524444444', '123456'), { code: 'no_code' });
  await assert.rejects(o.sendCode('0524444444'), { code: 'api_error' });
});
test('network error is a Meser10Error', async () => {
  const o = mk({ fetch: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(o.sendSms('0541111111', 'x'), { code: 'network' });
});
test('bad context and invalid phone never call the API', async () => {
  const f = mockFetch(); const o = mk({ fetch: f });
  await assert.rejects(o.sendCode('12345'), { code: 'invalid_phone' });
  await assert.rejects(o.sendCode('0541111111', 'a:b'), { code: 'config' });
  assert.equal(f.calls.length, 0);
});
