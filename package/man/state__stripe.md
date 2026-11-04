#### Description

Stripe adapter for aux4/state. Defines product and fixed-amount price resources, including recurring billing. Amount, currency, product and recurrence changes require replacement. Destruction archives resources, preserving existing subscriptions. API communication is performed by community/stripe.

#### Usage

```bash
aux4 state stripe resource
```

#### Example

```bash
aux4 state apply --config dev
```
