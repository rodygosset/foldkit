import { Effect, Schema } from 'effect'
import { expectTypeOf } from 'vitest'

import * as Form from './index.js'

class EmailTaken extends Schema.TaggedError<EmailTaken>()('EmailTaken', {
  email: Schema.String,
}) {}

const email = Form.field({ schema: Schema.String, initial: { value: '' } })

const fieldErrorChecks = () => {
  Form.define({
    name: 'TypedRejection',
    fields: { email },
    submit: {
      error: EmailTaken,
      execute: () => Effect.void,
      toFieldErrors: error => {
        expectTypeOf(error).toEqualTypeOf<EmailTaken>()
        return { email: `${error.email} is already registered` }
      },
    },
  })

  const unknownFieldConfig = {
    name: 'UnknownField',
    fields: { email },
    submit: {
      error: EmailTaken,
      execute: () => Effect.void,
      toFieldErrors: () => ({ username: 'Taken' }),
    },
  }
  // @ts-expect-error A field error must name a field of the Form.
  Form.define(unknownFieldConfig)

  const mixedFieldErrorsConfig = {
    name: 'MixedFieldErrors',
    fields: { email },
    submit: {
      error: EmailTaken,
      execute: () => Effect.void,
      toFieldErrors: () => ({ email: 'Taken', emial: 'Taken' }),
    },
  }
  // @ts-expect-error Every field error must name a field of the Form.
  Form.define(mixedFieldErrorsConfig)

  const branchFieldErrorsConfig = {
    name: 'BranchFieldErrors',
    fields: { email, invite: email },
    submit: {
      error: EmailTaken,
      execute: () => Effect.void,
      toFieldErrors: (error: EmailTaken) =>
        error.email === '' ? { email: 'Taken' } : { invte: 'Expired' },
    },
  }
  // @ts-expect-error A misspelled field in one branch is rejected.
  Form.define(branchFieldErrorsConfig)

  Form.define({
    name: 'ValidBranchFieldErrors',
    fields: { email, invite: email },
    submit: {
      error: EmailTaken,
      execute: () => Effect.void,
      toFieldErrors: error =>
        error.email === '' ? { email: 'Taken' } : { invite: 'Expired' },
    },
  })

  const noErrorCodecConfig = {
    name: 'NoErrorCodec',
    fields: { email },
    submit: {
      execute: () => Effect.void,
      toFieldErrors: () => ({ email: 'Taken' }),
    },
  }
  // @ts-expect-error A submission that cannot fail has no errors to map.
  Form.define(noErrorCodecConfig)
}
void fieldErrorChecks
