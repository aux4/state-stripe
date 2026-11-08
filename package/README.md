# aux4/state-stripe

Resource schemas, defaults, change detection rules and lifecycle operations for Stripe products, fixed and metered prices, and Billing Meters. All API communication is delegated to community/stripe.

## Installation

```bash
aux4 aux4 pkger install aux4/state-stripe
```

Requires Node.js 22 or later. Installs aux4/state and community/stripe as dependencies.

## Package responsibilities

This package is the Stripe adapter for `aux4/state`. It defines resource schemas, defaults, canonical values, immutable fields and lifecycle operations. It calls `aux4 stripe api request` from `community/stripe` for every remote operation.

The call chain is `aux4/state` → `aux4/state-stripe` → `community/stripe`. The API package does not implement or depend on the state protocol. `aux4/state` computes replacements from this adapter's immutable-field declarations; this adapter translates lifecycle operations into Stripe requests.

## Quick Start

Create `billing.state.yaml`:

```yaml
version: 1
providers:
  stripe:
    package: aux4/state-stripe
    config:
      apiKeyEnv: ${var.stripeKeyEnv}
      mode: ${var.stripeMode}
resources:
  pro:
    type: stripe/product
    properties:
      name: "${var.productName}"
      marketing_features:
        - name: Unlimited projects
  proMonthly:
    type: stripe/price
    properties:
      product: ${resources.pro.id}
      currency: usd
      unit_amount: "${var.monthlyAmount}"
      recurring:
        interval: month
      lookup_key: pro_monthly
  cloudMachineDaySm:
    type: stripe/meter
    properties:
      display_name: Cloud machine days (small)
      event_name: aux4_cloud_machine_day_sm
      default_aggregation:
        formula: sum
      customer_mapping:
        type: by_id
        event_payload_key: stripe_customer_id
      value_settings:
        event_payload_key: value
  cloudMachineDaySmPrice:
    type: stripe/price
    properties:
      product: ${resources.pro.id}
      currency: usd
      unit_amount: 1000
      recurring:
        interval: month
        usage_type: metered
        meter: ${resources.cloudMachineDaySm.id}
```

Create `config.yaml`:

```yaml
config:
  dev:
    environment: dev
    variables:
      stripeKeyEnv: STRIPE_DEV_API_KEY
      stripeMode: test
      productName: Pro Development
      monthlyAmount: 500
  staging:
    environment: staging
    variables:
      stripeKeyEnv: STRIPE_STAGING_API_KEY
      stripeMode: test
      productName: Pro Staging
      monthlyAmount: 1000
  prod:
    environment: prod
    variables:
      stripeKeyEnv: STRIPE_PROD_API_KEY
      stripeMode: live
      productName: Pro
      monthlyAmount: 2000
```

Supply the keys through the named environment variables and run. The `variables` config object supplies `${var.*}` references; whole-value references preserve types, including numeric prices. The state file remains valid YAML and is not rewritten.

```bash
aux4 state validate --config dev
aux4 state plan --config dev
aux4 state apply --config dev
aux4 state plan --config prod
aux4 state apply --config prod
```

## Configuration

```yaml
version: 1
providers:
  stripe:
    package: aux4/state-stripe
    command: [aux4, state, stripe, resource] # default for provider named stripe
    config:
      apiKeyEnv: STRIPE_API_KEY # required environment variable name
      mode: test # required: test or live
      # account: acct_connectedAccount # optional connected account
resources:
  pro:
    type: stripe/product
    properties:
      name: Pro # required
      active: true # default
      description: "" # default
      metadata: {} # default; string values only
      images: [] # default; array of URLs
      marketing_features: # default: []; array of objects
        - name: Unlimited projects
  proMonthly:
    type: stripe/price
    properties:
      product: ${resources.pro.id} # required
      currency: usd # required
      unit_amount: 2000 # integer currency minor units; use unit_amount_decimal for fractional minor units
      recurring: # default: null, for a one-time price
        interval: month # required inside recurring: day, week, month or year
        interval_count: 1 # default; positive integer
        usage_type: metered # optional: licensed (default) or metered
        meter: ${resources.cloudMachineDaySm.id} # required when usage_type is metered
      active: true # default
      metadata: {} # default; string values only
      nickname: "" # default
      lookup_key: pro_monthly # default: ""
  cloudMachineDaySm:
    type: stripe/meter
    properties:
      display_name: Cloud machine days (small)
      event_name: aux4_cloud_machine_day_sm
      default_aggregation:
        formula: sum
      customer_mapping:
        type: by_id
        event_payload_key: stripe_customer_id
      value_settings:
        event_payload_key: value
      event_time_window: null
      active: true
```

Products support catalog details, metadata and marketing features. Prices support recurring billing, including Stripe Billing Meter references. Meters support display name, event name, aggregation formula, customer mapping, event time window, value key and active state. Stripe metadata values are strings. Currency codes must follow Stripe's rules. API calls use Stripe version `2026-10-28.endive`.

## Billing Meters

Declare each meter before its metered price. References establish dependency order, so meters are created before prices and prices are archived before their meter is deactivated.

```yaml
resources:
  cloudMachineDaySm:
    type: stripe/meter
    properties:
      display_name: Cloud machine days (small)
      event_name: aux4_cloud_machine_day_sm
      default_aggregation:
        formula: sum
      customer_mapping:
        type: by_id
        event_payload_key: stripe_customer_id
      value_settings:
        event_payload_key: value
  cloudMachineDaySmPrice:
    type: stripe/price
    properties:
      product: ${resources.cloudProduct.id}
      currency: usd
      unit_amount: 1000
      recurring:
        interval: month
        usage_type: metered
        meter: ${resources.cloudMachineDaySm.id}
```

Changing a meter's event name, aggregation, customer mapping, or value settings requires a new meter definition. Stripe only allows the display name to be updated. Destroying a managed meter deactivates it; Stripe retains it and its billing history.

## Price changes

Changing `product`, `currency`, `unit_amount`, `unit_amount_decimal`, or `recurring` creates a replacement price and archives the previous price after dependents have been updated. A metered price's meter reference is part of `recurring` and is replaced with the price. Other supported fields update in place. When a managed replacement keeps the old price's lookup key, the key is transferred to the new price. New resources do not automatically take lookup keys from unrelated prices.

Set exactly one amount field. Use `unit_amount` for an integer number of currency minor units. Use `unit_amount_decimal` as a decimal string when the per-unit charge has fractional minor units; Stripe accepts up to 12 decimal places. For example:

```yaml
unit_amount: null
unit_amount_decimal: "16.666666666667"
```

This represents about 16.67 cents per unit. The selected amount is immutable and changing it replaces the price.

**Existing subscriptions retain their original prices.** This package manages the product catalog; it does not migrate customer subscriptions or modify invoices. Applications using a lookup key will discover the new price for future purchases.

Archive operations set `active: false`; they do not delete billing history. An already absent resource is treated as successfully removed. Mutable property removals reset to the documented defaults. Metadata keys removed from the declaration are explicitly cleared.

## Environments and credentials

`apiKeyEnv` names the variable containing the secret or restricted Stripe API key. Keys must have an `sk_test_`, `rk_test_`, `sk_live_`, or `rk_live_` prefix matching `mode`. The provider records the actual account ID and mode, preventing an existing environment from being pointed at another account or switched between test and live.

For Connect, set `account` to the connected account ID; requests include that account header. Restricted keys need access to account identity and the products/prices operations used by the stack. Authorization failures fail the operation; they never count as a missing resource.

Use separate Stripe accounts or sandboxes for dev and staging, or choose distinct lookup keys if intentionally sharing an account/mode. Environment tracking alone does not create separate Stripe namespaces.

## Existing catalog

Import products before their prices:

```bash
aux4 state import --resource pro --id prod_existing --config dev
aux4 state import --resource proMonthly --id price_existing --config dev
aux4 state plan --config dev
```

Import does not change Stripe. Review the next plan before applying: omitted supported properties reset to defaults, and price shape changes can require replacement.

## Resource protocol

The engine invokes `aux4 state stripe resource` with a versioned JSON lifecycle request on stdin. It supports `schema`, `identity`, `read`, `create`, `update` and `delete`; normal users use `aux4 state plan`, `apply`, `destroy`, `inspect` and `import`.

## Environment Variables

The environment variable named by `providers.stripe.config.apiKeyEnv` supplies the Stripe key. No API keys are read from definition properties or saved to state. See the [aux4/state documentation](https://hub.aux4.io/r/public/packages/aux4/state) for state backup, locking, `preventDestroy` and interrupted-operation recovery.

Fractional-cent prices use `unit_amount: null` and a canonical `unit_amount_decimal` string, such as `"0.125"`. Use integer `unit_amount` for whole cents. Decimal strings must have a fractional part, at most 12 decimal places, no leading zeros except `0`, and no trailing fractional zeros. Values such as `"1000"`, `"1.0"`, `"01.5"`, or `"1.50"` are rejected before sending a price mutation to Stripe. This keeps subsequent plans stable when Stripe returns normalized amounts.
