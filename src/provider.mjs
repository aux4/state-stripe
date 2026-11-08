import { callStripe } from './stripe.mjs';

const fractionalAmountPattern = '^(?:0|[1-9]\\d*)\\.\\d{0,11}[1-9]$';
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
    unit_amount: { type: ['integer', 'null'], minimum: 0 },
    unit_amount_decimal: { type: 'string', pattern: fractionalAmountPattern },
    recurring: { type: ['object', 'null'], default: null, required: ['interval'], additionalProperties: false, properties: {
      interval: { type: 'string', enum: ['day', 'week', 'month', 'year'] },
      interval_count: { type: 'integer', minimum: 1, default: 1 },
      usage_type: { type: 'string', enum: ['licensed', 'metered'] },
      meter: { type: 'string' },
    } },
    active: { type: 'boolean', default: true },
    metadata,
    nickname: text,
    lookup_key: text,
  },
  meter: {
    display_name: { type: 'string', minLength: 1 },
    event_name: { type: 'string', minLength: 1 },
    default_aggregation: { type: 'object', required: ['formula'], additionalProperties: false, properties: {
      formula: { type: 'string', enum: ['count', 'last', 'sum'] },
    } },
    customer_mapping: { type: 'object', required: ['type', 'event_payload_key'], additionalProperties: false, properties: {
      type: { type: 'string', enum: ['by_id'] },
      event_payload_key: { type: 'string', minLength: 1 },
    } },
    event_time_window: { type: ['string', 'null'], enum: ['day', 'hour', null], default: null },
    value_settings: { type: 'object', required: ['event_payload_key'], additionalProperties: false, properties: {
      event_payload_key: { type: 'string', minLength: 1 },
    } },
    active: { type: 'boolean', default: true },
  },
};
export const signature = {
  version: 1,
  resources: {
    product: { schema: { type: 'object', required: ['name'], additionalProperties: false, properties: properties.product }, immutable: [] },
    price: { schema: { type: 'object', required: ['product', 'currency', 'unit_amount'], additionalProperties: false, properties: properties.price }, immutable: ['product', 'currency', 'unit_amount', 'unit_amount_decimal', 'recurring'] },
    meter: { schema: { type: 'object', required: ['display_name', 'event_name', 'default_aggregation', 'customer_mapping', 'value_settings'], additionalProperties: false, properties: properties.meter }, immutable: ['event_name', 'default_aggregation', 'customer_mapping', 'event_time_window', 'value_settings'] },
  },
};
function assert(condition, message) { if (!condition) throw new Error(message); }
function canonical(type, remote) {
  const result = {};
  for (const [key, spec] of Object.entries(properties[type])) {
    let value = remote[key];
    if (type === 'price' && key === 'product' && value && typeof value === 'object') value = value.id;
    if (type === 'price' && key === 'unit_amount_decimal' && remote.unit_amount !== null) continue;
    if (type === 'price' && key === 'recurring' && value) {
      value = { interval: value.interval, interval_count: value.interval_count ?? 1 };
      if (remote.recurring.usage_type === 'metered' || remote.recurring.meter) {
        value.usage_type = remote.recurring.usage_type ?? 'metered';
        value.meter = remote.recurring.meter;
      }
    }
    if (type === 'meter' && key === 'active') value = remote.status === 'active';
    if (type === 'meter' && key === 'default_aggregation' && value) value = { formula: value.formula };
    if (type === 'meter' && key === 'customer_mapping' && value) value = { type: value.type, event_payload_key: value.event_payload_key };
    if (type === 'meter' && key === 'value_settings' && value) value = { event_payload_key: value.event_payload_key };
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
  const collection = { product: 'products', price: 'prices', meter: 'billing/meters' }[request.type];
  const validId = {
    product: /^prod_[A-Za-z0-9]+$/,
    price: /^price_[A-Za-z0-9]+$/,
    meter: /^mtr_(?:test_)?[A-Za-z0-9]+$/,
  }[request.type];
  if (request.action === 'read') {
    assert(typeof request.id === 'string' && validId.test(request.id), 'Invalid Stripe resource ID');
    const remote = await api('GET', `${collection}/${encodeURIComponent(request.id)}`);
    return !remote || remote.deleted ? { exists: false } : { exists: true, id: remote.id, properties: canonical(request.type, remote) };
  }
  assert(['create', 'update', 'delete'].includes(request.action), `Unsupported Stripe action: ${request.action}`);
  assert(typeof request.idempotencyKey === 'string' && request.idempotencyKey.length, 'Mutations require an idempotency key');
  if (request.action === 'delete') {
    assert(typeof request.id === 'string' && validId.test(request.id), 'Invalid Stripe resource ID');
    if (request.type === 'meter') {
      const current = await api('GET', `${collection}/${encodeURIComponent(request.id)}`);
      if (!current || current.status === 'inactive') return { id: request.id, archived: true };
      await api('POST', `${collection}/${encodeURIComponent(request.id)}/deactivate`, {}, request.idempotencyKey);
    } else {
      await api('POST', `${collection}/${encodeURIComponent(request.id)}`, { active: false }, request.idempotencyKey);
    }
    return { id: request.id, archived: true };
  }
  assert(request.properties && typeof request.properties === 'object' && !Array.isArray(request.properties), 'properties must be an object');
  for (const key of Object.keys(request.properties)) assert(Object.hasOwn(properties[request.type], key), `Unsupported Stripe property: ${key}`);
  const body = structuredClone(request.properties);
  if (request.type === 'price') {
    const integerAmount = Number.isInteger(body.unit_amount) && body.unit_amount >= 0;
    const decimalAmount = typeof body.unit_amount_decimal === 'string' && new RegExp(fractionalAmountPattern).test(body.unit_amount_decimal);
    assert(integerAmount !== decimalAmount, 'Prices require exactly one of unit_amount (nonnegative integer) or unit_amount_decimal (canonical fractional cents, at most 12 places, no leading or trailing zeros; use unit_amount for whole cents)');
  }
  if (request.type === 'price' && body.recurring) {
    body.recurring.usage_type ??= 'licensed';
    if (body.recurring.usage_type === 'metered') {
      assert(typeof body.recurring.meter === 'string' && /^mtr_(?:test_)?[A-Za-z0-9]+$/.test(body.recurring.meter), 'Metered prices require a valid recurring.meter ID');
    } else {
      assert(body.recurring.meter === undefined || body.recurring.meter === null, 'Licensed prices cannot reference a meter');
      delete body.recurring.meter;
    }
  }
  if (request.type === 'meter' && request.action === 'update') {
    for (const key of signature.resources.meter.immutable) delete body[key];
    delete body.active;
  }
  if (request.type === 'price' && request.action === 'update') {
    for (const key of signature.resources.price.immutable) delete body[key];
  }
  if (request.action === 'create') {
    // Empty unset-only fields are meaningful on update but omitted on creation.
    for (const [key, value] of Object.entries(body)) if (value === null || value === '' || (typeof value === 'object' && !Object.keys(value).length)) delete body[key];
    if (request.type === 'meter') delete body.active;
    if (request.type === 'price' && body.lookup_key && request.replaces && request.previous?.lookup_key === body.lookup_key) body.transfer_lookup_key = true;
  }
  if (request.action === 'update') {
    assert(typeof request.id === 'string' && validId.test(request.id), 'Invalid Stripe resource ID');
    // Use the journaled read snapshot so retries send identical request bodies.
    assert(request.previous && typeof request.previous === 'object', 'Updates require previous properties from the plan');
    if (request.type === 'meter') {
      if (Object.hasOwn(body, 'display_name')) await api('POST', `${collection}/${encodeURIComponent(request.id)}`, { display_name: body.display_name }, request.idempotencyKey);
      const desiredActive = request.properties.active ?? true;
      const previousActive = request.previous.active ?? true;
      if (desiredActive !== previousActive) {
        await api('POST', `${collection}/${encodeURIComponent(request.id)}/${desiredActive ? 'reactivate' : 'deactivate'}`, {}, `${request.idempotencyKey}-${desiredActive ? 'reactivate' : 'deactivate'}`);
      }
      const remote = await api('GET', `${collection}/${encodeURIComponent(request.id)}`);
      assert(remote?.id, 'Stripe meter disappeared during update');
      return { id: remote.id, properties: canonical(request.type, remote) };
    }
    body.metadata ??= {};
    for (const key of Object.keys(request.previous.metadata ?? {})) if (!Object.hasOwn(body.metadata, key)) body.metadata[key] = '';
  }
  const endpoint = request.action === 'create' ? collection : `${collection}/${encodeURIComponent(request.id)}`;
  const remote = await api('POST', endpoint, body, request.idempotencyKey);
  assert(remote?.id, 'Stripe mutation did not return a resource ID');
  if (request.type === 'meter' && request.action === 'create' && request.properties.active === false) {
    await api('POST', `${collection}/${encodeURIComponent(remote.id)}/deactivate`, {}, `${request.idempotencyKey}-deactivate`);
    const inactive = await api('GET', `${collection}/${encodeURIComponent(remote.id)}`);
    assert(inactive?.id, 'Stripe meter disappeared during creation');
    return { id: inactive.id, properties: canonical(request.type, inactive) };
  }
  return { id: remote.id, properties: canonical(request.type, remote) };
}
