import { Effect, Option, Schema, Stream, pipe } from 'effect'

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
  type LiftConfig,
  type LiftQuery,
  type ParentKeyFoldConfig,
  type SettledFetchOf,
  allocateRequestId,
  applyPolicy,
  completeCancel,
  isParentKeyFoldConfig,
  parentKeyToLens,
  replaceSlot,
  runExecute,
  sameRequest,
} from './internal.js'

export type QueryConfig<Name extends string, A, AI, E, EI, R> = Readonly<{
  name: Name
  data: Schema.Codec<A, AI, never, never>
  error: Schema.Codec<E, EI, never, never>
  execute: Effect.Effect<A, E, R>
  interrupt?: boolean
}>

const makeQueryMessage = <A, AI, E, EI>(
  data: Schema.Codec<A, AI>,
  error: Schema.Codec<E, EI>,
) =>
  defineMessageUnion({
    UpdatedWatch: { isWatching: Schema.Boolean },
    SettledFetch: {
      instanceId: Schema.String,
      requestId: Schema.Number,
      result: Schema.Result(data, error),
    },
    CompletedCancelFetch: {
      instanceId: Schema.String,
      requestId: Schema.Number,
      outcome: FetchInterruptOutcome,
      intent: CancelIntent,
    },
  })

export type QueryMessage<A, AI, E, EI> = ReturnType<
  typeof makeQueryMessage<A, AI, E, EI>
>

/** Schema for a single Query's remote data and request identity. */
export function makeQueryModel<A, AI, E, EI>(
  data: Schema.Codec<A, AI>,
  error: Schema.Codec<E, EI>,
) {
  const states = AsyncData.Schema(data, error)
  return Schema.Struct({
    instanceId: Schema.String,
    nextRequestId: Schema.Number,
    maybePendingRequestId: Schema.Option(Schema.Number),
    data: states.schema,
  })
}

export type QueryModel<A, AI, E, EI> = ReturnType<
  typeof makeQueryModel<A, AI, E, EI>
>

/** Single-slot remote-data Submodel. Read its `AsyncData` with `read`. */
export interface Query<
  Name extends string,
  A,
  AI,
  E,
  EI,
  R = never,
  Interrupt extends boolean = false,
> {
  readonly Model: QueryModel<A, AI, E, EI>
  readonly Message: QueryMessage<A, AI, E, EI>
  readonly Fetch: Interrupt extends true
    ? Interruptible.DefinitionWithArgs<
        `Fetch${Name}`,
        { instanceId: typeof Schema.String; requestId: typeof Schema.Number },
        { readonly instanceId: string },
        Effect.Effect<SettledFetchOf<QueryMessage<A, AI, E, EI>>, never, R>
      >
    : Command.CommandDefinitionWithArgs<
        `Fetch${Name}`,
        { instanceId: typeof Schema.String; requestId: typeof Schema.Number },
        Effect.Effect<SettledFetchOf<QueryMessage<A, AI, E, EI>>, never, R>
      >
  readonly init: (instanceId: string) => QueryModel<A, AI, E, EI>['Type']
  readonly read: (
    model: QueryModel<A, AI, E, EI>['Type'],
  ) => AsyncData.AsyncData<A, E>
  readonly update: (
    model: QueryModel<A, AI, E, EI>['Type'],
    message: QueryMessage<A, AI, E, EI>['Type'],
  ) => Update.Return<
    QueryModel<A, AI, E, EI>['Type'],
    QueryMessage<A, AI, E, EI>['Type'],
    R
  >
  readonly revalidate: (
    model: QueryModel<A, AI, E, EI>['Type'],
  ) => Update.Return<
    QueryModel<A, AI, E, EI>['Type'],
    QueryMessage<A, AI, E, EI>['Type'],
    R
  >
  readonly revalidateOrLoad: (
    model: QueryModel<A, AI, E, EI>['Type'],
  ) => Update.Return<
    QueryModel<A, AI, E, EI>['Type'],
    QueryMessage<A, AI, E, EI>['Type'],
    R
  >
  readonly loadIfMissing: (
    model: QueryModel<A, AI, E, EI>['Type'],
  ) => Update.Return<
    QueryModel<A, AI, E, EI>['Type'],
    QueryMessage<A, AI, E, EI>['Type'],
    R
  >
  readonly replace: (
    model: QueryModel<A, AI, E, EI>['Type'],
  ) => Update.Return<
    QueryModel<A, AI, E, EI>['Type'],
    QueryMessage<A, AI, E, EI>['Type'],
    R
  >
  readonly watch: (
    model: QueryModel<A, AI, E, EI>['Type'],
  ) => Update.Return<
    QueryModel<A, AI, E, EI>['Type'],
    QueryMessage<A, AI, E, EI>['Type'],
    R
  >
  readonly forget: (
    model: QueryModel<A, AI, E, EI>['Type'],
  ) => Update.Return<
    QueryModel<A, AI, E, EI>['Type'],
    QueryMessage<A, AI, E, EI>['Type'],
    R
  >
  readonly lift: LiftQuery<
    QueryModel<A, AI, E, EI>['Type'],
    QueryMessage<A, AI, E, EI>['Type'],
    R
  >
  readonly watchSubscription: <ParentModel, ParentMessage>(
    entry: Subscription.EntryBuilder<ParentModel, ParentMessage, R>,
    config: {
      readonly toParentMessage: (
        message: QueryMessage<A, AI, E, EI>['Type'],
      ) => ParentMessage
      readonly modelToIsWatching: (model: ParentModel) => boolean
    },
  ) => Subscription.EntryWithoutKeepAlive<
    ParentModel,
    ParentMessage,
    { readonly isWatching: boolean },
    R
  >
  readonly run: Effect.Effect<AsyncData.AsyncData<A, E>, never, R>
}

export namespace Query {
  export type Any = {
    readonly Model: Schema.Top
    readonly Message: Schema.Top
    readonly init: (instanceId: string) => unknown
  }
}

export function defineQuery<Name extends string, A, AI, E, EI, R>(
  config: QueryConfig<Name, A, AI, E, EI, R> & { readonly interrupt: true },
): Query<Name, A, AI, E, EI, R, true>
export function defineQuery<Name extends string, A, AI, E, EI, R>(
  config: QueryConfig<Name, A, AI, E, EI, R> & { readonly interrupt?: false },
): Query<Name, A, AI, E, EI, R, false>
export function defineQuery<Name extends string, A, AI, E, EI, R>(
  config: QueryConfig<Name, A, AI, E, EI, R>,
): Query<Name, A, AI, E, EI, R, true> | Query<Name, A, AI, E, EI, R, false>
export function defineQuery<Name extends string, A, AI, E, EI, R>(
  config: QueryConfig<Name, A, AI, E, EI, R>,
): unknown {
  const Model = makeQueryModel(config.data, config.error)
  const Message = makeQueryMessage(config.data, config.error)
  type Message = QueryMessage<A, AI, E, EI>['Type']
  const FetchArgs = { instanceId: Schema.String, requestId: Schema.Number }
  const executeFetch = (
    args: Readonly<{ instanceId: string; requestId: number }>,
  ) =>
    pipe(
      config.execute,
      Effect.result,
      Effect.map(result =>
        Message.SettledFetch({
          instanceId: args.instanceId,
          requestId: args.requestId,
          result,
        }),
      ),
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
      keyFields: ['instanceId'],
      toKey: (keyArgs: { readonly instanceId: string }) => keyArgs.instanceId,
    },
    execute: executeFetch,
  })
  const Fetch = config.interrupt === true ? InterruptibleFetch : PlainFetch

  type Model = typeof Model.Type
  type UpdateReturn = Update.Return<Model, Message, R>

  const store: CacheStore<Model, undefined, A, E, Message, R> = {
    read: model => model.data,
    begin(model, _args, data) {
      const allocated = allocateRequestId(model.nextRequestId)
      return {
        model: modifyFields(model, {
          data: () => data,
          nextRequestId: () => allocated.nextRequestId,
          maybePendingRequestId: () => Option.some(allocated.requestId),
        }),
        request: {
          instanceId: model.instanceId,
          requestId: allocated.requestId,
        },
      }
    },
    isCurrent: (model, _args, request) =>
      sameRequest(model.instanceId, model.maybePendingRequestId, request),
    load: (_args, request) => Fetch(request),
    interrupt:
      config.interrupt === true
        ? (model, _args, intent) =>
            Option.map(model.maybePendingRequestId, requestId =>
              InterruptibleFetch.Interrupt(
                { instanceId: model.instanceId },
                outcome =>
                  Message.CompletedCancelFetch({
                    instanceId: model.instanceId,
                    requestId,
                    outcome,
                    intent,
                  }),
              ),
            )
        : undefined,
  }

  function forgetSlot(model: Model): UpdateReturn {
    if (AsyncData.isIdle(model.data)) {
      return { model }
    }

    const forgotten = modifyFields(model, {
      data: () => AsyncData.Idle(),
      maybePendingRequestId: () => Option.none(),
    })
    if (AsyncData.isPending(model.data) && store.interrupt !== undefined) {
      const maybeInterrupt = store.interrupt(
        model,
        undefined,
        CancelIntent.Forget(),
      )
      if (Option.isSome(maybeInterrupt)) {
        return { model: forgotten, commands: [maybeInterrupt.value] }
      }
    }

    return { model: forgotten }
  }

  const revalidate = (model: Model): UpdateReturn =>
    applyPolicy(store, model, undefined, 'revalidate')
  const revalidateOrLoad = (model: Model): UpdateReturn =>
    applyPolicy(store, model, undefined, 'revalidateOrLoad')
  const loadIfMissing = (model: Model): UpdateReturn =>
    applyPolicy(store, model, undefined, 'loadIfMissing')
  const replace = (model: Model): UpdateReturn =>
    replaceSlot(store, model, undefined)
  const watch = (model: Model): UpdateReturn => loadIfMissing(model)
  const forget = (model: Model): UpdateReturn => forgetSlot(model)

  const update = (model: Model, message: Message): UpdateReturn =>
    Message.match<UpdateReturn>(message, {
      UpdatedWatch: ({ isWatching }) =>
        isWatching ? watch(model) : forget(model),
      SettledFetch({ instanceId, requestId, result }) {
        if (!store.isCurrent(model, undefined, { instanceId, requestId })) {
          return { model }
        }

        return {
          model: modifyFields(model, {
            data: () => AsyncData.settle(model.data, result),
            maybePendingRequestId: () => Option.none(),
          }),
        }
      },
      CompletedCancelFetch({ instanceId, requestId, outcome, intent }) {
        if (!store.isCurrent(model, undefined, { instanceId, requestId })) {
          return { model }
        }

        return completeCancel(store, model, undefined, outcome, intent)
      },
    })

  const init = (instanceId: string): Model => ({
    instanceId,
    nextRequestId: 0,
    maybePendingRequestId: Option.none(),
    data: AsyncData.Idle(),
  })
  const read = (model: Model): AsyncData.AsyncData<A, E> => model.data

  const watchQuerySubscription = <ParentModel, ParentMessage>(
    entry: Subscription.EntryBuilder<ParentModel, ParentMessage, R>,
    toParentMessage: (message: Message) => ParentMessage,
    modelToIsWatching: (model: ParentModel) => boolean,
  ) =>
    entry(
      { isWatching: Schema.Boolean },
      {
        modelToDependencies: (parent: ParentModel) => ({
          isWatching: modelToIsWatching(parent),
        }),
        dependenciesToStream: ({
          isWatching,
        }: {
          readonly isWatching: boolean
        }) =>
          Stream.succeed(toParentMessage(Message.UpdatedWatch({ isWatching }))),
      },
    )

  const liftFromLens = <ParentModel, ParentMessage>(
    foldConfig: FoldLens<ParentModel, ParentMessage, Model, Message>,
  ) => ({
    fold: Update.foldChild({ update, ...foldConfig }),
    revalidate: Update.foldChildStep({
      update: revalidate,
      ...foldConfig,
    }),
    revalidateOrLoad: Update.foldChildStep({
      update: revalidateOrLoad,
      ...foldConfig,
    }),
    loadIfMissing: Update.foldChildStep({
      update: loadIfMissing,
      ...foldConfig,
    }),
    replace: Update.foldChildStep({ update: replace, ...foldConfig }),
    watch: Update.foldChildStep({ update: watch, ...foldConfig }),
    forget: Update.foldChildStep({ update: forget, ...foldConfig }),
    watchSubscription: (
      entry: Subscription.EntryBuilder<ParentModel, ParentMessage, R>,
      modelToIsWatching: (model: ParentModel) => boolean,
    ) =>
      watchQuerySubscription(
        entry,
        foldConfig.toParentMessage,
        modelToIsWatching,
      ),
  })

  function lift<ParentModel, ParentMessage>(
    config: ParentKeyFoldConfig<ParentModel, ParentMessage, Model, Message>,
  ): ReturnType<LiftQuery<Model, Message, R>>
  function lift<ParentModel, ParentMessage>(
    config: FoldLens<ParentModel, ParentMessage, Model, Message>,
  ): ReturnType<LiftQuery<Model, Message, R>>
  function lift<ParentModel, ParentMessage>(
    config: LiftConfig<ParentModel, ParentMessage, Model, Message>,
  ) {
    if (isParentKeyFoldConfig(config)) {
      return liftFromLens(parentKeyToLens(config))
    }

    return liftFromLens(config)
  }

  const watchSubscription = <ParentModel, ParentMessage>(
    entry: Subscription.EntryBuilder<ParentModel, ParentMessage, R>,
    watchConfig: {
      readonly toParentMessage: (message: Message) => ParentMessage
      readonly modelToIsWatching: (model: ParentModel) => boolean
    },
  ) =>
    watchQuerySubscription(
      entry,
      watchConfig.toParentMessage,
      watchConfig.modelToIsWatching,
    )

  const run = runExecute(config.execute)

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
