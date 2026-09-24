import { Clock, Effect, Layer, Schema } from 'effect'
import {
  FetchHttpClient,
  HttpClient,
  HttpRouter,
  HttpServer,
} from 'effect/http'
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiClient,
  HttpApiEndpoint,
  HttpApiGroup,
} from 'effect/http-api'
import * as Query from 'foldkit/experimental/query'

import {
  Post,
  PostDetail,
  Stats,
  fetchPostDetail,
  fetchPosts,
  fetchStats,
} from './data'

const FetchedPosts = Schema.Struct({
  posts: Schema.Array(Post),
  fetchedAt: Schema.Number,
})

const FetchedPostDetail = Schema.Struct({
  detail: PostDetail,
  fetchedAt: Schema.Number,
})

const FetchedStats = Schema.Struct({ stats: Stats, fetchedAt: Schema.Number })

const BlogApi = HttpApi.make('BlogApi').add(
  HttpApiGroup.make('blog')
    .add(
      HttpApiEndpoint.get('listPosts', '/posts', {
        success: FetchedPosts,
        error: Schema.String,
      }),
    )
    .add(
      HttpApiEndpoint.get('getPost', '/posts/:postId', {
        params: { postId: Schema.String },
        success: FetchedPostDetail,
        error: Schema.String,
      }),
    )
    .add(
      HttpApiEndpoint.get('getStats', '/stats', {
        success: FetchedStats,
        error: Schema.String,
      }),
    ),
)

const BlogHandlers = HttpApiBuilder.group(BlogApi, 'blog', handlers =>
  handlers
    .handle('listPosts', () =>
      Effect.gen(function* () {
        const posts = yield* fetchPosts
        const fetchedAt = yield* Clock.currentTimeMillis
        return { posts, fetchedAt }
      }),
    )
    .handle('getPost', ({ params }) =>
      Effect.gen(function* () {
        const detail = yield* fetchPostDetail(params.postId)
        const fetchedAt = yield* Clock.currentTimeMillis
        return { detail, fetchedAt }
      }),
    )
    .handle('getStats', () =>
      Effect.gen(function* () {
        const stats = yield* fetchStats
        const fetchedAt = yield* Clock.currentTimeMillis
        return { stats, fetchedAt }
      }),
    ),
)

export class BlogClient extends Query.HttpApi.Service<BlogClient>()(
  'BlogClient',
  { api: BlogApi },
) {
  static readonly layer = Layer.effect(
    BlogClient,
    Effect.gen(function* () {
      const webHandler = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpApiBuilder.layer(BlogApi).pipe(
              Layer.provide(BlogHandlers),
              Layer.provide(HttpServer.layerServices),
            ),
            { disableLogger: true },
          ),
        ),
        ({ dispose }) => Effect.promise(dispose),
      )
      const httpClient = yield* HttpClient.HttpClient.pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, (input, options) =>
          webHandler.handler(new Request(input, options)),
        ),
      )
      return yield* HttpApiClient.makeWith(BlogApi, {
        baseUrl: 'http://blog.local',
        httpClient,
      })
    }),
  )
}
