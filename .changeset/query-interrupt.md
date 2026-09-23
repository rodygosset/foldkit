---
'foldkit': minor
---

`Query.define({ interrupt: true })` makes Fetch interruptible. `init` stores `instanceId` on the Model. The interrupt key is that id, plus the slot key for a KeyedQuery. Forget and replace of a pending slot return an Interrupt Command. `CompletedCancelFetch` carries the pending `requestId`. update starts the replacement only when that id is still pending. Omit `interrupt` and a running Fetch finishes. A late `SettledFetch` still cannot write.
