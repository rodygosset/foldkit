---
'foldkit': minor
---

`Query.HttpApi.Service.query` builds a Query or KeyedQuery from an Effect HttpApi endpoint. An endpoint with no client request is a Query. Anything else is a KeyedQuery whose args are that request. The slot key is the JSON encoding of the args.

The last argument is `{ interrupt?: boolean }`. Omit it and Fetch is not interruptible. Pass `{ interrupt: true }` and `init` takes an `instanceId`, the same as `Query.define({ interrupt: true })`.
