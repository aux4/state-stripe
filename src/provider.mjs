import { callStripe } from './stripe.mjs';

const string = { type: 'string' };
const text = { type: 'string', default: '' };
const metadata = { type: 'object', additionalProperties: string, default: {} };
const properties = {
  product: {
    name: { type: 'string', minLength: 1 },
    active: { type: 'boolean', default: true },
    description: text,
    metadata,
    images: { type: 'array', items: string, default: [] },
    marketing_features: { type: 'array', items: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: string } }, default: [] },
  },
  price: {
    product: { type: 'string', minLength: 1 },
    currency: { type: 'string', minLength: 3 },
    unit_amount: { type: 'integer', minimum: 0 },
    recurring: { type: ['object', 'null'], default: null, required: ['interval'], additionalProperties: false, properties: {
      interval: { type: 'string', enum: ['day', 'week', 'month', 'year'] },
      interval_count: { type: 'integer', minimum: 1, default: 1 },
    } },
    active: { type: 'boolean', default: true },
    metadata,
    nickname: text,
    lookup_key: text,
  },
};
export const signature = {
  version: 1,
  resources: {
    product: { schema: { type: 'object', required: ['name'], additionalProperties: false, properties: properties.product }, immutable: [] },
    price: { schema: { type: 'object', required: ['product', 'currency', 'unit_amount'], additionalProperties: false, properties: properties.price }, immutable: ['product', 'currency', 'unit_amount', 'recurring'] },
  },
};
function assert(condition, message) { if (!condition) throw new Error(message); }
function canonical(type, remote) {
  const result = {};
  for (const [key, spec] of Object.entries(properties[type])) {
    let value = remote[key];
    if (type === 'price' && key === 'product' && value && typeof value === 'object') value = value.id;
    if (type === 'price' && key === 'recurring' && value) value = { interval: value.interval, interval_count: value.interval_count ?? 1 };
    if (value === undefined || value === null) value = Object.hasOwn(spec, 'default') ? structuredClone(spec.default) : value;
    result[key] = value;
  }
  return result;
}

export async function handle(request, { apiRequest = callStripe } = {}) {
  assert(request.version === 1, 'Unsupported provider protocol version');
  if (request.action === 'schema') return signature;
  const config = request.config ?? {};
  async function api(method, endpoint, data, idempotencyKey) {
    const response = await apiRequest({ method, path: `/v1/${endpoint}`, data, idempotencyKey, config });
    assert(Number.isInteger(response.status), 'Invalid Stripe API response');
    if (response.status === 404 && response.body?.error?.code === 'resource_missing') return null;
    if (response.status < 200 || response.status >= 300) throw new Error(`Stripe ${method} ${endpoint}: HTTP ${response.status} (${response.body?.error?.code ?? response.body?.error?.type ?? 'request_failed'})`);
    return response.body;
  }
  if (request.action === 'identity') {
    const account = await api('GET', 'account');
    assert(account?.id, 'Cannot determine Stripe account identity');
    return { account: account.id, mode: config.mode };
  }
  assert(Object.hasOwn(properties, request.type), `Unsupported Stripe resource: ${request.type}`);
  const collection = request.type === 'product' ? 'products' : 'prices';
  if (request.action === 'read') {
    assert(typeof request.id === 'string' && /^(prod|price)_[A-Za-z0-9]+$/.test(request.id), 'Invalid Stripe resource ID');
    const remote = await api('GET', `${collection}/${encodeURIComponent(request.id)}`);
    return !remote || remote.deleted ? { exists: false } : { exists: true, id: remote.id, properties: canonical(request.type, remote) };
  }
  assert(['create', 'update', 'delete'].includes(request.action), `Unsupported Stripe action: ${request.action}`);
  assert(typeof request.idempotencyKey === 'string' && request.idempotencyKey.length, 'Mutations require an idempotency key');
  if (request.action === 'delete') {
    assert(typeof request.id === 'string' && /^(prod|price)_[A-Za-z0-9]+$/.test(request.id), 'Invalid Stripe resource ID');
    await api('POST', `${collection}/${encodeURIComponent(request.id)}`, { active: false }, request.idempotencyKey);
    return { id: request.id, archived: true };
  }
  assert(request.properties && typeof request.properties === 'object' && !Array.isArray(request.properties), 'properties must be an object');
  for (const key of Object.keys(request.properties)) assert(Object.hasOwn(properties[request.type], key), `Unsupported Stripe property: ${key}`);
  const body = structuredClone(request.properties);
  if (request.type === 'price' && request.action === 'update') {
    for (const key of signature.resources.price.immutable) delete body[key];
  }
  if (request.action === 'create') {
    // Empty unset-only fields are meaningful on update but omitted on creation.
    for (const [key, value] of Object.entries(body)) if (value === null || value === '' || (typeof value === 'object' && !Object.keys(value).length)) delete body[key];
    if (request.type === 'price' && body.lookup_key && request.replaces && request.previous?.lookup_key === body.lookup_key) body.transfer_lookup_key = true;
  }
  if (request.action === 'update') {
    assert(typeof request.id === 'string' && /^(prod|price)_[A-Za-z0-9]+$/.test(request.id), 'Invalid Stripe resource ID');
    // Use the journaled read snapshot so retries send identical request bodies.
    assert(request.previous && typeof request.previous === 'object', 'Updates require previous properties from the plan');
    body.metadata ??= {};
    for (const key of Object.keys(request.previous.metadata ?? {})) if (!Object.hasOwn(body.metadata, key)) body.metadata[key] = '';
  }
  const endpoint = request.action === 'create' ? collection : `${collection}/${encodeURIComponent(request.id)}`;
  const remote = await api('POST', endpoint, body, request.idempotencyKey);
  assert(remote?.id, 'Stripe mutation did not return a resource ID');
  return { id: remote.id, properties: canonical(request.type, remote) };
}
