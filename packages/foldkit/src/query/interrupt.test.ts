import { Effect, Option, Result, Schema } from 'effect'
import { expect } from 'vitest'

import { describe, it } from '@effect/vitest'

import * as AsyncData from '../asyncData/index.js'
import * as Query from './index.js'

const notes = Query.define({
  name: 'InterruptNotes',
  data: Schema.String,
  error: Schema.String,
  execute: Effect.succeed('notes'),
  interrupt: true,
})

const noteById = Query.define({
  name: 'InterruptNoteById',
  args: { noteId: Schema.String },
  data: Schema.String,
  error: Schema.String,
  execute: ({ noteId }) => Effect.succeed(noteId),
  interrupt: true,
})

describe('interruptible Query Fetch', () => {
  it('keys a single-slot Fetch by Model instance', () => {
    const home = notes.loadIfMissing(notes.init('home'))
    const sidebar = notes.loadIfMissing(notes.init('sidebar'))

    expect(home.commands?.map(command => command.key)).toEqual([
      'FetchInterruptNotes:home',
    ])
    expect(sidebar.commands?.map(command => command.key)).toEqual([
      'FetchInterruptNotes:sidebar',
    ])
  })

  it('waits for cancellation before replacing a pending Fetch', () => {
    const started = notes.loadIfMissing(notes.init('home'))
    const replacing = notes.replace(started.model)

    expect(replacing.model).toBe(started.model)
    expect(replacing.commands?.map(command => command.name)).toEqual([
      'FetchInterruptNotes.Interrupt',
    ])
    expect(
      replacing.commands?.map(command =>
        'interruptsKey' in command ? command.interruptsKey : undefined,
      ),
    ).toEqual(['FetchInterruptNotes:home'])

    const cancelled = notes.update(
      replacing.model,
      notes.Message.CompletedCancelFetch({
        instanceId: 'home',
        requestId: 0,
        outcome: { _tag: 'Interrupted' },
        intent: Query.CancelIntent.Replace(),
      }),
    )

    expect(cancelled.model.maybePendingRequestId).toEqual(Option.some(1))
    expect(cancelled.commands?.map(command => command.name)).toEqual([
      'FetchInterruptNotes',
    ])
  })

  it('forgets pending data and ignores a late cancellation', () => {
    const started = notes.loadIfMissing(notes.init('home'))
    const forgotten = notes.forget(started.model)
    const watched = notes.watch(forgotten.model)
    const stale = notes.update(
      watched.model,
      notes.Message.CompletedCancelFetch({
        instanceId: 'home',
        requestId: 0,
        outcome: { _tag: 'Interrupted' },
        intent: Query.CancelIntent.Forget(),
      }),
    )

    expect(notes.read(forgotten.model)).toEqual(AsyncData.Idle())
    expect(forgotten.commands?.map(command => command.name)).toEqual([
      'FetchInterruptNotes.Interrupt',
    ])
    expect(stale.model).toBe(watched.model)
    expect(stale.commands).toBeUndefined()
  })

  it('keys and cancels one keyed slot without changing a sibling', () => {
    const first = noteById.loadIfMissing(noteById.init('home'), { noteId: '1' })
    const second = noteById.loadIfMissing(first.model, { noteId: '2' })
    const forgotten = noteById.forget(second.model, { noteId: '1' })

    expect(first.commands?.map(command => command.key)).not.toEqual(
      second.commands?.map(command => command.key),
    )
    expect(
      forgotten.commands?.map(command =>
        'interruptsKey' in command ? command.interruptsKey : undefined,
      ),
    ).toEqual(first.commands?.map(command => command.key))
    expect(noteById.read(forgotten.model, { noteId: '1' })).toEqual(
      AsyncData.Idle(),
    )
    expect(noteById.read(forgotten.model, { noteId: '2' })).toEqual(
      AsyncData.Loading(),
    )
  })

  it('replaces a keyed slot only after its cancellation completes', () => {
    const args = { noteId: '1' }
    const started = noteById.loadIfMissing(noteById.init('home'), args)
    const replacing = noteById.replace(started.model, args)
    const cancelled = noteById.update(
      replacing.model,
      noteById.Message.CompletedCancelFetch({
        args,
        instanceId: 'home',
        requestId: 0,
        outcome: { _tag: 'Interrupted' },
        intent: Query.CancelIntent.Replace(),
      }),
    )

    expect(replacing.model).toBe(started.model)
    expect(replacing.commands?.map(command => command.name)).toEqual([
      'FetchInterruptNoteById.Interrupt',
    ])
    expect(cancelled.commands?.map(command => command.name)).toEqual([
      'FetchInterruptNoteById',
    ])
    expect(cancelled.model.nextRequestId).toBe(2)
    expect(noteById.read(cancelled.model, args)).toEqual(AsyncData.Loading())
  })

  it('ignores an old completion after a Model instance is replaced', () => {
    const previous = notes.loadIfMissing(notes.init('previous'))
    const current = notes.loadIfMissing(notes.init('current'))
    const stale = notes.update(
      current.model,
      notes.Message.SettledFetch({
        instanceId: previous.model.instanceId,
        requestId: 0,
        result: Result.succeed('previous'),
      }),
    )

    expect(stale.model).toBe(current.model)
  })
})
