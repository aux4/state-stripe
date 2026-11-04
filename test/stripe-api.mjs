// Process-local Stripe API simulator. No network is used by catalog.test.mjs.
import fs from 'node:fs/promises';
const file = process.env.STATE_STRIPE_SIMULATOR;
if (!file) throw new Error('Missing simulator store');
function decode(body) {
  const result = {};
  for (const [path, value] of new URLSearchParams(body)) {
    const parts = path.match(/[^\[\]]+/g);
    let target = result;
    for (let i = 0; i < parts.length - 1; i++) target = target[parts[i]] ??= /^\d+$/.test(parts[i + 1]) ? [] : {};
    const key = parts.at(-1);
    target[key] = value === 'true' ? true : value === 'false' ? false : ['unit_amount', 'interval_count'].includes(key) ? Number(value) : value;
  }
  return result;
}
globalThis.fetch = async (url, options) => {
  if (!url.startsWith('https://api.stripe.com/v1/')) throw new Error('Network prohibited in simulator');
  const account = options.headers.Authorization.replace('Bearer sk_test_', '');
  const endpoint = url.slice('https://api.stripe.com/v1/'.length);
  const response = (body, status = 200) => ({ status, ok: status < 400, json: async () => body });
  if (endpoint === 'account') return response({ id: `acct_${account}` });
  let store;
  try { store = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; store = { next: 0, accounts: {}, subscriptions: ['existing_subscription'] }; }
  const resources = store.accounts[account] ??= {};
  const [collection, remoteId] = endpoint.split('/');
  if (!['products', 'prices'].includes(collection)) throw new Error(`Unsupported simulated endpoint ${endpoint}`);
  const missing = () => response({ error: { code: 'resource_missing' } }, 404);
  if (options.method === 'GET') return resources[remoteId] ? response(resources[remoteId]) : missing();
  const key = options.headers['Idempotency-Key'];
  if (!key) throw new Error('Missing idempotency key');
  const operations = store.operations ??= {};
  const fingerprint = JSON.stringify([url, options.method, options.body]);
  if (operations[key]) {
    if (operations[key].fingerprint !== fingerprint) return response({ error: { code: 'idempotency_error' } }, 400);
    return response(operations[key].result);
  }
  if (remoteId && !resources[remoteId]) return missing();
  const body = decode(options.body);
  const id = remoteId ?? `${collection === 'products' ? 'prod' : 'price'}_${++store.next}`;
  const remote = resources[id] ?? { id, active: true, metadata: {}, ...(collection === 'products' ? { images: [], marketing_features: [], description: '' } : { nickname: '', lookup_key: '', recurring: null }) };
  if (body.lookup_key && body.transfer_lookup_key) for (const r of Object.values(resources)) if (r.lookup_key === body.lookup_key) r.lookup_key = '';
  delete body.transfer_lookup_key;
  if (body.metadata === '') body.metadata = {};
  else if (body.metadata) {
    const metadata = { ...remote.metadata, ...body.metadata };
    for (const [k, v] of Object.entries(metadata)) if (v === '') delete metadata[k];
    body.metadata = metadata;
  }
  for (const field of ['images', 'marketing_features']) if (body[field] === '') body[field] = [];
  resources[id] = { ...remote, ...body };
  operations[key] = { fingerprint, result: resources[id] };
  await fs.writeFile(file, JSON.stringify(store));
  return response(resources[id]);
};
