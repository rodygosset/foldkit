Subscription.make<Model, Message>()(entry => ({
  watchWeather: weatherChild.watchSubscription(
    entry,
    model => model.isWatchingWeather,
  ),
}))
