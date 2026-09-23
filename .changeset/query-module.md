---
'foldkit': minor
'create-foldkit-app': patch
---

Add `Query.define` as a remote-data Submodel. Both Query Models expose `AsyncData` through `read` and keep request identity in their Models. Fetch is a Command. `loadIfMissing`, `revalidate`, and `revalidateOrLoad` start that Command from the Model. `forget` drops a slot; `watch` and `watchSubscription` decide which slots stay. A `SettledFetch` writes only when its `requestId` is still the pending one. `query.lift` folds child Messages into the parent with `toParentMessage` and `Update.Fold`.

Scaffold `api-cache-query` as the full app for this module.
