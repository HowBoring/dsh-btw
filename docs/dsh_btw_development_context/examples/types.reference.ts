/**
 * Conceptual types for dsh-btw. NOT executable plugin code; NOT DSH upstream public contracts.
 * Actual implementation must adapt to DSH's branded IDs, generated Remote constraints, and schemas.
 */

export type BtwTurnStatus = 'running' | 'complete' | 'cancelled' | 'error' | 'interrupted';

export interface ContextCut {
  sessionId: string;
  /** Index of the latest committed main Session event included in this capture. */
  eventSeq: number;
  capturedAt: number;
  attemptId?: string;
  attemptRevision?: number;
  chunkIndex?: number;
  /** Set if late observer / provider protocol limitations degraded live coverage. */
  degraded?: string;
}

export interface BtwTurn {
  turnId: string;
  requestId: string;
  question: string;
  answer: string;
  status: BtwTurnStatus;
  createdAt: number;
  updatedAt: number;
  contextCut: ContextCut;
  error?: string;
}

export interface BtwTopic {
  sessionId: string;
  topicId: string;
  title: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  /** Start question first, followed by explicit same-topic follow-ups. */
  turns: readonly BtwTurn[];
}

export interface BtwAskRequest {
  sessionId: string;
  question: string;
  requestId: string;
  /** Present for follow-up; absent for a new Topic. */
  topicId?: string;
  expectedTopicRevision?: number;
}

export interface BtwAskReceipt {
  sessionId: string;
  topicId: string;
  turnId: string;
  status: 'running';
  topicRevision: number;
}

export type BtwFrame =
  | { type: 'snapshot'; sessionId: string; feedRevision: number; topics: readonly BtwTopic[] }
  | { type: 'delta'; sessionId: string; topicId: string; turnId: string; feedRevision: number; offset: number; text: string }
  | { type: 'settled'; sessionId: string; topicId: string; turnId: string; feedRevision: number; topic: BtwTopic }
  | { type: 'error'; sessionId: string; feedRevision: number; code: string; message: string };

export interface BtwTopicRepository {
  list(sessionId: string): readonly BtwTopic[];
  get(sessionId: string, topicId: string): BtwTopic | undefined;
  /** Durable CAS and semantic validation occur in the implementation, not this type. */
  appendTurnCAS(topic: BtwTopic, expectedRevision: number | null): Promise<BtwTopic>;
  settleTurnCAS(sessionId: string, topicId: string, turnId: string, next: BtwTurnStatus, answer: string, expectedRevision: number): Promise<BtwTopic>;
}
