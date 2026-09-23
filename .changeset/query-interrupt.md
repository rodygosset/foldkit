---
'foldkit': minor
---

Add opt-in Fetch interruption to experimental Query. With `interrupt: true`, `init(instanceId)` scopes each Query instance, and Fetch keys include its request generation. `reset`, KeyedQuery's `forget`, and `retainOnly` cancel pending Fetches for evicted entries. `replace` waits for cancellation before starting the replacement and keeps available data visible, including when the original Fetch completes before cancellation. Interruptible Query `update` and lifted `fold` require the execute services because they can start a replacement Fetch. Default Queries retain their existing API and behavior.
