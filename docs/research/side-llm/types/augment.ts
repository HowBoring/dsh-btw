import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface GenerateOptions {
    purpose?: 'compaction' | 'session-title' | 'btw'
  }
}

export const btw: GenerateOptions = { provider: 'p', model: 'm', messages: [], purpose: 'btw' }
