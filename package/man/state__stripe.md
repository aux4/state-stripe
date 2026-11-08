#### Description

Stripe adapter for aux4/state. Defines product, fixed and metered price, and Billing Meter resources. Price amount, currency, product and recurrence changes require replacement. Meter event semantics are immutable; only the display name can be updated. Destroying a price archives it and destroying a meter deactivates it, preserving billing history. API communication is performed by community/stripe.

#### Usage

```bash
aux4 state stripe resource
```

#### Example

```bash
aux4 state apply --config dev
```
