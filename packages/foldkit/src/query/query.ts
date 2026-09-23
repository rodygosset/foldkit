import { Effect, Option, Schema, Stream, pipe } from 'effect'

import * as AsyncData from '../asyncData/index.js'
import * as Command from '../command/index.js'
import { defineMessageUnion } from '../message/index.js'
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
    RequestedRevalidate: {},
    RequestedRevalidateOrLoad: {},
    RequestedLoadIfMissing: {},
    RequestedReplace: {},
    RequestedWatch: {},
    RequestedForget: {},
    SettledFetch: {
      requestId: Schema.Number,
      result: Schema.Result(data, error),
    },
  })

export type QueryMessage<A, AI, E, EI> = ReturnType<
  typeof makeQueryMessage<A, AI, E, EI>
>

export function makeQueryModel<A, AI, E, EI>(
  data: Schema.Codec<A, AI>,
  error: Schema.Codec<E, EI>,
) {
  const states = AsyncData.Schema(data, error)
  return Schema.Struct({
    nextRequestId: Schema.Number,
    maybePendingRequestId: Schema.Option(Schema.Number),
    data: states.schema,
  })
}

export type QueryModel<A, AI, E, EI> = ReturnType<
  typeof makeQueryModel<A, AI, E, EI>
>

/** Single-slot remote-data Submodel. `Model` holds the request counter, the pending request id, and the `AsyncData`. */
export interface Query<Name extends string, A, AI, E, EI, R = never> {
  readonly Model: QueryModel<A, AI, E, EI>
  readonly Message: QueryMessage<A, AI, E, EI>
  readonly Fetch: Command.CommandDefinitionWithArgs<
    `Fetch${Name}`,
    { requestId: typeof Schema.Number },
    Effect.Effect<SettledFetchOf<QueryMessage<A, AI, E, EI>>, never, R>
  >
  readonly init: () => QueryModel<A, AI, E, EI>['Type']
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
  readonly informRevalidate: (
    model: QueryModel<A, AI, E, EI>['Type'],
  ) => Update.Return<
    QueryModel<A, AI, E, EI>['Type'],
    QueryMessage<A, AI, E, EI>['Type'],
    R
  >
  readonly informRevalidateOrLoad: (
    model: QueryModel<A, AI, E, EI>['Type'],
  ) => Update.Return<
    QueryModel<A, AI, E, EI>['Type'],
    QueryMessage<A, AI, E, EI>['Type'],
    R
  >
  readonly informLoadIfMissing: (
    model: QueryModel<A, AI, E, EI>['Type'],
  ) => Update.Return<
    QueryModel<A, AI, E, EI>['Type'],
    QueryMessage<A, AI, E, EI>['Type'],
    R
  >
  readonly informReplace: (
    model: QueryModel<A, AI, E, EI>['Type'],
  ) => Update.Return<
    QueryModel<A, AI, E, EI>['Type'],
    QueryMessage<A, AI, E, EI>['Type'],
    R
  >
  readonly informWatch: (
    model: QueryModel<A, AI, E, EI>['Type'],
  ) => Update.Return<
    QueryModel<A, AI, E, EI>['Type'],
    QueryMessage<A, AI, E, EI>['Type'],
    R
  >
  readonly informForget: (
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
    readonly init: () => unknown
  }
}

export function defineQuery<Name extends string, A, AI, E, EI, R>(
  config: QueryConfig<Name, A, AI, E, EI, R>,
): Query<Name, A, AI, E, EI, R> {
  const ModelSchema = makeQueryModel(config.data, config.error)
  const Message = makeQueryMessage(config.data, config.error)
  type Message = QueryMessage<A, AI, E, EI>['Type']
  const Fetch = Command.define(`Fetch${config.name}`, {
    args: { requestId: Schema.Number },
    messages: [Message.SettledFetch],
    execute: args =>
      pipe(
        config.execute,
        Effect.result,
        Effect.map(result =>
          Message.SettledFetch({
            requestId: args.requestId,
            result,
          }),
        ),
      ),
  })

  type Model = QueryModel<A, AI, E, EI>['Type']
  type Args = undefined
  type UpdateReturn = Update.Return<Model, Message, R>

  const store: CacheStore<Model, Args, A, E, Message, R> = {
    read: model => model.data,
    begin(model, _args, data) {
      const allocated = allocateRequestId(model.nextRequestId)
      return {
        model: {
          ...model,
          data,
          nextRequestId: allocated.nextRequestId,
          maybePendingRequestId: Option.some(allocated.requestId),
        },
        requestId: allocated.requestId,
      }
    },
    isCurrent: (model, _args, requestId) =>
      sameRequest(model.maybePendingRequestId, requestId),
    load: (_args, requestId) => Fetch({ requestId }),
  }

  function forgetSlot(model: Model): UpdateReturn {
    if (AsyncData.isIdle(model.data)) {
      return { model }
    }

    return {
      model: {
        ...model,
        data: AsyncData.Idle(),
        maybePendingRequestId: Option.none(),
      },
    }
  }

  const update = (model: Model, message: Message): UpdateReturn =>
    Message.match<UpdateReturn>(message, {
      RequestedRevalidate: () =>
        applyPolicy(store, model, undefined, 'revalidate'),
      RequestedRevalidateOrLoad: () =>
        applyPolicy(store, model, undefined, 'revalidateOrLoad'),
      RequestedLoadIfMissing: () =>
        applyPolicy(store, model, undefined, 'loadIfMissing'),
      RequestedReplace: () => replaceSlot(store, model, undefined),
      RequestedWatch: () =>
        applyPolicy(store, model, undefined, 'loadIfMissing'),
      RequestedForget: () => forgetSlot(model),
      SettledFetch({ requestId, result }) {
        if (!store.isCurrent(model, undefined, requestId)) {
          return { model }
        }

        return {
          model: {
            ...model,
            data: AsyncData.settle(model.data, result),
            maybePendingRequestId: Option.none(),
          },
        }
      },
    })

  const informRevalidate = (model: Model): UpdateReturn =>
    update(model, Message.RequestedRevalidate())
  const informRevalidateOrLoad = (model: Model): UpdateReturn =>
    update(model, Message.RequestedRevalidateOrLoad())
  const informLoadIfMissing = (model: Model): UpdateReturn =>
    update(model, Message.RequestedLoadIfMissing())
  const informReplace = (model: Model): UpdateReturn =>
    update(model, Message.RequestedReplace())
  const informWatch = (model: Model): UpdateReturn =>
    update(model, Message.RequestedWatch())
  const informForget = (model: Model): UpdateReturn =>
    update(model, Message.RequestedForget())

  const init = (): Model => ({
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
          Stream.succeed(
            toParentMessage(
              isWatching ? Message.RequestedWatch() : Message.RequestedForget(),
            ),
          ),
      },
    )

  const liftFromLens = <ParentModel, ParentMessage>(
    foldConfig: FoldLens<ParentModel, ParentMessage, Model, Message>,
  ) => ({
    fold: Update.foldChild({ update, ...foldConfig }),
    revalidate: Update.foldChildStep({
      update: informRevalidate,
      ...foldConfig,
    }),
    revalidateOrLoad: Update.foldChildStep({
      update: informRevalidateOrLoad,
      ...foldConfig,
    }),
    loadIfMissing: Update.foldChildStep({
      update: informLoadIfMissing,
      ...foldConfig,
    }),
    replace: Update.foldChildStep({ update: informReplace, ...foldConfig }),
    watch: Update.foldChildStep({ update: informWatch, ...foldConfig }),
    forget: Update.foldChildStep({ update: informForget, ...foldConfig }),
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
    Model: ModelSchema,
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
  } satisfies Query<Name, A, AI, E, EI, R>
}
