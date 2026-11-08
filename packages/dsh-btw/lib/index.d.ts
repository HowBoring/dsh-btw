import { a as BtwContextCut, c as BtwGetValue, d as BtwTopic, f as BtwTurn, h as btwTopicSchema, i as BtwCancelValue, l as BtwListRequest, m as BtwWatchRequest, n as BtwAskRequest, o as BtwFrame, p as BtwTurnStatus, r as BtwCancelRequest, s as BtwGetRequest, t as BtwAskReceipt, u as BtwListValue } from "./types-XwkVYnqN.js";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { GenerateOptions, Message, RequestMessage } from "@deepseek-ai/dsh-llm";
import * as _deepseek_ai_dsh_storage_domain0 from "@deepseek-ai/dsh-storage-domain";
import { Domain } from "@deepseek-ai/dsh-storage-domain";
import { Context } from "@deepseek-ai/cordis";
import { Session } from "@deepseek-ai/dsh-session";

//#region src/service.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-side BTW Remote service. */
    btw: BtwService;
  }
}
/** Host-side BTW service: admission, durable Topic history, and detached side calls. */
declare class BtwService extends TypertRemoteService {
  static inject: string[];
  private readonly mirror;
  private readonly hubs;
  private readonly active;
  private readonly requestIndex;
  private readonly ready;
  private repo;
  private initError;
  constructor(ctx: Context);
  private initialize;
  private indexTopic;
  private requestKey;
  private repository;
  private hub;
  private validateSession;
  private ensureAgent;
  ask(request: BtwAskRequest, signal?: AbortSignal): Promise<BtwAskReceipt>;
  private run;
  private release;
  private finalize;
  list(request: BtwListRequest): Promise<BtwListValue>;
  get(request: BtwGetRequest): Promise<BtwGetValue>;
  watch(request: BtwWatchRequest, signal?: AbortSignal): AsyncIterable<BtwFrame>;
  cancel(request: BtwCancelRequest): Promise<BtwCancelValue>;
}
//#endregion
//#region src/live.d.ts
interface MainRequestFacts {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: GenerateOptions['reasoningEffort'];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly system?: string;
}
interface LiveCapture {
  readonly facts?: MainRequestFacts;
  readonly inFlightText?: string;
  readonly attemptId?: string;
  readonly attemptRevision?: number;
  readonly chunkIndex?: number;
  readonly degraded: readonly string[];
}
/**
 * Process-local mirror of main-Agent model requests and live assistant chunks.
 * It observes only public waterfall/event payloads and never interrupts them.
 */
declare class LiveContextMirror {
  private readonly requests;
  private readonly attempts;
  constructor(ctx: Context);
  private observe;
  capture(session: Session): LiveCapture;
}
//#endregion
//#region src/normalize.d.ts
/** Upper bound for the quoted main-session transcript, in characters. */
declare const MAX_CONTEXT_CHARS = 48000;
interface NormalizedSideContext {
  readonly messages: readonly RequestMessage[];
  readonly system: string;
  readonly degraded: readonly string[];
}
/**
 * Build a provider-valid side request. Tool history is flattened to plain text:
 * assistant tool calls never appear without a matching result message, and no
 * synthetic successful result is invented. Reasoning, images, files, developer
 * messages and tool declarations are omitted.
 */
declare function normalizeSideContext(input: {
  readonly messages: readonly Message[];
  readonly cut: BtwContextCut;
  readonly history: readonly BtwTurn[];
  readonly question: string;
  readonly facts?: {
    readonly system?: string | undefined;
  };
  readonly inFlightText?: string | undefined;
}): NormalizedSideContext;
//#endregion
//#region src/runner.d.ts
interface SideRunResult {
  readonly status: 'complete' | 'cancelled' | 'error';
  readonly text: string;
  readonly error?: string;
}
/**
 * Execute one detached, tool-free side request. The caller owns the turn
 * AbortSignal; this runner never reuses the main request signal or session id.
 */
declare function runSideCall(input: {
  readonly ctx: Context;
  readonly facts: MainRequestFacts;
  readonly normalized: NormalizedSideContext;
  readonly signal: AbortSignal;
  readonly onDelta: (text: string) => void;
}): Promise<SideRunResult>;
//#endregion
//#region src/repository.d.ts
type TopicKey = string & {
  readonly __btwTopicKey: unique symbol;
};
/** One record per topic, keyed by a filesystem-safe encoding of Session + Topic. */
declare const btwDomainSpec: {
  name: string;
  version: number;
  layout: "per-record";
  tables: {
    topics: _deepseek_ai_dsh_storage_domain0.DomainTableSpec<TopicKey, BtwTopic>;
  };
};
type BtwDomain = Domain<typeof btwDomainSpec>;
/** Encode a Session/Topic pair into the per-record key grammar. */
declare function topicKey(sessionId: string, topicId: string): TopicKey;
/** Storage-backed Topic repository. Reads are synchronous snapshots of the open Domain. */
declare class BtwTopicRepository {
  private readonly domain;
  private readonly table;
  constructor(domain: BtwDomain);
  all(): BtwTopic[];
  topics(sessionId: string): BtwTopic[];
  get(sessionId: string, topicId: string): BtwTopic | undefined;
  put(topic: BtwTopic): Promise<void>;
  update(sessionId: string, topicId: string, transform: (current: BtwTopic) => BtwTopic): Promise<BtwTopic>;
  close(): Promise<void>;
}
//#endregion
export { BtwAskReceipt, BtwAskRequest, BtwCancelRequest, BtwCancelValue, BtwContextCut, BtwFrame, BtwGetRequest, BtwGetValue, BtwListRequest, BtwListValue, BtwService, BtwService as default, BtwTopic, BtwTopicRepository, BtwTurn, BtwTurnStatus, BtwWatchRequest, LiveContextMirror, MAX_CONTEXT_CHARS, btwDomainSpec, btwTopicSchema, normalizeSideContext, runSideCall, topicKey };