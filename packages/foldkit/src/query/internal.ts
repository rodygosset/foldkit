import { Effect, Match, Option, Predicate, Schema, pipe } from 'effect'

import * as AsyncData from '../asyncData/index.js'
import * as Command from '../command/index.js'
import * as Interruptible from '../command/interruptible/index.js'
import { defineMessageUnion } from '../message/index.js'
import { defineTaggedUnion } from '../schema/index.js'
import * as Subscription from '../subscription/subscription.js'
import * as Update from '../update/index.js'

export type Policy = 'loadIfMissing' | 'revalidate' | 'revalidateOrLoad'

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

export type FieldOf<ParentModel, ChildModel> = Extract<
  {
    [K in keyof ParentModel]-?: ParentModel[K] extends ChildModel ? K : never
  }[keyof ParentModel],
  string
>

export type ParentKeyFoldConfig<
  ParentModel,
  ParentMessage,
  ChildModel,
  ChildMessage,
> = Readonly<{
  field: FieldOf<ParentModel, ChildModel>
  toParentMessage: (message: ChildMessage) => ParentMessage
}>

export type LiftConfig<ParentModel, ParentMessage, ChildModel, ChildMessage> =
  | ParentKeyFoldConfig<ParentModel, ParentMessage, ChildModel, ChildMessage>
  | FoldLens<ParentModel, ParentMessage, ChildModel, ChildMessage>

export type LiftQuery<ChildModel, ChildMessage, R> = {
  <ParentModel, ParentMessage>(
    config: ParentKeyFoldConfig<
      ParentModel,
      ParentMessage,
      ChildModel,
      ChildMessage
    >,
  ): Lifted.Query<ParentModel, ParentMessage, ChildMessage, R>
  <ParentModel, ParentMessage>(
    config: FoldLens<ParentModel, ParentMessage, ChildModel, ChildMessage>,
  ): Lifted.Query<ParentModel, ParentMessage, ChildMessage, R>
}

export type LiftKeyedQuery<ChildModel, ChildMessage, Args, R> = {
  <ParentModel, ParentMessage>(
    config: ParentKeyFoldConfig<
      ParentModel,
      ParentMessage,
      ChildModel,
      ChildMessage
    >,
  ): Lifted.KeyedQuery<ParentModel, ParentMessage, ChildMessage, Args, R>
  <ParentModel, ParentMessage>(
    config: FoldLens<ParentModel, ParentMessage, ChildModel, ChildMessage>,
  ): Lifted.KeyedQuery<ParentModel, ParentMessage, ChildMessage, Args, R>
}

export const isParentKeyFoldConfig = <
  ParentModel,
  ParentMessage,
  ChildModel,
  ChildMessage,
>(
  config: LiftConfig<ParentModel, ParentMessage, ChildModel, ChildMessage>,
): config is Extract<
  LiftConfig<ParentModel, ParentMessage, ChildModel, ChildMessage>,
  { readonly field: string }
> => Predicate.hasProperty(config, 'field')

function setField<O extends Record<K, V>, K extends string, V>(
  model: O,
  key: K,
  value: V,
): O {
  return { ...model, [key]: value }
}

export function parentKeyToLens<
  ParentModel extends Record<FieldOf<ParentModel, ChildModel>, ChildModel>,
  ParentMessage,
  ChildModel,
  ChildMessage,
>(
  config: ParentKeyFoldConfig<
    ParentModel,
    ParentMessage,
    ChildModel,
    ChildMessage
  >,
): FoldLens<ParentModel, ParentMessage, ChildModel, ChildMessage> {
  return {
    read: function (model: ParentModel) {
      return Option.some(model[config.field])
    },
    write: function (model: ParentModel, nextChild: ChildModel) {
      return setField(model, config.field, nextChild)
    },
    toParentMessage: config.toParentMessage,
  }
}

// NOTE: Nested Command.Interruptible.Outcome in defineMessageUnion collapses
// through tsup to `node_modules/foldkit/dist/schema` (and sometimes
// `outcome?: any`). Tags match Outcome.
export const FetchInterruptOutcome = defineMessageUnion({
  Interrupted: {},
  NotFound: {},
})

/** The reason an interruptible Fetch was cancelled. `CompletedCancelFetch` carries it.
 * For `Replace`, update starts the next fetch when this `requestId` is still pending.
 * For `Forget`, update leaves the slot dropped. */
export const CancelIntent = defineTaggedUnion({
  Replace: {},
  Forget: {},
})

/** The reason an interruptible Fetch was cancelled. `CompletedCancelFetch` carries it.
 * For `Replace`, update starts the next fetch when this `requestId` is still pending.
 * For `Forget`, update leaves the slot dropped. */
export type CancelIntent = typeof CancelIntent.Type

export const foldChildFromInform = <
  ParentModel,
  ParentMessage,
  ChildModel,
  ChildMessage,
  Input,
  R,
>(
  inform: Update.Fold<ChildModel, ChildMessage, Input, R>,
  lens: FoldLens<ParentModel, ParentMessage, ChildModel, ChildMessage>,
): Update.Fold<ParentModel, ParentMessage, Input, R> =>
  Update.foldChild({
    update: (childModel: ChildModel, input: Input) => inform(childModel, input),
    ...lens,
  })

type Transition = <A, E>(
  data: AsyncData.AsyncData<A, E>,
) => Option.Option<AsyncData.AsyncData<A, E>>

const transitionFor = (policy: Policy): Transition =>
  Match.value(policy).pipe(
    Match.when('loadIfMissing', () => AsyncData.loadIfMissing),
    Match.when('revalidate', () => AsyncData.revalidate),
    Match.when('revalidateOrLoad', () => AsyncData.revalidateOrLoad),
    Match.exhaustive,
  )

export const allocateRequestId = (
  nextRequestId: number,
): Readonly<{
  requestId: number
  nextRequestId: number
}> => ({
  requestId: nextRequestId,
  nextRequestId: nextRequestId + 1,
})

export const sameRequest = (
  maybePendingRequestId: Option.Option<number>,
  requestId: number,
): boolean =>
  Option.match(maybePendingRequestId, {
    onNone: () => false,
    onSome: pendingRequestId => pendingRequestId === requestId,
  })

export type CacheStore<Model, Args, A, E, Message, R> = Readonly<{
  read: (model: Model, args: Args) => AsyncData.AsyncData<A, E>
  begin: (
    model: Model,
    args: Args,
    data: AsyncData.AsyncData<A, E>,
  ) => Readonly<{ model: Model; requestId: number }>
  isCurrent: (model: Model, args: Args, requestId: number) => boolean
  load: (
    args: Args,
    requestId: number,
    model: Model,
  ) => Command.Command<Message, never, R>
  interrupt?: (
    model: Model,
    args: Args,
    intent: CancelIntent,
  ) => Command.Command<Message, never, R>
}>

export type InterruptibleCacheStore<Model, Args, A, E, Message, R> = CacheStore<
  Model,
  Args,
  A,
  E,
  Message,
  R
> & {
  interrupt: (
    model: Model,
    args: Args,
    intent: CancelIntent,
  ) => Command.Command<Message, never, R>
}

export const applyPolicy = <Model, Args, A, E, Message, R>(
  store: CacheStore<Model, Args, A, E, Message, R>,
  model: Model,
  args: Args,
  policy: Policy,
): Update.Return<Model, Message, R> =>
  Option.match(transitionFor(policy)(store.read(model, args)), {
    onNone: () => ({ model }),
    onSome(nextData) {
      const begun = store.begin(model, args, nextData)
      return {
        model: begun.model,
        commands: [store.load(args, begun.requestId, begun.model)],
      }
    },
  })

export function replaceSlot<Model, Args, A, E, Message, R>(
  store: CacheStore<Model, Args, A, E, Message, R>,
  model: Model,
  args: Args,
): Update.Return<Model, Message, R> {
  if (!AsyncData.isPending(store.read(model, args)))
    return applyPolicy(store, model, args, 'revalidateOrLoad')

  if (store.interrupt !== undefined)
    return {
      model,
      commands: [store.interrupt(model, args, CancelIntent.Replace())],
    }

  const begun = store.begin(model, args, store.read(model, args))
  return {
    model: begun.model,
    commands: [store.load(args, begun.requestId, begun.model)],
  }
}

export const completeCancel = <Model, Args, A, E, Message, R>(
  store: CacheStore<Model, Args, A, E, Message, R>,
  model: Model,
  args: Args,
  outcome: Interruptible.Outcome,
  intent: CancelIntent,
): Update.Return<Model, Message, R> =>
  Interruptible.Outcome.match<Update.Return<Model, Message, R>>(outcome, {
    Interrupted: () =>
      CancelIntent.match<Update.Return<Model, Message, R>>(intent, {
        Replace() {
          const begun = store.begin(model, args, store.read(model, args))
          return {
            model: begun.model,
            commands: [store.load(args, begun.requestId, begun.model)],
          }
        },
        Forget: () => ({ model }),
      }),
    NotFound: () => ({ model }),
  })

export const runExecute = <A, E, R>(
  execute: Effect.Effect<A, E, R>,
): Effect.Effect<AsyncData.AsyncData<A, E>, never, R> =>
  pipe(
    execute,
    Effect.result,
    Effect.map(result => AsyncData.settle(AsyncData.Loading(), result)),
  )

export type SettledFetchOf<Message extends Schema.Top> = Extract<
  Message['Type'],
  { readonly _tag: 'SettledFetch' }
>

export type KeyedArgs<Fields extends Schema.Struct.Fields> = Schema.Schema.Type<
  Schema.Struct<Fields>
>

export namespace Lifted {
  export type Query<
    ParentModel,
    ParentMessage,
    ChildMessage,
    R = never,
  > = Readonly<{
    fold: Update.Fold<ParentModel, ParentMessage, ChildMessage, R>
    revalidate: Update.Step<ParentModel, ParentMessage, R>
    revalidateOrLoad: Update.Step<ParentModel, ParentMessage, R>
    loadIfMissing: Update.Step<ParentModel, ParentMessage, R>
    replace: Update.Step<ParentModel, ParentMessage, R>
    watch: Update.Step<ParentModel, ParentMessage, R>
    forget: Update.Step<ParentModel, ParentMessage, R>
    watchSubscription: (
      entry: Subscription.EntryBuilder<ParentModel, ParentMessage, R>,
      modelToIsWatching: (model: ParentModel) => boolean,
    ) => Subscription.EntryWithoutKeepAlive<
      ParentModel,
      ParentMessage,
      { readonly isWatching: boolean },
      R
    >
  }>

  export type KeyedQuery<
    ParentModel,
    ParentMessage,
    ChildMessage,
    Args,
    R = never,
  > = Readonly<{
    fold: Update.Fold<ParentModel, ParentMessage, ChildMessage, R>
    revalidate: Update.Fold<ParentModel, ParentMessage, Args, R>
    revalidateOrLoad: Update.Fold<ParentModel, ParentMessage, Args, R>
    loadIfMissing: Update.Fold<ParentModel, ParentMessage, Args, R>
    replace: Update.Fold<ParentModel, ParentMessage, Args, R>
    watch: Update.Fold<ParentModel, ParentMessage, ReadonlyArray<Args>, R>
    forget: Update.Fold<ParentModel, ParentMessage, Args, R>
    watchSubscription: (
      entry: Subscription.EntryBuilder<ParentModel, ParentMessage, R>,
      modelToArgs: (model: ParentModel) => ReadonlyArray<Args>,
    ) => Subscription.EntryWithoutKeepAlive<
      ParentModel,
      ParentMessage,
      { readonly args: ReadonlyArray<Args> },
      R
    >
  }>
}
