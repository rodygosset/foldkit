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
import { modifyFields } from '../struct/index.js'
import * as Subscription from '../subscription/subscription.js'
import * as Update from '../update/index.js'
import {
  type CacheStore,
  CancelIntent,
  FetchInterruptOutcome,
  type FoldLens,
  type KeyedArgs,
  type LiftConfig,
  type LiftKeyedQuery,
  type ParentKeyFoldConfig,
  type Policy,
  type SettledFetchOf,
  allocateRequestId,
  applyPolicy,
  completeCancel,
  foldChildFromPolicy,
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
    UpdatedWatch: { live: Schema.HashMap(Schema.String, Args) },
    SettledFetch: {
      args: Args,
      instanceId: Schema.String,
      requestId: Schema.Number,
      result: Schema.Result(data, error),
    },
    CompletedCancelFetch: {
      args: Args,
      instanceId: Schema.String,
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
> = ReturnType<typeof makeKeyedQueryMessage<A, AI, E, EI, Fields>>

/** Schema for a KeyedQuery's retained slots and request identity. */
export function makeKeyedQueryModel<A, AI, E, EI, Fields extends SyncFields>(
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
> = ReturnType<typeof makeKeyedQueryModel<A, AI, E, EI, Fields>>

/** Keyed remote-data Submodel. Read a slot's `AsyncData` with `read`. */
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
  readonly Model: KeyedQueryModel<A, AI, E, EI, Fields>
  readonly Message: KeyedQueryMessage<A, AI, E, EI, Fields>
  readonly Fetch: Interrupt extends true
    ? Interruptible.DefinitionWithArgs<
        `Fetch${Name}`,
        {
          instanceId: typeof Schema.String
          requestId: typeof Schema.Number
          queryArgs: Schema.Struct<Fields>
        },
        { readonly instanceId: string; readonly queryArgs: KeyedArgs<Fields> },
        Effect.Effect<
          SettledFetchOf<KeyedQueryMessage<A, AI, E, EI, Fields>>,
          never,
          R
        >
      >
    : Command.CommandDefinitionWithArgs<
        `Fetch${Name}`,
        {
          instanceId: typeof Schema.String
          requestId: typeof Schema.Number
          queryArgs: Schema.Struct<Fields>
        },
        Effect.Effect<
          SettledFetchOf<KeyedQueryMessage<A, AI, E, EI, Fields>>,
          never,
          R
        >
      >
  readonly init: (
    instanceId: string,
  ) => KeyedQueryModel<A, AI, E, EI, Fields>['Type']
  readonly read: (
    model: KeyedQueryModel<A, AI, E, EI, Fields>['Type'],
    args: KeyedArgs<Fields>,
  ) => AsyncData.AsyncData<A, E>
  readonly update: (
    model: KeyedQueryModel<A, AI, E, EI, Fields>['Type'],
    message: KeyedQueryMessage<A, AI, E, EI, Fields>['Type'],
  ) => Update.Return<
    KeyedQueryModel<A, AI, E, EI, Fields>['Type'],
    KeyedQueryMessage<A, AI, E, EI, Fields>['Type'],
    R
  >
  readonly revalidate: Update.Fold<
    KeyedQueryModel<A, AI, E, EI, Fields>['Type'],
    KeyedQueryMessage<A, AI, E, EI, Fields>['Type'],
    KeyedArgs<Fields>,
    R
  >
  readonly revalidateOrLoad: Update.Fold<
    KeyedQueryModel<A, AI, E, EI, Fields>['Type'],
    KeyedQueryMessage<A, AI, E, EI, Fields>['Type'],
    KeyedArgs<Fields>,
    R
  >
  readonly loadIfMissing: Update.Fold<
    KeyedQueryModel<A, AI, E, EI, Fields>['Type'],
    KeyedQueryMessage<A, AI, E, EI, Fields>['Type'],
    KeyedArgs<Fields>,
    R
  >
  readonly replace: Update.Fold<
    KeyedQueryModel<A, AI, E, EI, Fields>['Type'],
    KeyedQueryMessage<A, AI, E, EI, Fields>['Type'],
    KeyedArgs<Fields>,
    R
  >
  readonly watch: Update.Fold<
    KeyedQueryModel<A, AI, E, EI, Fields>['Type'],
    KeyedQueryMessage<A, AI, E, EI, Fields>['Type'],
    ReadonlyArray<KeyedArgs<Fields>>,
    R
  >
  readonly forget: Update.Fold<
    KeyedQueryModel<A, AI, E, EI, Fields>['Type'],
    KeyedQueryMessage<A, AI, E, EI, Fields>['Type'],
    KeyedArgs<Fields>,
    R
  >
  readonly lift: LiftKeyedQuery<
    KeyedQueryModel<A, AI, E, EI, Fields>['Type'],
    KeyedQueryMessage<A, AI, E, EI, Fields>['Type'],
    KeyedArgs<Fields>,
    R
  >
  readonly watchSubscription: <ParentModel, ParentMessage>(
    entry: Subscription.EntryBuilder<ParentModel, ParentMessage, R>,
    config: {
      readonly toParentMessage: (
        message: KeyedQueryMessage<A, AI, E, EI, Fields>['Type'],
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
    readonly init: (instanceId: string) => unknown
  }
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
  config: KeyedQueryConfig<Name, A, AI, E, EI, Fields, R>,
):
  | KeyedQuery<Name, A, AI, E, EI, Fields, R, true>
  | KeyedQuery<Name, A, AI, E, EI, Fields, R, false>
export function defineKeyedQuery<
  Name extends string,
  A,
  AI,
  E,
  EI,
  Fields extends SyncFields,
  R,
>(config: KeyedQueryConfig<Name, A, AI, E, EI, Fields, R>): unknown {
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
  const encodeInterruptKey = encodeKey(
    Schema.Tuple([Schema.String, Schema.String]),
  )

  const Message = makeKeyedQueryMessage(config.data, config.error, Args)
  type Message = KeyedQueryMessage<A, AI, E, EI, Fields>['Type']

  const FetchArgs = {
    instanceId: Schema.String,
    requestId: Schema.Number,
    queryArgs: Args,
  }

  const executeFetch = (
    args: Readonly<{ instanceId: string; requestId: number; queryArgs: Args }>,
  ) =>
    pipe(
      config.execute(args.queryArgs),
      Effect.result,
      Effect.map(function (result): typeof Message.SettledFetch.Type {
        return {
          _tag: 'SettledFetch',
          args: args.queryArgs,
          instanceId: args.instanceId,
          requestId: args.requestId,
          result,
        }
      }),
    )
  const PlainFetch = Command.define(`Fetch${config.name}`, {
    args: FetchArgs,
    messages: [Message.SettledFetch],
    execute: executeFetch,
  })
  const InterruptibleFetch = Command.define(`Fetch${config.name}`, {
    args: FetchArgs,
    messages: [Message.SettledFetch, Message.CompletedCancelFetch],
    interrupt: {
      keyFields: ['instanceId', 'queryArgs'],
      toKey: (keyArgs: {
        readonly instanceId: string
        readonly queryArgs: Args
      }) => encodeInterruptKey([keyArgs.instanceId, toKey(keyArgs.queryArgs)]),
    },
    execute: executeFetch,
  })
  const Fetch = config.interrupt === true ? InterruptibleFetch : PlainFetch

  const Model = makeKeyedQueryModel(config.data, config.error, Args)
  type Model = typeof Model.Type
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
        model: modifyFields(model, {
          nextRequestId: () => allocated.nextRequestId,
          slots: HashMap.set(toKey(args), {
            args,
            data,
            maybePendingRequestId: Option.some(allocated.requestId),
          }),
        }),
        request: {
          instanceId: model.instanceId,
          requestId: allocated.requestId,
        },
      }
    },
    isCurrent: (model, args, request) =>
      Option.match(HashMap.get(model.slots, toKey(args)), {
        onNone: () => false,
        onSome: slot =>
          sameRequest(model.instanceId, slot.maybePendingRequestId, request),
      }),
    load: (args, request) => Fetch({ ...request, queryArgs: args }),
    interrupt:
      config.interrupt === true
        ? (model, args, intent) =>
            Option.flatMap(HashMap.get(model.slots, toKey(args)), slot =>
              Option.map(slot.maybePendingRequestId, requestId =>
                InterruptibleFetch.Interrupt(
                  { instanceId: model.instanceId, queryArgs: args },
                  outcome => ({
                    _tag: 'CompletedCancelFetch',
                    args,
                    instanceId: model.instanceId,
                    requestId,
                    outcome,
                    intent,
                  }),
                ),
              ),
            )
        : undefined,
  }

  const hasSlot = (model: Model, args: Args): boolean =>
    HashMap.has(model.slots, toKey(args))

  function forgetSlot(model: Model, args: Args): UpdateReturn {
    if (!hasSlot(model, args)) return { model }

    const forgotten = modifyFields(model, {
      slots: HashMap.remove(toKey(args)),
    })
    if (
      AsyncData.isPending(store.read(model, args)) &&
      store.interrupt !== undefined
    ) {
      const maybeInterrupt = store.interrupt(model, args, CancelIntent.Forget())
      if (Option.isSome(maybeInterrupt)) {
        return { model: forgotten, commands: [maybeInterrupt.value] }
      }
    }

    return { model: forgotten }
  }

  const toLiveSlots = (liveArgs: ReadonlyArray<Args>) =>
    HashMap.fromIterable(
      Array.map(liveArgs, (args): readonly [string, Args] => [
        toKey(args),
        args,
      ]),
    )

  function watchSlots(
    model: Model,
    liveSlots: HashMap.HashMap<string, Args>,
  ): UpdateReturn {
    const liveKeys = HashSet.fromIterable(HashMap.keys(liveSlots))
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
      HashMap.toValues(liveSlots),
      (args): UpdateStep =>
        current =>
          applyPolicy(store, current, args, 'loadIfMissing'),
    )
    return Update.combine(model, Array.appendAll(forgetExtras, loadLive))
  }

  const policy = (name: Policy): Update.Fold<Model, Message, Args, R> =>
    Function.dual(2, (model: Model, args: Args): UpdateReturn =>
      applyPolicy(store, model, args, name),
    )

  const revalidate = policy('revalidate')
  const revalidateOrLoad = policy('revalidateOrLoad')
  const loadIfMissing = policy('loadIfMissing')
  const replace: Update.Fold<Model, Message, Args, R> = Function.dual(
    2,
    (model: Model, args: Args): UpdateReturn => replaceSlot(store, model, args),
  )
  const forget: Update.Fold<Model, Message, Args, R> = Function.dual(
    2,
    (model: Model, args: Args): UpdateReturn => forgetSlot(model, args),
  )
  const watch: Update.Fold<
    Model,
    Message,
    ReadonlyArray<Args>,
    R
  > = Function.dual(
    2,
    (model: Model, liveArgs: ReadonlyArray<Args>): UpdateReturn =>
      watchSlots(model, toLiveSlots(liveArgs)),
  )

  const update = (model: Model, message: Message): UpdateReturn =>
    Message.match<UpdateReturn>(message, {
      UpdatedWatch: ({ live }) => watchSlots(model, live),
      SettledFetch({ args, instanceId, requestId, result }) {
        if (!store.isCurrent(model, args, { instanceId, requestId })) {
          return { model }
        }

        const key = toKey(args)
        return Option.match(HashMap.get(model.slots, key), {
          onNone: () => ({
            model,
          }),
          onSome: slot => ({
            model: modifyFields(model, {
              slots: HashMap.set(key, {
                ...slot,
                data: AsyncData.settle(slot.data, result),
                maybePendingRequestId: Option.none(),
              }),
            }),
          }),
        })
      },
      CompletedCancelFetch({ args, instanceId, requestId, outcome, intent }) {
        if (!store.isCurrent(model, args, { instanceId, requestId })) {
          return { model }
        }

        return completeCancel(store, model, args, outcome, intent)
      },
    })

  const toWatchMessage = (liveArgs: ReadonlyArray<Args>): Message => ({
    _tag: 'UpdatedWatch',
    live: toLiveSlots(liveArgs),
  })

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
    revalidate: foldChildFromPolicy(revalidate, foldConfig),
    revalidateOrLoad: foldChildFromPolicy(revalidateOrLoad, foldConfig),
    loadIfMissing: foldChildFromPolicy(loadIfMissing, foldConfig),
    replace: foldChildFromPolicy(replace, foldConfig),
    watch: foldChildFromPolicy(watch, foldConfig),
    forget: foldChildFromPolicy(forget, foldConfig),
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
            HashMap.toValues(toLiveSlots(modelToArgs(parent))),
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
    revalidate,
    revalidateOrLoad,
    loadIfMissing,
    replace,
    watch,
    forget,
    lift,
    watchSubscription,
    run,
  }
}
