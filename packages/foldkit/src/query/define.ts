import { Predicate } from 'effect'

import {
  type KeyedQuery,
  type KeyedQueryConfig,
  type SyncFields,
  defineInterruptibleKeyedQuery,
  definePlainKeyedQuery,
} from './keyedQuery.js'
import {
  type Query,
  type QueryConfig,
  defineInterruptibleQuery,
  definePlainQuery,
} from './query.js'

type DefineConfig =
  | (QueryConfig<string, unknown, unknown, unknown, unknown, any> & {
      readonly args?: never
      readonly toKey?: never
    })
  | KeyedQueryConfig<
      string,
      unknown,
      unknown,
      unknown,
      unknown,
      SyncFields,
      any
    >

const isKeyedQueryConfig = (
  config: DefineConfig,
): config is KeyedQueryConfig<
  string,
  unknown,
  unknown,
  unknown,
  unknown,
  SyncFields,
  any
> => Predicate.hasProperty(config, 'args')

/** Defines a remote-data Submodel as {@link Query} or {@link KeyedQuery}. */
export function define<
  Name extends string,
  A,
  AI,
  E,
  EI,
  Fields extends SyncFields,
  R = never,
>(
  config: KeyedQueryConfig<Name, A, AI, E, EI, Fields, R> & {
    readonly interrupt: true
  },
): KeyedQuery<Name, A, AI, E, EI, Fields, R, true>
export function define<
  Name extends string,
  A,
  AI,
  E,
  EI,
  Fields extends SyncFields,
  R = never,
>(
  config: KeyedQueryConfig<Name, A, AI, E, EI, Fields, R> & {
    readonly interrupt?: false
  },
): KeyedQuery<Name, A, AI, E, EI, Fields, R, false>
export function define<Name extends string, A, AI, E, EI, R = never>(
  config: QueryConfig<Name, A, AI, E, EI, R> & {
    readonly interrupt: true
    readonly args?: never
    readonly toKey?: never
  },
): Query<Name, A, AI, E, EI, R, true>
export function define<Name extends string, A, AI, E, EI, R = never>(
  config: QueryConfig<Name, A, AI, E, EI, R> & {
    readonly interrupt?: false
    readonly args?: never
    readonly toKey?: never
  },
): Query<Name, A, AI, E, EI, R, false>
export function define(config: DefineConfig): unknown {
  if (isKeyedQueryConfig(config)) {
    if (config.interrupt === true) return defineInterruptibleKeyedQuery(config)

    return definePlainKeyedQuery(config)
  }

  if (config.interrupt === true) return defineInterruptibleQuery(config)

  return definePlainQuery(config)
}
