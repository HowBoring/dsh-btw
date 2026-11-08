import type { ContentBlock, Message, MessageId, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { BtwContextCut, BtwTurn } from './types.ts'

/** Upper bound for the quoted main-session transcript, in characters. */
export const MAX_CONTEXT_CHARS = 48_000

const SIDE_SYSTEM_ADDENDUM = [
  '',
  '## Separate BTW side channel',
  'You are answering a separate, read-only side question about the main session.',
  'You have no tools and cannot act on the session. Never claim to have executed a tool or',
  'observed a tool result that is not quoted here. Base the answer only on the supplied',
  'main-session context and this BTW topic history. The main agent does not see this exchange.',
].join('\n')

export interface NormalizedSideContext {
  readonly messages: readonly RequestMessage[]
  readonly system: string
  readonly degraded: readonly string[]
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()
}

/**
 * Build a provider-valid side request. Tool history is flattened to plain text:
 * assistant tool calls never appear without a matching result message, and no
 * synthetic successful result is invented. Reasoning, images, files, developer
 * messages and tool declarations are omitted.
 */
export function normalizeSideContext(input: {
  readonly messages: readonly Message[]
  readonly cut: BtwContextCut
  readonly history: readonly BtwTurn[]
  readonly question: string
  readonly facts?: { readonly system?: string | undefined }
  readonly inFlightText?: string | undefined
}): NormalizedSideContext {
  const degraded = new Set(input.cut.degraded)
  const openCalls = new Set<string>()
  const callNames = new Map<string, string>()

  for (const message of input.messages) {
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'tool-call') {
          openCalls.add(block.id)
          callNames.set(block.id, block.name)
        }
      }
    } else if (message.role === 'tool') {
      openCalls.delete(message.toolCallId)
    }
  }

  const lines: string[] = []
  for (const message of input.messages) {
    if (message.role === 'system' || message.role === 'developer') continue
    if (message.role === 'user') {
      const text = textOf(message.content)
      if (text) lines.push(`[user]\n${text}`)
      continue
    }
    if (message.role === 'tool') {
      const name = callNames.get(message.toolCallId) ?? 'tool'
      const text = textOf(message.content)
      lines.push(`[tool result: ${name}${message.isError ? ' (error)' : ''}]\n${text || '(empty result)'}`)
      continue
    }
    const text = textOf(message.content)
    if (text) lines.push(`[assistant]\n${text}`)
    for (const block of message.content) {
      if (block.type === 'tool-call' && openCalls.has(block.id)) {
        lines.push(
          `[tool call not executed in this side view: ${block.name}] The main agent requested this tool and no result is available at capture time.`,
        )
      }
    }
  }
  if (input.inFlightText?.trim()) {
    lines.push(`[assistant, still streaming at capture]\n${input.inFlightText.trim()}`)
  }

  let transcript = lines.join('\n\n')
  if (transcript.length > MAX_CONTEXT_CHARS) {
    transcript = `${transcript.slice(-MAX_CONTEXT_CHARS)}\n[... older main context truncated ...]`
    degraded.add('context-truncated')
  }
  if (!transcript) transcript = '(The main session has no observable committed conversation content yet.)'

  const messages: RequestMessage[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Main session context captured at BTW admission (read-only; newest last):\n\n${transcript}`,
        },
      ],
    },
  ]

  for (const turn of input.history) {
    if (!turn.answer.trim()) continue
    messages.push({ role: 'user', content: [{ type: 'text', text: turn.question }] })
    messages.push({
      id: turn.turnId as MessageId,
      role: 'assistant',
      content: [{ type: 'text', text: turn.answer }],
      source: {
        kind: 'model',
        provider: 'btw-history',
        model: 'btw-history',
      },
    })
    if (turn.status !== 'complete') degraded.add('history-partial')
  }

  messages.push({ role: 'user', content: [{ type: 'text', text: input.question }] })

  const baseSystem = input.facts?.system?.trim() ?? ''
  return {
    messages,
    system: baseSystem ? `${baseSystem}${SIDE_SYSTEM_ADDENDUM}` : SIDE_SYSTEM_ADDENDUM.trimStart(),
    degraded: [...degraded],
  }
}
