import { Array, Effect, Option } from 'effect'
import { AsyncData } from 'foldkit'
import { expect, test } from 'vitest'

import { BlogClient } from './api'
import { postDetailQuery, postsQuery } from './main'

test('loads posts and their details through the HttpApi client', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const posts = yield* postsQuery.run
      expect(AsyncData.isSuccess(posts)).toBe(true)
      if (!AsyncData.isSuccess(posts)) {
        throw new Error('Posts did not load')
      }

      const maybePost = Array.head(posts.data.posts)
      expect(Option.isSome(maybePost)).toBe(true)
      if (Option.isNone(maybePost)) {
        throw new Error('No posts returned')
      }

      const detail = yield* postDetailQuery.run({
        params: { postId: maybePost.value.id },
      })
      expect(AsyncData.isSuccess(detail)).toBe(true)
      if (!AsyncData.isSuccess(detail)) {
        throw new Error('Post did not load')
      }

      expect(detail.data.detail.id).toBe(maybePost.value.id)
      expect(detail.data.detail.title).toBe(maybePost.value.title)
    }).pipe(Effect.provide(BlogClient.layer)),
  )
})

test('settles a declared endpoint error through the HttpApi client', async () => {
  const detail = await Effect.runPromise(
    postDetailQuery
      .run({ params: { postId: 'missing-post' } })
      .pipe(Effect.provide(BlogClient.layer)),
  )

  expect(detail).toEqual(
    AsyncData.Failure({ error: 'No post found with id missing-post' }),
  )
})
