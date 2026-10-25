# Form

:::Warning{label="Experimental"}
Form ships from `foldkit/experimental` and `foldkit/experimental/form`. Its names, types, and Model shape may change before it enters Foldkit's stable API.
:::

:::Info{label="See it in an app"}
[Experimental Form](/example-apps/experimental-form) reuses one email field in a registration Form and a profile Form. It shows validation on change and on blur, an async email check, a topics array rendered as checkboxes, edit defaults, a failing submission, reset during a save, and Story and Scene tests.
:::

## Overview

### Form State in the Parent Update

A form in a Foldkit application usually repeats the same pieces for every field: the current value, the default it resets to, validation results, whether the person has touched it, and a submission state that moves from idle to saving to done. Writing those transitions by hand in each parent update buries the decisions the application actually makes.

Form is a viewless Submodel that owns those transitions. You describe each field with an Effect Schema and its validation, and you give the Form a submission Effect. The Form Model holds every field's state and the submission state. Form operations return the next Model and any validation or submission Commands. The Runtime performs those Commands later.

### What the Parent Decides

The parent stores the Form Model, wraps Form Messages in its own Message, and decides when to submit and when to reset. It renders ordinary HTML from the values the Form's selectors return. Form never renders anything.

### When to Use Form

Use Form for a flat set of fields. Each field holds one value: a scalar, or an immutable compound value such as a readonly array, an `Option`, or a tagged union. Form doesn't handle:

- Nested field paths, or per-element state inside an array field
- Validation that depends on more than one field
- Debouncing or cancelling async field checks

Use [Field Validation](/core/field-validation) directly when the application needs a different field lifecycle.

## Define a Form

### Define Fields

`Form.field` takes a Schema, an initial value, and optional validation. Each value is wrapped in a `value` property: `initial: { value: '' }`. A field has no name. Its key in `Form.define` names it, so one field definition can appear in several Forms, and each Form keeps its own state for it.

::Snippet{name="formDefine" label="Reusable and inline Form fields"}

Validation has three optional parts:

- `rules` comes from `FieldValidation.makeRules` and checks the decoded value synchronously.
- `validate` is an Effect that returns error messages, for checks that need a service or a network request. It runs only after `rules` pass.
- `validateOn` is `'Change'` (the default) or `'Blur'`. A `'Blur'` field clears its errors when the value changes and checks again on blur.

Submitting checks every field, whatever its `validateOn`.

`Form.Values<typeof registrationForm>` is the record of decoded values that the submission Effect receives. Use `typeof registrationForm.Model.Type` and `typeof registrationForm.Message.Type` when you need to name a Form's Model or Message type.

### Field Values and Schemas

The field's Schema decides the type of its initial value, its change payload, the value the selectors return, and the value submission receives. A transformed codec works: a `Schema.NumberFromString` field holds a number and encodes it as a string.

Field Schemas become part of the Form's Model and Message Schemas, so they must decode and encode synchronously without services. Their values must be serializable Model data, so functions and DOM handles can't be field values.

::Snippet{name="formCompoundValues" label="Compound and optional field values"}

An absent value is an `Option`. `Schema.OptionFromOptionalKey(Schema.String)` encodes `None` as a missing key, and `Schema.OptionFromNullOr(Schema.String)` encodes it as `null`. For a required `Option` field, set `isEmpty` to `Option.isNone` in its rules. Strings and arrays use the default empty check.

An array field is one value with one set of errors and metadata. A change replaces the whole array.

### Service Requirements

A field's `validate` Effect and the submission Effect can require services. Form carries those requirements onto the Commands its operations return, so the application provides them the same way it provides services to any other Command.

## Connect the Form to Its Parent

Put the Form's Model Schema in the parent Model and wrap its Message Schema in a `Got*` Message. `lift` adapts the Form's operations to the parent Model and Message.

::Snippet{name="formParent" label="Submission Effect and parent wiring"}

The lifted Form has four operations:

- `fold` applies a Form Message and returns the parent Model with any Commands mapped to parent Messages.
- `submit` starts a submission attempt.
- `reset` restores the Form's defaults.
- `reinitialize` replaces the Form's defaults and restores them.

### Optional and Nested Forms

`parentField` works only when the parent field always holds a complete Form Model. When the Form is optional, nested, or one of several, pass a lens instead: `lift({ read, write, toParentMessage })`. It follows [`Update.foldChild`](/core/submodel#fold-child). When `read` returns `None`, every lifted operation returns the parent Model unchanged and no Commands.

When the parent stores extra data next to the Form Model, `write` must keep that data. `reinitialize` hands `write` a brand new Form Model, so a `write` that only copies the Form's fields drops the extra data.

## Submit a Form

### Configure Submission

`submit.execute` receives the decoded values and returns an Effect. Form runs it inside its `Submit` Command after every field passes validation.

- When the Effect returns a value, add a `data` Schema for it. Omit `data` when it returns `void`.
- When the Effect can fail, add an `error` Schema for its error type. Omit `error` when it can't fail.

Both Schemas must decode and encode synchronously without services, like field Schemas.

### The Submission Lifecycle

Call `lifted.submit(parentModel)`, or `form.submit(model)` on the Form Model directly. Submit counts one attempt and checks every field's `rules`. For each field whose rules pass, that has a `validate` Effect, and whose current value hasn't already passed or started that check, Form returns a validation Command and the submission is `Validating`.

Once no check is pending, Form decides the attempt:

- If any field is invalid, its errors appear and the submission returns to `Idle`. The submission Effect doesn't run.
- If every field is valid, the submission is `Submitting` and Form returns the `Submit` Command.

When a validation Command's result completes the checks, folding it is what returns the `Submit` Command. The parent doesn't submit again.

Folding the `Submit` result moves the submission to `Succeeded` with the typed data or `Failed` with the typed error. Read it with `submission(model)` and match it with `form.Submission.match`.

While the submission is `Validating` or `Submitting`, another submit does nothing. Editing a field while `Validating` cancels the attempt. Editing a field while `Submitting` doesn't: the `Submit` Command already captured the values it sends. Editing after `Succeeded` or `Failed` returns the submission to `Idle`.

### Show Submission Errors on Fields

A server can reject a submission because of one field, for example an email that is already registered. `submit.toFieldErrors` takes the typed error and returns a message for each field it concerns. Form shows each message as that field's error, next to the input that caused it. Here `signUp` is an application function that returns an Effect, which fails with `SignupError`:

::Snippet{name="formFieldErrors" label="Submission errors mapped to fields"}

- The submission is `Failed` with the typed error whatever `toFieldErrors` returns. For an error that concerns no field, return `{}` and render the error from the submission.
- A field keeps its mapped error until its value changes. A blur without a change keeps the error.
- The next submit checks the field again and sends its value, so the server decides again.
- `toFieldErrors` is available only when `submit.error` is present. TypeScript rejects a key that is not a field name.

A message applies to a field only while it holds the value that was sent. If the person changed the field while the submission was pending, the field keeps the state of its new value.

### Stale Results

Each submission attempt and each field check carries a generation number. Form accepts a result only when its generation matches the attempt or check it is waiting for. A result from before a reset, from an older attempt, or from a check that a later edit replaced leaves the Form unchanged. The generations are plain numbers in the Form Model.

Route every Form Message back through the same lifted Form that started the work. A generation identifies an attempt within one Form slot, not across slots.

### Initial Values and Reset

`init()` builds a Form from each field's `initial`. Pass overrides to start from other values, for example an existing record: `init({ email: { value: 'reader@example.com' } })`. Overrides become the Form's defaults, and fields you leave out use their `initial`.

`reset` returns every field to its default and clears validation, interaction metadata, the submission, and the attempt count. Use `reinitialize(model, overrides)` to load a different record into a Form that already exists. It replaces the defaults and then resets.

Use `init` only to build a new parent Model. Replacing a live Form with `init()` would restart its generations, so a result from before the replacement could match a new attempt. `reset` and `reinitialize` keep the generations.

## Read Fields and Render HTML

Render from the Form's selectors rather than from its Model fields:

- `field(model, name)` returns the field's `value`, its `errors`, and `meta` with `isTouched`, `isBlurred`, `isDirty`, and `isDefaultValue`.
- `values(model)` returns every field's value, indexed by name.
- `submission(model)` returns the submission state.
- `submitCount(model)` returns the number of attempts since the Form was built, reset, or reinitialized.

::Snippet{name="formView" label="Rendering a Form with ordinary input events"}

A change marks the field touched and dirty. `isDirty` stays true even when the value returns to its default. `isDefaultValue` compares the current value with the default using the equivalence derived from the field's Schema, so arrays and records compare by content. Override that comparison with `Schema.overrideToEquivalence` on the field's Schema.

Field values are immutable. Change a field by sending a Message with its complete new value, as the topics checkboxes in the example app do.

## Derive a Form from a Schema

When a Schema already describes what a form sends, such as the payload of a command your server accepts, `Form.fromSchema` builds the Form from that Schema. You don't write a field list. Each property of the Struct becomes a field, decoding a field's input with its property Schema is the field's validation, and the submission Effect receives the Struct value built from the decoded properties. The result has every operation of a `Form.define` definition, so you connect it to the parent and render it the same way.

Here `scheduleTour` is an application function that returns an Effect, which fails with `ProspectBlocked`:

::Snippet{name="formFromSchema" label="A Form derived from a Schema Struct"}

`fromSchema` takes the same `submit` options as `Form.define`, including `toFieldErrors`. `fields` sets `validateOn` for each field that needs it.

### Field Kinds

The decoded type of each property decides the kind of its field. `form.kinds` holds the kind of each field, indexed by name:

| Property type                                                 | Kind      | Field value                             |
| ------------------------------------------------------------- | --------- | --------------------------------------- |
| `string`, a template literal, or strings with string literals | `Text`    | The text as typed                       |
| `number`                                                      | `Number`  | The text as typed                       |
| `boolean`                                                     | `Boolean` | The checkbox state                      |
| Union of string or number literals, or an enum                | `Choice`  | The chosen option as text, `''` if none |

A property marked with `Schema.optionalKey` or `Schema.optional` is an optional field, and its kind has `isOptional: true`. When the text of an optional field is blank, the submission leaves the property out. A `Boolean` field always sends its state.

A property of another type, such as an array or a date, has no field kind. TypeScript reports it on the `schema` option, and `fromSchema` throws if one reaches it at runtime. Write those Forms with `Form.define`.

### Validation Messages

A field is valid when its input decodes with its property Schema. Form shows the first message of a failed decode as the field's error, so the Schema's messages are the messages the person sees. Set them with the `message` annotation on the Schema and on its checks, as the example does.

When a property is encoded as a string, such as `Schema.Trim` or `Schema.NumberFromString`, the text decodes through the property's codec, and the submission receives the transformed value. Other properties decode the text against their decoded type. A `Number` field reads its text as a finite number first. Text that is not a number, and blank text in a required field, get the message for the property's type, `Enter a number` in the example.

Form checks each property on its own. A check on the whole Struct, such as two properties that must match, doesn't run in the Form.

### Render Derived Fields

Use `form.kinds` to choose the control for a field. A `Choice` kind carries its `options`:

::Snippet{name="formFromSchemaView" label="Controls chosen by field kind"}

### Edit an Existing Value

`form.toInputs(value)` turns a decoded value, or part of one, into field inputs. Pass them to `init` or `reinitialize` to edit an existing record: `tourForm.init(tourForm.toInputs(tour))`.

## Test Form Commands

`form.Submit` and `form.ValidateField.<field>` are public so Story and Scene tests can match and resolve them without running their Effects. Start them through `submit` and field changes rather than calling the definitions directly. Calling them directly skips the Model transition and the generation that lets Form accept the result.

The [Experimental Form example](/example-apps/experimental-form) resolves both Commands in its Story and Scene tests.
