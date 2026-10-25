import { Effect, Match, Schema } from 'effect'
import { Form } from 'foldkit/experimental'

class EmailTaken extends Schema.TaggedError<EmailTaken>()('EmailTaken', {
  email: Schema.String,
}) {}

class InviteExpired extends Schema.TaggedError<InviteExpired>()(
  'InviteExpired',
  {},
) {}

class SignupUnavailable extends Schema.TaggedError<SignupUnavailable>()(
  'SignupUnavailable',
  {},
) {}

const SignupError = Schema.Union([EmailTaken, InviteExpired, SignupUnavailable])
type SignupError = typeof SignupError.Type

declare const signUp: (
  values: Readonly<{ email: string; invite: string }>,
) => Effect.Effect<void, SignupError>

export const signupForm = Form.define({
  name: 'Signup',
  fields: {
    email: Form.field({ schema: Schema.String, initial: { value: '' } }),
    invite: Form.field({ schema: Schema.String, initial: { value: '' } }),
  },
  submit: {
    error: SignupError,
    execute: signUp,
    toFieldErrors: error =>
      Match.value(error).pipe(
        Match.tagsExhaustive({
          EmailTaken: ({ email }) => ({
            email: `${email} is already registered`,
          }),
          InviteExpired: () => ({ invite: 'This invite has expired' }),
          SignupUnavailable: () => ({}),
        }),
      ),
  },
})
