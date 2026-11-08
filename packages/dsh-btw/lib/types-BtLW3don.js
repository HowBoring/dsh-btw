import { z } from "zod";

//#region src/types.ts
const contextCutSchema = z.object({
	sessionId: z.string().min(1),
	eventSeq: z.number().int().min(-1),
	cutOffset: z.number().int().min(0),
	capturedAt: z.string().min(1),
	attemptId: z.string().min(1).optional(),
	attemptRevision: z.number().int().min(0).optional(),
	chunkIndex: z.number().int().min(0).optional(),
	degraded: z.array(z.string().min(1))
});
const turnSchema = z.object({
	turnId: z.string().min(1),
	requestId: z.string().min(1),
	question: z.string().min(1),
	answer: z.string(),
	status: z.enum([
		"running",
		"complete",
		"cancelled",
		"error",
		"interrupted"
	]),
	createdAt: z.string().min(1),
	updatedAt: z.string().min(1),
	contextCut: contextCutSchema,
	error: z.string().min(1).optional()
});
/** Stored value schema; the public TypeScript contract is the interface above. */
const btwTopicSchema = z.object({
	sessionId: z.string().min(1),
	topicId: z.string().min(1),
	title: z.string().min(1),
	revision: z.number().int().min(0),
	createdAt: z.string().min(1),
	updatedAt: z.string().min(1),
	turns: z.array(turnSchema)
});

//#endregion
export { btwTopicSchema as t };