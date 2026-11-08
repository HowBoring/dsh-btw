window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-btw",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
let zod = require("zod");
zod = __toESM(zod);
let react = require("react");
react = __toESM(react);
let react_jsx_runtime = require("react/jsx-runtime");
react_jsx_runtime = __toESM(react_jsx_runtime);

//#region ../../node_modules/@deepseek-ai/dsh-typert-protocol/lib/types/remote-info.js
/** Lazy assembly of generated Remote definitions using caller-supplied Zod; no runtime imports. */
/**
* Retain one generated definition per endpoint without constructing parsers or projections.
* The class instance builds its shared descriptor/method index on first access;
* input schemas and JSON Schema projections are cached only when requested.
* @param spec - compiler-produced method facts and Zod factories.
* @param zod - the generated artifact's Zod runtime for named-input parsers.
* @returns a lazy, mountable info instance with no registration or transport effects.
*/
function createTypertRemoteInfo(spec, zod$1) {
	return new RemoteInfo(spec, zod$1);
}
var RemoteInfo = class {
	spec;
	zod;
	index;
	constructor(spec, zod$1) {
		this.spec = spec;
		this.zod = zod$1;
	}
	get package() {
		return this.spec.package;
	}
	get descriptors() {
		return this.resolve().descriptors;
	}
	get methods() {
		return this.resolve().methods;
	}
	resolve() {
		if (this.index !== void 0) return this.index;
		const zod$1 = this.zod;
		const descriptors = [];
		const methods = Object.create(null);
		for (const [endpoint, definition] of Object.entries(this.spec.methods)) {
			const separator = endpoint.indexOf("/");
			const namespace = endpoint.slice(0, separator);
			const method = endpoint.slice(separator + 1);
			const parameters = definition.parameters.map((parameter) => ({
				...parameter,
				wire: parameter.wire ?? parameter.name
			}));
			const descriptor = {
				...definition,
				id: `${this.spec.package}#${endpoint}`,
				namespace,
				method,
				parameters,
				result: definition.result.description === void 0 ? definition.result : new ResultValue(definition.result)
			};
			if (definition.invocation.kind === "direct") {
				const inputs = [];
				methods[endpoint] = Object.assign(descriptor, {
					input(options) {
						const strict = options?.strict === true;
						return inputs[strict ? 1 : 0] ??= new NamedInput(parameters, strict, zod$1);
					},
					invoke(remote, input, signal) {
						const named = input;
						const values = parameters.map((parameter) => named[parameter.wire]);
						if (definition.cancellation !== void 0) values.push(signal);
						const receiver = Reflect.get(remote, namespace);
						return Reflect.get(receiver, method).apply(receiver, values);
					}
				});
			}
			descriptors.push(descriptor);
		}
		return this.index = {
			descriptors,
			methods
		};
	}
};
function optional(parameter) {
	return parameter.source === "json" && parameter.acceptsUndefined === true;
}
var NamedInput = class {
	parameters;
	strict;
	zod;
	schema;
	projection;
	constructor(parameters, strict, zod$1) {
		this.parameters = parameters;
		this.strict = strict;
		this.zod = zod$1;
	}
	codec(parameter) {
		return this.strict ? parameter.strictCodec : parameter.codec;
	}
	create = () => this.schema ??= this.zod.strictObject(Object.fromEntries(this.parameters.map((parameter) => {
		const value = this.codec(parameter).create();
		return [parameter.wire, optional(parameter) ? value.optional() : value.nonoptional()];
	})));
	get jsonSchema() {
		return this.project().jsonSchema;
	}
	get jsonSchemaError() {
		return this.project().jsonSchemaError;
	}
	project() {
		if (this.projection !== void 0) return this.projection;
		const unavailable = this.parameters.find((parameter) => this.codec(parameter).jsonSchema === void 0);
		if (unavailable !== void 0) return this.projection = { jsonSchemaError: this.codec(unavailable).jsonSchemaError ?? `No JSON Schema for parameter ${unavailable.wire}` };
		return this.projection = { jsonSchema: {
			type: "object",
			properties: Object.fromEntries(this.parameters.map((parameter) => [parameter.wire, {
				...this.codec(parameter).jsonSchema,
				...parameter.description === void 0 ? {} : { description: parameter.description }
			}])),
			required: this.parameters.filter((parameter) => !optional(parameter)).map((parameter) => parameter.wire),
			additionalProperties: false
		} };
	}
};
var ResultValue = class {
	spec;
	projection;
	constructor(spec) {
		this.spec = spec;
	}
	get mode() {
		return this.spec.mode;
	}
	get typeSymbol() {
		return this.spec.typeSymbol;
	}
	get create() {
		return this.spec.create;
	}
	get decode() {
		return this.spec.decode;
	}
	get encode() {
		return this.spec.encode;
	}
	get description() {
		return this.spec.description;
	}
	get jsonSchemaError() {
		return this.spec.jsonSchemaError;
	}
	get jsonSchema() {
		if (this.projection === void 0) {
			const schema = this.spec.jsonSchema;
			this.projection = { value: schema === void 0 ? void 0 : {
				...schema,
				description: this.spec.description
			} };
		}
		return this.projection.value;
	}
};

//#endregion
//#region src/client/remote.ts
const request = (typeSymbol) => ({
	name: "request",
	source: "json",
	codec: codec(typeSymbol),
	strictCodec: codec(typeSymbol)
});
function codec(typeSymbol) {
	return {
		mode: "strict",
		typeSymbol,
		create: () => zod.z.unknown(),
		jsonSchema: {}
	};
}
function result(typeSymbol, create) {
	return {
		mode: "strict",
		typeSymbol,
		create,
		jsonSchema: {}
	};
}
/** The generated Remote contribution for the BTW namespace. */
const btwRemote = createTypertRemoteInfo({
	package: "@deepseek-ai/dsh-btw",
	methods: {
		"btw/ask": {
			service: "btw",
			description: "Admit a BTW question or follow-up and return a durable receipt before the side model call.",
			invocation: { kind: "direct" },
			parameters: [request("@deepseek-ai/dsh-btw/types#BtwAskRequest")],
			cancellation: { parameter: "signal" },
			result: result("@deepseek-ai/dsh-btw/types#BtwAskReceipt", () => zod.z.unknown())
		},
		"btw/list": {
			service: "btw",
			description: "List durable BTW Topics for one Session without waking its Agent.",
			invocation: { kind: "direct" },
			parameters: [request("@deepseek-ai/dsh-btw/types#BtwListRequest")],
			result: result("@deepseek-ai/dsh-btw/types#BtwListValue", () => zod.z.unknown())
		},
		"btw/get": {
			service: "btw",
			description: "Read one durable BTW Topic for one Session without waking its Agent.",
			invocation: { kind: "direct" },
			parameters: [request("@deepseek-ai/dsh-btw/types#BtwGetRequest")],
			result: result("@deepseek-ai/dsh-btw/types#BtwGetValue", () => zod.z.unknown())
		},
		"btw/watch": {
			service: "btw",
			description: "Stream BTW Topic snapshots and deltas for one Session; closing the stream never cancels work.",
			mode: "stream",
			invocation: { kind: "direct" },
			parameters: [request("@deepseek-ai/dsh-btw/types#BtwWatchRequest")],
			cancellation: { parameter: "signal" },
			result: result("@deepseek-ai/dsh-btw/types#BtwFrame", () => zod.z.unknown())
		},
		"btw/cancel": {
			service: "btw",
			description: "Explicitly cancel the one active BTW turn in a Session and retain its partial answer.",
			invocation: { kind: "direct" },
			parameters: [request("@deepseek-ai/dsh-btw/types#BtwCancelRequest")],
			result: result("@deepseek-ai/dsh-btw/types#BtwCancelValue", () => zod.z.unknown())
		}
	}
}, zod.z);
var remote_default = btwRemote;

//#endregion
//#region src/client/BtwPanel.tsx
const panel = {
	display: "flex",
	flexDirection: "column",
	gap: 12,
	height: "100%",
	minHeight: 0,
	padding: 12,
	boxSizing: "border-box",
	fontSize: 13
};
const row = {
	display: "flex",
	gap: 8,
	alignItems: "center",
	flexWrap: "wrap"
};
const topics = {
	display: "flex",
	flexDirection: "column",
	gap: 4,
	maxHeight: 160,
	overflowY: "auto"
};
const topicButton = (active) => ({
	textAlign: "left",
	padding: "6px 8px",
	borderRadius: 6,
	border: active ? "1px solid var(--dsh-color-accent, #4f8cff)" : "1px solid transparent",
	background: active ? "var(--dsh-color-accent-muted, rgba(79,140,255,0.12))" : "transparent",
	color: "inherit",
	cursor: "pointer",
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap"
});
const detail = {
	flex: 1,
	minHeight: 0,
	overflowY: "auto",
	display: "flex",
	flexDirection: "column",
	gap: 12
};
const turnBox = {
	display: "flex",
	flexDirection: "column",
	gap: 4
};
const questionStyle = { fontWeight: 600 };
const answer = {
	whiteSpace: "pre-wrap",
	wordBreak: "break-word",
	margin: 0
};
const meta = {
	opacity: .65,
	fontSize: 11
};
const textarea = {
	width: "100%",
	minHeight: 64,
	resize: "vertical",
	boxSizing: "border-box"
};
const errorStyle = {
	color: "var(--dsh-color-danger, #d94848)",
	whiteSpace: "pre-wrap"
};
const STATUS_LABEL = {
	running: "answering…",
	complete: "complete",
	cancelled: "cancelled",
	error: "error",
	interrupted: "interrupted"
};
function upsert(list, topic) {
	const next = list.filter((candidate) => candidate.topicId !== topic.topicId);
	next.push(topic);
	return next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
function BtwPanel({ sessionId, btw }) {
	const [items, setItems] = (0, react.useState)([]);
	const [selectedId, setSelectedId] = (0, react.useState)(void 0);
	const [live, setLive] = (0, react.useState)({});
	const [question, setQuestion] = (0, react.useState)("");
	const [sending, setSending] = (0, react.useState)(false);
	const [error, setError] = (0, react.useState)(void 0);
	const revision = (0, react.useRef)(0);
	const selectedRef = (0, react.useRef)(void 0);
	selectedRef.current = selectedId;
	(0, react.useEffect)(() => {
		setItems([]);
		setSelectedId(void 0);
		setLive({});
		setError(void 0);
		revision.current = 0;
		const controller = new AbortController();
		const handle = btw.watch({ sessionId }, controller.signal);
		(async () => {
			try {
				for await (const frame of handle) {
					if (frame.revision < revision.current) continue;
					revision.current = frame.revision;
					if (frame.type === "snapshot") {
						setItems(frame.topics);
						setSelectedId((current) => {
							if (current && frame.topics.some((topic) => topic.topicId === current)) return current;
							return frame.topics[0]?.topicId;
						});
					} else if (frame.type === "topic") {
						setItems((current) => upsert(current, frame.topic));
						setSelectedId((current) => {
							if (current) return current;
							return frame.topic.turns.some((turn) => turn.status === "running") ? frame.topic.topicId : current;
						});
					} else if (frame.type === "delta") setLive((current) => ({
						...current,
						[frame.turnId]: `${current[frame.turnId] ?? ""}${frame.text}`
					}));
					else if (frame.type === "settled") setLive((current) => {
						const next = { ...current };
						delete next[frame.turnId];
						return next;
					});
				}
			} catch (cause) {
				if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
			}
		})();
		return () => {
			controller.abort();
			handle.dispose();
		};
	}, [btw, sessionId]);
	const selected = items.find((topic) => topic.topicId === selectedId);
	const running = selected?.turns.find((turn) => turn.status === "running");
	const anyRunning = items.some((topic) => topic.turns.some((turn) => turn.status === "running"));
	const submit = (0, react.useCallback)(async () => {
		const text = question.trim();
		if (!text || sending) return;
		setSending(true);
		setError(void 0);
		try {
			const result$1 = await btw.ask({
				sessionId,
				...selectedId === void 0 ? {} : { topicId: selectedId },
				question: text,
				requestId: crypto.randomUUID()
			});
			if (!result$1.ok) throw result$1.error;
			setQuestion("");
			setSelectedId(result$1.value.topicId);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSending(false);
		}
	}, [
		btw,
		question,
		selectedId,
		sending,
		sessionId
	]);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: panel,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: row,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "BTW side questions" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: meta,
					children: "does not touch the main conversation"
				})]
			}),
			items.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: topics,
				children: items.map((topic) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					style: topicButton(topic.topicId === selectedId),
					onClick: () => setSelectedId(topic.topicId),
					title: topic.title,
					children: topic.title
				}, topic.topicId))
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: detail,
				children: [selected ? selected.turns.map((turn) => {
					const text = `${turn.answer}${live[turn.turnId] ?? ""}`;
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: turnBox,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: questionStyle,
								children: turn.question
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: meta,
								children: [STATUS_LABEL[turn.status], turn.contextCut.degraded.length > 0 ? ` · context: ${turn.contextCut.degraded.join(", ")}` : ""]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
								style: answer,
								children: text || (turn.status === "running" ? "…" : "")
							}),
							turn.error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: errorStyle,
								children: turn.error
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: row,
								children: [turn.answer && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => void navigator.clipboard.writeText(turn.answer),
									children: "Copy"
								}), turn.status === "running" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => {
										btw.cancel({
											sessionId,
											topicId: selected.topicId,
											turnId: turn.turnId
										});
									},
									children: "Stop"
								})]
							})
						]
					}, turn.turnId);
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: meta,
					children: "No side conversation yet. Ask below to start one."
				}), error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: errorStyle,
					children: error
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 6
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
					style: textarea,
					value: question,
					placeholder: selected ? `Follow up in "${selected.title}"…` : "Ask a side question…",
					onChange: (event) => setQuestion(event.target.value),
					onKeyDown: (event) => {
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
							event.preventDefault();
							submit();
						}
					}
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: row,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							disabled: sending || anyRunning || !question.trim(),
							onClick: () => void submit(),
							children: sending ? "Asking…" : selected ? "Follow up" : "Ask BTW"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							disabled: sending || anyRunning,
							onClick: () => {
								setSelectedId(void 0);
								setQuestion("");
								setError(void 0);
							},
							children: "New topic"
						}),
						running && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: meta,
							children: "One BTW turn per Session; stop it to ask again."
						})
					]
				})]
			})
		]
	});
}

//#endregion
//#region src/client/index.tsx
const name = "@deepseek-ai/dsh-btw";
const inject = [
	"remote",
	"slots",
	"sidebarRight",
	"sidebarRightTabs",
	"commandUi",
	"inputTriggers"
];
const TAB_ID = "dsh-btw";
const TAB_KIND = "btw";
/** Mount the feature Remote, the Session-scoped panel, and `/btw` Client routing. */
async function apply(ctx) {
	const unmount = await ctx.remote.$mount(remote_default);
	ctx.effect(() => () => void unmount());
	ctx.inject(["remote.btw"], (scope) => {
		const btw = scope.remote.btw;
		ctx.effect(() => ctx.sidebarRightTabs.register({
			id: TAB_ID,
			kind: TAB_KIND,
			priority: "extension",
			title: () => "BTW"
		}), "dsh-btw: sidebar tab type");
		ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
			name: "sidebar.right.pane.tab",
			key: TAB_ID,
			inject: () => ({ btw })
		}, BtwPanel)), "dsh-btw: sidebar panel");
		ctx.effect(() => ctx.commandUi.register({
			name: "btw",
			label: () => "BTW side question",
			description: () => "Open side conversations that never touch the main conversation",
			available: () => true,
			ui: {
				kind: "action",
				run: (session) => {
					ctx.sidebarRight.openTabIn(session.sessionId, TAB_KIND);
				}
			}
		}), "dsh-btw: bare /btw command");
		ctx.effect(() => ctx.inputTriggers.registerSource({
			trigger: "/",
			name: "btw",
			showGroupTitle: false,
			candidates: async () => [],
			onPick: () => void 0,
			matchEnter: async (session, line, _signal, envelope) => {
				if (!line.startsWith("/btw ")) return void 0;
				if (envelope.attachments > 0) throw new Error("BTW side questions do not accept attachments");
				const parsed = line.slice(5).trim();
				if (!parsed) return void 0;
				const sessionId = session.sessionId;
				return { claim: {
					name: "btw",
					token: "/btw ",
					submit: async (args) => {
						const question = (args || parsed).trim();
						if (!question) return {
							kind: "error",
							text: "BTW needs a question"
						};
						ctx.sidebarRight.openTabIn(sessionId, TAB_KIND);
						const result$1 = await btw.ask({
							sessionId,
							question,
							requestId: crypto.randomUUID()
						});
						return result$1.ok ? { kind: "success" } : {
							kind: "error",
							text: result$1.error.message
						};
					}
				} };
			}
		}), "dsh-btw: argued /btw input source");
	});
}

//#endregion
exports.apply = apply;
exports.inject = inject;
exports.name = name;
    return module.exports;
  }
});
