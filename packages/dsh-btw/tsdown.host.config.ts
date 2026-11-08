import { defineConfig } from 'tsdown'
import { decorators } from './tsdown.decorators.ts'

export default defineConfig({
  entry: { index: 'src/index.ts', types: 'src/types.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: true,
  outDir: 'lib',
  clean: true,
  plugins: [decorators()],
  external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-storage-domain', '@deepseek-ai/dsh-typert-protocol', 'zod'],
})
