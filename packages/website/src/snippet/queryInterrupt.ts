const postsQuery = Query.define({
  name: 'Posts',
  data: PostList,
  error: Schema.String,
  execute: fetchPosts,
  interrupt: true,
})

const Model = Schema.Struct({ posts: postsQuery.Model })
type Model = typeof Model.Type

const Message = defineMessageUnion({
  GotPostsMessage: { message: postsQuery.Message },
  ClickedCancelPosts: {},
  ClickedReloadPosts: {},
})
type Message = typeof Message.Type

const posts = postsQuery.lift<Model, Message>({
  parentField: 'posts',
  toParentMessage: message => Message.GotPostsMessage({ message }),
})

const init = () => {
  const model = Model.make({ posts: postsQuery.init('home-posts') })

  return posts.loadIfMissing(model)
}

const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    GotPostsMessage: ({ message }) => posts.fold(model, message),
    ClickedCancelPosts: () => posts.reset(model),
    ClickedReloadPosts: () => posts.replace(model),
  })
