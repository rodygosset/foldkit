import { Array } from 'effect'
import { Form } from 'foldkit/experimental'
import { type HtmlBuilder } from 'foldkit/html'

import { Message, type Model, tourForm } from './formFromSchema'

const textControl = (
  model: Model,
  h: HtmlBuilder<Message>,
  name: 'prospect' | 'partySize' | 'stage' | 'notes',
) => {
  const field = tourForm.field(model.tour, name)
  const toMessage = (value: string) =>
    Message.GotTourMessage({ message: tourForm.changed(name, { value }) })

  return Form.FieldKind.matchOrElse(
    tourForm.kinds[name],
    {
      Choice: ({ options }) =>
        h.select(
          [h.Id(name), h.Value(field.value), h.OnChange(toMessage)],
          [
            h.option([h.Value('')], ['Choose…']),
            ...Array.map(options, option =>
              h.option([h.Value(option)], [option]),
            ),
          ],
        ),
      Number: () =>
        h.input([
          h.Id(name),
          h.InputMode('numeric'),
          h.Value(field.value),
          h.OnInput(toMessage),
        ]),
    },
    () => h.input([h.Id(name), h.Value(field.value), h.OnInput(toMessage)]),
  )
}

const petsControl = (model: Model, h: HtmlBuilder<Message>) => {
  const hasPets = tourForm.field(model.tour, 'hasPets')

  return h.input([
    h.Id('hasPets'),
    h.Type('checkbox'),
    h.Checked(hasPets.value),
    h.OnClick(
      Message.GotTourMessage({
        message: tourForm.changed('hasPets', { value: !hasPets.value }),
      }),
    ),
  ])
}
