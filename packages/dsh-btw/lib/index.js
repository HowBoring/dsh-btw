import { t as btwTopicSchema } from "./types-BtLW3don.js";
import { randomUUID } from "node:crypto";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { BlockAssembler, isAgentLoopRequest } from "@deepseek-ai/dsh-llm";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";

//#region src/live.ts
/**
* Process-local mirror of main-Agent model requests and live assistant chunks.
* It observes only public waterfall/event payloads and never interrupts them.
*/
var LiveContextMirror = class {
	requests = /* @__PURE__ */ new Map();
	attempts = /* @__PURE__ */ new Map();
	constructor(ctx) {
		ctx.on("llm/stream", (options, next) => {
			if (isAgentLoopRequest(options) && options.sessionId !== void 0) this.requests.set(options.sessionId, {
				provider: options.provider,
				model: options.model,
				...options.reasoningEffort === void 0 ? {} : { reasoningEffort: options.reasoningEffort },
				...options.temperature === void 0 ? {} : { temperature: options.temperature },
				...options.maxTokens === void 0 ? {} : { maxTokens: options.maxTokens },
				...options.system === void 0 ? {} : { system: options.system }
			});
			return next();
		});
		ctx.on("agent/assistant-stream", ({ agent, frame }) => {
			this.observe(agent.session.id, frame);
		});
		ctx.on("session/event", (session, event) => {
			if (event.type === "assistant/message" || event.type === "assistant/attempt") this.attempts.delete(session.id);
		});
		ctx.on("agent/disposed", ({ agent }) => {
			this.attempts.delete(agent.session.id);
			this.requests.delete(agent.session.id);
		});
		ctx.on("session/disposed", (session) => {
			this.attempts.delete(session.id);
			this.requests.delete(session.id);
		});
	}
	observe(sessionId, frame) {
		if (frame.type === "start") {
			this.attempts.set(sessionId, {
				attemptId: frame.attemptId,
				revision: frame.revision,
				nextIndex: 0,
				invalid: false,
				assembler: new BlockAssembler()
			});
			return;
		}
		const state = this.attempts.get(sessionId);
		if (frame.type === "end") {
			if (state?.attemptId === frame.attemptId) this.attempts.delete(sessionId);
			return;
		}
		if (!state || state.attemptId !== frame.attemptId || state.revision !== frame.revision) return;
		if (frame.index !== state.nextIndex) {
			state.invalid = true;
			return;
		}
		state.nextIndex += 1;
		state.assembler.push(frame.chunk);
	}
	capture(session) {
		const degraded = [];
		const facts = this.requests.get(session.id);
		if (!facts) degraded.push("missing-main-request");
		const state = this.attempts.get(session.id);
		if (!state) return {
			...facts ? { facts } : {},
			degraded
		};
		if (state.invalid) {
			degraded.push("missing-attempt-prefix");
			return {
				...facts ? { facts } : {},
				attemptId: state.attemptId,
				attemptRevision: state.revision,
				chunkIndex: state.nextIndex,
				degraded
			};
		}
		const text = state.assembler.interruptedBlocks().filter((block) => block.type === "text").map((block) => block.text).join("");
		return {
			...facts ? { facts } : {},
			...text.trim() ? { inFlightText: text } : {},
			attemptId: state.attemptId,
			attemptRevision: state.revision,
			chunkIndex: state.nextIndex,
			degraded
		};
	}
};

//#endregion
//#region src/normalize.ts
/** Upper bound for the quoted main-session transcript, in characters. */
const MAX_CONTEXT_CHARS = 48e3;
const SIDE_SYSTEM_ADDENDUM = [
	"",
	"## Separate BTW side channel",
	"You are answering a separate, read-only side question about the main session.",
	"You have no tools and cannot act on the session. Never claim to have executed a tool or",
	"observed a tool result that is not quoted here. Base the answer only on the supplied",
	"main-session context and this BTW topic history. The main agent does not see this exchange."
].join("\n");
function textOf(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("").trim();
}
/**
* Build a provider-valid side request. Tool history is flattened to plain text:
* assistant tool calls never appear without a matching result message, and no
* synthetic successful result is invented. Reasoning, images, files, developer
* messages and tool declarations are omitted.
*/
function normalizeSideContext(input) {
	const degraded = new Set(input.cut.degraded);
	const openCalls = /* @__PURE__ */ new Set();
	const callNames = /* @__PURE__ */ new Map();
	for (const message of input.messages) if (message.role === "assistant") {
		for (const block of message.content) if (block.type === "tool-call") {
			openCalls.add(block.id);
			callNames.set(block.id, block.name);
		}
	} else if (message.role === "tool") openCalls.delete(message.toolCallId);
	const lines = [];
	for (const message of input.messages) {
		if (message.role === "system" || message.role === "developer") continue;
		if (message.role === "user") {
			const text$1 = textOf(message.content);
			if (text$1) lines.push(`[user]\n${text$1}`);
			continue;
		}
		if (message.role === "tool") {
			const name = callNames.get(message.toolCallId) ?? "tool";
			const text$1 = textOf(message.content);
			lines.push(`[tool result: ${name}${message.isError ? " (error)" : ""}]\n${text$1 || "(empty result)"}`);
			continue;
		}
		const text = textOf(message.content);
		if (text) lines.push(`[assistant]\n${text}`);
		for (const block of message.content) if (block.type === "tool-call" && openCalls.has(block.id)) lines.push(`[tool call not executed in this side view: ${block.name}] The main agent requested this tool and no result is available at capture time.`);
	}
	if (input.inFlightText?.trim()) lines.push(`[assistant, still streaming at capture]\n${input.inFlightText.trim()}`);
	let transcript = lines.join("\n\n");
	if (transcript.length > MAX_CONTEXT_CHARS) {
		transcript = `${transcript.slice(-MAX_CONTEXT_CHARS)}\n[... older main context truncated ...]`;
		degraded.add("context-truncated");
	}
	if (!transcript) transcript = "(The main session has no observable committed conversation content yet.)";
	const messages = [{
		role: "user",
		content: [{
			type: "text",
			text: `Main session context captured at BTW admission (read-only; newest last):\n\n${transcript}`
		}]
	}];
	for (const turn of input.history) {
		if (!turn.answer.trim()) continue;
		messages.push({
			role: "user",
			content: [{
				type: "text",
				text: turn.question
			}]
		});
		messages.push({
			id: turn.turnId,
			role: "assistant",
			content: [{
				type: "text",
				text: turn.answer
			}],
			source: {
				kind: "model",
				provider: "btw-history",
				model: "btw-history"
			}
		});
		if (turn.status !== "complete") degraded.add("history-partial");
	}
	messages.push({
		role: "user",
		content: [{
			type: "text",
			text: input.question
		}]
	});
	const baseSystem = input.facts?.system?.trim() ?? "";
	return {
		messages,
		system: baseSystem ? `${baseSystem}${SIDE_SYSTEM_ADDENDUM}` : SIDE_SYSTEM_ADDENDUM.trimStart(),
		degraded: [...degraded]
	};
}

//#endregion
//#region src/repository.ts
/** One record per topic, keyed by a filesystem-safe encoding of Session + Topic. */
const btwDomainSpec = defineDomain({
	name: "btw_topics",
	version: 1,
	layout: "per-record",
	tables: { topics: domainTable(btwTopicSchema) }
});
/** Encode a Session/Topic pair into the per-record key grammar. */
function topicKey(sessionId, topicId) {
	return Buffer.from(`${sessionId}\u0000${topicId}`, "utf8").toString("base64url");
}
/** Storage-backed Topic repository. Reads are synchronous snapshots of the open Domain. */
var BtwTopicRepository = class {
	domain;
	table;
	constructor(domain) {
		this.domain = domain;
		this.table = domain.table("topics");
	}
	all() {
		return [...this.table.entries()].map(([, topic]) => topic);
	}
	topics(sessionId) {
		const topics = [];
		for (const [, topic] of this.table.entries()) if (topic.sessionId === sessionId) topics.push(topic);
		return topics.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}
	get(sessionId, topicId) {
		const topic = this.table.get(topicKey(sessionId, topicId));
		return topic?.sessionId === sessionId ? topic : void 0;
	}
	async put(topic) {
		await this.table.put(topicKey(topic.sessionId, topic.topicId), topic);
	}
	async update(sessionId, topicId, transform) {
		return this.table.update(topicKey(sessionId, topicId), (current) => {
			if (current.sessionId !== sessionId || current.topicId !== topicId) throw new Error("btw topic identity changed");
			return transform(current);
		});
	}
	close() {
		return this.domain.close();
	}
};

//#endregion
//#region src/runner.ts
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 9e4;
function sleep(ms, signal) {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}
function retryable(policy, code) {
	if (!policy) return false;
	return policy.mode === "always" || policy.retryableCodes.includes(code);
}
function failureCode(error) {
	if (error && typeof error === "object") {
		const failure = error.failure;
		if (failure && typeof failure.code === "string") return failure.code;
		if (typeof error.code === "string") return error.code;
	}
	return "provider-error";
}
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* Execute one detached, tool-free side request. The caller owns the turn
* AbortSignal; this runner never reuses the main request signal or session id.
*/
async function runSideCall(input) {
	const deadline = AbortSignal.timeout(TIMEOUT_MS);
	const signal = AbortSignal.any([input.signal, deadline]);
	let lastError;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
		if (signal.aborted) break;
		const config = {
			provider: input.facts.provider,
			model: input.facts.model,
			maxTokens: Math.min(input.facts.maxTokens ?? 4096, 4096),
			...input.facts.reasoningEffort === void 0 ? {} : { reasoningEffort: input.facts.reasoningEffort },
			...input.facts.temperature === void 0 ? {} : { temperature: input.facts.temperature }
		};
		let prepared;
		try {
			prepared = await input.ctx.llm.prepareCall(config, signal);
		} catch (error) {
			lastError = error;
			if (!retryable(void 0, failureCode(error))) break;
			continue;
		}
		let text = "";
		try {
			const stream = prepared.stream({
				...prepared.config,
				messages: [...input.normalized.messages],
				system: input.normalized.system,
				signal
			});
			let finish;
			for await (const chunk of stream) if (chunk.type === "text-delta") {
				text += chunk.text;
				input.onDelta(chunk.text);
			} else if (chunk.type === "finish") finish = chunk.reason;
			if (finish?.kind === "error") throw Object.assign(/* @__PURE__ */ new Error("side provider returned an error"), { failure: finish.failure });
			if (finish?.kind === "aborted" || signal.aborted) return {
				status: "cancelled",
				text
			};
			if (!finish && !text) throw Object.assign(/* @__PURE__ */ new Error("side provider returned no content"), { failure: { code: "EMPTY_RESPONSE" } });
			return {
				status: "complete",
				text
			};
		} catch (error) {
			lastError = error;
			if (signal.aborted) return {
				status: "cancelled",
				text
			};
			if (text) return {
				status: "error",
				text,
				error: messageOf(error)
			};
			if (!retryable(prepared.retryPolicy, failureCode(error))) return {
				status: "error",
				text,
				error: messageOf(error)
			};
		}
		if (attempt + 1 < MAX_ATTEMPTS) {
			const backoff = prepared.retryPolicy;
			const base = Math.min(backoff.maxDelayMs, backoff.initialDelayMs * 2 ** attempt);
			const jitter = 1 + (Math.random() * 2 - 1) * backoff.jitterRatio;
			await sleep(Math.round(base * jitter), signal);
		}
	}
	if (deadline.aborted && !input.signal.aborted) return {
		status: "error",
		text: "",
		error: "provider-timeout: side request exceeded its deadline"
	};
	if (signal.aborted) return {
		status: "cancelled",
		text: ""
	};
	return {
		status: "error",
		text: "",
		error: messageOf(lastError ?? "provider-error")
	};
}

//#endregion
//#region src/hub.ts
/** In-memory, per-Session revisioned fan-out for streamed BTW updates. */
var BtwHub = class {
	subscribers = /* @__PURE__ */ new Set();
	currentRevision = 0;
	get revision() {
		return this.currentRevision;
	}
	publish(body) {
		this.currentRevision += 1;
		const frame = {
			...body,
			revision: this.currentRevision
		};
		for (const subscriber of this.subscribers) try {
			subscriber(frame);
		} catch {}
	}
	subscribe(subscriber) {
		this.subscribers.add(subscriber);
		return () => this.subscribers.delete(subscriber);
	}
	clear() {
		this.subscribers.clear();
	}
};

//#endregion
//#region src/service.ts
var __runInitializers = void 0 && (void 0).__runInitializers || function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = void 0 && (void 0).__esDecorate || function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
const MAX_QUESTION_CHARS = 8e3;
function now() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
function fail(code, message, details = {}) {
	throw new RemoteError(code, message, details);
}
/** Host-side BTW service: admission, durable Topic history, and detached side calls. */
let BtwService = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _ask_decorators;
	let _list_decorators;
	let _get_decorators;
	let _watch_decorators;
	let _cancel_decorators;
	return class BtwService$1 extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_ask_decorators = [Remote({ resources: { session: (request) => request.sessionId } })];
			_list_decorators = [Remote({ resources: { session: (request) => request.sessionId } })];
			_get_decorators = [Remote({ resources: { session: (request) => request.sessionId } })];
			_watch_decorators = [Remote({
				mode: "stream",
				resources: { session: (request) => request.sessionId }
			})];
			_cancel_decorators = [Remote({ resources: { session: (request) => request.sessionId } })];
			__esDecorate(this, null, _ask_decorators, {
				kind: "method",
				name: "ask",
				static: false,
				private: false,
				access: {
					has: (obj) => "ask" in obj,
					get: (obj) => obj.ask
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _list_decorators, {
				kind: "method",
				name: "list",
				static: false,
				private: false,
				access: {
					has: (obj) => "list" in obj,
					get: (obj) => obj.list
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _get_decorators, {
				kind: "method",
				name: "get",
				static: false,
				private: false,
				access: {
					has: (obj) => "get" in obj,
					get: (obj) => obj.get
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _watch_decorators, {
				kind: "method",
				name: "watch",
				static: false,
				private: false,
				access: {
					has: (obj) => "watch" in obj,
					get: (obj) => obj.watch
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _cancel_decorators, {
				kind: "method",
				name: "cancel",
				static: false,
				private: false,
				access: {
					has: (obj) => "cancel" in obj,
					get: (obj) => obj.cancel
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static inject = [
			"llm",
			"sessions",
			"agents",
			"storageDomain",
			"typert"
		];
		mirror = __runInitializers(this, _instanceExtraInitializers);
		hubs = /* @__PURE__ */ new Map();
		active = /* @__PURE__ */ new Map();
		requestIndex = /* @__PURE__ */ new Map();
		ready;
		repo;
		initError;
		constructor(ctx) {
			super(ctx, "btw", { namespace: "btw" });
			this.mirror = new LiveContextMirror(ctx);
			this.ready = this.initialize().catch((error) => {
				this.initError = error;
			});
			ctx.effect(() => () => {
				for (const turn of this.active.values()) turn.controller.abort();
				this.active.clear();
				for (const hub of this.hubs.values()) hub.clear();
				this.repo?.close();
			});
		}
		async initialize() {
			this.repo = new BtwTopicRepository(await this.ctx.storageDomain.open(btwDomainSpec));
			for (const topic of this.repo.all()) {
				this.indexTopic(topic);
				if (!topic.turns.some((turn) => turn.status === "running")) continue;
				await this.repo.update(topic.sessionId, topic.topicId, (current) => {
					const at = now();
					return {
						...current,
						revision: current.revision + 1,
						updatedAt: at,
						turns: current.turns.map((turn) => turn.status === "running" ? {
							...turn,
							status: "interrupted",
							error: "host-crash",
							updatedAt: at
						} : turn)
					};
				});
			}
		}
		indexTopic(topic) {
			for (const turn of topic.turns) this.requestIndex.set(this.requestKey(topic.sessionId, turn.requestId), {
				topicId: topic.topicId,
				turnId: turn.turnId
			});
		}
		requestKey(sessionId, requestId) {
			return `${sessionId}\u0000${requestId}`;
		}
		async repository() {
			await this.ready;
			if (this.initError !== void 0 || !this.repo) throw new RemoteError("btw/internal", "BTW storage is unavailable", {});
			return this.repo;
		}
		hub(sessionId) {
			let hub = this.hubs.get(sessionId);
			if (!hub) {
				hub = new BtwHub();
				this.hubs.set(sessionId, hub);
			}
			return hub;
		}
		validateSession(sessionId) {
			if (typeof sessionId !== "string" || !sessionId) fail("btw/invalid-input", "sessionId is required", { field: "sessionId" });
		}
		ensureAgent(sessionId) {
			const agent = this.ctx.agents.get(sessionId);
			if (!agent) fail("btw/context-unavailable", "The main Agent is not live in this Host process", {});
			const session = agent.session;
			const live = this.mirror.capture(session);
			let facts = live.facts;
			const degraded = [...live.degraded];
			if (!facts) {
				const { provider, model } = agent.options;
				if (provider && model) {
					facts = {
						provider,
						model,
						...agent.options.reasoningEffort === void 0 ? {} : { reasoningEffort: agent.options.reasoningEffort },
						...agent.options.maxTokens === void 0 ? {} : { maxTokens: agent.options.maxTokens }
					};
					degraded.push("late-mount");
				}
			}
			if (!facts) fail("btw/no-model", "No main model route is observable yet", {});
			return {
				session,
				facts,
				degraded,
				...live.inFlightText === void 0 ? {} : { inFlightText: live.inFlightText },
				...live.attemptId === void 0 ? {} : { attemptId: live.attemptId },
				...live.attemptRevision === void 0 ? {} : { attemptRevision: live.attemptRevision },
				...live.chunkIndex === void 0 ? {} : { chunkIndex: live.chunkIndex }
			};
		}
		async ask(request, signal) {
			this.validateSession(request.sessionId);
			const question = typeof request.question === "string" ? request.question.trim() : "";
			if (!question) fail("btw/invalid-input", "question is required", { field: "question" });
			if (question.length > MAX_QUESTION_CHARS) fail("btw/invalid-input", "question is too long", { field: "question" });
			if (typeof request.requestId !== "string" || !request.requestId) fail("btw/invalid-input", "requestId is required", { field: "requestId" });
			signal?.throwIfAborted();
			const duplicate = this.requestIndex.get(this.requestKey(request.sessionId, request.requestId));
			if (duplicate) {
				const topic = (await this.repository()).get(request.sessionId, duplicate.topicId);
				const turn = topic?.turns.find((candidate) => candidate.turnId === duplicate.turnId);
				return {
					topicId: duplicate.topicId,
					turnId: duplicate.turnId,
					status: turn?.status ?? "running",
					revision: topic?.revision ?? 0
				};
			}
			if (this.active.has(request.sessionId)) fail("btw/busy", "Another BTW turn is active in this Session", {});
			const repoBeforeCapture = this.repo;
			if (!repoBeforeCapture) fail("btw/internal", "BTW storage is not ready", {});
			const existing = request.topicId ? repoBeforeCapture.get(request.sessionId, request.topicId) : void 0;
			if (request.topicId && !existing) fail("btw/invalid-input", "Unknown BTW topic for this Session", { field: "topicId" });
			if (request.expectedRevision !== void 0 && existing && request.expectedRevision !== existing.revision) fail("btw/revision-conflict", "BTW topic revision changed", {
				expected: request.expectedRevision,
				actual: existing.revision
			});
			if (existing?.turns.some((turn) => turn.status === "running")) fail("btw/busy", "This BTW topic already has a running turn", { topicId: existing.topicId });
			const topicId = existing?.topicId ?? randomUUID();
			const turnId = randomUUID();
			const controller = new AbortController();
			const active = {
				sessionId: request.sessionId,
				topicId,
				turnId,
				requestId: request.requestId,
				controller,
				phase: "admitting"
			};
			this.active.set(request.sessionId, active);
			this.requestIndex.set(this.requestKey(request.sessionId, request.requestId), {
				topicId,
				turnId
			});
			let cut;
			let messages;
			let facts;
			try {
				const captured = this.ensureAgent(request.sessionId);
				const session = captured.session;
				messages = session.deriveMessages();
				facts = captured.facts;
				cut = {
					sessionId: request.sessionId,
					eventSeq: session.seq - 1,
					cutOffset: session.seq,
					capturedAt: now(),
					...captured.attemptId === void 0 ? {} : { attemptId: captured.attemptId },
					...captured.attemptRevision === void 0 ? {} : { attemptRevision: captured.attemptRevision },
					...captured.chunkIndex === void 0 ? {} : { chunkIndex: captured.chunkIndex },
					degraded: captured.degraded
				};
				const at = now();
				const turn = {
					turnId,
					requestId: request.requestId,
					question,
					answer: "",
					status: "running",
					createdAt: at,
					updatedAt: at,
					contextCut: cut
				};
				const topic = existing ? {
					...existing,
					revision: existing.revision + 1,
					updatedAt: at,
					turns: [...existing.turns, turn]
				} : {
					sessionId: request.sessionId,
					topicId,
					title: question.length > 60 ? `${question.slice(0, 57)}...` : question,
					revision: 1,
					createdAt: at,
					updatedAt: at,
					turns: [turn]
				};
				const repo = await this.repository();
				if (controller.signal.aborted) {
					this.release(active);
					this.requestIndex.delete(this.requestKey(request.sessionId, request.requestId));
					fail("btw/invalid-input", "BTW request was cancelled before admission", {});
				}
				await repo.put(topic);
				if (controller.signal.aborted) {
					await this.finalize(active, "cancelled", "", "cancelled before dispatch");
					return {
						topicId,
						turnId,
						status: "cancelled",
						revision: topic.revision + 1
					};
				}
				this.hub(request.sessionId).publish({
					type: "topic",
					topic
				});
				this.run(active, topic, messages, facts, captured.inFlightText);
				return {
					topicId,
					turnId,
					status: "running",
					revision: topic.revision
				};
			} catch (error) {
				this.active.delete(request.sessionId);
				this.requestIndex.delete(this.requestKey(request.sessionId, request.requestId));
				if (error instanceof RemoteError) throw error;
				throw new RemoteError("btw/storage-admission-failed", "BTW turn could not be admitted durably", { cause: error });
			}
		}
		async run(active, topic, messages, facts, inFlightText) {
			const signal = active.controller.signal;
			try {
				active.phase = "running";
				const current = topic.turns.find((turn) => turn.turnId === active.turnId);
				if (!current) return;
				const history = topic.turns.filter((turn) => turn.turnId !== active.turnId);
				const normalized = normalizeSideContext({
					messages,
					cut: current.contextCut,
					history,
					question: current.question,
					facts,
					...inFlightText === void 0 ? {} : { inFlightText }
				});
				if (signal.aborted) {
					await this.finalize(active, "cancelled", "", "cancelled before dispatch");
					return;
				}
				const result = await runSideCall({
					ctx: this.ctx,
					facts,
					normalized,
					signal,
					onDelta: (text) => this.hub(active.sessionId).publish({
						type: "delta",
						topicId: active.topicId,
						turnId: active.turnId,
						text
					})
				});
				await this.finalize(active, result.status, result.text, result.error);
			} catch (error) {
				await this.finalize(active, "error", "", error instanceof Error ? error.message : String(error)).catch(() => void 0);
			}
		}
		release(active) {
			if (this.active.get(active.sessionId)?.turnId === active.turnId) this.active.delete(active.sessionId);
		}
		async finalize(active, status, answer, error) {
			active.phase = "finalizing";
			const repo = this.repo;
			if (!repo) return;
			let changed = false;
			try {
				const updated = await repo.update(active.sessionId, active.topicId, (current) => {
					const index = current.turns.findIndex((turn$1) => turn$1.turnId === active.turnId);
					if (index < 0) return current;
					const turn = current.turns[index];
					if (!turn || turn.status !== "running") return current;
					const at = now();
					const next = {
						...turn,
						status,
						answer: answer || turn.answer,
						updatedAt: at,
						...error === void 0 ? {} : { error }
					};
					changed = true;
					return {
						...current,
						revision: current.revision + 1,
						updatedAt: at,
						turns: current.turns.map((candidate, candidateIndex) => candidateIndex === index ? next : candidate)
					};
				});
				if (changed) {
					this.hub(active.sessionId).publish({
						type: "topic",
						topic: updated
					});
					this.hub(active.sessionId).publish({
						type: "settled",
						topicId: active.topicId,
						turnId: active.turnId,
						status,
						...error === void 0 ? {} : { error }
					});
				}
			} catch (cause) {
				this.hub(active.sessionId).publish({
					type: "settled",
					topicId: active.topicId,
					turnId: active.turnId,
					status: "interrupted",
					error: `storage-terminal-unknown: ${cause instanceof Error ? cause.message : String(cause)}`
				});
			} finally {
				this.release(active);
			}
		}
		async list(request) {
			this.validateSession(request.sessionId);
			return { topics: (await this.repository()).topics(request.sessionId) };
		}
		async get(request) {
			this.validateSession(request.sessionId);
			return { topic: (await this.repository()).get(request.sessionId, request.topicId) ?? null };
		}
		async *watch(request, signal) {
			this.validateSession(request.sessionId);
			const repo = await this.repository();
			const hub = this.hub(request.sessionId);
			const queue = [];
			let wake;
			const unsubscribe = hub.subscribe((frame) => {
				queue.push(frame);
				wake?.();
			});
			try {
				yield {
					type: "snapshot",
					revision: hub.revision,
					topics: repo.topics(request.sessionId)
				};
				while (!signal?.aborted) {
					const next = queue.shift();
					if (next) {
						yield next;
						continue;
					}
					await new Promise((resolve) => {
						const done = () => {
							signal?.removeEventListener("abort", done);
							resolve();
						};
						wake = done;
						signal?.addEventListener("abort", done, { once: true });
					});
					wake = void 0;
				}
			} finally {
				unsubscribe();
			}
		}
		async cancel(request) {
			this.validateSession(request.sessionId);
			const repo = await this.repository();
			const active = this.active.get(request.sessionId);
			if (!active || active.topicId !== request.topicId || active.turnId !== request.turnId) return {
				cancelled: false,
				topic: repo.get(request.sessionId, request.topicId) ?? null
			};
			active.controller.abort();
			return {
				cancelled: true,
				topic: repo.get(request.sessionId, request.topicId) ?? null
			};
		}
	};
})();

//#endregion
export { BtwService, BtwService as default, BtwTopicRepository, LiveContextMirror, MAX_CONTEXT_CHARS, btwDomainSpec, btwTopicSchema, normalizeSideContext, runSideCall, topicKey };