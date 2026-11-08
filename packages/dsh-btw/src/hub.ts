import type { BtwFrame } from './types.ts'

type FrameBody = BtwFrame extends infer F ? (F extends BtwFrame ? Omit<F, 'revision'> : never) : never
type Subscriber = (frame: BtwFrame) => void

/** In-memory, per-Session revisioned fan-out for streamed BTW updates. */
export class BtwHub {
  private readonly subscribers = new Set<Subscriber>()
  private currentRevision = 0

  get revision(): number {
    return this.currentRevision
  }

  publish(body: FrameBody): void {
    this.currentRevision += 1
    const frame = { ...body, revision: this.currentRevision } as BtwFrame
    for (const subscriber of this.subscribers) {
      try {
        subscriber(frame)
      } catch {
        // A broken reader never breaks the worker or other readers.
      }
    }
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber)
    return () => this.subscribers.delete(subscriber)
  }

  clear(): void {
    this.subscribers.clear()
  }
}
