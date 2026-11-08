import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, signature } from '../src/provider.mjs';
const config = { apiKeyEnv: 'TEST_KEY', mode: 'test' };
const req = (action, extra = {}) => ({ version: 1, action, config, type: 'product', idempotencyKey: 'operation-key', ...extra });
function mock(responses) {
  const calls = [];
  return { calls, apiRequest: async request => {
    calls.push(request);
    const next = responses.shift();
    assert(next, 'Unexpected API call');
    return { status: Number.isInteger(next.status) ? next.status : 200, body: next.body ?? next };
  } };
}
test('schema validation stays offline and defines immutable price fields', async () => {
  const m = mock([]);
  assert.deepEqual(await handle(req('schema'), m), signature);
  assert.equal(m.calls.length, 0);
  assert(signature.resources.price.immutable.includes('unit_amount'));
});
test('identity delegates account retrieval and preserves selected mode', async () => {
  const m = mock([{ id: 'acct_target' }]);
  assert.deepEqual(await handle(req('identity'), m), { account: 'acct_target', mode: 'test' });
  assert.equal(m.calls[0].path, '/v1/account');
  assert.deepEqual(m.calls[0].config, config);
});
test('creation delegates structured data and idempotency without HTTP encoding', async () => {
  const m = mock([{ id: 'prod_new' }]);
  const properties = { name: 'Pro', images: ['https://example.com/pro.png'], marketing_features: [{ name: 'Projects' }] };
  assert.equal((await handle(req('create', { properties }), m)).id, 'prod_new');
  assert.deepEqual(m.calls[0].data, properties);
  assert.equal(m.calls[0].idempotencyKey, 'operation-key');
  assert.equal(m.calls[0].method, 'POST');
});
test('managed price replacements transfer lookup keys; unrelated creation does not', async () => {
  const properties = { product: 'prod_existing', currency: 'usd', unit_amount: 2000, lookup_key: 'pro_monthly' };
  const replacement = mock([{ id: 'price_new' }]);
  await handle(req('create', { type: 'price', replaces: 'price_old', previous: { lookup_key: 'pro_monthly' }, properties }), replacement);
  assert.equal(replacement.calls[0].data.transfer_lookup_key, true);
  const fresh = mock([{ id: 'price_new' }]);
  await handle(req('create', { type: 'price', properties }), fresh);
  assert.equal(fresh.calls[0].data.transfer_lookup_key, undefined);
});
test('missing resources are distinct from authentication failures', async () => {
  assert.deepEqual(await handle(req('read', { id: 'prod_missing' }), mock([{ status: 404, body: { error: { code: 'resource_missing' } } }])), { exists: false });
  await assert.rejects(handle(req('read', { id: 'prod_existing' }), mock([{ status: 401, body: { error: { type: 'authentication_error', message: 'secret must not be echoed' } } }])), /HTTP 401 \(authentication_error\)/);
});
test('canonical values discard remote defaults outside managed fields', async () => {
  const m = mock([{ id: 'price_existing', product: { id: 'prod_existing' }, currency: 'usd', unit_amount: 2000, recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' }, created: 123 }]);
  const result = await handle(req('read', { type: 'price', id: 'price_existing' }), m);
  assert.equal(result.properties.product, 'prod_existing');
  assert.deepEqual(result.properties.recurring, { interval: 'month', interval_count: 1 });
  assert.equal(result.properties.created, undefined);
});
test('updates use the journaled snapshot to clear metadata and omit immutable fields', async () => {
  const m = mock([{ id: 'price_existing' }]);
  await handle(req('update', { type: 'price', id: 'price_existing', previous: { metadata: { old: 'value' } }, properties: { product: 'prod_existing', currency: 'usd', unit_amount: 1000, metadata: { new: 'value' }, nickname: '' } }), m);
  assert.deepEqual(m.calls[0].data.metadata, { new: 'value', old: '' });
  assert.equal(m.calls[0].data.unit_amount, undefined);
  assert.equal(m.calls.length, 1);
});
test('destroy archives and absent resources are already removed', async () => {
  const m = mock([{ id: 'price_existing', active: false }]);
  assert.equal((await handle(req('delete', { type: 'price', id: 'price_existing' }), m)).archived, true);
  assert.deepEqual(m.calls[0].data, { active: false });
  assert.equal((await handle(req('delete', { id: 'prod_missing' }), mock([{ status: 404, body: { error: { code: 'resource_missing' } } }]))).archived, true);
  await assert.rejects(handle(req('read', { id: '../customers' }), mock([])), /Invalid Stripe resource ID/);
});
const meterProperties = { display_name: 'Runs', event_name: 'runs', default_aggregation: { formula: 'sum' }, customer_mapping: { type: 'by_id', event_payload_key: 'customer' }, value_settings: { event_payload_key: 'value' }, event_time_window: null, active: true };
test('meter lifecycle preserves identity, immutable settings and separate idempotency keys', async () => {
  const active = { id: 'mtr_test_123', ...meterProperties, status: 'active' };
  const created = mock([active]);
  const result = await handle(req('create', { type: 'meter', properties: meterProperties }), created);
  assert.equal(created.calls[0].path, '/v1/billing/meters');
  assert.equal(created.calls[0].data.active, undefined);
  assert.deepEqual(result.properties, meterProperties);
  const read = await handle(req('read', { type: 'meter', id: active.id }), mock([active]));
  assert.deepEqual(read.properties, meterProperties);
  const inactive = { ...active, status: 'inactive', display_name: 'Command runs' };
  const update = mock([active, inactive, inactive]);
  const updated = await handle(req('update', { type: 'meter', id: active.id, previous: meterProperties, properties: { ...meterProperties, display_name: 'Command runs', active: false } }), update);
  assert.deepEqual(update.calls.map(c => [c.method, c.path]), [['POST', '/v1/billing/meters/mtr_test_123'], ['POST', '/v1/billing/meters/mtr_test_123/deactivate'], ['GET', '/v1/billing/meters/mtr_test_123']]);
  assert.deepEqual(update.calls[0].data, { display_name: 'Command runs' });
  assert.notEqual(update.calls[0].idempotencyKey, update.calls[1].idempotencyKey);
  assert.equal(updated.properties.active, false);
  const reactivate = mock([active, active]);
  await handle(req('update', { type: 'meter', id: active.id, previous: { ...meterProperties, active: false }, properties: { active: true } }), reactivate);
  assert.equal(reactivate.calls[0].path, '/v1/billing/meters/mtr_test_123/reactivate');
  const deletion = mock([active, inactive]);
  assert.equal((await handle(req('delete', { type: 'meter', id: active.id }), deletion)).archived, true);
  assert.equal(deletion.calls[1].path, '/v1/billing/meters/mtr_test_123/deactivate');
  const alreadyInactive = mock([inactive]);
  await handle(req('delete', { type: 'meter', id: active.id }), alreadyInactive);
  assert.equal(alreadyInactive.calls.length, 1);
  const createInactive = mock([active, inactive, inactive]);
  assert.equal((await handle(req('create', { type: 'meter', properties: { ...meterProperties, active: false } }), createInactive)).properties.active, false);
  assert.equal(createInactive.calls[1].path, '/v1/billing/meters/mtr_test_123/deactivate');
});
test('metered fractional prices roundtrip and reject noncanonical or ambiguous amounts before network', async () => {
  const properties = { product: 'prod_existing', currency: 'usd', unit_amount: null, unit_amount_decimal: '0.125', recurring: { interval: 'month', interval_count: 1, usage_type: 'metered', meter: 'mtr_test_123' }, active: true, metadata: {}, nickname: '', lookup_key: '' };
  const remote = { id: 'price_fractional', ...properties };
  const m = mock([remote, remote]);
  const created = await handle(req('create', { type: 'price', properties }), m);
  const read = await handle(req('read', { type: 'price', id: remote.id }), m);
  assert.deepEqual(created.properties, properties);
  assert.deepEqual(read.properties, properties);
  assert.equal(m.calls[0].data.unit_amount, undefined);
  assert.deepEqual(m.calls[0].data.recurring, properties.recurring);
  for (const decimal of ['1000', '1.0', '01.5', '1.50', '-0.5', '0.1234567890123']) {
    const bad = mock([]);
    await assert.rejects(handle(req('create', { type: 'price', properties: { ...properties, unit_amount_decimal: decimal } }), bad), /canonical fractional/);
    assert.equal(bad.calls.length, 0);
  }
  await assert.rejects(handle(req('create', { type: 'price', properties: { ...properties, unit_amount: 1 } }), mock([])), /exactly one/);
  await assert.rejects(handle(req('create', { type: 'price', properties: { ...properties, recurring: { interval: 'month', usage_type: 'metered' } } }), mock([])), /valid recurring.meter/);
});
