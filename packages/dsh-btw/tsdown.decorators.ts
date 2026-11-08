import ts from 'typescript'
import type { Plugin } from 'tsdown'

const TS = /^[^?]*\.[cm]?tsx?(?:\?|$)/
const DECORATOR = /^\s*@[A-Za-z_$][\w$]*/m

/** Lower standard decorators before bundling, as the shipped DSH build does. */
export function decorators(): Plugin {
  return {
    name: 'dsh-btw-decorators',
    transform: {
      filter: { id: TS },
      handler(code: string, id: string) {
        if (!DECORATOR.test(code)) return
        const result = ts.transpileModule(code, {
          fileName: id.replace(/\?.*$/su, ''),
          compilerOptions: {
            target: ts.ScriptTarget.ES2024,
            module: ts.ModuleKind.ESNext,
            ...(id.endsWith('x') ? { jsx: ts.JsxEmit.ReactJSX } : {}),
            sourceMap: true,
          },
        })
        return { code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'), map: result.sourceMapText }
      },
    },
  }
}
