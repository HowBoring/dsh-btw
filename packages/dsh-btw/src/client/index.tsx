import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import remote from './remote.ts'
import { BtwPanel } from './BtwPanel.tsx'

export const name = '@deepseek-ai/dsh-btw'
export const inject = ['remote', 'slots', 'sidebarRight', 'sidebarRightTabs', 'commandUi', 'inputTriggers']

const TAB_ID = 'dsh-btw'
const TAB_KIND = 'btw'

/** Mount the feature Remote, the Session-scoped panel, and `/btw` Client routing. */
export async function apply(ctx: Context): Promise<void> {
  const unmount = await ctx.remote.$mount(remote)
  ctx.effect(() => () => void unmount())

  ctx.inject(['remote.btw'], (scope) => {
    const btw = scope.remote.btw

    ctx.effect(
      () =>
        ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          priority: 'extension',
          title: () => 'BTW',
        }),
      'dsh-btw: sidebar tab type',
    )

    ctx.effect(
      () =>
        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register(
            {
              name: 'sidebar.right.pane.tab',
              key: TAB_ID,
              inject: () => ({ btw }),
            },
            BtwPanel,
          ),
        ),
      'dsh-btw: sidebar panel',
    )

    ctx.effect(
      () =>
        ctx.commandUi.register({
          name: 'btw',
          label: () => 'BTW side question',
          description: () => 'Open side conversations that never touch the main conversation',
          available: () => true,
          ui: {
            kind: 'action',
            run: (session) => {
              ctx.sidebarRight.openTabIn(session.sessionId, TAB_KIND)
            },
          },
        }),
      'dsh-btw: bare /btw command',
    )

    ctx.effect(
      () =>
        ctx.inputTriggers.registerSource({
          trigger: '/',
          name: 'btw',
          showGroupTitle: false,
          candidates: async () => [],
          onPick: () => undefined,
          matchEnter: async (session, line, _signal, envelope) => {
            if (!line.startsWith('/btw ')) return undefined
            if (envelope.attachments > 0) {
              throw new Error('BTW side questions do not accept attachments')
            }
            const parsed = line.slice('/btw '.length).trim()
            if (!parsed) return undefined
            const sessionId = session.sessionId
            return {
              claim: {
                name: 'btw',
                token: '/btw ',
                submit: async (args: string) => {
                  const question = (args || parsed).trim()
                  if (!question) return { kind: 'error', text: 'BTW needs a question' }
                  ctx.sidebarRight.openTabIn(sessionId, TAB_KIND)
                  const result = await btw.ask({
                    sessionId,
                    question,
                    requestId: crypto.randomUUID(),
                  })
                  return result.ok
                    ? { kind: 'success' }
                    : { kind: 'error', text: result.error.message }
                },
              },
            }
          },
        }),
      'dsh-btw: argued /btw input source',
    )
  })
}
