import { PostsClient } from './httpapi-client'
import { defineMessageUnion } from 'foldkit/message'

const postsQuery = PostsClient.query('Posts', 'posts', 'list')
export const Message = defineMessageUnion({ GotPostsMessage: { message: postsQuery.Message } })
