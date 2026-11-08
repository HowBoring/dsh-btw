/**
 * Browser-side Remote contribution.
 *
 * The public Typert generator currently requires the whole DSH monorepo (the
 * protocol package is analyzed as a first-party workspace source), so this
 * contribution is authored against the same public `createTypertRemoteInfo`
 * contract the generator emits. Host dispatch still reads the runtime
 * `@Remote` decorators on `BtwService`; this file only describes the wire.
 */
import { z } from 'zod'
// The root protocol package is Host-only in the browser module table; the
// self-contained remote-info entry is the one the client bundle may inline.
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import type { RemoteResult, RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import type {
  BtwAskReceipt,
  BtwAskRequest,
  BtwCancelRequest,
  BtwCancelValue,
  BtwFrame,
  BtwGetRequest,
  BtwGetValue,
  BtwListRequest,
  BtwListValue,
  BtwWatchRequest,
} from '../types.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$627477 {
    ask: (request: BtwAskRequest, signal?: AbortSignal) => Promise<RemoteResult<BtwAskReceipt>>
    list: (request: BtwListRequest) => Promise<RemoteResult<BtwListValue>>
    get: (request: BtwGetRequest) => Promise<RemoteResult<BtwGetValue>>
    watch: (request: BtwWatchRequest, signal?: AbortSignal) => RemoteStreamHandle<BtwFrame, never>
    cancel: (request: BtwCancelRequest) => Promise<RemoteResult<BtwCancelValue>>
  }
  interface TypertRemoteMap {
    'btw/ask': (request: BtwAskRequest, signal?: AbortSignal) => Promise<RemoteResult<BtwAskReceipt>>
    'btw/list': (request: BtwListRequest) => Promise<RemoteResult<BtwListValue>>
    'btw/get': (request: BtwGetRequest) => Promise<RemoteResult<BtwGetValue>>
    'btw/watch': (request: BtwWatchRequest, signal?: AbortSignal) => RemoteStreamHandle<BtwFrame, never>
    'btw/cancel': (request: BtwCancelRequest) => Promise<RemoteResult<BtwCancelValue>>
  }
  interface TypertRemoteNamespaceMap {
    btw: TypertRemoteNamespace$627477
  }
}

const request = (typeSymbol: string): { name: string; source: 'json'; codec: ReturnType<typeof codec>; strictCodec: ReturnType<typeof codec> } => ({
  name: 'request',
  source: 'json',
  codec: codec(typeSymbol),
  strictCodec: codec(typeSymbol),
})

function codec(typeSymbol: string) {
  return {
    mode: 'strict' as const,
    typeSymbol,
    create: () => z.unknown(),
    jsonSchema: {},
  }
}

function result(typeSymbol: string, create: () => z.ZodType): {
  mode: 'strict'
  typeSymbol: string
  create: () => z.ZodType
  jsonSchema: Record<string, unknown>
} {
  return { mode: 'strict', typeSymbol, create, jsonSchema: {} }
}

/** The generated Remote contribution for the BTW namespace. */
export const btwRemote = createTypertRemoteInfo({
  package: '@deepseek-ai/dsh-btw',
  methods: {
    'btw/ask': {
      service: 'btw',
      description: 'Admit a BTW question or follow-up and return a durable receipt before the side model call.',
      invocation: { kind: 'direct' },
      parameters: [request('@deepseek-ai/dsh-btw/types#BtwAskRequest')],
      cancellation: { parameter: 'signal' },
      result: result('@deepseek-ai/dsh-btw/types#BtwAskReceipt', () => z.unknown()),
    },
    'btw/list': {
      service: 'btw',
      description: 'List durable BTW Topics for one Session without waking its Agent.',
      invocation: { kind: 'direct' },
      parameters: [request('@deepseek-ai/dsh-btw/types#BtwListRequest')],
      result: result('@deepseek-ai/dsh-btw/types#BtwListValue', () => z.unknown()),
    },
    'btw/get': {
      service: 'btw',
      description: 'Read one durable BTW Topic for one Session without waking its Agent.',
      invocation: { kind: 'direct' },
      parameters: [request('@deepseek-ai/dsh-btw/types#BtwGetRequest')],
      result: result('@deepseek-ai/dsh-btw/types#BtwGetValue', () => z.unknown()),
    },
    'btw/watch': {
      service: 'btw',
      description: 'Stream BTW Topic snapshots and deltas for one Session; closing the stream never cancels work.',
      mode: 'stream',
      invocation: { kind: 'direct' },
      parameters: [request('@deepseek-ai/dsh-btw/types#BtwWatchRequest')],
      cancellation: { parameter: 'signal' },
      result: result('@deepseek-ai/dsh-btw/types#BtwFrame', () => z.unknown()),
    },
    'btw/cancel': {
      service: 'btw',
      description: 'Explicitly cancel the one active BTW turn in a Session and retain its partial answer.',
      invocation: { kind: 'direct' },
      parameters: [request('@deepseek-ai/dsh-btw/types#BtwCancelRequest')],
      result: result('@deepseek-ai/dsh-btw/types#BtwCancelValue', () => z.unknown()),
    },
  },
} satisfies Parameters<typeof createTypertRemoteInfo>[0], z)

export type BtwRemote = typeof btwRemote

export default btwRemote
