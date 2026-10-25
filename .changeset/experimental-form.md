---
'foldkit': minor
'@foldkit/oxlint-plugin': patch
'@foldkit/vite-plugin': patch
---

Add experimental Form, a viewless Submodel that manages field values, validation, interaction metadata, and submission. Define each field with an Effect Schema, an initial value, synchronous rules, an optional async `validate` Effect, and a `validateOn` trigger of `'Change'` or `'Blur'`. Configure submission with an `execute` Effect, plus a `data` Schema when it returns a value and an `error` Schema when it can fail. The parent stores the Form Model, folds its Messages through `lift`, and renders from its selectors. Form rejects stale validation and submission results by generation, and carries validator and submission service requirements onto the Commands it returns. `form.Submit` and `form.ValidateField.<field>` can be matched and resolved in Story and Scene tests. Import Form from `foldkit/experimental` or `foldkit/experimental/form`.

Field values can be scalars or immutable compound values such as arrays, `Option`s, and tagged unions. Each value is wrapped in a `value` property, as in `initial: { value: '' }`. Field Schemas must decode and encode synchronously without services.

A typed submission error can mark the fields it concerns. `submit.toFieldErrors` returns a message per field name, and Form shows each message as that field's error until the field changes. A field that changed while the submission was pending keeps the state of its new value. The submission is `Failed` with the typed error either way.

`Form.fromSchema` derives a Form from a Schema Struct, such as the payload of a server command. Each string, number, boolean, or literal-union property becomes a `Text`, `Number`, `Boolean`, or `Choice` field, and an optional property becomes an optional field. Decoding a field's input with its property Schema is its validation, so the Schema's messages become field errors. The submission Effect receives the Struct value built from the decoded properties, and checks on the whole Struct don't run. `form.kinds` describes each field's control, and `form.toInputs` turns a decoded value into field inputs for `init` and `reinitialize`.

Experimental Query's `lift` now accepts a `parentField` only when that field's type matches the Query Model exactly, and calls inherited lens methods with the lens as `this`. A parent field typed as a wider or narrower type than the Query Model needs a lens.

Recognize locally defined Form Message schemas in Submodel wrapper lint rules through both experimental imports.

Include `effect/SchemaGetter` in the Vite plugin's forced Effect dependency entries.
