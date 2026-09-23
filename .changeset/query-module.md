---
'foldkit': minor
'create-foldkit-app': patch
---

Add `Query.define` as a remote-data Submodel. `read` returns `AsyncData`. The Query Model keeps `nextRequestId`, `maybePendingRequestId`, and `data`. A KeyedQuery keeps one `nextRequestId` and a `HashMap` of slots. Each slot keeps `args`, `data`, and `maybePendingRequestId`. Fetch is a Command. `loadIfMissing`, `revalidate`, and `revalidateOrLoad` start that Command from the Model. `informForget` drops a slot. `informWatch` and `watchSubscription` decide which slots stay. A `SettledFetch` writes only when its `requestId` is still the pending one. `query.lift` folds child Messages into the parent with `toParentMessage` and `Update.Fold`.

Scaffold `api-cache-query` as the full app for this module.
