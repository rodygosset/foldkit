import { Effect, HashMap, Option, Result, Schema } from 'effect'
import { expect } from 'vitest'

import { describe, it } from '@effect/vitest'

import * as AsyncData from '../asyncData/index.js'
import * as Query from './index.js'

const note = Query.define({
  name: 'LifecycleNote',
  data: Schema.String,
  error: Schema.String,
  execute: Effect.succeed('current'),
})

const noteById = Query.define({
  name: 'LifecycleNoteById',
  data: Schema.String,
  error: Schema.String,
  args: { noteId: Schema.String, preview: Schema.Boolean },
  toKey: ({ noteId }) => noteId,
  execute: ({ preview }) => Effect.succeed(globalThis.String(preview)),
})

describe('Query Model lifetimes', () => {
  it('ignores a completion from a replaced single-slot Model', () => {
    const previous = note.loadIfMissing(note.init('previous'))
    const current = note.loadIfMissing(note.init('current'))
    const stale = note.update(
      current.model,
      note.Message.SettledFetch({
        instanceId: previous.model.instanceId,
        requestId: 0,
        result: Result.succeed('previous'),
      }),
    )

    expect(stale.model).toBe(current.model)
    expect(note.read(stale.model)).toEqual(AsyncData.Loading())
  })

  it('ignores a completion from a replaced KeyedQuery Model', () => {
    const args = { noteId: '1', preview: true }
    const previous = noteById.loadIfMissing(noteById.init('previous'), args)
    const current = noteById.loadIfMissing(noteById.init('current'), args)
    const stale = noteById.update(
      current.model,
      noteById.Message.SettledFetch({
        args,
        instanceId: previous.model.instanceId,
        requestId: 0,
        result: Result.succeed('previous'),
      }),
    )

    expect(stale.model).toBe(current.model)
    expect(noteById.read(stale.model, args)).toEqual(AsyncData.Loading())
  })
})

describe('KeyedQuery watch normalization', () => {
  it('uses the last args for a duplicate key in both entry points', () => {
    const liveArgs: ReadonlyArray<Parameters<typeof noteById.run>[0]> = [
      { noteId: '1', preview: true },
      { noteId: '1', preview: false },
    ]
    const direct = noteById.watch(noteById.init('direct'), liveArgs)
    const updatedWatch = Schema.decodeUnknownSync(noteById.Message)({
      _tag: 'UpdatedWatch',
      live: HashMap.fromIterable([['1', { noteId: '1', preview: false }]]),
    })
    const viaMessage = noteById.update(noteById.init('message'), updatedWatch)

    expect(
      Option.getOrThrow(HashMap.get(direct.model.slots, '1')).args,
    ).toEqual({ noteId: '1', preview: false })
    expect(
      Option.getOrThrow(HashMap.get(viaMessage.model.slots, '1')).args,
    ).toEqual({ noteId: '1', preview: false })
    expect(direct.commands).toHaveLength(1)
    expect(viaMessage.commands).toHaveLength(1)
  })
})
