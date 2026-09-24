import {
  Array,
  Context,
  Effect,
  Fiber,
  HashMap,
  Layer,
  Option,
  Schema,
} from 'effect'
import {
  FetchHttpClient,
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from 'effect/http'
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiClient,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
} from 'effect/http-api'
import { afterEach, beforeEach, expect, expectTypeOf, vi } from 'vitest'

import { describe, it } from '@effect/vitest'

import * as AsyncData from '../../asyncData/index.js'
import { __htmlBuilder } from '../../html/index.js'
import { defineMessageUnion } from '../../message/index.js'
import { makeElement } from '../../runtime/makeElement.js'
import type * as Update from '../../update/index.js'
import * as Query from './index.js'

const Note = Schema.Struct({ id: Schema.String, body: Schema.String })
type Note = typeof Note.Type

let container: HTMLElement

beforeEach(function () {
  container = document.createElement('div')
  container.id = 'app'
  document.body.appendChild(container)
})

afterEach(function () {
  document.body.innerHTML = ''
})

function awaitStatus(text: string) {
  return vi.waitFor(function () {
    const maybeStatus = Option.fromNullishOr(document.getElementById('status'))
    expect(
      Option.isSome(maybeStatus) ? maybeStatus.value.textContent : '',
    ).toContain(text)
  })
}

function awaitTwoAnimationFrames() {
  return new Promise<void>(function (resolve) {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        resolve()
      })
    })
  })
}

function click(id: string) {
  const maybeButton = Option.fromNullishOr(document.getElementById(id))
  if (Option.isNone(maybeButton)) {
    throw new Error(`Missing #${id}`)
  }
  maybeButton.value.click()
}

class NotesSecretService extends Context.Service<
  NotesSecretService,
  { readonly token: string }
>()('NotesSecretService') {}

const stringNeedingDecode = Schema.String.pipe(
  Schema.optional,
  Schema.withDecodingDefault(
    Effect.gen(function* () {
      yield* NotesSecretService
      return ''
    }),
  ),
)

const stringNeedingEncode = Schema.flip(stringNeedingDecode)

class NotesAuthError extends Schema.Error<NotesAuthError>('NotesAuthError')({
  _tag: Schema.tag('NotesAuthError'),
}) {}

class NotesClientAuthError extends Schema.TaggedError<NotesClientAuthError>()(
  'NotesClientAuthError',
  { message: Schema.String },
) {}

class NotesAuth extends HttpApiMiddleware.Service<
  NotesAuth,
  { clientError: NotesClientAuthError }
>()('NotesAuth', {
  error: NotesAuthError,
  requiredForClient: true,
}) {}

const TotalsError = HttpApiSchema.WithHeaders(
  Schema.Struct({ total: Schema.BigInt }),
  { 'x-count': Schema.Int },
).pipe(HttpApiSchema.status(400))

class TotalsAuth extends HttpApiMiddleware.Service<TotalsAuth>()('TotalsAuth', {
  error: TotalsError,
}) {}

const Api = HttpApi.make('Api').add(
  HttpApiGroup.make('notes')
    .add(
      HttpApiEndpoint.get('list', '/notes', {
        success: Schema.Array(Note),
        error: Schema.String,
      }),
    )
    .add(
      HttpApiEndpoint.get('getById', '/notes/:id', {
        params: { id: Schema.String },
        success: Note,
        error: Schema.String.pipe(HttpApiSchema.status(404)),
      }),
    )
    .add(
      HttpApiEndpoint.get('getByIdNonce', '/notes/:id/nonce', {
        params: { id: Schema.String },
        query: { nonce: Schema.String },
        success: Note,
        error: Schema.String,
      }),
    )
    .add(
      HttpApiEndpoint.post('create', '/notes', {
        payload: Note,
        success: Note,
        error: Schema.String,
      }),
    )
    .add(
      HttpApiEndpoint.get('guarded', '/notes/guarded', {
        success: Note,
        error: Schema.String,
      }).middleware(NotesAuth),
    )
    .add(HttpApiEndpoint.get('ping', '/ping'))
    .add(
      HttpApiEndpoint.get('totals', '/totals', {
        success: HttpApiSchema.WithHeaders(
          Schema.Struct({ total: Schema.BigInt }),
          { 'x-count': Schema.Int },
        ),
      }),
    )
    .add(
      HttpApiEndpoint.get('failedTotals', '/failed-totals', {
        success: Schema.String,
        error: TotalsError,
      }),
    )
    .add(
      HttpApiEndpoint.get('guardedTotals', '/guarded-totals', {
        success: Schema.String,
      }).middleware(TotalsAuth),
    ),
)

const NonQueryableApi = HttpApi.make('NonQueryableApi').add(
  HttpApiGroup.make('notes')
    .add(
      HttpApiEndpoint.get('secret', '/secret', {
        success: stringNeedingEncode,
      }),
    )
    .add(
      HttpApiEndpoint.get('locked', '/locked/:id', {
        params: {
          id: stringNeedingEncode,
        },
        success: Note,
      }),
    )
    .add(
      HttpApiEndpoint.get('decoded', '/decoded', {
        success: stringNeedingDecode,
      }),
    )
    .add(
      HttpApiEndpoint.get('events', '/events', {
        success: HttpApiSchema.StreamSse({ data: Note }),
      }),
    )
    .add(
      HttpApiEndpoint.get('bytes', '/bytes', {
        success: HttpApiSchema.StreamUint8Array(),
      }),
    )
    .add(
      HttpApiEndpoint.get('mixedBytes', '/mixed-bytes', {
        success: [Schema.String, HttpApiSchema.StreamUint8Array()],
      }),
    )
    .add(
      HttpApiEndpoint.get('mixedHeaderEvents', '/mixed-header-events', {
        success: [
          Note,
          HttpApiSchema.WithHeaders(HttpApiSchema.StreamSse({ data: Note }), {
            'x-count': Schema.Int,
          }),
        ],
      }),
    )
    .add(
      HttpApiEndpoint.post('upload', '/upload', {
        payload: Note.pipe(HttpApiSchema.asMultipart()),
        success: Note,
      }),
    )
    .add(
      HttpApiEndpoint.post('streamUpload', '/stream-upload', {
        payload: Note.pipe(HttpApiSchema.asMultipartStream()),
        success: Note,
      }),
    )
    .add(
      HttpApiEndpoint.get('headerEvents', '/header-events', {
        success: HttpApiSchema.WithHeaders(
          HttpApiSchema.StreamSse({ data: Note }),
          { 'x-count': Schema.Int },
        ),
      }),
    ),
)

class NotesClient extends Query.HttpApi.Service<NotesClient>()('NotesClient', {
  api: Api,
}) {}

const notes = NotesClient.query('Notes', 'notes', 'list')
const noteById = NotesClient.query('Note', 'notes', 'getById')
const noteByIdNonce = NotesClient.query('NoteNonce', 'notes', 'getByIdNonce')
const createNote = NotesClient.query('CreateNote', 'notes', 'create')
const guarded = NotesClient.query('Guarded', 'notes', 'guarded')
const ping = NotesClient.query('Ping', 'notes', 'ping')

const NotesAuthLive = HttpApiMiddleware.layerClient(
  NotesAuth,
  function ({ next, request }) {
    return next(request)
  },
)

const NotesAuthServerLive = Layer.succeed(NotesAuth, httpEffect => httpEffect)

const totalsError = HttpApiSchema.withHeaders({
  body: { total: 30n },
  headers: { 'x-count': 3 },
})
const TotalsAuthServerLive = Layer.succeed(TotalsAuth, () =>
  Effect.fail(totalsError),
)

const notesHandlers = (
  onNonceRequest: (nonce: string) => Effect.Effect<void>,
) =>
  HttpApiBuilder.group(Api, 'notes', handlers =>
    handlers
      .handle('list', () => Effect.succeed([{ id: '1', body: 'hello' }]))
      .handle('getById', ({ params }) => {
        if (params.id === 'missing') {
          return Effect.fail('not found')
        }

        if (params.id === 'schema') {
          return Effect.succeed(
            HttpServerResponse.jsonUnsafe({ id: params.id }),
          )
        }

        return Effect.succeed({ id: params.id, body: 'hello' })
      })
      .handle('getByIdNonce', ({ params, query }) =>
        onNonceRequest(query.nonce).pipe(
          Effect.andThen(
            query.nonce === '1'
              ? Effect.never
              : Effect.succeed({ id: params.id, body: query.nonce }),
          ),
        ),
      )
      .handle('create', ({ payload }) => Effect.succeed(payload))
      .handle('guarded', () => Effect.succeed({ id: '1', body: 'hello' }))
      .handle('ping', () => Effect.void)
      .handle('failedTotals', () => Effect.fail(totalsError))
      .handle('guardedTotals', () => Effect.succeed('authorized'))
      .handle('totals', () =>
        Effect.succeed(
          HttpApiSchema.withHeaders({
            body: { total: 30n },
            headers: { 'x-count': 3 },
          }),
        ),
      ),
  ).pipe(
    Layer.provide(NotesAuthServerLive),
    Layer.provide(TotalsAuthServerLive),
  )

const makeHttpClient = (
  apiLayer: Layer.Layer<never, never, HttpRouter.HttpRouter>,
  isOffline = false,
) =>
  Effect.gen(function* () {
    const webHandler = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(apiLayer, { disableLogger: true }),
      ),
      ({ dispose }) => Effect.promise(dispose),
    )

    return yield* HttpClient.HttpClient.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, (input, options) => {
        if (isOffline) {
          return Promise.reject(new Error('offline'))
        }

        return webHandler.handler(new Request(input, options))
      }),
    )
  })

const notesClientLayer = ({
  onNonceRequest = () => Effect.void,
  isOffline = false,
}: Readonly<{
  onNonceRequest?: (nonce: string) => Effect.Effect<void>
  isOffline?: boolean
}> = {}): Layer.Layer<NotesClient> =>
  Layer.effect(
    NotesClient,
    Effect.gen(function* () {
      const httpClient = yield* makeHttpClient(
        HttpApiBuilder.layer(Api).pipe(
          Layer.provide(notesHandlers(onNonceRequest)),
          Layer.provide(HttpServer.layerServices),
        ),
        isOffline,
      )
      return yield* HttpApiClient.makeWith(Api, {
        baseUrl: 'http://test',
        httpClient,
      })
    }),
  ).pipe(Layer.provide(NotesAuthLive))

const NotesClientLive = notesClientLayer()

const TopLevelApi = HttpApi.make('TopLevelApi').add(
  HttpApiGroup.make('notes', { topLevel: true }).add(
    HttpApiEndpoint.get('list', '/notes', {
      success: Schema.Array(Note),
      error: Schema.String,
    }),
  ),
)

class TopLevelNotesClient extends Query.HttpApi.Service<TopLevelNotesClient>()(
  'TopLevelNotesClient',
  { api: TopLevelApi },
) {}

const topLevelNotes = TopLevelNotesClient.query('Notes', 'notes', 'list')

const TopLevelNotesClientLive = Layer.effect(
  TopLevelNotesClient,
  Effect.gen(function* () {
    const httpClient = yield* makeHttpClient(
      HttpApiBuilder.layer(TopLevelApi).pipe(
        Layer.provide(
          HttpApiBuilder.group(TopLevelApi, 'notes', handlers =>
            handlers.handle('list', () =>
              Effect.succeed([{ id: '1', body: 'hello' }]),
            ),
          ),
        ),
        Layer.provide(HttpServer.layerServices),
      ),
    )
    return yield* HttpApiClient.makeWith(TopLevelApi, {
      baseUrl: 'http://test',
      httpClient,
    })
  }),
)

class NonQueryableClient extends Query.HttpApi.Service<NonQueryableClient>()(
  'NonQueryableClient',
  { api: NonQueryableApi },
) {}

describe('Query.HttpApi.Service.query', () => {
  it('is a Query whose run depends on the client tag', () => {
    expectTypeOf(notes.run).toEqualTypeOf<
      Effect.Effect<
        AsyncData.AsyncData<
          ReadonlyArray<Note>,
          string | Query.HttpApi.HttpApiClientError
        >,
        never,
        NotesClient
      >
    >()
  })

  it('requires the client only where a Fetch can be dispatched', () => {
    const interruptible = NotesClient.query(
      'InterruptibleNotes',
      'notes',
      'list',
      { interrupt: true },
    )
    expectTypeOf(notes.init).parameters.toEqualTypeOf<[]>()
    expectTypeOf(interruptible.init).parameters.toEqualTypeOf<
      [instanceId: string]
    >()
    expectTypeOf(notes.update).returns.toExtend<
      Update.Return<typeof notes.Model.Type, typeof notes.Message.Type>
    >()
    expectTypeOf(interruptible.update).returns.toExtend<
      Update.Return<
        typeof interruptible.Model.Type,
        typeof interruptible.Message.Type,
        NotesClient
      >
    >()
    expectTypeOf(interruptible.update).returns.not.toExtend<
      Update.Return<
        typeof interruptible.Model.Type,
        typeof interruptible.Message.Type
      >
    >()
  })

  it.effect('run uses the HttpApiClient method', () =>
    Effect.gen(function* () {
      const data = yield* Effect.provide(notes.run, NotesClientLive)
      expect(data).toEqual(
        AsyncData.Success({ data: [{ id: '1', body: 'hello' }] }),
      )
    }),
  )

  it.effect('run uses a top-level client method', () =>
    Effect.gen(function* () {
      const data = yield* Effect.provide(
        topLevelNotes.run,
        TopLevelNotesClientLive,
      )
      expect(data).toEqual(
        AsyncData.Success({ data: [{ id: '1', body: 'hello' }] }),
      )
    }),
  )
})

describe('Query.HttpApi.Service.query KeyedQuery', () => {
  it('is a KeyedQuery Submodel over the client request', () => {
    expectTypeOf(noteById.run).parameter(0).toEqualTypeOf<{
      readonly params: { readonly id: string }
    }>()
    expectTypeOf(createNote.run).parameter(0).toEqualTypeOf<{
      readonly payload: Note
    }>()
  })

  it.effect('run forwards params to the client method', () =>
    Effect.gen(function* () {
      const data = yield* Effect.provide(
        noteById.run({ params: { id: '7' } }),
        NotesClientLive,
      )
      expect(data).toEqual(
        AsyncData.Success({ data: { id: '7', body: 'hello' } }),
      )
    }),
  )

  it.effect('run settles a declared endpoint error', () =>
    Effect.gen(function* () {
      const data = yield* Effect.provide(
        noteById.run({ params: { id: 'missing' } }),
        NotesClientLive,
      )
      expect(data).toEqual(AsyncData.Failure({ error: 'not found' }))
    }),
  )

  it.effect('run settles HttpClientError as Failure', () =>
    Effect.gen(function* () {
      const data = yield* Effect.provide(
        noteById.run({ params: { id: '1' } }),
        notesClientLayer({ isOffline: true }),
      )
      expect(AsyncData.isFailure(data)).toBe(true)
      if (AsyncData.isFailure(data) && typeof data.error !== 'string') {
        expect(data.error._tag).toBe('HttpApiClientError')
        expect(data.error.reason._tag).toBe('HttpError')
        if (data.error.reason._tag === 'HttpError') {
          expect(data.error.reason.kind).toBe('TransportError')
        }
      }
    }),
  )

  it.effect('run settles SchemaError as Failure', () =>
    Effect.gen(function* () {
      const data = yield* Effect.provide(
        noteById.run({ params: { id: 'schema' } }),
        NotesClientLive,
      )
      expect(AsyncData.isFailure(data)).toBe(true)
      if (AsyncData.isFailure(data) && typeof data.error !== 'string') {
        expect(data.error._tag).toBe('HttpApiClientError')
        expect(data.error.reason._tag).toBe('SerializableSchemaError')
      }
    }),
  )

  it.effect('run forwards payload on POST', () =>
    Effect.gen(function* () {
      const payload = { id: '9', body: 'created' }
      const data = yield* Effect.provide(
        createNote.run({ payload }),
        NotesClientLive,
      )
      expect(data).toEqual(AsyncData.Success({ data: payload }))
    }),
  )

  it('distinct params keep distinct slots', () => {
    const first = noteById.loadIfMissing(noteById.init(), {
      params: { id: 'a' },
    })
    const second = noteById.loadIfMissing(first.model, {
      params: { id: 'b' },
    })
    expect(noteById.read(second.model, { params: { id: 'a' } })).toEqual(
      AsyncData.Loading(),
    )
    expect(noteById.read(second.model, { params: { id: 'b' } })).toEqual(
      AsyncData.Loading(),
    )
  })
})

describe('Query.HttpApi.Service.query extra args', () => {
  it('distinct extra args keep distinct entries', () => {
    const first = noteByIdNonce.loadIfMissing(noteByIdNonce.init(), {
      params: { id: 'a' },
      query: { nonce: '1' },
    })
    const second = noteByIdNonce.loadIfMissing(first.model, {
      params: { id: 'a' },
      query: { nonce: '2' },
    })
    expect(HashMap.size(second.model.entries)).toBe(2)
    expect(
      noteByIdNonce.read(second.model, {
        params: { id: 'a' },
        query: { nonce: '1' },
      }),
    ).toEqual(AsyncData.Loading())
    expect(
      noteByIdNonce.read(second.model, {
        params: { id: 'a' },
        query: { nonce: '2' },
      }),
    ).toEqual(AsyncData.Loading())
  })

  it('interrupt: true keys Fetch by instance id and generation', () => {
    const interruptible = NotesClient.query(
      'NoteNonceInterrupt',
      'notes',
      'getByIdNonce',
      { interrupt: true },
    )
    expectTypeOf(interruptible.init).parameter(0).toEqualTypeOf<string>()
    expectTypeOf(noteByIdNonce.init).parameters.toEqualTypeOf<[]>()

    const sidebar = interruptible.init('sidebar')
    const home = interruptible.init('home')
    const firstArgs = { params: { id: 'a' }, query: { nonce: '1' } }
    const secondArgs = { params: { id: 'a' }, query: { nonce: '2' } }
    const sidebarFetch = interruptible.loadIfMissing(sidebar, firstArgs)
    const homeFetch = interruptible.loadIfMissing(home, firstArgs)
    const otherSlot = interruptible.loadIfMissing(
      sidebarFetch.model,
      secondArgs,
    )
    const plain = noteByIdNonce.loadIfMissing(noteByIdNonce.init(), firstArgs)

    expect(sidebarFetch.commands?.map(command => command.key)).not.toEqual(
      homeFetch.commands?.map(command => command.key),
    )
    expect(sidebarFetch.commands?.map(command => command.key)).not.toEqual(
      otherSlot.commands?.map(command => command.key),
    )
    expect(plain.commands?.map(command => command.key)).toEqual([undefined])
  })

  it('forgetting one extra-arg entry keeps the sibling entry', async function () {
    const attempts: Record<string, number> = {}
    const live = notesClientLayer({
      onNonceRequest: nonce =>
        Effect.sync(() => {
          attempts[nonce] = (attempts[nonce] ?? 0) + 1
        }),
    })
    const Message = defineMessageUnion({
      GotNoteMessage: { message: noteByIdNonce.Message },
      ClickedForgetNote: {},
    })
    const notes = noteByIdNonce.lift<
      typeof noteByIdNonce.Model.Type,
      typeof Message.Type
    >({
      read: model => Option.some(model),
      write: (_model, nextNotes) => nextNotes,
      toParentMessage: message => Message.GotNoteMessage({ message }),
    })
    const h = __htmlBuilder<typeof Message.Type>()

    const element = makeElement({
      Model: noteByIdNonce.Model,
      init: function () {
        const first = notes.loadIfMissing(noteByIdNonce.init(), {
          params: { id: 'a' },
          query: { nonce: '1' },
        })
        const second = notes.loadIfMissing(first.model, {
          params: { id: 'a' },
          query: { nonce: '2' },
        })
        return {
          model: second.model,
          commands: [...(first.commands ?? []), ...(second.commands ?? [])],
        }
      },
      update: (model, message) =>
        Message.match(message, {
          GotNoteMessage: ({ message }) => notes.fold(model, message),
          ClickedForgetNote: () =>
            notes.forget(model, { params: { id: 'a' }, query: { nonce: '1' } }),
        }),
      view: function (model) {
        const dropped = noteByIdNonce.read(model, {
          params: { id: 'a' },
          query: { nonce: '1' },
        })
        const kept = noteByIdNonce.read(model, {
          params: { id: 'a' },
          query: { nonce: '2' },
        })
        return h.div(
          [],
          [
            h.div([h.Id('status')], [`${dropped._tag} ${kept._tag}`]),
            h.button(
              [h.Id('forget-nonce-1'), h.OnClick(Message.ClickedForgetNote())],
              ['forget-nonce-1'],
            ),
          ],
        )
      },
      resources: live,
      container,
    })

    const fiber = Effect.runFork(element.start())

    try {
      await awaitStatus('Success')
      await awaitTwoAnimationFrames()
      click('forget-nonce-1')
      await awaitStatus('Idle Success')
      expect(attempts['1']).toBe(1)
      expect(attempts['2']).toBe(1)
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber))
    }
  })
})

describe('Query.HttpApi.Service.query empty success', () => {
  it.effect('run succeeds with no content', () =>
    Effect.gen(function* () {
      const data = yield* Effect.provide(ping.run, NotesClientLive)
      expect(data).toEqual(AsyncData.Success({ data: undefined }))
    }),
  )
})

describe('Query.HttpApi.Service.query middleware', () => {
  it('includes middleware errors in the Query error type', () => {
    expectTypeOf(guarded.run).toEqualTypeOf<
      Effect.Effect<
        AsyncData.AsyncData<
          Note,
          string | NotesAuthError | Query.HttpApi.HttpApiClientError
        >,
        never,
        NotesClient
      >
    >()
  })
})

describe('Query.HttpApi.Service.query construction', () => {
  type QueryEndpointId = Parameters<typeof NonQueryableClient.query>[2]

  it('rejects an endpoint whose success codec requires encoding services', () => {
    expectTypeOf<'list'>().toExtend<Parameters<typeof NotesClient.query>[2]>()
    expectTypeOf<'secret'>().not.toExtend<QueryEndpointId>()
  })

  it('rejects an endpoint whose request codec requires encoding services', () => {
    expectTypeOf<'locked'>().not.toExtend<QueryEndpointId>()
  })

  it('rejects an endpoint whose success codec requires decoding services', () => {
    expectTypeOf<'decoded'>().not.toExtend<QueryEndpointId>()
  })

  it('rejects multipart request endpoints', () => {
    expectTypeOf<'upload'>().not.toExtend<QueryEndpointId>()
    expectTypeOf<'streamUpload'>().not.toExtend<QueryEndpointId>()
  })

  it('rejects stream success endpoints', () => {
    expectTypeOf<'events'>().not.toExtend<QueryEndpointId>()
    expectTypeOf<'bytes'>().not.toExtend<QueryEndpointId>()
    expectTypeOf<'headerEvents'>().not.toExtend<QueryEndpointId>()
    expectTypeOf<'mixedBytes'>().not.toExtend<QueryEndpointId>()
    expectTypeOf<'mixedHeaderEvents'>().not.toExtend<QueryEndpointId>()
  })
})

describe('Query.HttpApi Model codecs', () => {
  it.effect(
    'round trips decoded response bodies and headers through JSON',
    () =>
      Effect.gen(function* () {
        const totals = NotesClient.query('Totals', 'notes', 'totals')
        const loading = totals.loadIfMissing(totals.init())
        const fetch = loading.commands?.at(0)
        expect(fetch).toBeDefined()
        if (fetch === undefined) {
          throw new Error('Missing Fetch')
        }
        const message = yield* Effect.provide(fetch.effect, NotesClientLive)
        const settled = totals.update(loading.model, message)
        const codec = Schema.toCodecJson(totals.Model)
        const encoded = Schema.encodeSync(codec)(settled.model)
        const restored = Schema.decodeUnknownSync(codec)(
          JSON.parse(JSON.stringify(encoded)),
        )
        expect(restored).toEqual(settled.model)
        expect(totals.read(restored)).toEqual(
          AsyncData.Success({
            data: HttpApiSchema.withHeaders({
              body: { total: 30n },
              headers: { 'x-count': 3 },
            }),
          }),
        )
      }),
  )

  it.effect(
    'round trips declared endpoint and middleware errors with headers through JSON',
    () =>
      Effect.gen(function* () {
        for (const endpoint of Schema.Literals([
          'failedTotals',
          'guardedTotals',
        ]).literals) {
          const totals = NotesClient.query('FailedTotals', 'notes', endpoint)
          type FailureEncoded = Extract<
            (typeof totals.Model.Encoded)['data'],
            { readonly _tag: 'Failure' }
          >
          expectTypeOf<FailureEncoded['error']>().toEqualTypeOf<
            | Readonly<{
                body: Readonly<{ total: bigint }>
                headers: Readonly<{ 'x-count': number }>
              }>
            | typeof Query.HttpApi.HttpApiClientError.Encoded
          >()
          const loading = totals.loadIfMissing(totals.init())
          const fetch = Option.getOrThrow(Array.head(loading.commands ?? []))
          const message = yield* Effect.provide(fetch.effect, NotesClientLive)
          const settled = totals.update(loading.model, message)
          const codec = Schema.toCodecJson(totals.Model)
          const encoded = Schema.encodeSync(codec)(settled.model)
          const restored = Schema.decodeUnknownSync(codec)(
            JSON.parse(JSON.stringify(encoded)),
          )

          expect(restored).toEqual(settled.model)
          expect(totals.read(restored)).toEqual(
            AsyncData.Failure({ error: totalsError }),
          )
        }
      }),
  )

  it.effect('settles client middleware failures through a Fetch Command', () =>
    Effect.gen(function* () {
      const cause = NotesClientAuthError.make({
        message: 'token refresh failed',
      })
      const failingAuth = HttpApiMiddleware.layerClient(NotesAuth, () =>
        Effect.fail(cause),
      )
      const live = Layer.effect(
        NotesClient,
        HttpApiClient.makeWith(Api, {
          baseUrl: 'http://test',
          httpClient: HttpClient.make(() =>
            Effect.die('Unexpected HTTP request'),
          ),
        }),
      ).pipe(Layer.provide(failingAuth))
      const loading = guarded.loadIfMissing(guarded.init())
      const fetch = loading.commands?.at(0)
      expect(fetch).toBeDefined()
      if (fetch === undefined) {
        throw new Error('Missing Fetch')
      }
      const message = yield* Effect.provide(fetch.effect, live)
      const settled = guarded.update(loading.model, message)
      expect(guarded.read(settled.model)).toEqual(
        AsyncData.Failure({
          error: Query.HttpApi.HttpApiClientError.make({
            reason: Query.HttpApi.HttpApiMiddlewareClientError.make({ cause }),
          }),
        }),
      )
    }),
  )
})
