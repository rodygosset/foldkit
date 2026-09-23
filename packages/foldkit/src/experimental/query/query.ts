import { Effect, Match, Number, Predicate, Schema, pipe } from 'effect'

import * as AsyncData from '../../asyncData/index.js'
import * as Command from '../../command/index.js'
import * as Interruptible from '../../command/interruptible/index.js'
import { defineMessageUnion } from '../../message/index.js'
import { modifyFields } from '../../struct/index.js'
import * as Update from '../../update/index.js'
import {
  CancelIntent,
  type CompletedFetchOf,
  type FoldLens,
  type LiftConfig,
  type LiftQuery,
  type ParentFieldConfig,
  type QueryStore,
  applyTransition,
  completeCancel,
  encodeInterruptKey,
  isParentFieldConfig,
  parentFieldToLens,
  replaceEntry,
  runExecute,
} from './internal.js'

export type QueryConfig<Name extends string, A, AI, E, EI, R> = Readonly<{
  name: Name
  data: Schema.Codec<A, AI, never, never>
  error: Schema.Codec<E, EI, never, never>
  /** Cancels pending Fetches when they are evicted or replaced. */
  interrupt?: boolean
  execute: Effect.Effect<A, E, R>
}>

const makeQueryMessage = <A, AI, E, EI>(
  data: Schema.Codec<A, AI>,
  error: Schema.Codec<E, EI>,
) =>
  defineMessageUnion({
    CompletedFetch: {
      generation: Schema.Number,
      result: Schema.Result(data, error),
    },
  })

const makeInterruptibleQueryMessage = <A, AI, E, EI>(
  data: Schema.Codec<A, AI>,
  error: Schema.Codec<E, EI>,
) =>
  defineMessageUnion({
    CompletedFetch: {
      instanceId: Schema.String,
      generation: Schema.Number,
      result: Schema.Result(data, error),
    },
    CompletedCancelFetch: {
      instanceId: Schema.String,
      generation: Schema.Number,
      outcome: Interruptible.Outcome,
      intent: CancelIntent,
    },
  })

/**
 * Schema-backed Message union dispatched when a Query Fetch completes.
 *
 * @experimental Ships from `foldkit/experimental/query`; expect breaking changes while the API settles.
 */
export type QueryMessage<
  A,
  AI,
  E,
  EI,
  Interrupt extends boolean = false,
> = Interrupt extends true
  ? ReturnType<typeof makeInterruptibleQueryMessage<A, AI, E, EI>>
  : ReturnType<typeof makeQueryMessage<A, AI, E, EI>>

/** Builds the Model Schema for a Query. */
export const makeQueryModel = <A, AI, E, EI>(
  data: Schema.Codec<A, AI>,
  error: Schema.Codec<E, EI>,
) =>
  Schema.Struct({
    data: AsyncData.Schema(data, error).schema,
    generation: Schema.Number,
  })

const makeInterruptibleQueryModel = <A, AI, E, EI>(
  data: Schema.Codec<A, AI>,
  error: Schema.Codec<E, EI>,
) =>
  Schema.Struct({
    ...makeQueryModel(data, error).fields,
    instanceId: Schema.String,
  })

/**
 * Model Schema for a Query containing one `AsyncData` value.
 *
 * @experimental Ships from `foldkit/experimental/query`; expect breaking changes while the API settles.
 */
export type QueryModel<
  A,
  AI,
  E,
  EI,
  Interrupt extends boolean = false,
> = Interrupt extends true
  ? ReturnType<typeof makeInterruptibleQueryModel<A, AI, E, EI>>
  : ReturnType<typeof makeQueryModel<A, AI, E, EI>>

/**
 * Submodel for fetching and retaining one `AsyncData` value.
 *
 * @experimental Ships from `foldkit/experimental/query`; expect breaking changes while the API settles.
 */
export interface Query<
  Name extends string,
  A,
  AI,
  E,
  EI,
  R = never,
  Interrupt extends boolean = false,
> {
  /** Schema for this Query's Model. */
  readonly Model: QueryModel<A, AI, E, EI, Interrupt>
  /** Schema-backed union of Messages handled by this Query. */
  readonly Message: QueryMessage<A, AI, E, EI, Interrupt>
  /**
   * Command definition for matching this Query's pending fetch in Story and
   * Scene tests. Start fetches through a loading operation so the Model and
   * request generation advance together; do not call this directly.
   */
  readonly Fetch: Interrupt extends true
    ? Interruptible.DefinitionWithArgs<
        `Fetch${Name}`,
        {
          readonly instanceId: typeof Schema.String
          readonly generation: typeof Schema.Number
        },
        Readonly<{ instanceId: string; generation: number }>,
        Effect.Effect<
          CompletedFetchOf<QueryMessage<A, AI, E, EI, true>>,
          never,
          R
        >
      >
    : Command.CommandDefinitionWithArgs<
        `Fetch${Name}`,
        { readonly generation: typeof Schema.Number },
        Effect.Effect<CompletedFetchOf<QueryMessage<A, AI, E, EI>>, never, R>
      >
  /**
   * Creates a Query Model for initial parent Model construction. Never replace
   * a live Query with `init()`: it can reuse an in-flight request generation.
   * Use `reset` instead. Interruptible Queries require an instance identifier.
   */
  readonly init: Interrupt extends true
    ? (instanceId: string) => QueryModel<A, AI, E, EI, Interrupt>['Type']
    : () => QueryModel<A, AI, E, EI, Interrupt>['Type']
  /** Clears the Query while preserving request identity and cancels pending work when interruption is enabled. */
  readonly reset: (
    model: QueryModel<A, AI, E, EI, Interrupt>['Type'],
  ) => Update.Return<
    QueryModel<A, AI, E, EI, Interrupt>['Type'],
    QueryMessage<A, AI, E, EI, Interrupt>['Type']
  >
  /** Reads the `AsyncData` value from the Query Model. */
  readonly read: (
    model: QueryModel<A, AI, E, EI, Interrupt>['Type'],
  ) => AsyncData.AsyncData<A, E>
  /** Folds Fetch and cancellation completions into the Query Model. */
  readonly update: (
    model: QueryModel<A, AI, E, EI, Interrupt>['Type'],
    message: QueryMessage<A, AI, E, EI, Interrupt>['Type'],
  ) => Update.Return<
    QueryModel<A, AI, E, EI, Interrupt>['Type'],
    QueryMessage<A, AI, E, EI, Interrupt>['Type'],
    Interrupt extends true ? R : never
  >
  /** Refreshes loaded data and does nothing when no data is present. */
  readonly revalidate: (
    model: QueryModel<A, AI, E, EI, Interrupt>['Type'],
  ) => Update.Return<
    QueryModel<A, AI, E, EI, Interrupt>['Type'],
    QueryMessage<A, AI, E, EI, Interrupt>['Type'],
    R
  >
  /** Loads missing data or refreshes loaded data. */
  readonly revalidateOrLoad: (
    model: QueryModel<A, AI, E, EI, Interrupt>['Type'],
  ) => Update.Return<
    QueryModel<A, AI, E, EI, Interrupt>['Type'],
    QueryMessage<A, AI, E, EI, Interrupt>['Type'],
    R
  >
  /** Loads data only when the Query has no usable value. */
  readonly loadIfMissing: (
    model: QueryModel<A, AI, E, EI, Interrupt>['Type'],
  ) => Update.Return<
    QueryModel<A, AI, E, EI, Interrupt>['Type'],
    QueryMessage<A, AI, E, EI, Interrupt>['Type'],
    R
  >
  /** Starts a new Fetch even when one is pending, retaining available data. */
  readonly replace: Query<Name, A, AI, E, EI, R, Interrupt>['loadIfMissing']
  /** Lifts this Query's update and loading operations into a parent Model. */
  readonly lift: LiftQuery<
    QueryModel<A, AI, E, EI, Interrupt>['Type'],
    QueryMessage<A, AI, E, EI, Interrupt>['Type'],
    R,
    Interrupt extends true ? R : never
  >
  /** Executes the configured fetch directly and returns settled `AsyncData`. */
  readonly run: Effect.Effect<AsyncData.AsyncData<A, E>, never, R>
}

export function defineQuery<Name extends string, A, AI, E, EI, R>(
  config: QueryConfig<Name, A, AI, E, EI, R> & Readonly<{ interrupt: true }>,
): Query<Name, A, AI, E, EI, R, true>
export function defineQuery<Name extends string, A, AI, E, EI, R>(
  config: QueryConfig<Name, A, AI, E, EI, R> & Readonly<{ interrupt?: false }>,
): Query<Name, A, AI, E, EI, R>
export function defineQuery<Name extends string, A, AI, E, EI, R>(
  config: QueryConfig<Name, A, AI, E, EI, R>,
): Query<Name, A, AI, E, EI, R, true> | Query<Name, A, AI, E, EI, R>
export function defineQuery<Name extends string, A, AI, E, EI, R>(
  config: QueryConfig<Name, A, AI, E, EI, R>,
): unknown {
  const PlainModel = makeQueryModel(config.data, config.error)
  const InterruptibleModel = makeInterruptibleQueryModel(
    config.data,
    config.error,
  )
  const Model = config.interrupt === true ? InterruptibleModel : PlainModel
  type Model = typeof PlainModel.Type | typeof InterruptibleModel.Type
  const PlainMessage = makeQueryMessage(config.data, config.error)
  const InterruptibleMessage = makeInterruptibleQueryMessage(
    config.data,
    config.error,
  )
  const Message =
    config.interrupt === true ? InterruptibleMessage : PlainMessage
  type Message = typeof PlainMessage.Type | typeof InterruptibleMessage.Type

  const PlainFetch = Command.define(`Fetch${config.name}`, {
    args: { generation: Schema.Number },
    messages: [PlainMessage.CompletedFetch],
    execute: ({ generation }) =>
      pipe(
        config.execute,
        Effect.result,
        Effect.map(result =>
          PlainMessage.CompletedFetch({ generation, result }),
        ),
      ),
  })
  const InterruptibleFetch = Command.define(`Fetch${config.name}`, {
    args: { instanceId: Schema.String, generation: Schema.Number },
    messages: [
      InterruptibleMessage.CompletedFetch,
      InterruptibleMessage.CompletedCancelFetch,
    ],
    interrupt: {
      keyFields: ['instanceId', 'generation'],
      toKey: ({ instanceId, generation }) =>
        encodeInterruptKey(instanceId, generation),
    },
    execute: ({ instanceId, generation }) =>
      pipe(
        config.execute,
        Effect.result,
        Effect.map(result =>
          InterruptibleMessage.CompletedFetch({
            instanceId,
            generation,
            result,
          }),
        ),
      ),
  })
  const Fetch = config.interrupt === true ? InterruptibleFetch : PlainFetch

  type UpdateReturn = Update.Return<Model, Message, R>
  type PureUpdateReturn = Update.Return<Model, Message>

  const store: QueryStore<Model, undefined, A, E, Message, R> = {
    read: model => model.data,
    start: (model, _args, data) => {
      const nextGeneration = Number.increment(model.generation)

      return {
        model: modifyFields(model, {
          data: () => data,
          generation: () => nextGeneration,
        }),
        generation: nextGeneration,
      }
    },
    fetch: (model, _args, generation) =>
      config.interrupt === true && Predicate.hasProperty(model, 'instanceId')
        ? InterruptibleFetch({ instanceId: model.instanceId, generation })
        : PlainFetch({ generation }),
    interrupt:
      config.interrupt === true
        ? (model, _args, intent) => {
            if (!Predicate.hasProperty(model, 'instanceId')) {
              throw new Error('Interruptible Query requires an instanceId')
            }

            return InterruptibleFetch.Interrupt(
              { instanceId: model.instanceId, generation: model.generation },
              outcome =>
                InterruptibleMessage.CompletedCancelFetch({
                  instanceId: model.instanceId,
                  generation: model.generation,
                  outcome,
                  intent,
                }),
            )
          }
        : undefined,
  }

  const init = (instanceId?: string): Model => {
    if (config.interrupt === true) {
      if (instanceId === undefined) {
        throw new Error('Interruptible Query.init requires an instanceId')
      }

      return InterruptibleModel.make({
        data: AsyncData.Idle(),
        generation: 0,
        instanceId,
      })
    }

    return PlainModel.make({ data: AsyncData.Idle(), generation: 0 })
  }
  const reset = (model: Model): PureUpdateReturn => {
    const nextModel = modifyFields(model, { data: () => AsyncData.Idle() })

    if (AsyncData.isPending(model.data) && store.interrupt !== undefined) {
      return {
        model: nextModel,
        commands: [store.interrupt(model, undefined, CancelIntent.Forget())],
      }
    }

    return { model: nextModel }
  }
  const read = (model: Model): AsyncData.AsyncData<A, E> => model.data

  const revalidate = (model: Model): UpdateReturn =>
    applyTransition(store, model, undefined, AsyncData.revalidate)
  const revalidateOrLoad = (model: Model): UpdateReturn =>
    applyTransition(store, model, undefined, AsyncData.revalidateOrLoad)
  const loadIfMissing = (model: Model): UpdateReturn =>
    applyTransition(store, model, undefined, AsyncData.loadIfMissing)

  const replace = (model: Model): UpdateReturn =>
    replaceEntry(store, model, undefined)

  const update = (model: Model, message: Message): UpdateReturn =>
    pipe(
      Match.value(message),
      Match.withReturnType<UpdateReturn>(),
      Match.tagsExhaustive({
        CompletedFetch(message) {
          const { generation, result } = message
          if (
            Predicate.hasProperty(message, 'instanceId') &&
            (!Predicate.hasProperty(model, 'instanceId') ||
              message.instanceId !== model.instanceId)
          ) {
            return { model }
          }

          const data = read(model)

          if (!AsyncData.isPending(data) || generation !== model.generation) {
            return { model }
          }

          return {
            model: modifyFields(model, {
              data: () => AsyncData.settle(data, result),
            }),
          }
        },
        CompletedCancelFetch({ instanceId, generation, intent }) {
          if (
            !Predicate.hasProperty(model, 'instanceId') ||
            instanceId !== model.instanceId ||
            generation !== model.generation ||
            AsyncData.isIdle(model.data)
          ) {
            return { model }
          }

          return completeCancel(store, model, undefined, intent)
        },
      }),
    )

  const liftFromLens = <ParentModel, ParentMessage>(
    lens: FoldLens<ParentModel, ParentMessage, Model, Message>,
  ) => ({
    fold: Update.foldChild({ update, ...lens }),
    reset: Update.foldChildStep({
      update: reset,
      ...lens,
    }),
    revalidate: Update.foldChildStep({
      update: revalidate,
      ...lens,
    }),
    revalidateOrLoad: Update.foldChildStep({
      update: revalidateOrLoad,
      ...lens,
    }),
    loadIfMissing: Update.foldChildStep({
      update: loadIfMissing,
      ...lens,
    }),
    replace: Update.foldChildStep({ update: replace, ...lens }),
  })

  function lift<ParentModel, ParentMessage>(
    config: ParentFieldConfig<ParentModel, ParentMessage, Model, Message>,
  ): ReturnType<LiftQuery<Model, Message, R, R>>
  function lift<ParentModel, ParentMessage>(
    config: FoldLens<ParentModel, ParentMessage, Model, Message>,
  ): ReturnType<LiftQuery<Model, Message, R, R>>
  function lift<ParentModel, ParentMessage>(
    config: LiftConfig<ParentModel, ParentMessage, Model, Message>,
  ) {
    if (isParentFieldConfig(config)) {
      return liftFromLens(parentFieldToLens(config))
    }

    return liftFromLens(config)
  }

  const run = runExecute(config.execute)

  return {
    Model,
    Message,
    Fetch,
    init,
    reset,
    read,
    update,
    revalidate,
    revalidateOrLoad,
    loadIfMissing,
    replace,
    lift,
    run,
  }
}
