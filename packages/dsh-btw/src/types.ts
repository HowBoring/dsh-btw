import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-typert-protocol'

/** Terminal and in-flight states of one BTW turn. */
export type BtwTurnStatus = 'running' | 'complete' | 'cancelled' | 'error' | 'interrupted'

/** Coherent view of the main session captured synchronously at BTW admission. */
export interface BtwContextCut {
  readonly sessionId: string
  /** Inclusive sequence of the last committed session event observed. -1 for an empty log. */
  readonly eventSeq: number
  /** Exclusive session offset at capture; `eventSeq + 1` when no late event raced. */
  readonly cutOffset: number
  readonly capturedAt: string
  readonly attemptId?: string | undefined
  readonly attemptRevision?: number | undefined
  /** Number of assistant-stream chunks observed for the active attempt. */
  readonly chunkIndex?: number | undefined
  /** Safe, user-facing coverage gaps (`late-mount`, `missing-main-request`, ...). */
  readonly degraded: readonly string[]
}

/** One question/answer pair inside a BTW topic. */
export interface BtwTurn {
  readonly turnId: string
  readonly requestId: string
  readonly question: string
  readonly answer: string
  readonly status: BtwTurnStatus
  readonly createdAt: string
  readonly updatedAt: string
  readonly contextCut: BtwContextCut
  readonly error?: string | undefined
}

/** Durable side history for one Session and one selected topic. */
export interface BtwTopic {
  readonly sessionId: string
  readonly topicId: string
  readonly title: string
  /** Monotone per topic; incremented by every durable turn mutation. */
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly turns: readonly BtwTurn[]
}

export interface BtwAskRequest {
  readonly sessionId: string
  readonly topicId?: string
  readonly question: string
  readonly requestId: string
  readonly expectedRevision?: number
}

export interface BtwAskReceipt {
  readonly topicId: string
  readonly turnId: string
  readonly status: BtwTurnStatus
  readonly revision: number
}

export interface BtwListRequest {
  readonly sessionId: string
}

export interface BtwListValue {
  readonly topics: readonly BtwTopic[]
}

export interface BtwGetRequest {
  readonly sessionId: string
  readonly topicId: string
}

export interface BtwGetValue {
  readonly topic: BtwTopic | null
}

export interface BtwWatchRequest {
  readonly sessionId: string
  readonly topicId?: string
}

export interface BtwCancelRequest {
  readonly sessionId: string
  readonly topicId: string
  readonly turnId: string
}

export interface BtwCancelValue {
  readonly cancelled: boolean
  readonly topic: BtwTopic | null
}

/** Gap-free stream frames: snapshot first, then per-session revisioned updates. */
export type BtwFrame =
  | {
      readonly type: 'snapshot'
      readonly revision: number
      readonly topics: readonly BtwTopic[]
    }
  | {
      readonly type: 'topic'
      readonly revision: number
      readonly topic: BtwTopic
    }
  | {
      readonly type: 'delta'
      readonly revision: number
      readonly topicId: string
      readonly turnId: string
      readonly text: string
    }
  | {
      readonly type: 'settled'
      readonly revision: number
      readonly topicId: string
      readonly turnId: string
      readonly status: BtwTurnStatus
      readonly error?: string
    }

const contextCutSchema = z.object({
  sessionId: z.string().min(1),
  eventSeq: z.number().int().min(-1),
  cutOffset: z.number().int().min(0),
  capturedAt: z.string().min(1),
  attemptId: z.string().min(1).optional(),
  attemptRevision: z.number().int().min(0).optional(),
  chunkIndex: z.number().int().min(0).optional(),
  degraded: z.array(z.string().min(1)),
})

const turnSchema = z.object({
  turnId: z.string().min(1),
  requestId: z.string().min(1),
  question: z.string().min(1),
  answer: z.string(),
  status: z.enum(['running', 'complete', 'cancelled', 'error', 'interrupted']),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  contextCut: contextCutSchema,
  error: z.string().min(1).optional(),
})

/** Stored value schema; the public TypeScript contract is the interface above. */
export const btwTopicSchema = z.object({
  sessionId: z.string().min(1),
  topicId: z.string().min(1),
  title: z.string().min(1),
  revision: z.number().int().min(0),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  turns: z.array(turnSchema),
})

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'btw/invalid-input': { readonly field?: string }
    'btw/busy': { readonly topicId?: string }
    'btw/no-model': {}
    'btw/context-unavailable': {}
    'btw/revision-conflict': { readonly expected?: number; readonly actual?: number }
    'btw/storage-admission-failed': {}
    'btw/storage-terminal-unknown': {}
    'btw/internal': {}
  }
}
