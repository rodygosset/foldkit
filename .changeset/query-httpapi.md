---
'foldkit': minor
---

`Query.HttpApi.Service.query` builds a Query or KeyedQuery from an Effect HttpApi endpoint. An endpoint with no client request is a Query. Anything else is a KeyedQuery whose args are that request. The slot key is the JSON encoding of the args.

The last argument is `{ interrupt?: boolean }`. Omit it and Fetch is not interruptible. Pass `{ interrupt: true }` to interrupt a Fetch on forget or replace. Default Queries use `init()`. With `{ interrupt: true }`, use `init(instanceId)`, as with `Query.define`.

Multipart requests and streaming success responses are excluded. Transport, decoding, and client middleware failures become `HttpApiClientError`; declared endpoint and server middleware errors keep their original types. Responses with headers preserve their body and header codecs for Model serialization.
