import { Schema } from 'effect'
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import * as Query from 'foldkit/experimental/query'
import { defineMessageUnion } from 'foldkit/message'

const PostsApi = HttpApi.make('Posts').add(HttpApiGroup.make('posts').add(HttpApiEndpoint.get('list', '/posts', { success: Schema.Array(Schema.String) })))
class PostsClient extends Query.HttpApi.Service<PostsClient>()('PostsClient', { api: PostsApi }) {}
const postsQuery = PostsClient.query('Posts', 'posts', 'list')
export const Message = defineMessageUnion({ GotPostsMessage: { message: postsQuery.Message } })
