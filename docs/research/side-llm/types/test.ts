import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

const base = { provider: 'p', model: 'm', messages: [] as GenerateOptions['messages'] }

// positive control: an installed purpose compiles
export const compaction: GenerateOptions = { ...base, purpose: 'compaction' }

// @ts-expect-error 'btw' is not in the closed union 'compaction' | 'session-title'
export const btw: GenerateOptions = { ...base, purpose: 'btw' }
