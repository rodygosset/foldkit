import { Result } from 'effect'
import {
  Command,
  click,
  expect,
  given,
  inside,
  role,
  scene,
  text,
} from 'foldkit/scene'
import { describe, test } from 'vitest'

import { Tabs } from '@foldkit/ui'

import { postDetailQuery, statsQuery, update, view } from './main'
import {
  FETCHED_AT,
  cachedFirstPostModel,
  firstPostDetail,
  fixtureStats,
  loadedPostsModel,
  loadingPostsModel,
} from './main.fixture'

const resolveFocusTab = Command.resolve(
  Tabs.FocusTab,
  Tabs.Message.CompletedFocusTab(),
)

describe('view', () => {
  test('posts load into clickable rows with an Invalidate button', () => {
    scene(
      { update, view },
      given(loadingPostsModel),
      expect(text('Loading posts...')).toExist(),
      expect(role('button', { name: 'Invalidate' })).toExist(),
      expect(role('tab', { name: 'Posts' })).toExist(),
      expect(role('tab', { name: 'Stats' })).toExist(),
    )
  })

  test('clicking a post fetches its detail and renders it', () => {
    scene(
      { update, view },
      given(loadedPostsModel),
      click(role('button', { name: /First Post/ })),
      expect(text('Loading post...')).toExist(),
      Command.expectExact(postDetailQuery.Fetch),
      Command.resolve(
        postDetailQuery.Fetch,
        postDetailQuery.Message.CompletedFetch({
          args: { params: { postId: 'first-post' } },
          generation: 1,
          result: Result.succeed({
            detail: firstPostDetail,
            fetchedAt: FETCHED_AT,
          }),
        }),
      ),
      inside(
        role('article'),
        expect(text('By Grace Hopper')).toExist(),
        expect(text('The whole body of the first fixture post.')).toExist(),
      ),
      expect(role('button', { name: 'Back to posts' })).toExist(),
    )
  })

  test('a cached post shows the Cached badge and revisits skip the fetch', () => {
    scene(
      { update, view },
      given(cachedFirstPostModel),
      expect(text('Cached')).toExist(),
      click(role('button', { name: /First Post/ })),
      Command.expectNone(),
      expect(text('By Grace Hopper')).toExist(),
    )
  })

  test('a failed detail fetch shows the error with a Retry button', () => {
    scene(
      { update, view },
      given(loadedPostsModel),
      click(role('button', { name: /First Post/ })),
      Command.resolve(
        postDetailQuery.Fetch,
        postDetailQuery.Message.CompletedFetch({
          args: { params: { postId: 'first-post' } },
          generation: 1,
          result: Result.fail('The connection dropped.'),
        }),
      ),
      expect(text('The connection dropped.')).toExist(),
      expect(role('button', { name: 'Retry' })).toExist(),
    )
  })

  test('switching to the Stats tab fetches and renders stats', () => {
    scene(
      { update, view },
      given(loadedPostsModel),
      click(role('tab', { name: 'Stats' })),
      expect(text('Loading stats...')).toExist(),
      resolveFocusTab,
      Command.expectExact(statsQuery.Fetch),
      Command.resolve(
        statsQuery.Fetch,
        statsQuery.Message.CompletedFetch({
          generation: 1,
          result: Result.succeed({
            stats: fixtureStats,
            fetchedAt: FETCHED_AT,
          }),
        }),
      ),
      expect(text('Active users')).toExist(),
      expect(text('97%')).toExist(),
      expect(text('Updated at', { exact: false })).toExist(),
    )
  })
})
