# aux4/state-stripe

Resource schemas, defaults, change detection rules and lifecycle operations for Stripe products and prices. All API communication is delegated to community/stripe.

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
      unit_amount: 2000 # required; nonnegative integer in currency minor units
      recurring: # default: null, for a one-time price
        interval: month # required inside recurring: day, week, month or year
        interval_count: 1 # default; positive integer
      active: true # default
      metadata: {} # default; string values only
      nickname: "" # default
      lookup_key: pro_monthly # default: ""
```

Only these properties are supported in this release. Arbitrary nesting is available in the engine, but Stripe metadata values are strings. Product feature arrays and recurring price objects demonstrate typed arrays and nested objects. Currency codes must follow Stripe's rules. API calls use Stripe version `2026-10-28.endive`.

## Price changes

Changing `product`, `currency`, `unit_amount`, or `recurring` creates a replacement price and archives the previous price after dependents have been updated. Other supported fields update in place. When a managed replacement keeps the old price's lookup key, the key is transferred to the new price. New resources do not automatically take lookup keys from unrelated prices.

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
