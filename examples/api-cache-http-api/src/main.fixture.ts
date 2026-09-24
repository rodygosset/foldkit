import { Option, Result } from 'effect'
import { modifyFields } from 'foldkit/struct'

import { Tabs } from '@foldkit/ui'

import type { Post, PostDetail, Stats } from './data'
import type { Model } from './main'
import { TABS_ID, postDetailQuery, postsQuery, statsQuery } from './main'

export const FETCHED_AT = 1_750_000_000_000

export const fixturePosts: ReadonlyArray<Post> = [
  {
    id: 'first-post',
    title: 'First Post',
    excerpt: 'The first fixture post.',
  },
  {
    id: 'second-post',
    title: 'Second Post',
    excerpt: 'The second fixture post.',
  },
]

export const firstPostDetail: PostDetail = {
  id: 'first-post',
  title: 'First Post',
  author: 'Grace Hopper',
  body: 'The whole body of the first fixture post.',
}

export const fixtureStats: Stats = {
  activeUsers: 120,
  requestsPerSecond: 1234,
  cacheHitRatePercent: 97,
}

const loadingPosts = postsQuery.loadIfMissing(postsQuery.init()).model

export const loadingPostsModel: Model = {
  tabs: Tabs.init({ id: TABS_ID }),
  activeTab: 'Posts',
  posts: loadingPosts,
  postDetailById: postDetailQuery.init(),
  maybeSelectedPostId: Option.none(),
  stats: statsQuery.init(),
}

export const loadedPostsModel = modifyFields(loadingPostsModel, {
  posts: () =>
    postsQuery.update(
      loadingPosts,
      postsQuery.Message.CompletedFetch({
        generation: loadingPosts.generation,
        result: Result.succeed({ posts: fixturePosts, fetchedAt: FETCHED_AT }),
      }),
    ).model,
})

const firstPostArgs = { params: { postId: 'first-post' } }
const loadingFirstPost = postDetailQuery.loadIfMissing(
  postDetailQuery.init(),
  firstPostArgs,
).model

export const cachedFirstPostModel = modifyFields(loadedPostsModel, {
  postDetailById: () =>
    postDetailQuery.update(
      loadingFirstPost,
      postDetailQuery.Message.CompletedFetch({
        args: firstPostArgs,
        generation: loadingFirstPost.generation,
        result: Result.succeed({
          detail: firstPostDetail,
          fetchedAt: FETCHED_AT,
        }),
      }),
    ).model,
})

const loadingStats = statsQuery.loadIfMissing(statsQuery.init()).model

export const loadedStatsModel = modifyFields(loadedPostsModel, {
  activeTab: () => 'Stats',
  stats: () =>
    statsQuery.update(
      loadingStats,
      statsQuery.Message.CompletedFetch({
        generation: loadingStats.generation,
        result: Result.succeed({ stats: fixtureStats, fetchedAt: FETCHED_AT }),
      }),
    ).model,
})
