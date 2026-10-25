import { Effect, Schema } from 'effect'
import { Form } from 'foldkit/experimental'
import { defineMessageUnion } from 'foldkit/message'

const ScheduleTour = Schema.Struct({
  prospect: Schema.String.check(
    Schema.isMinLength(2, { message: 'Enter the full name' }),
  ),
  partySize: Schema.Number.annotate({ message: 'Enter a number' }).check(
    Schema.isInt({ message: 'Enter a whole number' }),
    Schema.isGreaterThan(0, { message: 'Enter a number above 0' }),
  ),
  hasPets: Schema.Boolean,
  stage: Schema.Literals(['Lead', 'Tour', 'Lease']).annotate({
    message: 'Choose a stage',
  }),
  notes: Schema.optionalKey(Schema.String),
})

class ProspectBlocked extends Schema.TaggedError<ProspectBlocked>()(
  'ProspectBlocked',
  { prospect: Schema.String },
) {}

declare const scheduleTour: (
  tour: typeof ScheduleTour.Type,
) => Effect.Effect<void, ProspectBlocked>

export const tourForm = Form.fromSchema({
  name: 'ScheduleTour',
  schema: ScheduleTour,
  fields: { prospect: { validateOn: 'Blur' } },
  submit: {
    error: ProspectBlocked,
    execute: scheduleTour,
    toFieldErrors: ({ prospect }) => ({
      prospect: `${prospect} cannot book tours`,
    }),
  },
})

export const Model = Schema.Struct({ tour: tourForm.Model })
export type Model = typeof Model.Type
export const Message = defineMessageUnion({
  GotTourMessage: { message: tourForm.Message },
  SubmittedTour: {},
})
export type Message = typeof Message.Type
