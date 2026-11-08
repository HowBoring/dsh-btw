import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BtwFrame, BtwTopic, BtwTurn } from '../types.ts'

export type BtwRemote = ClientRemote['btw']

export type BtwPanelProps = PropsRuntime<'sidebar.right.pane.tab'> & InjectFace<{ btw: BtwRemote }>

const panel: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  height: '100%',
  minHeight: 0,
  padding: 12,
  boxSizing: 'border-box',
  fontSize: 13,
}
const row: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }
const topics: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 160, overflowY: 'auto' }
const topicButton = (active: boolean): CSSProperties => ({
  textAlign: 'left',
  padding: '6px 8px',
  borderRadius: 6,
  border: active ? '1px solid var(--dsh-color-accent, #4f8cff)' : '1px solid transparent',
  background: active ? 'var(--dsh-color-accent-muted, rgba(79,140,255,0.12))' : 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})
const detail: CSSProperties = { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }
const turnBox: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 }
const questionStyle: CSSProperties = { fontWeight: 600 }
const answer: CSSProperties = { whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }
const meta: CSSProperties = { opacity: 0.65, fontSize: 11 }
const textarea: CSSProperties = { width: '100%', minHeight: 64, resize: 'vertical', boxSizing: 'border-box' }
const errorStyle: CSSProperties = { color: 'var(--dsh-color-danger, #d94848)', whiteSpace: 'pre-wrap' }

const STATUS_LABEL: Record<BtwTurn['status'], string> = {
  running: 'answering…',
  complete: 'complete',
  cancelled: 'cancelled',
  error: 'error',
  interrupted: 'interrupted',
}

function upsert(list: readonly BtwTopic[], topic: BtwTopic): BtwTopic[] {
  const next = list.filter((candidate) => candidate.topicId !== topic.topicId)
  next.push(topic)
  return next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function BtwPanel({ sessionId, btw }: BtwPanelProps): ReactNode {
  const [items, setItems] = useState<readonly BtwTopic[]>([])
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [live, setLive] = useState<Readonly<Record<string, string>>>({})
  const [question, setQuestion] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const revision = useRef(0)
  const selectedRef = useRef<string | undefined>(undefined)
  selectedRef.current = selectedId

  useEffect(() => {
    setItems([])
    setSelectedId(undefined)
    setLive({})
    setError(undefined)
    revision.current = 0
    const controller = new AbortController()
    const handle = btw.watch({ sessionId }, controller.signal)
    void (async () => {
      try {
        for await (const frame of handle as AsyncIterable<BtwFrame>) {
          if (frame.revision < revision.current) continue
          revision.current = frame.revision
          if (frame.type === 'snapshot') {
            setItems(frame.topics)
            setSelectedId((current) => {
              if (current && frame.topics.some((topic) => topic.topicId === current)) return current
              return frame.topics[0]?.topicId
            })
          } else if (frame.type === 'topic') {
            setItems((current) => upsert(current, frame.topic))
            setSelectedId((current) => {
              if (current) return current
              return frame.topic.turns.some((turn) => turn.status === 'running') ? frame.topic.topicId : current
            })
          } else if (frame.type === 'delta') {
            setLive((current) => ({
              ...current,
              [frame.turnId]: `${current[frame.turnId] ?? ''}${frame.text}`,
            }))
          } else if (frame.type === 'settled') {
            setLive((current) => {
              const next = { ...current }
              delete next[frame.turnId]
              return next
            })
          }
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => {
      controller.abort()
      void handle.dispose()
    }
  }, [btw, sessionId])

  const selected = items.find((topic) => topic.topicId === selectedId)
  const running = selected?.turns.find((turn) => turn.status === 'running')
  const anyRunning = items.some((topic) => topic.turns.some((turn) => turn.status === 'running'))

  const submit = useCallback(async () => {
    const text = question.trim()
    if (!text || sending) return
    setSending(true)
    setError(undefined)
    try {
      const result = await btw.ask({
        sessionId,
        ...(selectedId === undefined ? {} : { topicId: selectedId }),
        question: text,
        requestId: crypto.randomUUID(),
      })
      if (!result.ok) throw result.error
      setQuestion('')
      setSelectedId(result.value.topicId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSending(false)
    }
  }, [btw, question, selectedId, sending, sessionId])

  return (
    <div style={panel}>
      <div style={row}>
        <strong>BTW side questions</strong>
        <span style={meta}>does not touch the main conversation</span>
      </div>
      {items.length > 0 && (
        <div style={topics}>
          {items.map((topic) => (
            <button
              key={topic.topicId}
              type="button"
              style={topicButton(topic.topicId === selectedId)}
              onClick={() => setSelectedId(topic.topicId)}
              title={topic.title}
            >
              {topic.title}
            </button>
          ))}
        </div>
      )}
      <div style={detail}>
        {selected ? (
          selected.turns.map((turn) => {
            const text = `${turn.answer}${live[turn.turnId] ?? ''}`
            return (
              <div key={turn.turnId} style={turnBox}>
                <div style={questionStyle}>{turn.question}</div>
                <div style={meta}>
                  {STATUS_LABEL[turn.status]}
                  {turn.contextCut.degraded.length > 0 ? ` · context: ${turn.contextCut.degraded.join(', ')}` : ''}
                </div>
                <pre style={answer}>{text || (turn.status === 'running' ? '…' : '')}</pre>
                {turn.error && <div style={errorStyle}>{turn.error}</div>}
                <div style={row}>
                  {turn.answer && (
                    <button type="button" onClick={() => void navigator.clipboard.writeText(turn.answer)}>
                      Copy
                    </button>
                  )}
                  {turn.status === 'running' && (
                    <button
                      type="button"
                      onClick={() => {
                        void btw.cancel({ sessionId, topicId: selected.topicId, turnId: turn.turnId })
                      }}
                    >
                      Stop
                    </button>
                  )}
                </div>
              </div>
            )
          })
        ) : (
          <div style={meta}>No side conversation yet. Ask below to start one.</div>
        )}
        {error && <div style={errorStyle}>{error}</div>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <textarea
          style={textarea}
          value={question}
          placeholder={selected ? `Follow up in "${selected.title}"…` : 'Ask a side question…'}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void submit()
            }
          }}
        />
        <div style={row}>
          <button type="button" disabled={sending || anyRunning || !question.trim()} onClick={() => void submit()}>
            {sending ? 'Asking…' : selected ? 'Follow up' : 'Ask BTW'}
          </button>
          <button
            type="button"
            disabled={sending || anyRunning}
            onClick={() => {
              setSelectedId(undefined)
              setQuestion('')
              setError(undefined)
            }}
          >
            New topic
          </button>
          {running && <span style={meta}>One BTW turn per Session; stop it to ask again.</span>}
        </div>
      </div>
    </div>
  )
}
