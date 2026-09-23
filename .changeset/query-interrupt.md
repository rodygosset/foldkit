---
'foldkit': minor
---

`Query.define({ interrupt: true })` makes Fetch interruptible. The `instanceId` passed to `init` scopes its interrupt key; a KeyedQuery also includes the slot key. Forget and replace of a pending slot return an Interrupt Command. `CompletedCancelFetch` carries the pending request identity, and update starts a replacement only while that request is still current. Without `interrupt`, a running Fetch finishes, but a late `SettledFetch` still cannot write.
