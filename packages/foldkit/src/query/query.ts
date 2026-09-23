import { Effect, Option, Schema, Stream, pipe } from 'effect'

import * as AsyncData from '../asyncData/index.js'
import * as Command from '../command/index.js'
import { defineMessageUnion } from '../message/index.js'
import { modifyFields } from '../struct/index.js'
import * as Subscription from '../subscription/subscription.js'
import * as Update from '../update/index.js'
import {
  type CacheStore,
  type FoldLens,
  type LiftConfig,
  type LiftQuery,
  type ParentKeyFoldConfig,
  type SettledFetchOf,
  allocateRequestId,
  applyPolicy,
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
export interface Query<Name extends string, A, AI, E, EI, R = never> {
  readonly Model: QueryModel<A, AI, E, EI>
  readonly Message: QueryMessage<A, AI, E, EI>
  readonly Fetch: Command.CommandDefinitionWithArgs<
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
  config: QueryConfig<Name, A, AI, E, EI, R>,
): Query<Name, A, AI, E, EI, R> {
  const Model = makeQueryModel(config.data, config.error)
  const Message = makeQueryMessage(config.data, config.error)
  type Message = QueryMessage<A, AI, E, EI>['Type']
  const Fetch = Command.define(`Fetch${config.name}`, {
    args: { instanceId: Schema.String, requestId: Schema.Number },
    messages: [Message.SettledFetch],
    execute: args =>
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
      ),
  })

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
  }

  function forgetSlot(model: Model): UpdateReturn {
    if (AsyncData.isIdle(model.data)) {
      return { model }
    }

    return {
      model: modifyFields(model, {
        data: () => AsyncData.Idle(),
        maybePendingRequestId: () => Option.none(),
      }),
    }
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
  } satisfies Query<Name, A, AI, E, EI, R>
}
