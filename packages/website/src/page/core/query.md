# Query

## Overview

`Query.define` is a remote-data Submodel. `read` returns [AsyncData](/core/async-data). The Query Model also keeps `nextRequestId` and `maybePendingRequestId`. A KeyedQuery keeps one `nextRequestId` and a `HashMap` of slots. Each slot keeps `args`, `data`, and `maybePendingRequestId`. `read(model, args)` returns that slot's `AsyncData`, or `Idle` when the key is absent.

Fetch is a [Command](/core/commands). `informWatch` and `informForget` change which slots the Model keeps. `watchSubscription` is one [Subscription](/core/subscriptions) entry. Parents fold child Messages with `query.lift`.

See [API Cache Query](/example-apps/api-cache-query) for a full app.

## Define a Query

Pass `name`, `data`, `error`, and `execute`. `read` returns the `AsyncData` for those schemas. `read(query.init())` is `Idle`.

::Snippet{name="queryDefine" label="Query.define"}

Add `args` for a KeyedQuery. Omit `toKey` to JSON-encode args. Read a slot with `query.read(model, args)`.

::Snippet{name="queryKeyedDefine" label="KeyedQuery.define"}

`args` fields are `Schema.Codec`s with no encoding or decoding services.

## Interrupt a fetch

Omit `interrupt` and a running Fetch finishes. update ignores a `SettledFetch` whose `requestId` is no longer pending.

Pass `interrupt: true` when forget or replace should stop that Effect. Pass `instanceId` to `init`. The interrupt key is that id. A KeyedQuery adds the slot key. Two Models with different ids do not share a key.

`CompletedCancelFetch` carries the `requestId` that was pending when the Interrupt Command was built. update starts the replacement only when that id is still pending.

::Snippet{name="queryInterrupt" label="interrupt: true"}

## Lift into a parent

`query.lift` returns a child record. Bind it as `postsChild`. Pass `toParentMessage`, the same adapter `Update.foldChild` takes. A `Got*` handler calls `postsChild.fold(model, message)`. Policy Steps live on the same record, such as `postsChild.revalidateOrLoad(model)`.

`fold` is an `Update.Fold`. Data-first is `postsChild.fold(model, message)`. Data-last is `postsChild.fold(message)`, so it composes with `Update.combine`.

A full `read` / `write` lens still infers the parent Model from `read`.

::Snippet{name="queryLift" label="query.lift"}

## Watch and forget

A single-slot Query watches a boolean. `true` produces `RequestedWatch`. update loads when the data is missing. `false` produces `RequestedForget`. update sets `data` back to `Idle` and clears `maybePendingRequestId`.

::Snippet{name="queryWatchFlag" label="single-slot watchSubscription"}

A KeyedQuery watches the live args. `informWatch` takes an array. The Message carries a `HashMap` of `toKey` to args. Missing keys `loadIfMissing`. Extra keys follow `informForget` and leave the map. An empty array forgets every slot.

A Fetch that is already running finishes. update ignores its `SettledFetch` when that `requestId` is no longer the pending one. A late `SettledFetch` does not restore a forgotten slot.

`watchSubscription` is one Subscription entry. It reuses that lift's `toParentMessage`.

::Snippet{name="queryWatch" label="KeyedQuery watchSubscription"}

## HttpApi

`Query.HttpApi.Service.query` builds that same Submodel from an Effect HttpApi endpoint. An endpoint with no params, query, payload, or headers is a Query. Anything else is a KeyedQuery. The slot key is the JSON encoding of the client request.

Omit the config and Fetch is not interruptible. Pass `{ interrupt: true }` after the endpoint name when forget or replace should stop that Effect. `init` then takes an `instanceId`, the same as `Query.define({ interrupt: true })`.

See [API Cache HttpApi](/example-apps/api-cache-http-api) for a full app. That app omits the config.

## Run outside of Foldkit

`Query.run` on a Query is an Effect that runs `execute` and returns settled `AsyncData`. KeyedQuery `run(args)` does the same for one slot. Neither writes a Model.

## Full API Surface

The [Query API reference](/api-reference/query) lists `define`, `lift`, `run`, and the Query and KeyedQuery types.
