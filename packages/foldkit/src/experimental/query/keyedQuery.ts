import {
  Array,
  Effect,
  Function,
  HashMap,
  HashSet,
  Match,
  Number,
  Option,
  Order,
  Predicate,
  Record,
  Schema,
  pipe,
} from 'effect'

import * as AsyncData from '../../asyncData/index.js'
import * as Command from '../../command/index.js'
import * as Interruptible from '../../command/interruptible/index.js'
import { defineMessageUnion } from '../../message/index.js'
import { modifyFields } from '../../struct/index.js'
import * as Update from '../../update/index.js'
import {
  type AsyncDataTransition,
  CancelIntent,
  type CompletedFetchOf,
  type FoldLens,
  type KeyedArgs,
  type LiftConfig,
  type LiftKeyedQuery,
  type ParentFieldConfig,
  type QueryStore,
  applyTransition,
  completeCancel,
  encodeInterruptKey,
  isParentFieldConfig,
  liftChildFold,
  parentFieldToLens,
  replaceEntry,
  runExecute,
} from './internal.js'

export type SyncFields = {
  readonly [x: PropertyKey]: Schema.Codec<unknown, unknown, never, never>
}

const canonicalizeJsonEntry = ([key, value]: readonly [
  string,
  Schema.Json,
]): readonly [string, Schema.Json] => [key, canonicalizeJson(value)]

const jsonEntryOrder = Order.mapInput(
  Order.String,
  ([key]: readonly [string, Schema.Json]) => key,
)

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !globalThis.Array.isArray(value)

const canonicalizeJson = (value: Schema.Json): Schema.Json => {
  if (globalThis.Array.isArray(value)) {
    return Array.map(value, canonicalizeJson)
  }

  if (isJsonObject(value)) {
    return pipe(
      value,
      Record.toEntries,
      Array.sort(jsonEntryOrder),
      Array.map(canonicalizeJsonEntry),
      Record.fromEntries,
    )
  }

  return value
}

const encodeJsonString = Schema.encodeUnknownSync(
  Schema.fromJsonString(Schema.Json),
)

const encodeKey = <A, I>(schema: Schema.Codec<A, I, never, never>) => {
  const encodeJson = Schema.encodeUnknownSync(Schema.toCodecJson(schema))

  return (value: A): string =>
    encodeJsonString(canonicalizeJson(encodeJson(value)))
}

export type KeyedQueryConfig<
  Name extends string,
  A,
  AI,
  E,
  EI,
  Fields extends SyncFields,
  R,
> = Readonly<{
  /** Cancels pending Fetches when they are evicted or replaced. */
  interrupt?: boolean
  name: Name
  data: Schema.Codec<A, AI, never, never>
  error: Schema.Codec<E, EI, never, never>
  args: Fields
  toKey?: (args: Schema.Schema.Type<Schema.Struct<Fields>>) => string
  execute: (
    args: Schema.Schema.Type<Schema.Struct<Fields>>,
  ) => Effect.Effect<A, E, R>
}>

const makeKeyedQueryMessage = <A, AI, E, EI, Fields extends SyncFields>(
  data: Schema.Codec<A, AI>,
  error: Schema.Codec<E, EI>,
  Args: Schema.Struct<Fields>,
) =>
  defineMessageUnion({
    CompletedFetch: {
      args: Args,
      generation: Schema.Number,
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
    CompletedFetch: {
      args: Args,
      instanceId: Schema.String,
      generation: Schema.Number,
      result: Schema.Result(data, error),
    },
    CompletedCancelFetch: {
      args: Args,
      instanceId: Schema.String,
      generation: Schema.Number,
      outcome: Interruptible.Outcome,
      intent: CancelIntent,
    },
  })

/**
 * Schema-backed Message union dispatched when a KeyedQuery fetch completes.
 *
 * @experimental Ships from `foldkit/experimental/query`; expect breaking changes while the API settles.
 */
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

/** Builds the Model Schema for a KeyedQuery. */
export const makeKeyedQueryModel = <A, AI, E, EI, Fields extends SyncFields>(
  data: Schema.Codec<A, AI>,
  error: Schema.Codec<E, EI>,
  Args: Schema.Struct<Fields>,
) => {
  const asyncData = AsyncData.Schema(data, error)

  return Schema.Struct({
    generation: Schema.Number,
    entries: Schema.HashMap(
      Schema.String,
      Schema.Struct({
        args: Args,
        data: asyncData.schema,
        generation: Schema.Number,
      }),
    ),
  })
}

const makeInterruptibleKeyedQueryModel = <
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
  Schema.Struct({
    ...makeKeyedQueryModel(data, error, Args).fields,
    instanceId: Schema.String,
  })

/**
 * Model Schema for a KeyedQuery containing retained `AsyncData` entries.
 *
 * @experimental Ships from `foldkit/experimental/query`; expect breaking changes while the API settles.
 */
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

/**
 * Submodel for fetching and retaining `AsyncData` values by argument key.
 *
 * @experimental Ships from `foldkit/experimental/query`; expect breaking changes while the API settles.
 */
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
  /** Schema for this KeyedQuery's Model. */
  readonly Model: KeyedQueryModel<A, AI, E, EI, Fields, Interrupt>
  /** Schema-backed union of Messages handled by this KeyedQuery. */
  readonly Message: KeyedQueryMessage<A, AI, E, EI, Fields, Interrupt>
  /**
   * Command definition for matching this KeyedQuery's pending fetch in Story
   * and Scene tests. Start fetches through a loading operation so the Model
   * and request generation advance together; do not call this directly.
   */
  readonly Fetch: Interrupt extends true
    ? Interruptible.DefinitionWithArgs<
        `Fetch${Name}`,
        {
          readonly args: Schema.Struct<Fields>
          readonly instanceId: typeof Schema.String
          readonly generation: typeof Schema.Number
        },
        Readonly<{ instanceId: string; generation: number }>,
        Effect.Effect<
          CompletedFetchOf<KeyedQueryMessage<A, AI, E, EI, Fields, true>>,
          never,
          R
        >
      >
    : Command.CommandDefinitionWithArgs<
        `Fetch${Name}`,
        {
          readonly args: Schema.Struct<Fields>
          readonly generation: typeof Schema.Number
        },
        Effect.Effect<
          CompletedFetchOf<KeyedQueryMessage<A, AI, E, EI, Fields>>,
          never,
          R
        >
      >
  /**
   * Creates a KeyedQuery Model for initial parent Model construction. Never
   * replace a live KeyedQuery with `init()`: it can reuse an in-flight request
   * generation. Use `reset` instead. Interruptible Queries require an instance identifier.
   */
  readonly init: Interrupt extends true
    ? (
        instanceId: string,
      ) => KeyedQueryModel<A, AI, E, EI, Fields, Interrupt>['Type']
    : () => KeyedQueryModel<A, AI, E, EI, Fields, Interrupt>['Type']
  /** Clears every entry while preserving request identity and cancels pending work when interruption is enabled. */
  readonly reset: (
    model: KeyedQueryModel<A, AI, E, EI, Fields, Interrupt>['Type'],
  ) => Update.Return<
    KeyedQueryModel<A, AI, E, EI, Fields, Interrupt>['Type'],
    KeyedQueryMessage<A, AI, E, EI, Fields, Interrupt>['Type']
  >
  /** Reads one entry, returning `Idle` when that entry does not exist. */
  readonly read: (
    model: KeyedQueryModel<A, AI, E, EI, Fields, Interrupt>['Type'],
    args: KeyedArgs<Fields>,
  ) => AsyncData.AsyncData<A, E>
  /** Folds Fetch and cancellation completions into the matching entry. */
  readonly update: (
    model: KeyedQueryModel<A, AI, E, EI, Fields, Interrupt>['Type'],
    message: KeyedQueryMessage<A, AI, E, EI, Fields, Interrupt>['Type'],
  ) => Update.Return<
    KeyedQueryModel<A, AI, E, EI, Fields, Interrupt>['Type'],
    KeyedQueryMessage<A, AI, E, EI, Fields, Interrupt>['Type'],
    Interrupt extends true ? R : never
  >
  /** Refreshes a loaded entry and does nothing when it has no data. */
  readonly revalidate: Update.Fold<
    KeyedQueryModel<A, AI, E, EI, Fields, Interrupt>['Type'],
    KeyedQueryMessage<A, AI, E, EI, Fields, Interrupt>['Type'],
    KeyedArgs<Fields>,
    R
  >
  /** Loads a missing entry or refreshes a loaded entry. */
  readonly revalidateOrLoad: Update.Fold<
    KeyedQueryModel<A, AI, E, EI, Fields, Interrupt>['Type'],
    KeyedQueryMessage<A, AI, E, EI, Fields, Interrupt>['Type'],
    KeyedArgs<Fields>,
    R
  >
  /** Loads an entry only when it has no usable value. */
  readonly loadIfMissing: Update.Fold<
    KeyedQueryModel<A, AI, E, EI, Fields, Interrupt>['Type'],
    KeyedQueryMessage<A, AI, E, EI, Fields, Interrupt>['Type'],
    KeyedArgs<Fields>,
    R
  >
  /** Starts a new Fetch for an entry even when one is pending, retaining available data. */
  readonly replace: KeyedQuery<
    Name,
    A,
    AI,
    E,
    EI,
    Fields,
    R,
    Interrupt
  >['loadIfMissing']
  /** Removes one entry while preserving request identity. */
  readonly forget: Update.Fold<
    KeyedQueryModel<A, AI, E, EI, Fields, Interrupt>['Type'],
    KeyedQueryMessage<A, AI, E, EI, Fields, Interrupt>['Type'],
    KeyedArgs<Fields>
  >
  /** Removes entries outside the supplied keys without fetching or changing retained entries. */
  readonly retainOnly: Update.Fold<
    KeyedQueryModel<A, AI, E, EI, Fields, Interrupt>['Type'],
    KeyedQueryMessage<A, AI, E, EI, Fields, Interrupt>['Type'],
    ReadonlyArray<KeyedArgs<Fields>>
  >
  /** Lifts this KeyedQuery's update and loading operations into a parent Model. */
  readonly lift: LiftKeyedQuery<
    KeyedQueryModel<A, AI, E, EI, Fields, Interrupt>['Type'],
    KeyedQueryMessage<A, AI, E, EI, Fields, Interrupt>['Type'],
    KeyedArgs<Fields>,
    R,
    Interrupt extends true ? R : never
  >
  /** Executes one keyed fetch directly and returns settled `AsyncData`. */
  readonly run: (
    args: KeyedArgs<Fields>,
  ) => Effect.Effect<AsyncData.AsyncData<A, E>, never, R>
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
  config: KeyedQueryConfig<Name, A, AI, E, EI, Fields, R> &
    Readonly<{ interrupt: true }>,
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
  config: KeyedQueryConfig<Name, A, AI, E, EI, Fields, R> &
    Readonly<{ interrupt?: false }>,
): KeyedQuery<Name, A, AI, E, EI, Fields, R>
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
  | KeyedQuery<Name, A, AI, E, EI, Fields, R>
export function defineKeyedQuery<
  Name extends string,
  A,
  AI,
  E,
  EI,
  Fields extends SyncFields,
  R,
>(config: KeyedQueryConfig<Name, A, AI, E, EI, Fields, R>): unknown {
  const asyncData = AsyncData.Schema(config.data, config.error)
  type EntryData = typeof asyncData.schema.Type
  const Args = Schema.Struct(config.args)
  type Args = typeof Args.Type
  if (Array.isArrayEmpty(Record.keys(config.args))) {
    throw new Error(
      `Query.define("${config.name}"): keyed args must include at least one field`,
    )
  }

  const argsToKey = config.toKey ?? encodeKey(Args)

  const PlainMessage = makeKeyedQueryMessage(config.data, config.error, Args)
  const InterruptibleMessage = makeInterruptibleKeyedQueryMessage(
    config.data,
    config.error,
    Args,
  )
  const Message =
    config.interrupt === true ? InterruptibleMessage : PlainMessage
  type Message = typeof PlainMessage.Type | typeof InterruptibleMessage.Type

  const executeFetch = (args: Args) => pipe(config.execute(args), Effect.result)
  const PlainFetch = Command.define(`Fetch${config.name}`, {
    args: { args: Args, generation: Schema.Number },
    messages: [PlainMessage.CompletedFetch],
    execute: ({ args, generation }) =>
      pipe(
        executeFetch(args),
        Effect.map((result): typeof PlainMessage.CompletedFetch.Type => ({
          _tag: 'CompletedFetch',
          args,
          generation,
          result,
        })),
      ),
  })
  const InterruptibleFetch = Command.define(`Fetch${config.name}`, {
    args: { args: Args, instanceId: Schema.String, generation: Schema.Number },
    messages: [
      InterruptibleMessage.CompletedFetch,
      InterruptibleMessage.CompletedCancelFetch,
    ],
    interrupt: {
      keyFields: ['instanceId', 'generation'],
      toKey: ({ instanceId, generation }) =>
        encodeInterruptKey(instanceId, generation),
    },
    execute: ({ args, instanceId, generation }) =>
      pipe(
        executeFetch(args),
        Effect.map(
          (result): typeof InterruptibleMessage.CompletedFetch.Type => ({
            _tag: 'CompletedFetch',
            args,
            instanceId,
            generation,
            result,
          }),
        ),
      ),
  })
  const Fetch = config.interrupt === true ? InterruptibleFetch : PlainFetch

  const PlainModel = makeKeyedQueryModel(config.data, config.error, Args)
  const InterruptibleModel = makeInterruptibleKeyedQueryModel(
    config.data,
    config.error,
    Args,
  )
  const Model = config.interrupt === true ? InterruptibleModel : PlainModel
  type Model = typeof PlainModel.Type | typeof InterruptibleModel.Type
  type UpdateReturn = Update.Return<Model, Message, R>
  type PureUpdateReturn = Update.Return<Model, Message>

  const store: QueryStore<Model, Args, A, E, Message, R> = {
    read: (model, args) =>
      AsyncData.fromOptionOrIdle(
        Option.map(
          HashMap.get(model.entries, argsToKey(args)),
          entry => entry.data,
        ),
      ),
    start: (model, args, data) => {
      const nextGeneration = Number.increment(model.generation)

      return {
        model: modifyFields(model, {
          entries: HashMap.set(argsToKey(args), {
            args,
            data,
            generation: nextGeneration,
          }),
          generation: () => nextGeneration,
        }),
        generation: nextGeneration,
      }
    },
    fetch: (model, args, generation) =>
      config.interrupt === true && Predicate.hasProperty(model, 'instanceId')
        ? InterruptibleFetch({ args, instanceId: model.instanceId, generation })
        : PlainFetch({ args, generation }),
    interrupt:
      config.interrupt === true
        ? (model, args, intent) => {
            if (!Predicate.hasProperty(model, 'instanceId')) {
              throw new Error('Interruptible KeyedQuery requires an instanceId')
            }

            const entry = Option.getOrThrow(
              HashMap.get(model.entries, argsToKey(args)),
            )

            return InterruptibleFetch.Interrupt(
              { instanceId: model.instanceId, generation: entry.generation },
              (
                outcome,
              ): typeof InterruptibleMessage.CompletedCancelFetch.Type => ({
                _tag: 'CompletedCancelFetch',
                args,
                instanceId: model.instanceId,
                generation: entry.generation,
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
        throw new Error('Interruptible KeyedQuery.init requires an instanceId')
      }

      return InterruptibleModel.make({
        entries: HashMap.empty(),
        generation: 0,
        instanceId,
      })
    }

    return PlainModel.make({ entries: HashMap.empty(), generation: 0 })
  }
  const evictEntries = (
    model: Model,
    nextEntries: Model['entries'],
  ): PureUpdateReturn => {
    const nextModel = modifyFields(model, { entries: () => nextEntries })
    const interrupt = store.interrupt

    if (interrupt !== undefined) {
      const commands = pipe(
        HashMap.toEntries(model.entries),
        Array.filter(
          ([key, entry]) =>
            !HashMap.has(nextEntries, key) && AsyncData.isPending(entry.data),
        ),
        Array.map(([_key, entry]) =>
          interrupt(model, entry.args, CancelIntent.Forget()),
        ),
      )

      return { model: nextModel, commands }
    }

    return { model: nextModel }
  }
  const reset = (model: Model): PureUpdateReturn =>
    evictEntries(model, HashMap.empty())
  const read = (model: Model, args: Args): EntryData => store.read(model, args)

  const liftTransition = (
    transition: AsyncDataTransition,
  ): Update.Fold<Model, Message, Args, R> =>
    Function.dual(2, (model: Model, args: Args): UpdateReturn =>
      applyTransition(store, model, args, transition),
    )

  const revalidate = liftTransition(AsyncData.revalidate)
  const revalidateOrLoad = liftTransition(AsyncData.revalidateOrLoad)
  const loadIfMissing = liftTransition(AsyncData.loadIfMissing)

  const replace: Update.Fold<Model, Message, Args, R> = Function.dual(
    2,
    (model: Model, args: Args): UpdateReturn => {
      if (
        config.interrupt === true &&
        AsyncData.isPending(store.read(model, args))
      ) {
        const nextModel = modifyFields(model, {
          entries: HashMap.modify(argsToKey(args), entry =>
            modifyFields(entry, { args: () => args }),
          ),
        })

        return replaceEntry(store, nextModel, args)
      }

      return replaceEntry(store, model, args)
    },
  )
  const forget: Update.Fold<Model, Message, Args> = Function.dual(
    2,
    (model: Model, args: Args): PureUpdateReturn => {
      const forgottenKey = argsToKey(args)

      return evictEntries(model, HashMap.remove(model.entries, forgottenKey))
    },
  )
  const retainOnly: Update.Fold<
    Model,
    Message,
    ReadonlyArray<Args>
  > = Function.dual(
    2,
    (model: Model, args: ReadonlyArray<Args>): PureUpdateReturn => {
      const retainedKeys = HashSet.fromIterable(
        Array.map(args, args => argsToKey(args)),
      )

      return evictEntries(
        model,
        HashMap.filter(model.entries, (_entry, key) =>
          HashSet.has(retainedKeys, key),
        ),
      )
    },
  )

  const update = (model: Model, message: Message): UpdateReturn =>
    pipe(
      Match.value(message),
      Match.withReturnType<UpdateReturn>(),
      Match.tagsExhaustive({
        CompletedFetch(message) {
          const { args, generation, result } = message
          if (
            Predicate.hasProperty(message, 'instanceId') &&
            (!Predicate.hasProperty(model, 'instanceId') ||
              message.instanceId !== model.instanceId)
          ) {
            return { model }
          }

          const key = argsToKey(args)
          const maybeEntry = HashMap.get(model.entries, key)

          if (Option.isNone(maybeEntry)) {
            return { model }
          }

          const entry = maybeEntry.value

          if (
            !AsyncData.isPending(entry.data) ||
            generation !== entry.generation
          ) {
            return { model }
          }

          return {
            model: modifyFields(model, {
              entries: HashMap.set(
                key,
                modifyFields(entry, {
                  data: () => AsyncData.settle(entry.data, result),
                }),
              ),
            }),
          }
        },
        CompletedCancelFetch({ args, instanceId, generation, intent }) {
          if (
            !Predicate.hasProperty(model, 'instanceId') ||
            instanceId !== model.instanceId
          ) {
            return { model }
          }

          const maybeEntry = HashMap.get(model.entries, argsToKey(args))
          if (
            Option.isNone(maybeEntry) ||
            maybeEntry.value.generation !== generation
          ) {
            return { model }
          }

          return completeCancel(store, model, maybeEntry.value.args, intent)
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
    revalidate: liftChildFold(revalidate, lens),
    revalidateOrLoad: liftChildFold(revalidateOrLoad, lens),
    loadIfMissing: liftChildFold(loadIfMissing, lens),
    replace: liftChildFold(replace, lens),
    forget: liftChildFold(forget, lens),
    retainOnly: liftChildFold(retainOnly, lens),
  })

  function lift<ParentModel, ParentMessage>(
    config: ParentFieldConfig<ParentModel, ParentMessage, Model, Message>,
  ): ReturnType<LiftKeyedQuery<Model, Message, Args, R, R>>
  function lift<ParentModel, ParentMessage>(
    config: FoldLens<ParentModel, ParentMessage, Model, Message>,
  ): ReturnType<LiftKeyedQuery<Model, Message, Args, R, R>>
  function lift<ParentModel, ParentMessage>(
    config: LiftConfig<ParentModel, ParentMessage, Model, Message>,
  ) {
    if (isParentFieldConfig(config)) {
      return liftFromLens(parentFieldToLens(config))
    }

    return liftFromLens(config)
  }

  const run = (args: Args): Effect.Effect<EntryData, never, R> =>
    runExecute(config.execute(args))

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
    forget,
    retainOnly,
    lift,
    run,
  }
}
