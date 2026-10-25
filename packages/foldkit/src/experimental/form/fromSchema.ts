import {
  Array,
  Effect,
  Function,
  Number,
  Option,
  Predicate,
  Result,
  Schema,
  SchemaAST,
  SchemaIssue,
  String,
} from 'effect'

import * as FieldValidation from '../../fieldValidation/index.js'
import { defineTaggedUnion } from '../../schema/index.js'
import {
  type ExactFieldErrors,
  type FieldDefinition,
  type FieldErrors,
  type FieldSchema,
  type FormDefinition,
  type FormInputs,
  type SubmitEffectFor,
  type ValidationTrigger,
  define,
  field,
} from './form.js'

/** The control a derived field needs, read from its Schema property. `Text`
 * and `Number` fields hold the text a person typed, `Boolean` fields hold a
 * checkbox state, and `Choice` fields hold one of `options` as text. An
 * optional field submits no value when its text is blank.
 *
 * @experimental Ships from `foldkit/experimental/form`; expect breaking changes while the API settles.
 */
export const FieldKind = defineTaggedUnion({
  Text: { isOptional: Schema.Boolean },
  Number: { isOptional: Schema.Boolean },
  Boolean: {},
  Choice: {
    isOptional: Schema.Boolean,
    options: Schema.Array(Schema.String),
  },
})

/** The control a derived field needs. See {@link FieldKind}.
 *
 * @experimental Ships from `foldkit/experimental/form`; expect breaking changes while the API settles.
 */
export type FieldKind = typeof FieldKind.Type

type IsAny<T> = 0 extends 1 & T ? true : false

type InputSchemaForValue<Value> =
  IsAny<Value> extends true
    ? never
    : [Value] extends [never]
      ? never
      : [Value] extends [boolean]
        ? typeof Schema.Boolean
        : [Value] extends [string]
          ? typeof Schema.String
          : [Value] extends [number]
            ? typeof Schema.String
            : [Value] extends [string | number]
              ? string extends Value
                ? never
                : number extends Value
                  ? never
                  : typeof Schema.String
              : never

/** The field Schema that {@link fromSchema} derives for one Schema property:
 * `Schema.Boolean` for a boolean property and `Schema.String` for a string,
 * number, or literal property. A property of another type, or one whose
 * Schema needs services, has no derived field.
 *
 * @experimental Ships from `foldkit/experimental/form`; expect breaking changes while the API settles.
 */
export type InputSchema<Property extends Schema.Constraint> = [
  Property['DecodingServices'] | Property['EncodingServices'],
] extends [never]
  ? InputSchemaForValue<Exclude<Property['Type'], undefined>>
  : never

/** The field Schemas that {@link fromSchema} derives for a Struct's fields.
 *
 * @experimental Ships from `foldkit/experimental/form`; expect breaking changes while the API settles.
 */
export type InputSchemas<Fields extends Schema.Struct.Fields> = {
  readonly [Name in keyof Fields & string]: InputSchema<Fields[Name]>
}

type UnsupportedNames<Fields extends Schema.Struct.Fields> = {
  [Name in keyof Fields & string]: [InputSchema<Fields[Name]>] extends [never]
    ? Name
    : never
}[keyof Fields & string]

type SupportedFields<Fields extends Schema.Struct.Fields> = [
  UnsupportedNames<Fields>,
] extends [never]
  ? unknown
  : Readonly<{ '~unsupported fields': UnsupportedNames<Fields> }>

/** The decoded Struct value that a derived Form's submission receives.
 *
 * @experimental Ships from `foldkit/experimental/form`; expect breaking changes while the API settles.
 */
export type Payload<Fields extends Schema.Struct.Fields> =
  Schema.Struct<Fields>['Type']

type FieldOptions<Fields extends Schema.Struct.Fields> = Readonly<{
  [Name in keyof Fields & string]?: Readonly<{ validateOn?: ValidationTrigger }>
}>

type FromSchemaConfig<Fields extends Schema.Struct.Fields, Submit> = Readonly<{
  name: string
  schema: Schema.Struct<Fields> & SupportedFields<Fields>
  fields?: FieldOptions<NoInfer<Fields>>
  submit: Submit
}>

/** A Form definition derived from a Schema Struct, with the kind of each
 * field and a helper that turns a decoded value into field inputs.
 *
 * @experimental Ships from `foldkit/experimental/form`; expect breaking changes while the API settles.
 */
export type SchemaFormDefinition<
  Fields extends Schema.Struct.Fields,
  Requirements = never,
  A = void,
  AI = A,
  E = never,
  EI = E,
> = FormDefinition<
  InputSchemas<Fields>,
  Requirements,
  A,
  AI,
  E,
  EI,
  Requirements,
  never
> &
  Readonly<{
    /** The kind of each field, indexed by name. Used to render its control. */
    kinds: Readonly<Record<keyof Fields & string, FieldKind>>
    /** Turns some or all of a decoded value into field inputs for init and
     * reinitialize. */
    toInputs: (
      payload: Partial<Payload<Fields>>,
    ) => Partial<FormInputs<InputSchemas<Fields>>>
  }>

type Input = string | boolean

type DecodedInput = Result.Result<Option.Option<unknown>, string>

type DerivedField = Readonly<{
  name: string
  kind: FieldKind
  isKeyOptional: boolean
  decode: (input: Input) => DecodedInput
  toInput: (value: unknown) => Input
}>

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1()

const INVALID_VALUE_MESSAGE = 'Invalid value'

const firstMessage = (issue: SchemaIssue.Issue): string =>
  Array.head(formatIssue(issue).issues).pipe(
    Option.match({
      onNone: () => INVALID_VALUE_MESSAGE,
      onSome: ({ message }) => message,
    }),
  )

const decodeWith =
  (schema: Schema.Codec<unknown, unknown>) =>
  (value: unknown): DecodedInput =>
    Result.match(Schema.decodeUnknownResult(schema)(value), {
      onFailure: ({ issue }) => Result.fail(firstMessage(issue)),
      onSuccess: decoded => Result.succeed(Option.some(decoded)),
    })

const flattenMembers = (ast: SchemaAST.AST): ReadonlyArray<SchemaAST.AST> =>
  SchemaAST.isUnion(ast) ? Array.flatMap(ast.types, flattenMembers) : [ast]

const isStringLiteral = (ast: SchemaAST.AST): boolean =>
  SchemaAST.isLiteral(ast) && Predicate.isString(ast.literal)

const isNumberLiteral = (ast: SchemaAST.AST): boolean =>
  SchemaAST.isLiteral(ast) && Predicate.isNumber(ast.literal)

const isTextMember = (ast: SchemaAST.AST): boolean =>
  SchemaAST.isString(ast) || SchemaAST.isTemplateLiteral(ast)

const isBooleanMember = (ast: SchemaAST.AST): boolean =>
  SchemaAST.isBoolean(ast) ||
  (SchemaAST.isLiteral(ast) && Predicate.isBoolean(ast.literal))

const isEnumOf =
  (isValue: (value: unknown) => boolean) =>
  (ast: SchemaAST.AST): boolean =>
    SchemaAST.isEnum(ast) &&
    Array.every(ast.enums, ([, value]) => isValue(value))

const isStringEnum = isEnumOf(Predicate.isString)

const isNumberEnum = isEnumOf(Predicate.isNumber)

const isChoiceMember = (ast: SchemaAST.AST): boolean =>
  isStringLiteral(ast) || isNumberLiteral(ast) || SchemaAST.isEnum(ast)

const toChoiceValues = (ast: SchemaAST.AST): ReadonlyArray<string | number> => {
  if (SchemaAST.isEnum(ast)) {
    return Array.map(ast.enums, ([, value]) => value)
  } else if (
    SchemaAST.isLiteral(ast) &&
    (Predicate.isString(ast.literal) || Predicate.isNumber(ast.literal))
  ) {
    return [ast.literal]
  } else {
    return []
  }
}

const isBlank = (text: string): boolean => String.isEmpty(String.trim(text))

const parseNumber = (text: string): Option.Option<number> =>
  Number.parse(text).pipe(Option.filter(globalThis.Number.isFinite))

const deriveField = (
  name: string,
  property: Schema.Constraint,
): DerivedField => {
  const typeAst = SchemaAST.toType(property.ast)
  const members = flattenMembers(typeAst)
  const definedMembers = Array.filter(
    members,
    member => !SchemaAST.isUndefined(member),
  )
  const isKeyOptional = SchemaAST.isOptional(property.ast)
  const isOptional = isKeyOptional || Array.some(members, SchemaAST.isUndefined)

  const decodeType = decodeWith(Schema.make<Schema.Codec<unknown>>(typeAst))
  const codec = Schema.make<Schema.Codec<unknown, unknown>>(property.ast)
  const isTextEncoded = Array.every(
    Array.filter(
      flattenMembers(SchemaAST.toEncoded(property.ast)),
      member => !SchemaAST.isUndefined(member),
    ),
    SchemaAST.isString,
  )
  const decodeText = isTextEncoded ? decodeWith(codec) : decodeType

  const textOf = (input: Input): string =>
    Predicate.isString(input) ? input : ''

  const decodeFilled =
    (decodeNonBlank: (text: string) => DecodedInput) =>
    (input: Input): DecodedInput => {
      const text = textOf(input)

      if (!isBlank(text)) {
        return decodeNonBlank(text)
      } else if (isOptional) {
        return Result.succeed(Option.none())
      } else {
        return decodeType(undefined)
      }
    }

  const toText = (value: unknown): Input =>
    Result.match(Schema.encodeUnknownResult(codec)(value), {
      onFailure: () => globalThis.String(value),
      onSuccess: encoded =>
        isTextEncoded && Predicate.isString(encoded)
          ? encoded
          : globalThis.String(value),
    })

  const isEvery = (predicate: (ast: SchemaAST.AST) => boolean) =>
    Array.isArrayNonEmpty(definedMembers) &&
    Array.every(definedMembers, predicate)

  if (isEvery(isBooleanMember)) {
    return {
      name,
      kind: FieldKind.Boolean(),
      isKeyOptional,
      decode: decodeType,
      toInput: value => Predicate.isBoolean(value) && value,
    }
  }

  if (
    isEvery(
      member =>
        isTextMember(member) || isStringLiteral(member) || isStringEnum(member),
    ) &&
    Array.some(definedMembers, isTextMember)
  ) {
    return {
      name,
      kind: FieldKind.Text({ isOptional }),
      isKeyOptional,
      decode: input => {
        const text = textOf(input)

        if (isOptional && isBlank(text)) {
          return Result.succeed(Option.none())
        } else {
          return decodeText(text)
        }
      },
      toInput: toText,
    }
  }

  if (
    isEvery(
      member =>
        SchemaAST.isNumber(member) ||
        isNumberLiteral(member) ||
        isNumberEnum(member),
    ) &&
    Array.some(definedMembers, SchemaAST.isNumber)
  ) {
    return {
      name,
      kind: FieldKind.Number({ isOptional }),
      isKeyOptional,
      decode: decodeFilled(text => {
        if (isTextEncoded) {
          return Result.flatMap(decodeText(text), maybeNumber =>
            Option.exists(
              maybeNumber,
              value =>
                Predicate.isNumber(value) && !globalThis.Number.isFinite(value),
            )
              ? decodeType(text)
              : Result.succeed(maybeNumber),
          )
        } else {
          return Option.match(parseNumber(text), {
            onNone: () => decodeType(text),
            onSome: decodeType,
          })
        }
      }),
      toInput: toText,
    }
  }

  if (isEvery(isChoiceMember)) {
    const values = Array.flatMap(definedMembers, toChoiceValues)

    return {
      name,
      kind: FieldKind.Choice({
        isOptional,
        options: Array.map(values, value => globalThis.String(value)),
      }),
      isKeyOptional,
      decode: decodeFilled(text =>
        decodeType(
          Array.findFirst(
            values,
            value => globalThis.String(value) === text,
          ).pipe(Option.getOrElse(() => text)),
        ),
      ),
      toInput: value => globalThis.String(value),
    }
  }

  throw new Error(
    `Form.fromSchema cannot derive a field for "${name}". A derived field needs a string, number, boolean, or literal property.`,
  )
}

const toFieldDefinition = (
  derived: DerivedField,
  validateOn: ValidationTrigger,
):
  | FieldDefinition<typeof Schema.String>
  | FieldDefinition<typeof Schema.Boolean> => {
  const message = (input: Input) =>
    Result.match(derived.decode(input), {
      onFailure: Function.identity,
      onSuccess: () => INVALID_VALUE_MESSAGE,
    })
  const isDecodable = (input: Input) => Result.isSuccess(derived.decode(input))

  if (derived.kind._tag === 'Boolean') {
    return field({
      schema: Schema.Boolean,
      initial: { value: false },
      validateOn,
      rules: FieldValidation.makeRules<boolean>({
        isEmpty: Function.constFalse,
        rules: [[isDecodable, message]],
      }),
    })
  } else {
    return field({
      schema: Schema.String,
      initial: { value: '' },
      validateOn,
      rules: FieldValidation.makeRules<string>({
        isEmpty: Function.constFalse,
        rules: [[isDecodable, message]],
      }),
    })
  }
}

const readInput = (
  inputs: Readonly<Record<string, unknown>>,
  name: string,
): Result.Result<Input, string> => {
  const input = inputs[name]

  if (Predicate.isString(input) || Predicate.isBoolean(input)) {
    return Result.succeed(input)
  } else {
    return Result.fail(INVALID_VALUE_MESSAGE)
  }
}

const toPayloadEntries = (
  derived: DerivedField,
  inputs: Readonly<Record<string, unknown>>,
): Result.Result<ReadonlyArray<readonly [string, unknown]>, string> => {
  const toEntries = (
    maybeValue: Option.Option<unknown>,
  ): ReadonlyArray<readonly [string, unknown]> =>
    Option.match(maybeValue, {
      onNone: () => (derived.isKeyOptional ? [] : [[derived.name, undefined]]),
      onSome: value => [[derived.name, value]],
    })

  return Result.map(
    Result.flatMap(readInput(inputs, derived.name), derived.decode),
    toEntries,
  )
}

/** Derives a Form from a Schema Struct, such as the payload of a command your
 * server accepts. Each property becomes a field: a string is `Text`, a number
 * is `Number`, a boolean is `Boolean`, and a union of string or number
 * literals is `Choice`. An optional property (`Schema.optionalKey`,
 * `Schema.optional`) is an optional field. A field is valid when its input
 * decodes with its property Schema, so the Schema's messages become field
 * errors. Text decodes through the property's codec when the property is
 * encoded as a string, and through its decoded type otherwise. The
 * submission Effect receives the Struct value built from the decoded
 * properties. Checks on the whole Struct don't run.
 *
 * @experimental Ships from `foldkit/experimental/form`; expect breaking changes while the API settles.
 */
export function fromSchema<
  const Fields extends Schema.Struct.Fields,
  A,
  AI,
  E,
  EI,
  SubmitEffect extends Effect.Effect<NoInfer<A>, NoInfer<E>, unknown>,
  Returned extends FieldErrors<string> = {},
>(
  config: FromSchemaConfig<
    Fields,
    Readonly<{
      data: Schema.Codec<A, AI, never, never>
      error: Schema.Codec<E, EI, never, never>
      execute: (
        payload: NoInfer<Payload<Fields>>,
      ) => SubmitEffectFor<SubmitEffect, A, E>
      toFieldErrors?:
        | ((
            error: NoInfer<E>,
          ) => ExactFieldErrors<Returned, NoInfer<keyof Fields & string>>)
        | undefined
    }>
  >,
): SchemaFormDefinition<Fields, Effect.Services<SubmitEffect>, A, AI, E, EI>
export function fromSchema<
  const Fields extends Schema.Struct.Fields,
  A,
  AI,
  SubmitEffect extends Effect.Effect<NoInfer<A>, never, unknown>,
>(
  config: FromSchemaConfig<
    Fields,
    Readonly<{
      data: Schema.Codec<A, AI, never, never>
      error?: undefined
      execute: (
        payload: NoInfer<Payload<Fields>>,
      ) => SubmitEffectFor<SubmitEffect, A, never>
      toFieldErrors?: undefined
    }>
  >,
): SchemaFormDefinition<Fields, Effect.Services<SubmitEffect>, A, AI>
export function fromSchema<
  const Fields extends Schema.Struct.Fields,
  E,
  EI,
  SubmitEffect extends Effect.Effect<void, NoInfer<E>, unknown>,
  Returned extends FieldErrors<string> = {},
>(
  config: FromSchemaConfig<
    Fields,
    Readonly<{
      data?: undefined
      error: Schema.Codec<E, EI, never, never>
      execute: (
        payload: NoInfer<Payload<Fields>>,
      ) => SubmitEffectFor<SubmitEffect, void, E>
      toFieldErrors?:
        | ((
            error: NoInfer<E>,
          ) => ExactFieldErrors<Returned, NoInfer<keyof Fields & string>>)
        | undefined
    }>
  >,
): SchemaFormDefinition<
  Fields,
  Effect.Services<SubmitEffect>,
  void,
  void,
  E,
  EI
>
export function fromSchema<
  const Fields extends Schema.Struct.Fields,
  SubmitEffect extends Effect.Effect<void, never, unknown>,
>(
  config: FromSchemaConfig<
    Fields,
    Readonly<{
      data?: undefined
      error?: undefined
      execute: (
        payload: NoInfer<Payload<Fields>>,
      ) => SubmitEffectFor<SubmitEffect, void, never>
      toFieldErrors?: undefined
    }>
  >,
): SchemaFormDefinition<Fields, Effect.Services<SubmitEffect>>
export function fromSchema(
  config: Readonly<{
    name: string
    schema: Schema.Struct<Schema.Struct.Fields>
    fields?: Readonly<
      Record<string, Readonly<{ validateOn?: ValidationTrigger }> | undefined>
    >
    submit: Readonly<{
      data?: Schema.Codec<unknown, unknown, never, never> | undefined
      error?: Schema.Codec<unknown, unknown, never, never> | undefined
      execute: (
        payload: Readonly<Record<string, unknown>>,
      ) => Effect.Effect<unknown, unknown, unknown>
      toFieldErrors?: ((error: unknown) => FieldErrors<string>) | undefined
    }>
  }>,
): unknown {
  const derivedFields = Array.map(
    Object.entries(config.schema.fields),
    ([name, property]) => deriveField(name, property),
  )

  const fieldDefinitions = Object.fromEntries(
    Array.map(derivedFields, derived => [
      derived.name,
      toFieldDefinition(
        derived,
        config.fields?.[derived.name]?.validateOn ?? 'Change',
      ),
    ]),
  )

  const kinds = Object.fromEntries(
    Array.map(derivedFields, ({ name, kind }) => [name, kind]),
  )

  const toPayload = (
    inputs: Readonly<Record<string, unknown>>,
  ): Option.Option<Readonly<Record<string, unknown>>> =>
    Result.all(
      Array.map(derivedFields, derived => toPayloadEntries(derived, inputs)),
    ).pipe(
      Result.map(entries => Object.fromEntries(Array.flatten(entries))),
      Result.getSuccess,
    )

  const toInputs = (
    payload: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, Readonly<{ value: Input }>>> =>
    Object.fromEntries(
      Array.getSomes(
        Array.map(derivedFields, ({ name, toInput }) =>
          Option.map(Option.fromUndefinedOr(payload[name]), value => [
            name,
            { value: toInput(value) },
          ]),
        ),
      ),
    )

  const data: Schema.Codec<unknown, unknown, never, never> =
    config.submit.data ?? Schema.Void
  const error: Schema.Codec<unknown, unknown, never, never> =
    config.submit.error ?? Schema.Never

  const execute = (
    values: Readonly<Record<string, unknown>>,
  ): Effect.Effect<unknown, unknown, unknown> =>
    Option.match(toPayload(values), {
      onNone: () =>
        Effect.die(
          new Error(
            `Form.fromSchema submitted ${config.name} values that do not decode.`,
          ),
        ),
      onSome: config.submit.execute,
    })

  // NOTE: the field Schemas are derived at runtime, so this boundary hands define a record it cannot type per field.
  /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
  const fields = fieldDefinitions as Readonly<
    Record<string, FieldDefinition<FieldSchema>>
  >

  const definition = define({
    name: config.name,
    fields,
    submit: {
      data,
      error,
      execute,
      toFieldErrors: config.submit.toFieldErrors,
    },
  })

  return { ...definition, kinds, toInputs }
}
