import { HashMap, Option, Result, Schema } from 'effect'
import { AsyncData } from 'foldkit'
import { Command, given, message, model, story } from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { expect, test } from 'vitest'

import { Tabs } from '@foldkit/ui'

import {
  FetchPostDetail,
  FetchPosts,
  FetchStats,
  Message,
  postDetailQuery,
  postsQuery,
  statsQuery,
  update,
} from './main'
import {
  FETCHED_AT,
  firstPostDetail,
  fixturePosts,
  fixtureStats,
  loadedPostsModel,
  loadedStatsModel,
} from './main.fixture'

const encodeKey = Schema.Unknown.pipe(
  Schema.toCodecJson,
  Schema.fromJsonString,
  Schema.encodeUnknownSync,
)

const postDetailTag = (
  model: typeof loadedPostsModel,
  postId: string,
): string => postDetailQuery.read(model.postDetailById, { postId })._tag

const selectedPostsTab = Message.GotTabsMessage({
  message: Tabs.Message.SelectedTab({ index: 0, value: 'Posts' }),
})

const selectedStatsTab = Message.GotTabsMessage({
  message: Tabs.Message.SelectedTab({ index: 1, value: 'Stats' }),
})

const resolveFocusTab = Command.resolve(
  Tabs.FocusTab,
  Tabs.Message.CompletedFocusTab(),
)

test('first visit to the Stats tab fetches stats', () => {
  story(
    update,
    given(loadedPostsModel),
    message(selectedStatsTab),
    model(function (model) {
      expect(model.activeTab).toBe('Stats')
      expect(statsQuery.read(model.stats)._tag).toBe('Loading')
    }),
    resolveFocusTab,
    Command.resolve(
      FetchStats,
      statsQuery.Message.SettledFetch({
        requestId: 0,
        result: Result.succeed({
          stats: fixtureStats,
          fetchedAt: FETCHED_AT,
        }),
      }),
    ),
    model(function (model) {
      expect(statsQuery.read(model.stats)._tag).toBe('Success')
    }),
  )
})

test('returning to a tab with cached data does not refetch', () => {
  story(
    update,
    given(loadedStatsModel),
    message(selectedPostsTab),
    resolveFocusTab,
    Command.expectNone(),
    message(selectedStatsTab),
    resolveFocusTab,
    Command.expectNone(),
    model(function (model) {
      expect(statsQuery.read(model.stats)._tag).toBe('Success')
    }),
  )
})

test('a revalidation tick keeps stale stats on screen while refetching', () => {
  story(
    update,
    given(loadedStatsModel),
    message(Message.TickedRevalidateStats()),
    model(function (model) {
      const stats = statsQuery.read(model.stats)
      expect(stats._tag).toBe('Refreshing')
      if (stats._tag === 'Refreshing') {
        expect(stats.data.stats).toEqual(fixtureStats)
      }
    }),
    Command.resolve(
      FetchStats,
      statsQuery.Message.SettledFetch({
        requestId: 0,
        result: Result.succeed({
          stats: modifyFields(fixtureStats, { activeUsers: () => 99 }),
          fetchedAt: FETCHED_AT + 5000,
        }),
      }),
    ),
    model(function (model) {
      const stats = statsQuery.read(model.stats)
      expect(stats._tag).toBe('Success')
      if (stats._tag === 'Success') {
        expect(stats.data.stats.activeUsers).toBe(99)
      }
    }),
  )
})

test('a failed refresh keeps the stale stats on screen with the error', () => {
  story(
    update,
    given(loadedStatsModel),
    message(Message.TickedRevalidateStats()),
    Command.resolve(
      FetchStats,
      statsQuery.Message.SettledFetch({
        requestId: 0,
        result: Result.fail('The server is down.'),
      }),
    ),
    model(function (model) {
      const stats = statsQuery.read(model.stats)
      expect(stats._tag).toBe('Stale')
      if (stats._tag === 'Stale') {
        expect(stats.data.stats).toEqual(fixtureStats)
        expect(stats.error).toBe('The server is down.')
      }
    }),
  )
})

test('refresh clicks during an in-flight fetch are deduplicated', () => {
  story(
    update,
    given(
      modifyFields(loadedStatsModel, {
        stats: stats =>
          modifyFields(stats, {
            data: () => AsyncData.Loading(),
            maybePendingRequestId: () => Option.some(0),
          }),
      }),
    ),
    message(Message.ClickedRefreshStats()),
    Command.expectNone(),
  )
})

test('a revalidation tick during a refresh is deduplicated', () => {
  story(
    update,
    given(
      modifyFields(loadedStatsModel, {
        stats: stats =>
          modifyFields(stats, {
            data: () =>
              AsyncData.Refreshing({
                data: { stats: fixtureStats, fetchedAt: FETCHED_AT },
              }),
            maybePendingRequestId: () => Option.some(0),
          }),
      }),
    ),
    message(Message.TickedRevalidateStats()),
    Command.expectNone(),
  )
})

test('invalidating posts refetches while keeping the current list', () => {
  story(
    update,
    given(loadedPostsModel),
    message(Message.ClickedInvalidatePosts()),
    model(function (model) {
      const posts = postsQuery.read(model.posts)
      expect(posts._tag).toBe('Refreshing')
      if (posts._tag === 'Refreshing') {
        expect(posts.data.posts).toEqual(fixturePosts)
      }
    }),
    Command.resolve(
      FetchPosts,
      postsQuery.Message.SettledFetch({
        requestId: 0,
        result: Result.succeed({
          posts: fixturePosts,
          fetchedAt: FETCHED_AT + 1000,
        }),
      }),
    ),
    model(model => {
      expect(postsQuery.read(model.posts)._tag).toBe('Success')
    }),
  )
})

test('retrying failed posts shows the loading state and refetches', () => {
  story(
    update,
    given(
      modifyFields(loadedPostsModel, {
        posts: posts =>
          modifyFields(posts, {
            data: () => AsyncData.Failure({ error: 'The server is down.' }),
            maybePendingRequestId: () => Option.none(),
          }),
      }),
    ),
    message(Message.ClickedRetryPosts()),
    model(function (model) {
      expect(postsQuery.read(model.posts)._tag).toBe('Loading')
    }),
    Command.resolve(
      FetchPosts,
      postsQuery.Message.SettledFetch({
        requestId: 0,
        result: Result.succeed({
          posts: fixturePosts,
          fetchedAt: FETCHED_AT,
        }),
      }),
    ),
    model(model => {
      expect(postsQuery.read(model.posts)._tag).toBe('Success')
    }),
  )
})

test('opening a post fetches it, and Back forgets the slot', () => {
  story(
    update,
    given(loadedPostsModel),
    message(Message.ClickedPost({ postId: 'first-post' })),
    model(function (current) {
      expect(postDetailTag(current, 'first-post')).toBe('Loading')
    }),
    Command.resolve(
      FetchPostDetail,
      postDetailQuery.Message.SettledFetch({
        args: { postId: 'first-post' },
        requestId: 0,
        result: Result.succeed({
          detail: firstPostDetail,
          fetchedAt: FETCHED_AT,
        }),
      }),
    ),
    message(Message.ClickedBackToPosts()),
    message(
      Message.GotPostDetailMessage({
        message: postDetailQuery.Message.RequestedWatch({
          live: HashMap.empty(),
        }),
      }),
    ),
    model(function (current) {
      expect(postDetailTag(current, 'first-post')).toBe('Idle')
    }),
    message(Message.ClickedPost({ postId: 'first-post' })),
    Command.resolve(
      FetchPostDetail,
      postDetailQuery.Message.SettledFetch({
        args: { postId: 'first-post' },
        requestId: 1,
        result: Result.succeed({
          detail: firstPostDetail,
          fetchedAt: FETCHED_AT,
        }),
      }),
    ),
    model(function (current) {
      expect(postDetailTag(current, 'first-post')).toBe('Success')
    }),
  )
})

test('a failed post detail fetch lands in Failure and retry refetches', () => {
  story(
    update,
    given(loadedPostsModel),
    message(Message.ClickedPost({ postId: 'first-post' })),
    Command.resolve(
      FetchPostDetail,
      postDetailQuery.Message.SettledFetch({
        args: { postId: 'first-post' },
        requestId: 0,
        result: Result.fail('The connection dropped.'),
      }),
    ),
    model(function (model) {
      expect(postDetailTag(model, 'first-post')).toBe('Failure')
    }),
    message(Message.ClickedRetryPostDetail({ postId: 'first-post' })),
    model(model => {
      expect(postDetailTag(model, 'first-post')).toBe('Loading')
    }),
    Command.resolve(
      FetchPostDetail,
      postDetailQuery.Message.SettledFetch({
        args: { postId: 'first-post' },
        requestId: 1,
        result: Result.succeed({
          detail: firstPostDetail,
          fetchedAt: FETCHED_AT,
        }),
      }),
    ),
    model(function (model) {
      expect(postDetailTag(model, 'first-post')).toBe('Success')
    }),
  )
})

test('revisiting a post with a cached failure loads it again', () => {
  story(
    update,
    given(
      modifyFields(loadedPostsModel, {
        postDetailById: postDetailById =>
          modifyFields(postDetailById, {
            slots: slots =>
              HashMap.set(slots, encodeKey({ postId: 'first-post' }), {
                args: { postId: 'first-post' },
                data: AsyncData.Failure({ error: 'The connection dropped.' }),
                maybePendingRequestId: Option.none(),
              }),
          }),
      }),
    ),
    message(Message.ClickedPost({ postId: 'first-post' })),
    model(model => {
      expect(postDetailTag(model, 'first-post')).toBe('Loading')
      expect(model.maybeSelectedPostId).toEqual(Option.some('first-post'))
    }),
    Command.resolve(
      FetchPostDetail,
      postDetailQuery.Message.SettledFetch({
        args: { postId: 'first-post' },
        requestId: 0,
        result: Result.fail('The connection dropped.'),
      }),
    ),
    model(function (model) {
      expect(postDetailTag(model, 'first-post')).toBe('Failure')
    }),
  )
})
