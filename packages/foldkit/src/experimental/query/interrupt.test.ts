import {
  Array,
  Context,
  Effect,
  Fiber,
  HashMap,
  Option,
  Result,
  Schema,
  pipe,
} from 'effect'
import { expect, expectTypeOf } from 'vitest'

import { describe, it } from '@effect/vitest'

import * as AsyncData from '../../asyncData/index.js'
import * as Interruptible from '../../command/interruptible/index.js'
import { defineMessageUnion } from '../../message/index.js'
import * as Update from '../../update/index.js'
import * as Query from './index.js'
import { CancelIntent } from './internal.js'

const notes = Query.define({
  name: 'InterruptNotes',
  data: Schema.String,
  error: Schema.String,
  execute: Effect.succeed('notes'),
  interrupt: true,
})
const noteById = Query.define({
  name: 'InterruptNoteById',
  args: { noteId: Schema.String, preview: Schema.Boolean },
  toKey: ({ noteId }) => noteId,
  data: Schema.String,
  error: Schema.String,
  execute: ({ noteId }) => Effect.succeed(noteId),
  interrupt: true,
})
const firstArgs = { noteId: '1', preview: true }
const secondArgs = { noteId: '2', preview: false }

const completeCancel = (
  generation: number,
  outcome: Interruptible.Outcome = Interruptible.Outcome.Interrupted(),
) =>
  notes.Message.CompletedCancelFetch({
    instanceId: 'home',
    generation,
    outcome,
    intent: CancelIntent.Replace(),
  })
const completeFetch = (generation: number, data: string) =>
  notes.Message.CompletedFetch({
    instanceId: 'home',
    generation,
    result: Result.succeed(data),
  })
const completeKeyedCancel = (
  args: typeof firstArgs,
  generation: number,
  outcome: Interruptible.Outcome = Interruptible.Outcome.Interrupted(),
) =>
  noteById.Message.CompletedCancelFetch({
    args,
    instanceId: 'home',
    generation,
    outcome,
    intent: CancelIntent.Replace(),
  })
const commandKeys = <Message>(
  commands: Update.Return<unknown, Message>['commands'],
) => Array.map(commands ?? [], command => command.key)
const interruptedKeys = <Message>(
  commands: Update.Return<unknown, Message>['commands'],
) =>
  Array.map(commands ?? [], command =>
    'interruptsKey' in command ? command.interruptsKey : undefined,
  )
const firstCommand = <Message, Requirements>(
  commands: Update.Return<unknown, Message, Requirements>['commands'],
) => Option.getOrThrow(Array.head(commands ?? []))

describe('interruptible Query Fetch', () => {
  it('scopes Fetch keys to the Model instance and generation', () => {
    const home = notes.loadIfMissing(notes.init('home'))
    const sidebar = notes.loadIfMissing(notes.init('sidebar'))
    const reloaded = notes.loadIfMissing(notes.reset(home.model).model)

    expect(commandKeys(home.commands)).not.toEqual(
      commandKeys(sidebar.commands),
    )
    expect(commandKeys(home.commands)).not.toEqual(
      commandKeys(reloaded.commands),
    )
    expect(interruptedKeys(notes.reset(home.model).commands)).toEqual(
      commandKeys(home.commands),
    )
  })

  it.each([
    Interruptible.Outcome.Interrupted(),
    Interruptible.Outcome.NotFound(),
  ])('replaces pending work after cancellation reports $._tag', outcome => {
    const started = notes.loadIfMissing(notes.init('home'))
    const replacing = notes.replace(started.model)
    const cancelled = notes.update(
      replacing.model,
      completeCancel(started.model.generation, outcome),
    )
    const stale = notes.update(
      cancelled.model,
      completeFetch(started.model.generation, 'old'),
    )

    expect(replacing.model).toBe(started.model)
    expect(interruptedKeys(replacing.commands)).toEqual(
      commandKeys(started.commands),
    )
    expect(cancelled.model.generation).toBe(started.model.generation + 1)
    expect(firstCommand(cancelled.commands).name).toBe('FetchInterruptNotes')
    expect(stale.model).toBe(cancelled.model)
    expect(notes.read(cancelled.model)).toEqual(AsyncData.Loading())
  })

  it('keeps data visible while cancelling a refresh and fetching its replacement', () => {
    const loaded = notes.loadIfMissing(notes.init('home'))
    const settled = notes.update(
      loaded.model,
      completeFetch(loaded.model.generation, 'retained'),
    )
    const refreshing = notes.revalidate(settled.model)
    const replacing = notes.replace(refreshing.model)
    const cancelled = notes.update(
      replacing.model,
      completeCancel(refreshing.model.generation),
    )

    expect(notes.read(replacing.model)).toEqual(
      AsyncData.Refreshing({ data: 'retained' }),
    )
    expect(notes.read(cancelled.model)).toEqual(
      AsyncData.Refreshing({ data: 'retained' }),
    )
  })

  it('starts the replacement when Fetch settles before cancellation completes', () => {
    const started = notes.loadIfMissing(notes.init('home'))
    const replacing = notes.replace(started.model)
    const settled = notes.update(
      replacing.model,
      completeFetch(started.model.generation, 'completed'),
    )
    const cancelled = notes.update(
      settled.model,
      completeCancel(
        started.model.generation,
        Interruptible.Outcome.NotFound(),
      ),
    )

    expect(notes.read(cancelled.model)).toEqual(
      AsyncData.Refreshing({ data: 'completed' }),
    )
    expect(cancelled.commands).toHaveLength(1)
  })

  it('does not restart a replacement after reset and ignores duplicate cancellation', () => {
    const started = notes.loadIfMissing(notes.init('home'))
    const replacing = notes.replace(started.model)
    const reset = notes.reset(replacing.model)
    const stale = notes.update(
      reset.model,
      completeCancel(started.model.generation),
    )
    const cancelled = notes.update(
      replacing.model,
      completeCancel(started.model.generation),
    )
    const duplicate = notes.update(
      cancelled.model,
      completeCancel(started.model.generation),
    )

    expect(stale.model).toBe(reset.model)
    expect(stale.commands).toBeUndefined()
    expect(duplicate.model).toBe(cancelled.model)
    expect(duplicate.commands).toBeUndefined()
  })

  it('ignores a completion from another Model instance', () => {
    const current = notes.loadIfMissing(notes.init('current'))
    const stale = notes.update(
      current.model,
      completeFetch(current.model.generation, 'previous'),
    )
    const cancelled = notes.update(
      current.model,
      completeCancel(current.model.generation),
    )

    expect(stale.model).toBe(current.model)
    expect(cancelled.model).toBe(current.model)
  })

  it.effect('interrupts the running Fetch when reset clears the Query', () =>
    Effect.gen(function* () {
      const registry = Interruptible.__makeRegistry()
      const pending = Query.define({
        name: 'PendingNotes',
        data: Schema.String,
        error: Schema.String,
        execute: Effect.never,
        interrupt: true,
      })
      const started = pending.loadIfMissing(pending.init('home'))
      const fetch = firstCommand(started.commands)
      const fiber = yield* Effect.forkChild(
        Effect.provideService(
          fetch.effect,
          Interruptible.__CurrentRegistry,
          registry,
        ),
      )
      yield* Effect.yieldNow
      const reset = pending.reset(started.model)
      const message = yield* Effect.provideService(
        firstCommand(reset.commands).effect,
        Interruptible.__CurrentRegistry,
        registry,
      )
      const exit = yield* Fiber.await(fiber)

      expect(exit._tag).toBe('Failure')
      expect(message).toEqual(
        pending.Message.CompletedCancelFetch({
          instanceId: 'home',
          generation: started.model.generation,
          outcome: Interruptible.Outcome.Interrupted(),
          intent: CancelIntent.Forget(),
        }),
      )
      expect(pending.update(reset.model, message).model).toBe(reset.model)
    }),
  )
})

describe('interruptible KeyedQuery Fetch', () => {
  it('cancels an evicted key without touching retained entries', () => {
    const first = noteById.loadIfMissing(noteById.init('home'), firstArgs)
    const second = noteById.loadIfMissing(first.model, secondArgs)
    const retained = noteById.retainOnly(second.model, [secondArgs])
    const forgotten = noteById.forget(second.model, firstArgs)

    expect(interruptedKeys(retained.commands)).toEqual(
      commandKeys(first.commands),
    )
    expect(interruptedKeys(forgotten.commands)).toEqual(
      commandKeys(first.commands),
    )
    expect(noteById.read(retained.model, firstArgs)).toEqual(AsyncData.Idle())
    expect(noteById.read(retained.model, secondArgs)).toEqual(
      AsyncData.Loading(),
    )
    expect(retained.model.generation).toBe(second.model.generation)
    expect(
      noteById.retainOnly(retained.model, [secondArgs]).commands,
    ).toHaveLength(0)
  })

  it('reset cancels every pending entry', () => {
    const first = noteById.loadIfMissing(noteById.init('home'), firstArgs)
    const second = noteById.loadIfMissing(first.model, secondArgs)
    const reset = noteById.reset(second.model)

    expect(interruptedKeys(reset.commands)).toEqual(
      expect.arrayContaining([
        ...commandKeys(first.commands),
        ...commandKeys(second.commands),
      ]),
    )
    expect(reset.commands).toHaveLength(2)
    expect(HashMap.size(reset.model.entries)).toBe(0)
    expect(reset.model.generation).toBe(second.model.generation)
  })

  it('evicts a settled entry without returning an Interrupt Command', () => {
    const first = noteById.loadIfMissing(noteById.init('home'), firstArgs)
    const settled = noteById.update(
      first.model,
      noteById.Message.CompletedFetch({
        args: firstArgs,
        instanceId: 'home',
        generation: first.model.generation,
        result: Result.succeed('settled'),
      }),
    )

    expect(noteById.forget(settled.model, firstArgs).commands).toHaveLength(0)
  })

  it.each([
    Interruptible.Outcome.Interrupted(),
    Interruptible.Outcome.NotFound(),
  ])('replaces a keyed Fetch with new arguments after $._tag', outcome => {
    const first = noteById.loadIfMissing(noteById.init('home'), firstArgs)
    const second = noteById.loadIfMissing(first.model, secondArgs)
    const replacementArgs = { noteId: '1', preview: false }
    const replacing = noteById.replace(second.model, replacementArgs)
    const cancelled = noteById.update(
      replacing.model,
      completeKeyedCancel(replacementArgs, first.model.generation, outcome),
    )

    expect(interruptedKeys(replacing.commands)).toEqual(
      commandKeys(first.commands),
    )
    expect(cancelled.model.generation).toBe(second.model.generation + 1)
    expect(firstCommand(cancelled.commands).args).toEqual({
      args: replacementArgs,
      instanceId: 'home',
      generation: cancelled.model.generation,
    })
    expect(HashMap.get(cancelled.model.entries, '2')).toEqual(
      HashMap.get(second.model.entries, '2'),
    )
  })

  it.each([
    { isFirstCompletionFirst: true, isFetchSettled: false },
    { isFirstCompletionFirst: false, isFetchSettled: false },
    { isFirstCompletionFirst: true, isFetchSettled: true },
    { isFirstCompletionFirst: false, isFetchSettled: true },
  ])(
    'uses the latest replacement arguments regardless of completion order: %o',
    ({ isFirstCompletionFirst, isFetchSettled }) => {
      const started = noteById.loadIfMissing(noteById.init('home'), firstArgs)
      const earlierArgs = { noteId: '1', preview: false }
      const latestArgs = { noteId: '1', preview: true }
      const earlier = noteById.replace(started.model, earlierArgs)
      const latest = noteById.replace(earlier.model, latestArgs)
      const beforeCancellation = isFetchSettled
        ? noteById.update(
            latest.model,
            noteById.Message.CompletedFetch({
              args: firstArgs,
              instanceId: 'home',
              generation: started.model.generation,
              result: Result.succeed('original'),
            }),
          )
        : latest
      const earlierCompletion = completeKeyedCancel(
        earlierArgs,
        started.model.generation,
      )
      const latestCompletion = completeKeyedCancel(
        latestArgs,
        started.model.generation,
      )
      const firstCancellation = noteById.update(
        beforeCancellation.model,
        isFirstCompletionFirst ? earlierCompletion : latestCompletion,
      )
      const secondCancellation = noteById.update(
        firstCancellation.model,
        isFirstCompletionFirst ? latestCompletion : earlierCompletion,
      )

      expect(interruptedKeys(earlier.commands)).toEqual(
        commandKeys(started.commands),
      )
      expect(interruptedKeys(latest.commands)).toEqual(
        commandKeys(started.commands),
      )
      expect(firstCommand(firstCancellation.commands).args).toEqual({
        args: latestArgs,
        instanceId: 'home',
        generation: started.model.generation + 1,
      })
      expect(secondCancellation.model).toBe(firstCancellation.model)
      expect(secondCancellation.commands).toBeUndefined()
    },
  )

  it('ignores cancellation after eviction or another generation starts', () => {
    const started = noteById.loadIfMissing(noteById.init('home'), firstArgs)
    const forgotten = noteById.forget(started.model, firstArgs)
    const reloaded = noteById.loadIfMissing(forgotten.model, firstArgs)
    const completion = completeKeyedCancel(firstArgs, started.model.generation)

    expect(noteById.update(forgotten.model, completion).model).toBe(
      forgotten.model,
    )
    expect(noteById.update(reloaded.model, completion).model).toBe(
      reloaded.model,
    )
  })

  it.effect(
    'a delayed eviction cannot interrupt a new Fetch for the same key',
    () =>
      Effect.gen(function* () {
        const registry = Interruptible.__makeRegistry()
        const pending = Query.define({
          name: 'PendingNote',
          args: { noteId: Schema.String },
          data: Schema.String,
          error: Schema.String,
          execute: () => Effect.never,
          interrupt: true,
        })
        const first = pending.loadIfMissing(pending.init('home'), {
          noteId: '1',
        })
        const forgotten = pending.forget(first.model, { noteId: '1' })
        const reloaded = pending.loadIfMissing(forgotten.model, { noteId: '1' })
        const fetch = firstCommand(reloaded.commands)
        const fiber = yield* Effect.forkChild(
          Effect.provideService(
            fetch.effect,
            Interruptible.__CurrentRegistry,
            registry,
          ),
        )
        yield* Effect.yieldNow
        const completion = yield* Effect.provideService(
          firstCommand(forgotten.commands).effect,
          Interruptible.__CurrentRegistry,
          registry,
        )

        expect(completion).toEqual(
          pending.Message.CompletedCancelFetch({
            args: { noteId: '1' },
            instanceId: 'home',
            generation: first.model.generation,
            outcome: Interruptible.Outcome.NotFound(),
            intent: CancelIntent.Forget(),
          }),
        )
        const maybeKey = Option.fromNullishOr(fetch.key)
        expect(registry.lookup(Option.getOrThrow(maybeKey))).toHaveLength(1)
        expect(pending.update(reloaded.model, completion).model).toBe(
          reloaded.model,
        )
        yield* Fiber.interrupt(fiber)
      }),
  )
})

describe('interruptible Query types', () => {
  class NoteService extends Context.Service<
    NoteService,
    Readonly<{ data: string }>
  >()('QueryInterruptTest/NoteService') {}
  const served = Query.define({
    name: 'ServedInterruptNote',
    data: Schema.String,
    error: Schema.String,
    execute: pipe(
      NoteService,
      Effect.map(service => service.data),
    ),
    interrupt: true,
  })
  type ServedModel = typeof served.Model.Type
  type ServedMessage = typeof served.Message.Type

  it('requires execute services only in operations that can start a Fetch', () => {
    expectTypeOf(served.init).parameter(0).toEqualTypeOf<string>()
    expectTypeOf(served.update).returns.toEqualTypeOf<
      Update.Return<ServedModel, ServedMessage, NoteService>
    >()
    expectTypeOf(served.reset).returns.toEqualTypeOf<
      Update.Return<ServedModel, ServedMessage>
    >()
    const ParentModel = Schema.Struct({ notes: served.Model })
    type ParentModel = typeof ParentModel.Type
    const ParentMessage = defineMessageUnion({
      GotNotesMessage: { message: served.Message },
    })
    type ParentMessage = typeof ParentMessage.Type
    const lifted = served.lift<ParentModel, ParentMessage>({
      parentField: 'notes',
      toParentMessage: message => ParentMessage.GotNotesMessage({ message }),
    })

    expectTypeOf(lifted.fold).toEqualTypeOf<
      Update.Fold<ParentModel, ParentMessage, ServedMessage, NoteService>
    >()
    expectTypeOf(lifted.reset).toEqualTypeOf<
      Update.Step<ParentModel, ParentMessage>
    >()
  })

  it('keeps keyed eviction free of execute services while lifted cancellation can fetch', () => {
    const servedById = Query.define({
      name: 'ServedInterruptNoteById',
      args: { noteId: Schema.String },
      data: Schema.String,
      error: Schema.String,
      execute: () =>
        pipe(
          NoteService,
          Effect.map(service => service.data),
        ),
      interrupt: true,
    })
    type ServedModel = typeof servedById.Model.Type
    type ServedMessage = typeof servedById.Message.Type
    const ParentModel = Schema.Struct({ notes: servedById.Model })
    type ParentModel = typeof ParentModel.Type
    const ParentMessage = defineMessageUnion({
      GotNotesMessage: { message: servedById.Message },
    })
    type ParentMessage = typeof ParentMessage.Type
    const lifted = servedById.lift<ParentModel, ParentMessage>({
      parentField: 'notes',
      toParentMessage: message => ParentMessage.GotNotesMessage({ message }),
    })

    expectTypeOf(servedById.update).returns.toEqualTypeOf<
      Update.Return<ServedModel, ServedMessage, NoteService>
    >()
    expectTypeOf(lifted.fold).toEqualTypeOf<
      Update.Fold<ParentModel, ParentMessage, ServedMessage, NoteService>
    >()
    expectTypeOf(lifted.forget).toEqualTypeOf<
      Update.Fold<ParentModel, ParentMessage, Readonly<{ noteId: string }>>
    >()
    expectTypeOf(lifted.retainOnly).toEqualTypeOf<
      Update.Fold<
        ParentModel,
        ParentMessage,
        ReadonlyArray<Readonly<{ noteId: string }>>
      >
    >()

    const started = lifted.loadIfMissing(
      ParentModel.make({ notes: servedById.init('home') }),
      { noteId: '1' },
    )
    const replacing = lifted.replace(started.model, { noteId: '1' })
    const cancelled = lifted.fold(
      replacing.model,
      servedById.Message.CompletedCancelFetch({
        args: { noteId: '1' },
        instanceId: 'home',
        generation: started.model.notes.generation,
        outcome: Interruptible.Outcome.Interrupted(),
        intent: CancelIntent.Replace(),
      }),
    )

    expect(cancelled.model.notes.generation).toBe(
      started.model.notes.generation + 1,
    )
    expect(cancelled.commands).toHaveLength(1)
    expect(firstCommand(cancelled.commands).name).toBe(
      'FetchServedInterruptNoteById',
    )
  })
})
