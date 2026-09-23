const postsQuery = Query.define({
  name: 'Posts',
  data: Schema.Array(Post),
  error: Schema.String,
  execute: fetchPosts,
  interrupt: true,
})

const posts = postsQuery.init('home')
