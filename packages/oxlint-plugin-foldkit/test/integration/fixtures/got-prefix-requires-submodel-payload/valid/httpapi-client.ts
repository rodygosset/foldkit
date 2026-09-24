import { Schema } from 'effect'
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import * as Query from 'foldkit/experimental/query'

const PostsApi = HttpApi.make('Posts').add(HttpApiGroup.make('posts').add(HttpApiEndpoint.get('list', '/posts', { success: Schema.Array(Schema.String) })))
export class PostsClient extends Query.HttpApi.Service<PostsClient>()('PostsClient', { api: PostsApi }) {}
