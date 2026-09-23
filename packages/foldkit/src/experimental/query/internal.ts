import { Effect, Option, Predicate, Schema, pipe } from 'effect'

import * as AsyncData from '../../asyncData/index.js'
import * as Command from '../../command/index.js'
import { defineTaggedUnion } from '../../schema/index.js'
import * as Update from '../../update/index.js'

export type FoldLens<ParentModel, ParentMessage, ChildModel, ChildMessage> =
  Pick<
    Update.ChildFold<
      ParentModel,
      ParentMessage,
      ChildModel,
      never,
      ChildMessage
    >,
    'read' | 'write' | 'toParentMessage'
  >

export type ParentFieldOf<ParentModel, ChildModel> = Extract<
  {
    [K in keyof ParentModel]-?: ParentModel[K] extends ChildModel ? K : never
  }[keyof ParentModel],
  string
>

export type ParentFieldConfig<
  ParentModel,
  ParentMessage,
  ChildModel,
  ChildMessage,
> = Readonly<{
  parentField: ParentFieldOf<ParentModel, ChildModel>
  toParentMessage: (message: ChildMessage) => ParentMessage
}>

export type LiftConfig<ParentModel, ParentMessage, ChildModel, ChildMessage> =
  | ParentFieldConfig<ParentModel, ParentMessage, ChildModel, ChildMessage>
  | FoldLens<ParentModel, ParentMessage, ChildModel, ChildMessage>

export type LiftQuery<
  ChildModel,
  ChildMessage,
  FetchRequirements,
  UpdateRequirements = never,
> = {
  <ParentModel, ParentMessage>(
    config: ParentFieldConfig<
      ParentModel,
      ParentMessage,
      ChildModel,
      ChildMessage
    >,
  ): LiftedQuery<
    ParentModel,
    ParentMessage,
    ChildMessage,
    FetchRequirements,
    UpdateRequirements
  >
  <ParentModel, ParentMessage>(
    config: FoldLens<ParentModel, ParentMessage, ChildModel, ChildMessage>,
  ): LiftedQuery<
    ParentModel,
    ParentMessage,
    ChildMessage,
    FetchRequirements,
    UpdateRequirements
  >
}

export type LiftKeyedQuery<
  ChildModel,
  ChildMessage,
  Args,
  FetchRequirements,
  UpdateRequirements = never,
> = {
  <ParentModel, ParentMessage>(
    config: ParentFieldConfig<
      ParentModel,
      ParentMessage,
      ChildModel,
      ChildMessage
    >,
  ): LiftedKeyedQuery<
    ParentModel,
    ParentMessage,
    ChildMessage,
    Args,
    FetchRequirements,
    UpdateRequirements
  >
  <ParentModel, ParentMessage>(
    config: FoldLens<ParentModel, ParentMessage, ChildModel, ChildMessage>,
  ): LiftedKeyedQuery<
    ParentModel,
    ParentMessage,
    ChildMessage,
    Args,
    FetchRequirements,
    UpdateRequirements
  >
}

export const isParentFieldConfig = <
  ParentModel,
  ParentMessage,
  ChildModel,
  ChildMessage,
>(
  config: LiftConfig<ParentModel, ParentMessage, ChildModel, ChildMessage>,
): config is Extract<
  LiftConfig<ParentModel, ParentMessage, ChildModel, ChildMessage>,
  { readonly parentField: string }
> => Predicate.hasProperty(config, 'parentField')

const setField = <
  Field extends string,
  Value,
  Struct extends Record<Field, Value>,
>(
  model: Struct,
  field: Field,
  value: Value,
): Struct => ({ ...model, [field]: value })

export const parentFieldToLens = <
  ParentModel extends Record<
    ParentFieldOf<ParentModel, ChildModel>,
    ChildModel
  >,
  ParentMessage,
  ChildModel,
  ChildMessage,
>(
  config: ParentFieldConfig<
    ParentModel,
    ParentMessage,
    ChildModel,
    ChildMessage
  >,
): FoldLens<ParentModel, ParentMessage, ChildModel, ChildMessage> => ({
  read: (model: ParentModel) => Option.some(model[config.parentField]),
  write: (model: ParentModel, nextChild: ChildModel) =>
    setField(model, config.parentField, nextChild),
  toParentMessage: config.toParentMessage,
})

export const liftChildFold = <
  ParentModel,
  ParentMessage,
  ChildModel,
  ChildMessage,
  Input,
  R,
>(
  childFold: Update.Fold<ChildModel, ChildMessage, Input, R>,
  lens: FoldLens<ParentModel, ParentMessage, ChildModel, ChildMessage>,
): Update.Fold<ParentModel, ParentMessage, Input, R> =>
  Update.foldChild({
    update: (childModel: ChildModel, input: Input) =>
      childFold(childModel, input),
    ...lens,
  })

export type AsyncDataTransition = <A, E>(
  data: AsyncData.AsyncData<A, E>,
) => Option.Option<AsyncData.AsyncData<A, E>>

export type QueryStore<Model, Args, A, E, Message, R> = Readonly<{
  read: (model: Model, args: Args) => AsyncData.AsyncData<A, E>
  start: (
    model: Model,
    args: Args,
    data: AsyncData.AsyncData<A, E>,
  ) => Readonly<{ model: Model; generation: number }>
  fetch: (
    model: Model,
    args: Args,
    generation: number,
  ) => Command.Command<Message, never, R>
  interrupt?:
    | ((
        model: Model,
        args: Args,
        intent: CancelIntent,
      ) => Command.Command<Message>)
    | undefined
}>

export const applyTransition = <Model, Args, A, E, Message, R>(
  store: QueryStore<Model, Args, A, E, Message, R>,
  model: Model,
  args: Args,
  transition: AsyncDataTransition,
): Update.Return<Model, Message, R> =>
  Option.match(transition(store.read(model, args)), {
    onNone: () => ({ model }),
    onSome: nextData => {
      const queryStart = store.start(model, args, nextData)

      return {
        model: queryStart.model,
        commands: [store.fetch(queryStart.model, args, queryStart.generation)],
      }
    },
  })

/** Reason carried by a completed Query Fetch cancellation. */
export const CancelIntent = defineTaggedUnion({
  Replace: {},
  Forget: {},
})

/** Reason carried by a completed Query Fetch cancellation. */
export type CancelIntent = typeof CancelIntent.Type

const replacementTransition: AsyncDataTransition = data =>
  AsyncData.isPending(data)
    ? Option.some(data)
    : AsyncData.revalidateOrLoad(data)

export const replaceEntry = <Model, Args, A, E, Message, R>(
  store: QueryStore<Model, Args, A, E, Message, R>,
  model: Model,
  args: Args,
): Update.Return<Model, Message, R> => {
  if (
    AsyncData.isPending(store.read(model, args)) &&
    store.interrupt !== undefined
  ) {
    return {
      model,
      commands: [store.interrupt(model, args, CancelIntent.Replace())],
    }
  }

  return applyTransition(store, model, args, replacementTransition)
}

export const completeCancel = <Model, Args, A, E, Message, R>(
  store: QueryStore<Model, Args, A, E, Message, R>,
  model: Model,
  args: Args,
  intent: CancelIntent,
): Update.Return<Model, Message, R> =>
  CancelIntent.match<Update.Return<Model, Message, R>>(intent, {
    Replace: () => applyTransition(store, model, args, replacementTransition),
    Forget: () => ({ model }),
  })

const encodeFetchIdentity = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.Number])),
)

export const encodeInterruptKey = (
  instanceId: string,
  generation: number,
): string => encodeFetchIdentity([instanceId, generation])

export const runExecute = <A, E, R>(
  execute: Effect.Effect<A, E, R>,
): Effect.Effect<AsyncData.AsyncData<A, E>, never, R> =>
  pipe(
    execute,
    Effect.result,
    Effect.map(result => AsyncData.settle(AsyncData.Loading(), result)),
  )

export type CompletedFetchOf<Message extends Schema.Top> = Extract<
  Message['Type'],
  { readonly _tag: 'CompletedFetch' }
>

export type KeyedArgs<Fields extends Schema.Struct.Fields> = Schema.Schema.Type<
  Schema.Struct<Fields>
>

type LiftedQuery<
  ParentModel,
  ParentMessage,
  ChildMessage,
  FetchRequirements,
  UpdateRequirements,
> = Readonly<{
  fold: Update.Fold<
    ParentModel,
    ParentMessage,
    ChildMessage,
    UpdateRequirements
  >
  reset: Update.Step<ParentModel, ParentMessage>
  revalidate: Update.Step<ParentModel, ParentMessage, FetchRequirements>
  revalidateOrLoad: Update.Step<ParentModel, ParentMessage, FetchRequirements>
  loadIfMissing: Update.Step<ParentModel, ParentMessage, FetchRequirements>
  replace: Update.Step<ParentModel, ParentMessage, FetchRequirements>
}>

type LiftedKeyedQuery<
  ParentModel,
  ParentMessage,
  ChildMessage,
  Args,
  FetchRequirements,
  UpdateRequirements,
> = Readonly<{
  fold: Update.Fold<
    ParentModel,
    ParentMessage,
    ChildMessage,
    UpdateRequirements
  >
  reset: Update.Step<ParentModel, ParentMessage>
  revalidate: Update.Fold<ParentModel, ParentMessage, Args, FetchRequirements>
  revalidateOrLoad: Update.Fold<
    ParentModel,
    ParentMessage,
    Args,
    FetchRequirements
  >
  loadIfMissing: Update.Fold<
    ParentModel,
    ParentMessage,
    Args,
    FetchRequirements
  >
  replace: Update.Fold<ParentModel, ParentMessage, Args, FetchRequirements>
  forget: Update.Fold<ParentModel, ParentMessage, Args>
  retainOnly: Update.Fold<ParentModel, ParentMessage, ReadonlyArray<Args>>
}>
