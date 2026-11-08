import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkspaceTypertGenerator, findWorkspaceRoot, writePackageArtifacts } from '@deepseek-ai/dsh-typert-generator'

const packageDir = dirname(fileURLToPath(new URL('../packages/dsh-btw/package.json', import.meta.url)))
const root = findWorkspaceRoot(join(packageDir, 'lib'))
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const artifacts = new WorkspaceTypertGenerator(root).generate(undefined, ['host'])
writePackageArtifacts(packageDir, artifacts.filter((artifact) => artifact.package === manifest.name))
console.log(`generated ${artifacts.length} Typert artifact(s) for ${manifest.name}`)
