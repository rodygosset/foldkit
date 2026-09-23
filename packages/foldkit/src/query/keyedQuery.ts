import {
  Array,
  Effect,
  Function,
  HashMap,
  HashSet,
  Option,
  Order,
  Record,
  Schema,
  Stream,
  pipe,
} from 'effect'

import * as AsyncData from '../asyncData/index.js'
import * as Command from '../command/index.js'
import type * as Interruptible from '../command/interruptible/index.js'
import { defineMessageUnion } from '../message/index.js'
import * as Subscription from '../subscription/subscription.js'
import * as Update from '../update/index.js'
import {
  type CacheStore,
  CancelIntent,
  FetchInterruptOutcome,
  type FoldLens,
  type InterruptibleCacheStore,
  type KeyedArgs,
  type LiftConfig,
  type LiftKeyedQuery,
  type ParentKeyFoldConfig,
  type SettledFetchOf,
  allocateRequestId,
  applyPolicy,
  completeCancel,
  foldChildFromInform,
  isParentKeyFoldConfig,
  parentKeyToLens,
  replaceSlot,
  runExecute,
  sameRequest,
} from './internal.js'

export type SyncFields = {
  readonly [x: PropertyKey]: Schema.Codec<unknown, unknown, never, never>
}

const isArgKeyFields = <Args extends object>(
  keys: ReadonlyArray<string>,
): keys is Array.NonEmptyReadonlyArray<keyof Args & string> =>
  Array.isReadonlyArrayNonEmpty(keys)

export const encodeKey = <S extends Schema.Codec<unknown, unknown>>(
  schema: S,
) =>
  schema.pipe(
    Schema.toCodecJson,
    Schema.fromJsonString,
    Schema.encodeUnknownSync,
  )

export type KeyedQueryConfig<
  Name extends string,
  A,
  AI,
  E,
  EI,
  Fields extends SyncFields,
  R,
> = Readonly<{
  name: Name
  data: Schema.Codec<A, AI, never, never>
  error: Schema.Codec<E, EI, never, never>
  args: Fields
  toKey?: (args: Schema.Schema.Type<Schema.Struct<Fields>>) => string
  execute: (
    args: Schema.Schema.Type<Schema.Struct<Fields>>,
  ) => Effect.Effect<A, E, R>
  interrupt?: boolean
}>

const makeKeyedQueryMessage = <A, AI, E, EI, Fields extends SyncFields>(
  data: Schema.Codec<A, AI>,
  error: Schema.Codec<E, EI>,
  Args: Schema.Struct<Fields>,
) =>
  defineMessageUnion({
    RequestedRevalidate: { args: Args },
    RequestedRevalidateOrLoad: { args: Args },
    RequestedLoadIfMissing: { args: Args },
    RequestedReplace: { args: Args },
    RequestedWatch: { live: Schema.HashMap(Schema.String, Args) },
    RequestedForget: { args: Args },
    SettledFetch: {
      args: Args,
      requestId: Schema.Number,
      result: Schema.Result(data, error),
    },
  })

const makeInterruptibleKeyedQueryMessage = <
  A,
  AI,
  E,
  EI,
  Fields extends SyncFields,
>(
  data: Schema.Codec<A, AI>,
  error: Schema.Codec<E, EI>,
  Args: Schema.Struct<Fields>,
) =>
  defineMessageUnion({
    RequestedRevalidate: { args: Args },
    RequestedRevalidateOrLoad: { args: Args },
    RequestedLoadIfMissing: { args: Args },
    RequestedReplace: { args: Args },
    RequestedWatch: { live: Schema.HashMap(Schema.String, Args) },
    RequestedForget: { args: Args },
    SettledFetch: {
      args: Args,
      requestId: Schema.Number,
      result: Schema.Result(data, error),
    },
    CompletedCancelFetch: {
      args: Args,
      requestId: Schema.Number,
      outcome: FetchInterruptOutcome,
      intent: CancelIntent,
    },
  })

export type KeyedQueryMessage<
  A,
  AI,
  E,
  EI,
  Fields extends SyncFields,
  Interrupt extends boolean = false,
> = Interrupt extends true
  ? ReturnType<typeof makeInterruptibleKeyedQueryMessage<A, AI, E, EI, Fields>>
  : ReturnType<typeof makeKeyedQueryMessage<A, AI, E, EI, Fields>>

export function makeKeyedQueryModel<A, AI, E, EI, Fields extends SyncFields>(
  data: Schema.Codec<A, AI>,
  error: Schema.Codec<E, EI>,
  Args: Schema.Struct<Fields>,
) {
  const states = AsyncData.Schema(data, error)
  return Schema.Struct({
    nextRequestId: Schema.Number,
    slots: Schema.HashMap(
      Schema.String,
      Schema.Struct({
        args: Args,
        data: states.schema,
        maybePendingRequestId: Schema.Option(Schema.Number),
      }),
    ),
  })
}

export function makeInterruptibleKeyedQueryModel<
  A,
  AI,
  E,
  EI,
  Fields extends SyncFields,
>(
  data: Schema.Codec<A, AI>,
  error: Schema.Codec<E, EI>,
  Args: Schema.Struct<Fields>,
) {
  const states = AsyncData.Schema(data, error)
  return Schema.Struct({
    instanceId: Schema.String,
    nextRequestId: Schema.Number,
    slots: Schema.HashMap(
      Schema.String,
      Schema.Struct({
        args: Args,
        data: states.schema,
        maybePendingRequestId: Schema.Option(Schema.Number),
      }),
    ),
  })
}

export type KeyedQueryModel<
  A,
  AI,
  E,
  EI,
  Fields extends SyncFields,
  Interrupt extends boolean = false,
> = Interrupt extends true
  ? ReturnType<typeof makeInterruptibleKeyedQueryModel<A, AI, E, EI, Fields>>
  : ReturnType<typeof makeKeyedQueryModel<A, AI, E, EI, Fields>>

/** KeyedQuery remote-data Submodel. `Model` owns the request counter and the slot map. */
export interface KeyedQuery<
  Name extends string,
  A,
  AI,
  E,
  EI,
  Fields extends SyncFields,
  R = never,
  Interrupt extends boolean = false,
> {
  readonly Model: KeyedQueryModel<A, AI, E, EI, Fields, Interrupt>
  readonly Message: KeyedQueryMessage<A, AI, E, EI, Fields, Interrupt>
  readonly Fetch: Interrupt extends true
    ? Interruptible.DefinitionWithArgs<
        `Fetch${Name}`,
        {
          requestId: typeof Schema.Number
          instanceId: typeof Schema.String
          userArgs: Schema.Struct<Fields>
        },
        {
          readonly instanceId: string
          readonly userArgs: KeyedArgs<Fields>
        },
        Effect.Effect<
          SettledFetchOf<KeyedQueryMessage<A, AI, E, EI, Fields, true>>,
          never,
          R
        >
      >
    : Command.CommandDefinitionWithArgs<
        `Fetch${Name}`,
        {
          requestId: typeof Schema.Number
          userArgs: Schema.Struct<Fields>
        },
        Effect.Effect<
          SettledFetchOf<KeyedQueryMessage<A, AI, E, EI, Fields, false>>,
          never,
          R
        >
      >
  readonly init: Interrupt extends true
    ? (
        instanceId: string,
      ) => KeyedQueryModel<A, AI, E, EI, Fields, true>['Type']
    : () => KeyedQueryModel<A, AI, E, EI, Fields, false>['Type']
  readonly read: (
    model: KeyedQueryModel<A, AI, E, EI, Fields, Interrupt>['Type'],
    args: KeyedArgs<Fields>,
  ) => AsyncData.AsyncData<A, E>
  readonly update: (
    model: KeyedQueryModel<A, AI, E, EI, Fields, Interrupt>['Type'],
    message: KeyedQueryMessage<A, AI, E, EI, Fields, Interrupt>['Type'],
  ) => Update.Return<
    KeyedQueryModel<A, AI, E, EI, Fields, Interrupt>['Type'],
    KeyedQueryMessage<A, AI, E, EI, Fields, Interrupt>['Type'],
    R
  >
  readonly informRevalidate: Update.Fold<
    KeyedQueryModel<A, AI, E, EI, Fields, Interrupt>['Type'],
    KeyedQueryMessage<A, AI, E, EI, Fields, Interrupt>['Type'],
    KeyedArgs<Fields>,
    R
  >
  readonly informRevalidateOrLoad: Update.Fold<
    KeyedQueryModel<A, AI, E, EI, Fields, Interrupt>['Type'],
    KeyedQueryMessage<A, AI, E, EI, Fields, Interrupt>['Type'],
    KeyedArgs<Fields>,
    R
  >
  readonly informLoadIfMissing: Update.Fold<
    KeyedQueryModel<A, AI, E, EI, Fields, Interrupt>['Type'],
    KeyedQueryMessage<A, AI, E, EI, Fields, Interrupt>['Type'],
    KeyedArgs<Fields>,
    R
  >
  readonly informReplace: Update.Fold<
    KeyedQueryModel<A, AI, E, EI, Fields, Interrupt>['Type'],
    KeyedQueryMessage<A, AI, E, EI, Fields, Interrupt>['Type'],
    KeyedArgs<Fields>,
    R
  >
  readonly informWatch: Update.Fold<
    KeyedQueryModel<A, AI, E, EI, Fields, Interrupt>['Type'],
    KeyedQueryMessage<A, AI, E, EI, Fields, Interrupt>['Type'],
    ReadonlyArray<KeyedArgs<Fields>>,
    R
  >
  readonly informForget: Update.Fold<
    KeyedQueryModel<A, AI, E, EI, Fields, Interrupt>['Type'],
    KeyedQueryMessage<A, AI, E, EI, Fields, Interrupt>['Type'],
    KeyedArgs<Fields>,
    R
  >
  readonly lift: LiftKeyedQuery<
    KeyedQueryModel<A, AI, E, EI, Fields, Interrupt>['Type'],
    KeyedQueryMessage<A, AI, E, EI, Fields, Interrupt>['Type'],
    KeyedArgs<Fields>,
    R
  >
  readonly watchSubscription: <ParentModel, ParentMessage>(
    entry: Subscription.EntryBuilder<ParentModel, ParentMessage, R>,
    config: {
      readonly toParentMessage: (
        message: KeyedQueryMessage<A, AI, E, EI, Fields, Interrupt>['Type'],
      ) => ParentMessage
      readonly modelToArgs: (
        model: ParentModel,
      ) => ReadonlyArray<KeyedArgs<Fields>>
    },
  ) => Subscription.EntryWithoutKeepAlive<
    ParentModel,
    ParentMessage,
    { readonly args: ReadonlyArray<KeyedArgs<Fields>> },
    R
  >
  readonly run: (
    args: KeyedArgs<Fields>,
  ) => Effect.Effect<AsyncData.AsyncData<A, E>, never, R>
}

export namespace KeyedQuery {
  export type Any = {
    readonly Model: Schema.Top
    readonly Message: Schema.Top
    readonly init: () => unknown
  }
}

export function definePlainKeyedQuery<
  Name extends string,
  A,
  AI,
  E,
  EI,
  Fields extends SyncFields,
  R,
>(
  config: KeyedQueryConfig<Name, A, AI, E, EI, Fields, R>,
): KeyedQuery<Name, A, AI, E, EI, Fields, R, false> {
  const states = AsyncData.Schema(config.data, config.error)
  type SlotState = typeof states.schema.Type
  const Args = Schema.Struct(config.args)
  type Args = typeof Args.Type
  const keys = Record.keys(config.args)
  if (!isArgKeyFields<Args>(keys)) {
    throw new Error(
      `Query.define("${config.name}"): keyed args must include at least one field`,
    )
  }

  const toKey = (args: Args): string =>
    config.toKey !== undefined ? config.toKey(args) : encodeKey(Args)(args)

  const Message = makeKeyedQueryMessage(config.data, config.error, Args)
  type Message = KeyedQueryMessage<A, AI, E, EI, Fields, false>['Type']

  const FetchArgs = {
    requestId: Schema.Number,
    userArgs: Args,
  }

  const Fetch = Command.define(`Fetch${config.name}`, {
    args: FetchArgs,
    messages: [Message.SettledFetch],
    execute: args =>
      pipe(
        config.execute(args.userArgs),
        Effect.result,
        Effect.map(function (result): typeof Message.SettledFetch.Type {
          // NOTE: SettledFetch's constructor input view rejects args that are already the decoded Type.
          return {
            _tag: 'SettledFetch',
            args: args.userArgs,
            requestId: args.requestId,
            result,
          }
        }),
      ),
  })

  const Model = makeKeyedQueryModel(config.data, config.error, Args)
  type Model = KeyedQueryModel<A, AI, E, EI, Fields, false>['Type']
  type UpdateReturn = Update.Return<Model, Message, R>
  type UpdateStep = Update.Step<Model, Message, R>

  const store: CacheStore<Model, Args, A, E, Message, R> = {
    read: (model, args) =>
      AsyncData.fromOptionOrIdle(
        Option.map(HashMap.get(model.slots, toKey(args)), slot => slot.data),
      ),
    begin(model, args, data) {
      const allocated = allocateRequestId(model.nextRequestId)
      return {
        model: {
          ...model,
          nextRequestId: allocated.nextRequestId,
          slots: HashMap.set(model.slots, toKey(args), {
            args,
            data,
            maybePendingRequestId: Option.some(allocated.requestId),
          }),
        },
        requestId: allocated.requestId,
      }
    },
    isCurrent: (model, args, requestId) =>
      Option.match(HashMap.get(model.slots, toKey(args)), {
        onNone: () => false,
        onSome: slot => sameRequest(slot.maybePendingRequestId, requestId),
      }),
    load: (args, requestId, _model) => Fetch({ requestId, userArgs: args }),
  }

  const hasSlot = (model: Model, args: Args): boolean =>
    HashMap.has(model.slots, toKey(args))

  function forgetSlot(model: Model, args: Args): UpdateReturn {
    if (!hasSlot(model, args)) return { model }

    return {
      model: {
        ...model,
        slots: HashMap.remove(model.slots, toKey(args)),
      },
    }
  }

  function watchSlots(
    model: Model,
    liveArgs: ReadonlyArray<Args>,
  ): UpdateReturn {
    const liveKeys = HashSet.fromIterable(
      Array.map(liveArgs, args => toKey(args)),
    )
    const forgetExtras = HashMap.reduce(
      model.slots,
      Array.empty<UpdateStep>(),
      function (steps, slot, key) {
        if (HashSet.has(liveKeys, key)) return steps

        return Array.append(steps, (current: Model) =>
          forgetSlot(current, slot.args),
        )
      },
    )
    const loadLive = Array.map(
      liveArgs,
      (args): UpdateStep =>
        current =>
          applyPolicy(store, current, args, 'loadIfMissing'),
    )
    return Update.combine(model, Array.appendAll(forgetExtras, loadLive))
  }

  const update = (model: Model, message: Message): UpdateReturn =>
    Message.match<UpdateReturn>(message, {
      RequestedRevalidate: ({ args }) =>
        applyPolicy(store, model, args, 'revalidate'),
      RequestedRevalidateOrLoad: ({ args }) =>
        applyPolicy(store, model, args, 'revalidateOrLoad'),
      RequestedLoadIfMissing: ({ args }) =>
        applyPolicy(store, model, args, 'loadIfMissing'),
      RequestedReplace: ({ args }) => replaceSlot(store, model, args),
      RequestedWatch: ({ live }) => watchSlots(model, HashMap.toValues(live)),
      RequestedForget: ({ args }) => forgetSlot(model, args),
      SettledFetch({ args, requestId, result }) {
        if (!store.isCurrent(model, args, requestId)) return { model }

        const key = toKey(args)
        return Option.match(HashMap.get(model.slots, key), {
          onNone: () => ({
            model,
          }),
          onSome: slot => ({
            model: {
              ...model,
              slots: HashMap.set(model.slots, key, {
                ...slot,
                data: AsyncData.settle(slot.data, result),
                maybePendingRequestId: Option.none(),
              }),
            },
          }),
        })
      },
    })

  const inform = (
    build: (args: Args) => Message,
  ): Update.Fold<Model, Message, Args, R> =>
    Function.dual(2, (model: Model, args: Args): UpdateReturn =>
      update(model, build(args)),
    )

  const informRevalidate = inform(function (args) {
    return { _tag: 'RequestedRevalidate', args }
  })
  const informRevalidateOrLoad = inform(function (args) {
    return { _tag: 'RequestedRevalidateOrLoad', args }
  })
  const informLoadIfMissing = inform(function (args) {
    return { _tag: 'RequestedLoadIfMissing', args }
  })
  const informReplace = inform(function (args) {
    return { _tag: 'RequestedReplace', args }
  })
  const informForget = inform(function (args) {
    return { _tag: 'RequestedForget', args }
  })
  const toWatchMessage = (liveArgs: ReadonlyArray<Args>): Message => ({
    _tag: 'RequestedWatch',
    live: HashMap.fromIterable(
      Array.map(liveArgs, function (args) {
        return [toKey(args), args] as const
      }),
    ),
  })

  const informWatch: Update.Fold<
    Model,
    Message,
    ReadonlyArray<Args>,
    R
  > = Function.dual(2, (model: Model, liveArgs: ReadonlyArray<Args>) =>
    update(model, toWatchMessage(liveArgs)),
  )

  const init = (): Model => ({
    nextRequestId: 0,
    slots: HashMap.empty(),
  })
  const read = (model: Model, args: Args): SlotState => store.read(model, args)

  const liftFromLens = <ParentModel, ParentMessage>(
    foldConfig: FoldLens<ParentModel, ParentMessage, Model, Message>,
  ) => ({
    fold: Update.foldChild({ update, ...foldConfig }),
    revalidate: foldChildFromInform(informRevalidate, foldConfig),
    revalidateOrLoad: foldChildFromInform(informRevalidateOrLoad, foldConfig),
    loadIfMissing: foldChildFromInform(informLoadIfMissing, foldConfig),
    replace: foldChildFromInform(informReplace, foldConfig),
    watch: foldChildFromInform(informWatch, foldConfig),
    forget: foldChildFromInform(informForget, foldConfig),
    watchSubscription: (
      entry: Subscription.EntryBuilder<ParentModel, ParentMessage, R>,
      modelToArgs: (model: ParentModel) => ReadonlyArray<Args>,
    ) =>
      watchKeyedQuerySubscription(
        entry,
        foldConfig.toParentMessage,
        modelToArgs,
      ),
  })

  function lift<ParentModel, ParentMessage>(
    config: ParentKeyFoldConfig<ParentModel, ParentMessage, Model, Message>,
  ): ReturnType<LiftKeyedQuery<Model, Message, Args, R>>
  function lift<ParentModel, ParentMessage>(
    config: FoldLens<ParentModel, ParentMessage, Model, Message>,
  ): ReturnType<LiftKeyedQuery<Model, Message, Args, R>>
  function lift<ParentModel, ParentMessage>(
    config: LiftConfig<ParentModel, ParentMessage, Model, Message>,
  ) {
    if (isParentKeyFoldConfig(config)) {
      return liftFromLens(parentKeyToLens(config))
    }

    return liftFromLens(config)
  }

  const watchKeyedQuerySubscription = <ParentModel, ParentMessage>(
    entry: Subscription.EntryBuilder<ParentModel, ParentMessage, R>,
    toParentMessage: (message: Message) => ParentMessage,
    modelToArgs: (model: ParentModel) => ReadonlyArray<Args>,
  ) =>
    entry(
      { args: Schema.Array(Args) },
      {
        modelToDependencies: (parent: ParentModel) => ({
          args: Array.sortWith(
            modelToArgs(parent),
            liveArgs => toKey(liveArgs),
            Order.String,
          ),
        }),
        dependenciesToStream: ({
          args,
        }: {
          readonly args: ReadonlyArray<Args>
        }) => Stream.succeed(toParentMessage(toWatchMessage(args))),
      },
    )

  const watchSubscription = <ParentModel, ParentMessage>(
    entry: Subscription.EntryBuilder<ParentModel, ParentMessage, R>,
    watchConfig: {
      readonly toParentMessage: (message: Message) => ParentMessage
      readonly modelToArgs: (model: ParentModel) => ReadonlyArray<Args>
    },
  ) =>
    watchKeyedQuerySubscription(
      entry,
      watchConfig.toParentMessage,
      watchConfig.modelToArgs,
    )

  const run = (args: Args): Effect.Effect<SlotState, never, R> =>
    runExecute(config.execute(args))

  return {
    Model,
    Message,
    Fetch,
    init,
    read,
    update,
    informRevalidate,
    informRevalidateOrLoad,
    informLoadIfMissing,
    informReplace,
    informWatch,
    informForget,
    lift,
    watchSubscription,
    run,
  } satisfies KeyedQuery<Name, A, AI, E, EI, Fields, R, false>
}

export function defineInterruptibleKeyedQuery<
  Name extends string,
  A,
  AI,
  E,
  EI,
  Fields extends SyncFields,
  R,
>(
  config: KeyedQueryConfig<Name, A, AI, E, EI, Fields, R>,
): KeyedQuery<Name, A, AI, E, EI, Fields, R, true> {
  const states = AsyncData.Schema(config.data, config.error)
  type SlotState = typeof states.schema.Type
  const Args = Schema.Struct(config.args)
  type Args = typeof Args.Type
  const keys = Record.keys(config.args)
  if (!isArgKeyFields<Args>(keys))
    throw new Error(
      `Query.define("${config.name}"): keyed args must include at least one field`,
    )

  const toKey = (args: Args): string =>
    config.toKey !== undefined ? config.toKey(args) : encodeKey(Args)(args)

  const Message = makeInterruptibleKeyedQueryMessage(
    config.data,
    config.error,
    Args,
  )
  type Message = KeyedQueryMessage<A, AI, E, EI, Fields, true>['Type']

  const FetchArgs = {
    requestId: Schema.Number,
    instanceId: Schema.String,
    userArgs: Args,
  }

  const Fetch = Command.define(`Fetch${config.name}`, {
    args: FetchArgs,
    messages: [Message.SettledFetch, Message.CompletedCancelFetch],
    interrupt: {
      keyFields: ['instanceId', 'userArgs'],
      toKey: function (keyArgs: {
        readonly instanceId: string
        readonly userArgs: Args
      }) {
        return `${keyArgs.instanceId}:${toKey(keyArgs.userArgs)}`
      },
    },
    execute: args =>
      pipe(
        config.execute(args.userArgs),
        Effect.result,
        Effect.map((result): typeof Message.SettledFetch.Type =>
          // NOTE: SettledFetch's constructor input view rejects args that are already the decoded Type.
          ({
            _tag: 'SettledFetch',
            args: args.userArgs,
            requestId: args.requestId,
            result,
          }),
        ),
      ),
  })

  const Model = makeInterruptibleKeyedQueryModel(
    config.data,
    config.error,
    Args,
  )
  type Model = KeyedQueryModel<A, AI, E, EI, Fields, true>['Type']
  type UpdateReturn = Update.Return<Model, Message, R>
  type UpdateStep = Update.Step<Model, Message, R>

  const store: InterruptibleCacheStore<Model, Args, A, E, Message, R> = {
    read: (model, args) =>
      AsyncData.fromOptionOrIdle(
        Option.map(HashMap.get(model.slots, toKey(args)), slot => slot.data),
      ),
    begin(model, args, data) {
      const allocated = allocateRequestId(model.nextRequestId)
      return {
        model: {
          ...model,
          nextRequestId: allocated.nextRequestId,
          slots: HashMap.set(model.slots, toKey(args), {
            args,
            data,
            maybePendingRequestId: Option.some(allocated.requestId),
          }),
        },
        requestId: allocated.requestId,
      }
    },
    isCurrent: (model, args, requestId) =>
      Option.match(HashMap.get(model.slots, toKey(args)), {
        onNone: () => false,
        onSome: slot => sameRequest(slot.maybePendingRequestId, requestId),
      }),
    load: (args, requestId, model) =>
      Fetch({
        requestId,
        instanceId: model.instanceId,
        userArgs: args,
      }),
    interrupt(model, args, intent) {
      const requestId = Option.match(
        Option.flatMap(
          HashMap.get(model.slots, toKey(args)),
          slot => slot.maybePendingRequestId,
        ),
        {
          onNone: () => 0,
          onSome: pendingRequestId => pendingRequestId,
        },
      )
      return Fetch.Interrupt(
        { instanceId: model.instanceId, userArgs: args },
        outcome => ({
          _tag: 'CompletedCancelFetch',
          args,
          requestId,
          outcome,
          intent,
        }),
      )
    },
  }

  const hasSlot = (model: Model, args: Args): boolean =>
    HashMap.has(model.slots, toKey(args))

  function forgetSlot(model: Model, args: Args): UpdateReturn {
    if (!hasSlot(model, args)) return { model }

    const isPending = AsyncData.isPending(store.read(model, args))
    const forgotten = {
      ...model,
      slots: HashMap.remove(model.slots, toKey(args)),
    }

    if (isPending)
      return {
        model: forgotten,
        commands: [store.interrupt(model, args, CancelIntent.Forget())],
      }

    return { model: forgotten }
  }

  function watchSlots(
    model: Model,
    liveArgs: ReadonlyArray<Args>,
  ): UpdateReturn {
    const liveKeys = HashSet.fromIterable(
      Array.map(liveArgs, args => toKey(args)),
    )
    const forgetExtras = HashMap.reduce(
      model.slots,
      Array.empty<UpdateStep>(),
      function (steps, slot, key) {
        if (HashSet.has(liveKeys, key)) return steps

        return Array.append(steps, (current: Model) =>
          forgetSlot(current, slot.args),
        )
      },
    )
    const loadLive = Array.map(
      liveArgs,
      (args): UpdateStep =>
        current =>
          applyPolicy(store, current, args, 'loadIfMissing'),
    )
    return Update.combine(model, Array.appendAll(forgetExtras, loadLive))
  }

  const update = (model: Model, message: Message): UpdateReturn =>
    Message.match<UpdateReturn>(message, {
      RequestedRevalidate: ({ args }) =>
        applyPolicy(store, model, args, 'revalidate'),
      RequestedRevalidateOrLoad: ({ args }) =>
        applyPolicy(store, model, args, 'revalidateOrLoad'),
      RequestedLoadIfMissing: ({ args }) =>
        applyPolicy(store, model, args, 'loadIfMissing'),
      RequestedReplace: ({ args }) => replaceSlot(store, model, args),
      RequestedWatch: ({ live }) => watchSlots(model, HashMap.toValues(live)),
      RequestedForget: ({ args }) => forgetSlot(model, args),
      SettledFetch({ args, requestId, result }) {
        if (!store.isCurrent(model, args, requestId)) return { model }

        const key = toKey(args)
        return Option.match(HashMap.get(model.slots, key), {
          onNone: () => ({
            model,
          }),
          onSome: slot => ({
            model: {
              ...model,
              slots: HashMap.set(model.slots, key, {
                ...slot,
                data: AsyncData.settle(slot.data, result),
                maybePendingRequestId: Option.none(),
              }),
            },
          }),
        })
      },
      CompletedCancelFetch({ args, requestId, outcome, intent }) {
        if (!store.isCurrent(model, args, requestId)) return { model }

        return completeCancel(store, model, args, outcome, intent)
      },
    })

  const inform = (
    build: (args: Args) => Message,
  ): Update.Fold<Model, Message, Args, R> =>
    Function.dual(2, (model: Model, args: Args): UpdateReturn =>
      update(model, build(args)),
    )

  const informRevalidate = inform(function (args) {
    return { _tag: 'RequestedRevalidate', args }
  })
  const informRevalidateOrLoad = inform(function (args) {
    return { _tag: 'RequestedRevalidateOrLoad', args }
  })
  const informLoadIfMissing = inform(function (args) {
    return { _tag: 'RequestedLoadIfMissing', args }
  })
  const informReplace = inform(function (args) {
    return { _tag: 'RequestedReplace', args }
  })
  const informForget = inform(function (args) {
    return { _tag: 'RequestedForget', args }
  })
  const toWatchMessage = (liveArgs: ReadonlyArray<Args>): Message => ({
    _tag: 'RequestedWatch',
    live: HashMap.fromIterable(
      Array.map(liveArgs, args => [toKey(args), args] as const),
    ),
  })

  const informWatch: Update.Fold<
    Model,
    Message,
    ReadonlyArray<Args>,
    R
  > = Function.dual(2, (model: Model, liveArgs: ReadonlyArray<Args>) =>
    update(model, toWatchMessage(liveArgs)),
  )

  const init = (instanceId: string): Model => ({
    instanceId,
    nextRequestId: 0,
    slots: HashMap.empty(),
  })
  const read = (model: Model, args: Args): SlotState => store.read(model, args)

  const liftFromLens = <ParentModel, ParentMessage>(
    foldConfig: FoldLens<ParentModel, ParentMessage, Model, Message>,
  ) => ({
    fold: Update.foldChild({ update, ...foldConfig }),
    revalidate: foldChildFromInform(informRevalidate, foldConfig),
    revalidateOrLoad: foldChildFromInform(informRevalidateOrLoad, foldConfig),
    loadIfMissing: foldChildFromInform(informLoadIfMissing, foldConfig),
    replace: foldChildFromInform(informReplace, foldConfig),
    watch: foldChildFromInform(informWatch, foldConfig),
    forget: foldChildFromInform(informForget, foldConfig),
    watchSubscription: (
      entry: Subscription.EntryBuilder<ParentModel, ParentMessage, R>,
      modelToArgs: (model: ParentModel) => ReadonlyArray<Args>,
    ) =>
      watchKeyedQuerySubscription(
        entry,
        foldConfig.toParentMessage,
        modelToArgs,
      ),
  })

  function lift<ParentModel, ParentMessage>(
    config: ParentKeyFoldConfig<ParentModel, ParentMessage, Model, Message>,
  ): ReturnType<LiftKeyedQuery<Model, Message, Args, R>>
  function lift<ParentModel, ParentMessage>(
    config: FoldLens<ParentModel, ParentMessage, Model, Message>,
  ): ReturnType<LiftKeyedQuery<Model, Message, Args, R>>
  function lift<ParentModel, ParentMessage>(
    config: LiftConfig<ParentModel, ParentMessage, Model, Message>,
  ) {
    if (isParentKeyFoldConfig(config))
      return liftFromLens(parentKeyToLens(config))

    return liftFromLens(config)
  }

  const watchKeyedQuerySubscription = <ParentModel, ParentMessage>(
    entry: Subscription.EntryBuilder<ParentModel, ParentMessage, R>,
    toParentMessage: (message: Message) => ParentMessage,
    modelToArgs: (model: ParentModel) => ReadonlyArray<Args>,
  ) =>
    entry(
      { args: Schema.Array(Args) },
      {
        modelToDependencies: (parent: ParentModel) => ({
          args: Array.sortWith(
            modelToArgs(parent),
            liveArgs => toKey(liveArgs),
            Order.String,
          ),
        }),
        dependenciesToStream: ({
          args,
        }: {
          readonly args: ReadonlyArray<Args>
        }) => Stream.succeed(toParentMessage(toWatchMessage(args))),
      },
    )

  const watchSubscription = <ParentModel, ParentMessage>(
    entry: Subscription.EntryBuilder<ParentModel, ParentMessage, R>,
    watchConfig: {
      readonly toParentMessage: (message: Message) => ParentMessage
      readonly modelToArgs: (model: ParentModel) => ReadonlyArray<Args>
    },
  ) =>
    watchKeyedQuerySubscription(
      entry,
      watchConfig.toParentMessage,
      watchConfig.modelToArgs,
    )

  const run = (args: Args): Effect.Effect<SlotState, never, R> =>
    runExecute(config.execute(args))

  return {
    Model,
    Message,
    Fetch,
    init,
    read,
    update,
    informRevalidate,
    informRevalidateOrLoad,
    informLoadIfMissing,
    informReplace,
    informWatch,
    informForget,
    lift,
    watchSubscription,
    run,
  } satisfies KeyedQuery<Name, A, AI, E, EI, Fields, R, true>
}

export function defineKeyedQuery<
  Name extends string,
  A,
  AI,
  E,
  EI,
  Fields extends SyncFields,
  R,
>(
  config: KeyedQueryConfig<Name, A, AI, E, EI, Fields, R> & {
    readonly interrupt: true
  },
): KeyedQuery<Name, A, AI, E, EI, Fields, R, true>
export function defineKeyedQuery<
  Name extends string,
  A,
  AI,
  E,
  EI,
  Fields extends SyncFields,
  R,
>(
  config: KeyedQueryConfig<Name, A, AI, E, EI, Fields, R> & {
    readonly interrupt?: false
  },
): KeyedQuery<Name, A, AI, E, EI, Fields, R, false>
export function defineKeyedQuery<
  Name extends string,
  A,
  AI,
  E,
  EI,
  Fields extends SyncFields,
  R,
>(
  config: KeyedQueryConfig<Name, A, AI, E, EI, Fields, R> & {
    readonly interrupt?: boolean
  },
):
  | KeyedQuery<Name, A, AI, E, EI, Fields, R, true>
  | KeyedQuery<Name, A, AI, E, EI, Fields, R, false> {
  if (config.interrupt === true) return defineInterruptibleKeyedQuery(config)

  return definePlainKeyedQuery(config)
}
