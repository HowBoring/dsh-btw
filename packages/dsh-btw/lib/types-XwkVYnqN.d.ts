import { z } from "zod";

//#region src/types.d.ts
/** Terminal and in-flight states of one BTW turn. */
type BtwTurnStatus = 'running' | 'complete' | 'cancelled' | 'error' | 'interrupted';
/** Coherent view of the main session captured synchronously at BTW admission. */
interface BtwContextCut {
  readonly sessionId: string;
  /** Inclusive sequence of the last committed session event observed. -1 for an empty log. */
  readonly eventSeq: number;
  /** Exclusive session offset at capture; `eventSeq + 1` when no late event raced. */
  readonly cutOffset: number;
  readonly capturedAt: string;
  readonly attemptId?: string | undefined;
  readonly attemptRevision?: number | undefined;
  /** Number of assistant-stream chunks observed for the active attempt. */
  readonly chunkIndex?: number | undefined;
  /** Safe, user-facing coverage gaps (`late-mount`, `missing-main-request`, ...). */
  readonly degraded: readonly string[];
}
/** One question/answer pair inside a BTW topic. */
interface BtwTurn {
  readonly turnId: string;
  readonly requestId: string;
  readonly question: string;
  readonly answer: string;
  readonly status: BtwTurnStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly contextCut: BtwContextCut;
  readonly error?: string | undefined;
}
/** Durable side history for one Session and one selected topic. */
interface BtwTopic {
  readonly sessionId: string;
  readonly topicId: string;
  readonly title: string;
  /** Monotone per topic; incremented by every durable turn mutation. */
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly turns: readonly BtwTurn[];
}
interface BtwAskRequest {
  readonly sessionId: string;
  readonly topicId?: string;
  readonly question: string;
  readonly requestId: string;
  readonly expectedRevision?: number;
}
interface BtwAskReceipt {
  readonly topicId: string;
  readonly turnId: string;
  readonly status: BtwTurnStatus;
  readonly revision: number;
}
interface BtwListRequest {
  readonly sessionId: string;
}
interface BtwListValue {
  readonly topics: readonly BtwTopic[];
}
interface BtwGetRequest {
  readonly sessionId: string;
  readonly topicId: string;
}
interface BtwGetValue {
  readonly topic: BtwTopic | null;
}
interface BtwWatchRequest {
  readonly sessionId: string;
  readonly topicId?: string;
}
interface BtwCancelRequest {
  readonly sessionId: string;
  readonly topicId: string;
  readonly turnId: string;
}
interface BtwCancelValue {
  readonly cancelled: boolean;
  readonly topic: BtwTopic | null;
}
/** Gap-free stream frames: snapshot first, then per-session revisioned updates. */
type BtwFrame = {
  readonly type: 'snapshot';
  readonly revision: number;
  readonly topics: readonly BtwTopic[];
} | {
  readonly type: 'topic';
  readonly revision: number;
  readonly topic: BtwTopic;
} | {
  readonly type: 'delta';
  readonly revision: number;
  readonly topicId: string;
  readonly turnId: string;
  readonly text: string;
} | {
  readonly type: 'settled';
  readonly revision: number;
  readonly topicId: string;
  readonly turnId: string;
  readonly status: BtwTurnStatus;
  readonly error?: string;
};
/** Stored value schema; the public TypeScript contract is the interface above. */
declare const btwTopicSchema: z.ZodObject<{
  sessionId: z.ZodString;
  topicId: z.ZodString;
  title: z.ZodString;
  revision: z.ZodNumber;
  createdAt: z.ZodString;
  updatedAt: z.ZodString;
  turns: z.ZodArray<z.ZodObject<{
    turnId: z.ZodString;
    requestId: z.ZodString;
    question: z.ZodString;
    answer: z.ZodString;
    status: z.ZodEnum<{
      error: "error";
      running: "running";
      complete: "complete";
      cancelled: "cancelled";
      interrupted: "interrupted";
    }>;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
    contextCut: z.ZodObject<{
      sessionId: z.ZodString;
      eventSeq: z.ZodNumber;
      cutOffset: z.ZodNumber;
      capturedAt: z.ZodString;
      attemptId: z.ZodOptional<z.ZodString>;
      attemptRevision: z.ZodOptional<z.ZodNumber>;
      chunkIndex: z.ZodOptional<z.ZodNumber>;
      degraded: z.ZodArray<z.ZodString>;
    }, z.core.$strip>;
    error: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>;
}, z.core.$strip>;
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'btw/invalid-input': {
      readonly field?: string;
    };
    'btw/busy': {
      readonly topicId?: string;
    };
    'btw/no-model': {};
    'btw/context-unavailable': {};
    'btw/revision-conflict': {
      readonly expected?: number;
      readonly actual?: number;
    };
    'btw/storage-admission-failed': {};
    'btw/storage-terminal-unknown': {};
    'btw/internal': {};
  }
}
//#endregion
export { BtwContextCut as a, BtwGetValue as c, BtwTopic as d, BtwTurn as f, btwTopicSchema as h, BtwCancelValue as i, BtwListRequest as l, BtwWatchRequest as m, BtwAskRequest as n, BtwFrame as o, BtwTurnStatus as p, BtwCancelRequest as r, BtwGetRequest as s, BtwAskReceipt as t, BtwListValue as u };