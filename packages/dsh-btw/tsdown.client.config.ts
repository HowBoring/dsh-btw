import { defineConfig } from 'tsdown'
import { decorators } from './tsdown.decorators.ts'

export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  dts: false,
  outDir: 'lib',
  outExtensions: () => ({ js: '.js' }),
  clean: false,
  plugins: [decorators()],
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'zod'],
  noExternal: ['@deepseek-ai/dsh-typert-protocol/remote-info'],
})
