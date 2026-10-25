import { Array, Effect, Option, Schema } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import * as Form from './index.js'

const Stage = Schema.Literals(['Lead', 'Tour', 'Lease'])

const ScheduleTour = Schema.Struct({
  prospect: Schema.String.check(
    Schema.isMinLength(2, { message: 'Enter the full name' }),
  ),
  partySize: Schema.Number.annotate({ message: 'Enter a number' }).check(
    Schema.isInt({ message: 'Enter a whole number' }),
    Schema.isGreaterThan(0, { message: 'Enter a number above 0' }),
  ),
  hasPets: Schema.Boolean,
  stage: Stage.annotate({ message: 'Choose a stage' }),
  notes: Schema.optionalKey(Schema.String),
  floor: Schema.optional(Schema.Number),
})

describe('field kinds', () => {
  it('derives a field kind from each property of the Schema', () => {
    const tourForm = Form.fromSchema({
      name: 'ScheduleTour',
      schema: ScheduleTour,
      submit: { execute: () => Effect.void },
    })

    expect(tourForm.kinds).toEqual({
      prospect: Form.FieldKind.Text({ isOptional: false }),
      partySize: Form.FieldKind.Number({ isOptional: false }),
      hasPets: Form.FieldKind.Boolean(),
      stage: Form.FieldKind.Choice({
        isOptional: false,
        options: ['Lead', 'Tour', 'Lease'],
      }),
      notes: Form.FieldKind.Text({ isOptional: true }),
      floor: Form.FieldKind.Number({ isOptional: true }),
    })
  })
})

const makeTourForm = () => {
  const execute = vi.fn((_payload: typeof ScheduleTour.Type) => Effect.void)
  const tourForm = Form.fromSchema({
    name: 'ScheduleTour',
    schema: ScheduleTour,
    fields: { prospect: { validateOn: 'Blur' } },
    submit: { execute },
  })

  return { tourForm, execute }
}

const runFirstCommand = <Message>(
  commands:
    | ReadonlyArray<{ readonly effect: Effect.Effect<Message> }>
    | undefined,
): Message => {
  const maybeCommand = Array.head(commands ?? [])
  if (Option.isNone(maybeCommand)) {
    throw new Error('Expected a Command')
  }
  return Effect.runSync(maybeCommand.value.effect)
}

const submittedPayload = (
  execute: Readonly<{
    mock: Readonly<{ calls: ReadonlyArray<ReadonlyArray<unknown>> }>
  }>,
) =>
  Array.last(execute.mock.calls).pipe(
    Option.flatMap(Array.head),
    Option.getOrThrow,
  )

describe('validation from the Schema', () => {
  it('shows the Schema message of each property that does not decode', () => {
    const { tourForm, execute } = makeTourForm()
    const submit = tourForm.submit(tourForm.init())

    expect(tourForm.field(submit.model, 'prospect').errors).toEqual([
      'Enter the full name',
    ])
    expect(tourForm.field(submit.model, 'partySize').errors).toEqual([
      'Enter a number',
    ])
    expect(tourForm.field(submit.model, 'stage').errors).toEqual([
      'Choose a stage',
    ])
    expect(tourForm.field(submit.model, 'hasPets').errors).toEqual([])
    expect(tourForm.field(submit.model, 'notes').errors).toEqual([])
    expect(tourForm.field(submit.model, 'floor').errors).toEqual([])
    expect(tourForm.submission(submit.model)._tag).toBe('Idle')
    expect(submit.commands ?? []).toEqual([])
    expect(execute).not.toHaveBeenCalled()
  })

  it.each([
    ['abc', 'Enter a number'],
    ['NaN', 'Enter a number'],
    ['   ', 'Enter a number'],
    ['1.5', 'Enter a whole number'],
    ['0', 'Enter a number above 0'],
  ])('rejects the number input %j', (value, message) => {
    const { tourForm } = makeTourForm()
    const change = tourForm.update(
      tourForm.init(),
      tourForm.changed('partySize', { value }),
    )

    expect(tourForm.field(change.model, 'partySize').errors).toEqual([message])
  })

  it('checks a field on blur when its options ask for it', () => {
    const { tourForm } = makeTourForm()
    const change = tourForm.update(
      tourForm.init(),
      tourForm.changed('prospect', { value: 'A' }),
    )

    expect(tourForm.field(change.model, 'prospect').errors).toEqual([])

    const blur = tourForm.update(change.model, tourForm.blurred('prospect'))

    expect(tourForm.field(blur.model, 'prospect').errors).toEqual([
      'Enter the full name',
    ])
  })

  it('rejects a choice that is not one of the options', () => {
    const { tourForm } = makeTourForm()
    const change = tourForm.update(
      tourForm.init(),
      tourForm.changed('stage', { value: 'Closed' }),
    )

    expect(tourForm.field(change.model, 'stage').errors).toEqual([
      'Choose a stage',
    ])
  })
})

describe('submission payload', () => {
  it('sends the decoded Struct value and omits empty optional properties', () => {
    const { tourForm, execute } = makeTourForm()
    const model = tourForm.init({
      prospect: { value: 'Ada Lovelace' },
      partySize: { value: ' 3 ' },
      hasPets: { value: true },
      stage: { value: 'Tour' },
    })
    const submit = tourForm.submit(model)

    expect(tourForm.submission(submit.model)._tag).toBe('Submitting')

    runFirstCommand(submit.commands)

    expect(submittedPayload(execute)).toStrictEqual({
      prospect: 'Ada Lovelace',
      partySize: 3,
      hasPets: true,
      stage: 'Tour',
    })
  })

  it('sends filled optional properties', () => {
    const { tourForm, execute } = makeTourForm()
    const model = tourForm.init({
      prospect: { value: 'Ada Lovelace' },
      partySize: { value: '2' },
      stage: { value: 'Lead' },
      notes: { value: 'Ring twice' },
      floor: { value: '4' },
    })

    runFirstCommand(tourForm.submit(model).commands)

    expect(submittedPayload(execute)).toStrictEqual({
      prospect: 'Ada Lovelace',
      partySize: 2,
      hasPets: false,
      stage: 'Lead',
      notes: 'Ring twice',
      floor: 4,
    })
  })

  it('decodes number literal choices', () => {
    const execute = vi.fn(
      (_payload: { readonly rooms: 1 | 2 | 3 }) => Effect.void,
    )
    const roomsForm = Form.fromSchema({
      name: 'Rooms',
      schema: Schema.Struct({ rooms: Schema.Literals([1, 2, 3]) }),
      submit: { execute },
    })

    expect(roomsForm.kinds.rooms).toEqual(
      Form.FieldKind.Choice({ isOptional: false, options: ['1', '2', '3'] }),
    )

    const change = roomsForm.update(
      roomsForm.init(),
      roomsForm.changed('rooms', { value: '2' }),
    )
    runFirstCommand(roomsForm.submit(change.model).commands)

    expect(submittedPayload(execute)).toStrictEqual({ rooms: 2 })
  })
})

describe('inputs from a decoded value', () => {
  it('starts a Form from an existing value and submits it unchanged', () => {
    const { tourForm, execute } = makeTourForm()
    const tour = ScheduleTour.make({
      prospect: 'Grace Hopper',
      partySize: 2,
      hasPets: true,
      stage: 'Lease',
      floor: 7,
    })
    const model = tourForm.init(tourForm.toInputs(tour))

    expect(tourForm.values(model)).toEqual({
      prospect: 'Grace Hopper',
      partySize: '2',
      hasPets: true,
      stage: 'Lease',
      notes: '',
      floor: '7',
    })

    runFirstCommand(tourForm.submit(model).commands)

    expect(submittedPayload(execute)).toStrictEqual(tour)
  })
})

const submitInputs = <Fields extends Schema.Struct.Fields>(
  schema: Schema.Struct<Fields>,
  inputs: Readonly<Record<string, string | boolean>>,
) => {
  const execute = vi.fn((_payload: unknown) => Effect.void)
  const form = Reflect.apply(Form.fromSchema, undefined, [
    { name: 'Probe', schema, submit: { execute } },
  ])
  const model = form.init(
    Object.fromEntries(
      Object.entries(inputs).map(([name, value]) => [name, { value }]),
    ),
  )
  const submit = form.submit(model)
  const commands: ReadonlyArray<Readonly<{ effect: Effect.Effect<unknown> }>> =
    submit.commands ?? []

  return {
    form,
    submit,
    maybePayload: Option.map(Array.head(commands), command => {
      Effect.runSync(command.effect)
      return submittedPayload(execute)
    }),
  }
}

describe('property shapes', () => {
  it('sets a required undefined property to undefined when its text is blank', () => {
    const { maybePayload } = submitInputs(
      Schema.Struct({ nickname: Schema.UndefinedOr(Schema.String) }),
      { nickname: '' },
    )

    expect(Option.getOrThrow(maybePayload)).toStrictEqual({
      nickname: undefined,
    })
  })

  it('leaves out an optional property when its text is only spaces', () => {
    const { maybePayload } = submitInputs(
      Schema.Struct({
        notes: Schema.optionalKey(Schema.String),
        stage: Schema.optionalKey(Schema.Literals(['Lead', 'Tour'])),
      }),
      { notes: '   ', stage: '' },
    )

    expect(Option.getOrThrow(maybePayload)).toStrictEqual({})
  })

  it('requires a true literal to be checked', () => {
    const Terms = Schema.Struct({
      accepted: Schema.Literal(true).annotate({ message: 'Accept the terms' }),
    })
    const declined = submitInputs(Terms, { accepted: false })
    const accepted = submitInputs(Terms, { accepted: true })

    expect(
      declined.form.field(declined.submit.model, 'accepted').errors,
    ).toEqual(['Accept the terms'])
    expect(Option.getOrThrow(accepted.maybePayload)).toStrictEqual({
      accepted: true,
    })
  })

  it('decodes text through a transformed property codec', () => {
    const Profile = Schema.Struct({
      name: Schema.Trim.check(Schema.isMinLength(2)),
      age: Schema.NumberFromString,
    })
    const { maybePayload } = submitInputs(Profile, {
      name: '  Ada ',
      age: '36',
    })

    expect(Option.getOrThrow(maybePayload)).toStrictEqual({
      name: 'Ada',
      age: 36,
    })

    const execute = vi.fn((_payload: typeof Profile.Type) => Effect.void)
    const profileForm = Form.fromSchema({
      name: 'Profile',
      schema: Profile,
      submit: { execute },
    })

    expect(profileForm.toInputs({ name: 'Ada', age: 36 })).toEqual({
      name: { value: 'Ada' },
      age: { value: '36' },
    })
  })

  it('decodes an optional transformed property through its codec', () => {
    const { maybePayload } = submitInputs(
      Schema.Struct({ nickname: Schema.optional(Schema.Trim) }),
      { nickname: ' Ada ' },
    )

    expect(Option.getOrThrow(maybePayload)).toStrictEqual({ nickname: 'Ada' })
  })

  it.each(['abc', 'NaN', 'Infinity'])(
    'rejects %j for a number decoded from text',
    text => {
      const { form, submit } = submitInputs(
        Schema.Struct({
          age: Schema.NumberFromString.annotate({ message: 'Enter an age' }),
        }),
        { age: text },
      )

      expect(form.field(submit.model, 'age').errors).toEqual(['Enter an age'])
      expect(submit.commands ?? []).toEqual([])
    },
  )

  it('treats a template literal or a union with a string as text', () => {
    const Reference = Schema.Struct({
      code: Schema.TemplateLiteral(['REF-', Schema.Number]),
      label: Schema.Union([Schema.Literal('None'), Schema.String]),
    })
    const { form, maybePayload } = submitInputs(Reference, {
      code: 'REF-12',
      label: 'Garden',
    })

    expect(form.kinds).toEqual({
      code: Form.FieldKind.Text({ isOptional: false }),
      label: Form.FieldKind.Text({ isOptional: false }),
    })
    expect(Option.getOrThrow(maybePayload)).toStrictEqual({
      code: 'REF-12',
      label: 'Garden',
    })

    const invalid = submitInputs(Reference, { code: 'REF-x', label: '' })

    expect(
      invalid.form.field(invalid.submit.model, 'code').errors,
    ).toHaveLength(1)
  })

  it('joins an enum with a string as text and with a number as a number', () => {
    const { form, maybePayload } = submitInputs(
      Schema.Struct({
        label: Schema.Union([Schema.String, Schema.Enum({ None: 'none' })]),
        size: Schema.Union([Schema.Number, Schema.Enum({ Default: 0 })]),
      }),
      { label: 'Garden', size: '3' },
    )

    expect(form.kinds).toEqual({
      label: Form.FieldKind.Text({ isOptional: false }),
      size: Form.FieldKind.Number({ isOptional: false }),
    })
    expect(Option.getOrThrow(maybePayload)).toStrictEqual({
      label: 'Garden',
      size: 3,
    })
  })

  it('offers the values of an enum as choices', () => {
    const Priority = { Low: 'low', High: 'high' } as const
    const Ticket = Schema.Struct({ priority: Schema.Enum(Priority) })
    const { form, maybePayload } = submitInputs(Ticket, { priority: 'high' })

    expect(form.kinds.priority).toEqual(
      Form.FieldKind.Choice({ isOptional: false, options: ['low', 'high'] }),
    )
    expect(Option.getOrThrow(maybePayload)).toStrictEqual({
      priority: Priority.High,
    })
  })

  it('rejects number text that is not finite', () => {
    const { form, submit } = submitInputs(
      Schema.Struct({
        price: Schema.Number.annotate({ message: 'Enter a price' }),
      }),
      { price: 'Infinity' },
    )

    expect(form.field(submit.model, 'price').errors).toEqual(['Enter a price'])
  })
})

describe('unsupported properties', () => {
  it('names a property that has no derived field', () => {
    const Tagged = Schema.Struct({
      name: Schema.String,
      tags: Schema.Array(Schema.String),
    })

    expect(() =>
      Reflect.apply(Form.fromSchema, undefined, [
        {
          name: 'Tagged',
          schema: Tagged,
          submit: { execute: () => Effect.void },
        },
      ]),
    ).toThrow('Form.fromSchema cannot derive a field for "tags"')
  })
})

class ProspectBlocked extends Schema.TaggedError<ProspectBlocked>()(
  'ProspectBlocked',
  { prospect: Schema.String },
) {}

describe('submission errors', () => {
  it('maps a typed submission error to a derived field', () => {
    const tourForm = Form.fromSchema({
      name: 'BlockedTour',
      schema: ScheduleTour,
      submit: {
        error: ProspectBlocked,
        execute: ({ prospect }) =>
          Effect.fail(new ProspectBlocked({ prospect })),
        toFieldErrors: ({ prospect }) => ({
          prospect: `${prospect} cannot book tours`,
        }),
      },
    })
    const model = tourForm.init(
      tourForm.toInputs({
        prospect: 'Ada Lovelace',
        partySize: 1,
        stage: 'Lead',
      }),
    )
    const submit = tourForm.submit(model)
    const rejection = tourForm.update(
      submit.model,
      runFirstCommand(submit.commands),
    )

    expect(tourForm.field(rejection.model, 'prospect').errors).toEqual([
      'Ada Lovelace cannot book tours',
    ])
    expect(tourForm.submission(rejection.model)._tag).toBe('Failed')
  })
})
