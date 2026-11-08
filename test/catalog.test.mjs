import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const sibling = path.resolve(root, '../state/package');
const cwd = existsSync(path.join(sibling, '.aux4')) ? sibling : path.join(root, 'package');
const extraFiles = [path.join(root, 'package/.aux4'), path.resolve(root, '../community/stripe/package/.aux4')].filter(existsSync).join(path.delimiter);

test('real engine and Stripe provider manage independent catalogs, replace prices and preserve subscriptions', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aux4-stripe-catalog-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const simulator = path.join(dir, 'stripe-api.json');
  const env = { ...process.env, AUX4_AUX4_FILES: extraFiles, NODE_OPTIONS: '--import=' + pathToFileURL(path.join(root, 'test/stripe-api.mjs')).href, STATE_STRIPE_SIMULATOR: simulator, CATALOG_DEV_KEY: 'sk_test_dev', CATALOG_PROD_KEY: 'sk_test_prod', CATALOG_OTHER_KEY: 'sk_test_other' };
  const definition = {
    version: 1,
    providers: { stripe: {
      package: 'aux4/state-stripe',
      config: { apiKeyEnv: '${var.keyEnv}', mode: 'test' },
    } },
    resources: {
      pro: { type: 'stripe/product', properties: { name: 'Pro', metadata: { team: 'billing' }, marketing_features: [{ name: 'Unlimited projects' }] } },
      monthly: { type: 'stripe/price', properties: { product: '${resources.pro.id}', currency: 'usd', unit_amount: 2000, recurring: { interval: 'month' }, lookup_key: 'pro_monthly' } },
      meter: { type: 'stripe/meter', properties: { display_name: 'Runs', event_name: 'runs', default_aggregation: { formula: 'sum' }, customer_mapping: { type: 'by_id', event_payload_key: 'customer' }, value_settings: { event_payload_key: 'value' } } },
      usage: { type: 'stripe/price', properties: { product: '${resources.pro.id}', currency: 'usd', unit_amount: null, unit_amount_decimal: '0.125', recurring: { interval: 'month', usage_type: 'metered', meter: '${resources.meter.id}' } } },
      yearly: { type: 'stripe/price', properties: { product: '${resources.pro.id}', currency: 'usd', unit_amount: 20000, recurring: { interval: 'year' }, lookup_key: 'pro_yearly' } },
    },
  };
  const write = () => fs.writeFile(path.join(dir, 'billing.state.yaml'), JSON.stringify(definition, null, 2));
  const run = (action, environment, keyEnv = environment === 'dev' ? 'CATALOG_DEV_KEY' : 'CATALOG_PROD_KEY', fail = false) => {
    const result = spawnSync('aux4', ['state', action, '--dir', dir, '--environment', environment, '--variables', JSON.stringify({ keyEnv }), '--format', 'json', ...(['apply', 'destroy'].includes(action) ? ['--yes', 'true'] : [])], { cwd, env, encoding: 'utf8', timeout: 20000 });
    if (fail) { assert.notEqual(result.status, 0); return result.stderr; }
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  await write();
  assert.equal(run('validate', 'dev').resources, 5);
  run('apply', 'dev'); run('apply', 'prod');
  const dev = run('inspect', 'dev'), prod = run('inspect', 'prod');
  assert.notEqual(dev.resources.pro.id, prod.resources.pro.id);
  assert.equal(run('plan', 'dev').counts.noop, 5);
  definition.resources.monthly.properties.unit_amount = 2500;
  await write();
  assert.equal(run('plan', 'dev').counts.replace, 1);
  run('apply', 'dev');
  const newDev = run('inspect', 'dev');
  assert.notEqual(newDev.resources.monthly.id, dev.resources.monthly.id);
  assert.equal(newDev.resources.yearly.id, dev.resources.yearly.id);
  assert.equal(run('plan', 'dev').counts.noop, 5);
  let remote = JSON.parse(await fs.readFile(simulator, 'utf8'));
  assert.equal(remote.accounts.dev[dev.resources.monthly.id].active, false);
  assert.equal(remote.accounts.dev[newDev.resources.monthly.id].lookup_key, 'pro_monthly');
  assert.equal(remote.accounts.prod[prod.resources.monthly.id].unit_amount, 2000);
  assert.deepEqual(remote.subscriptions, ['existing_subscription']);
  definition.resources.pro.properties.metadata = {};
  definition.resources.pro.properties.marketing_features.push({ name: 'Priority support' });
  await write();
  run('apply', 'dev');
  remote = JSON.parse(await fs.readFile(simulator, 'utf8'));
  assert.deepEqual(remote.accounts.dev[dev.resources.pro.id].metadata, {});
  assert.equal(remote.accounts.dev[dev.resources.pro.id].marketing_features.length, 2);
  assert.equal(run('plan', 'dev').counts.noop, 5);
  assert.match(run('plan', 'dev', 'CATALOG_OTHER_KEY', true), /identity differs/);
  run('destroy', 'dev');
  remote = JSON.parse(await fs.readFile(simulator, 'utf8'));
  assert(Object.values(remote.accounts.dev).every(r => r.status ? r.status === 'inactive' : r.active === false));
  assert(Object.values(remote.accounts.prod).every(r => r.active === true));
});
