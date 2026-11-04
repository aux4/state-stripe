#### Description

Read one protocol-version-1 JSON request from stdin and return a JSON object on stdout. Supported actions: schema, identity, read, create, update and delete. Resource types are product and price. Errors go to stderr with a nonzero exit status. The engine invokes this command automatically. Schemas, defaults, immutable fields and canonical resource values belong to this adapter. Every remote operation is delegated to community/stripe through `aux4 stripe api request`; this command never performs HTTP communication itself.

Configuration requires apiKeyEnv naming an environment variable containing a Stripe secret/restricted key, and mode set to test or live. Optional account selects a connected account. Identity returns the actual account and mode. Mutation requests require idempotencyKey; updates also require previous canonical properties. Deletion sets active to false. See the package README and aux4/state provider contract for request fields and property schemas.

#### Usage

```bash
aux4 state stripe resource < request.json
```

#### Example

Create `request.json`:

```json
{
  "version": 1,
  "action": "schema"
}
```

```bash
aux4 state stripe resource < request.json
```

Returns the product and price schemas, including immutable price properties.
