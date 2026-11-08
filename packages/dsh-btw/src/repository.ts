import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { btwTopicSchema } from './types.ts'
import type { BtwTopic } from './types.ts'

type TopicKey = string & { readonly __btwTopicKey: unique symbol }

/** One record per topic, keyed by a filesystem-safe encoding of Session + Topic. */
export const btwDomainSpec = defineDomain({
  name: 'btw_topics',
  version: 1,
  layout: 'per-record',
  tables: {
    topics: domainTable<TopicKey, BtwTopic>(btwTopicSchema),
  },
})

export type BtwDomain = Domain<typeof btwDomainSpec>

/** Encode a Session/Topic pair into the per-record key grammar. */
export function topicKey(sessionId: string, topicId: string): TopicKey {
  return Buffer.from(`${sessionId}\u0000${topicId}`, 'utf8').toString('base64url') as TopicKey
}

/** Storage-backed Topic repository. Reads are synchronous snapshots of the open Domain. */
export class BtwTopicRepository {
  private readonly domain: BtwDomain
  private readonly table

  constructor(domain: BtwDomain) {
    this.domain = domain
    this.table = domain.table('topics')
  }

  all(): BtwTopic[] {
    return [...this.table.entries()].map(([, topic]) => topic)
  }

  topics(sessionId: string): BtwTopic[] {
    const topics: BtwTopic[] = []
    for (const [, topic] of this.table.entries()) {
      if (topic.sessionId === sessionId) topics.push(topic)
    }
    return topics.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  get(sessionId: string, topicId: string): BtwTopic | undefined {
    const topic = this.table.get(topicKey(sessionId, topicId))
    return topic?.sessionId === sessionId ? topic : undefined
  }

  async put(topic: BtwTopic): Promise<void> {
    await this.table.put(topicKey(topic.sessionId, topic.topicId), topic)
  }

  async update(sessionId: string, topicId: string, transform: (current: BtwTopic) => BtwTopic): Promise<BtwTopic> {
    return this.table.update(topicKey(sessionId, topicId), (current) => {
      if (current.sessionId !== sessionId || current.topicId !== topicId) {
        throw new Error('btw topic identity changed')
      }
      return transform(current)
    })
  }

  close(): Promise<void> {
    return this.domain.close()
  }
}
