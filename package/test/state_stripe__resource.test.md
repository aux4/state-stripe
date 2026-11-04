# state stripe resource

## should expose the provider schema without credentials

```file:request.json
{
  "version": 1,
  "action": "schema"
}
```

```execute
aux4 state stripe resource < request.json | jq '.resources.price.immutable'
```

```expect:json
[
  "product",
  "currency",
  "unit_amount",
  "recurring"
]
```

## should reject an unsupported protocol version

```file:request.json
{
  "version": 2,
  "action": "schema"
}
```

```execute
aux4 state stripe resource < request.json
```

```error:partial
Unsupported provider protocol version
```
