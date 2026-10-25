import { Context, Effect, Schema } from 'effect'
import { expectTypeOf } from 'vitest'

import type { Command } from '../../command/index.js'
import * as Form from './index.js'

const Booking = Schema.Struct({
  guest: Schema.String,
  nights: Schema.Number,
  isPaid: Schema.Boolean,
  room: Schema.Literals(['Single', 'Double']),
  note: Schema.optionalKey(Schema.String),
})

class BookingRefused extends Schema.TaggedError<BookingRefused>()(
  'BookingRefused',
  { room: Schema.String },
) {}

class SaveBooking extends Context.Service<
  SaveBooking,
  { save: (booking: typeof Booking.Type) => Effect.Effect<void> }
>()('SaveBooking') {}

const bookingForm = Form.fromSchema({
  name: 'Booking',
  schema: Booking,
  submit: {
    error: BookingRefused,
    execute: booking => {
      expectTypeOf(booking).toEqualTypeOf<typeof Booking.Type>()
      return Effect.void
    },
    toFieldErrors: error => {
      expectTypeOf(error).toEqualTypeOf<BookingRefused>()
      return { room: `${error.room} is not available` }
    },
  },
})

const fieldValueChecks = () => {
  const model = bookingForm.init()

  expectTypeOf(bookingForm.values(model)).toEqualTypeOf<{
    readonly guest: string
    readonly nights: string
    readonly isPaid: boolean
    readonly room: string
    readonly note: string
  }>()
  expectTypeOf(bookingForm.kinds.room).toEqualTypeOf<Form.FieldKind>()
  expectTypeOf(bookingForm.toInputs)
    .parameter(0)
    .toEqualTypeOf<Partial<typeof Booking.Type>>()

  // @ts-expect-error A Number field holds the text a person typed.
  bookingForm.changed('nights', { value: 2 })
  // @ts-expect-error A derived Form has only the Struct's properties.
  bookingForm.changed('guests', { value: 'Ada' })
}
void fieldValueChecks

const requirementChecks = () => {
  const savedForm = Form.fromSchema({
    name: 'SavedBooking',
    schema: Booking,
    submit: {
      execute: booking =>
        Effect.gen(function* () {
          const bookings = yield* SaveBooking
          yield* bookings.save(booking)
        }),
    },
  })
  const submit = savedForm.submit(savedForm.init())

  expectTypeOf(submit.commands).toEqualTypeOf<
    | ReadonlyArray<Command<typeof savedForm.Message.Type, never, SaveBooking>>
    | undefined
  >()
}
void requirementChecks

const unsupportedChecks = () => {
  const Tagged = Schema.Struct({
    name: Schema.String,
    tags: Schema.Array(Schema.String),
  })

  Form.fromSchema({
    name: 'Tagged',
    // @ts-expect-error A property without a derived field kind is rejected.
    schema: Tagged,
    submit: { execute: () => Effect.void },
  })

  Form.fromSchema({
    name: 'UnknownOption',
    schema: Booking,
    // @ts-expect-error Field options must name a property of the Struct.
    fields: { guests: { validateOn: 'Blur' } },
    submit: { execute: () => Effect.void },
  })

  const unknownFieldErrorConfig = {
    name: 'UnknownFieldError',
    schema: Booking,
    submit: {
      error: BookingRefused,
      execute: () => Effect.void,
      toFieldErrors: () => ({ suite: 'Taken' }),
    },
  }
  // @ts-expect-error A field error must name a property of the Struct.
  Form.fromSchema(unknownFieldErrorConfig)

  const mixedFieldErrorsConfig = {
    name: 'MixedFieldErrors',
    schema: Booking,
    submit: {
      error: BookingRefused,
      execute: () => Effect.void,
      toFieldErrors: () => ({ room: 'Taken', rooom: 'Taken' }),
    },
  }
  // @ts-expect-error Every field error must name a property of the Struct.
  Form.fromSchema(mixedFieldErrorsConfig)

  const anyConfig = {
    name: 'AnyField',
    schema: Schema.Struct({ value: Schema.Any }),
    submit: { execute: () => Effect.void },
  }
  // @ts-expect-error A property of type any has no derived field kind.
  Form.fromSchema(anyConfig)

  const wideUnionConfig = {
    name: 'WideUnion',
    schema: Schema.Struct({
      value: Schema.Union([Schema.String, Schema.Number]),
    }),
    submit: { execute: () => Effect.void },
  }
  // @ts-expect-error A property that is any string or any number has no derived field kind.
  Form.fromSchema(wideUnionConfig)
}
void unsupportedChecks

const supportedChecks = () => {
  const labelForm = Form.fromSchema({
    name: 'Label',
    schema: Schema.Struct({
      label: Schema.Union([Schema.Literal('None'), Schema.String]),
      code: Schema.TemplateLiteral(['REF-', Schema.Number]),
      size: Schema.Literals(['S', 1]),
    }),
    submit: {
      error: BookingRefused,
      execute: () => Effect.void,
      toFieldErrors: error =>
        error.room === '' ? { label: 'Taken' } : { code: 'Taken' },
    },
  })

  expectTypeOf(labelForm.values(labelForm.init())).toEqualTypeOf<{
    readonly label: string
    readonly code: string
    readonly size: string
  }>()
}
void supportedChecks
