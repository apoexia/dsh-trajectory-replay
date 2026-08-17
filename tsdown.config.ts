import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

const PLUGIN_ID = '@dsh-external/dsh-trajectory-replay'

/**
 * Externals resolved from the browser module table (platform seed entries
 * plus the documented runtime store-engine exemption). Everything else is
 * inlined into the bundle.
 */
const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

/**
 * Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline.
 * The suffix matters: tsdown's guard matches ids ending in `.css`, so the
 * virtual id must not. CSS Modules are compiled by lightningcss; the css text
 * auto-injects a `<style data-plugin>` tag at factory execution (the loader
 * removes plugin-owned tags on unload).
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

const cssModulesInline = {
  name: 'dsh-css-modules-inline',
  resolveId(source: string, importer: string | undefined) {
    if (!source.endsWith('.module.css')) return null
    const abs = importer !== undefined
      ? resolvePath(dirname(importer), source)
      : source
    return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
  },
  async load(virtualId: string) {
    if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
    const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
    this.addWatchFile(fileId)
    const source = await readFile(fileId)
    const { code, exports: cssExports } = transform({
      filename: fileId,
      code: source,
      cssModules: { pattern: '[hash]_[local]' },
      minify: true,
    })
    const classMap: Record<string, string> = {}
    for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
    const tagId = `${PLUGIN_ID}/${basename(fileId)}`
    return [
      `const css = ${JSON.stringify(code.toString())};`,
      `const tagId = ${JSON.stringify(tagId)};`,
      'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
      '  const tag = document.createElement(\'style\');',
      `  tag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
      '  tag.dataset.pluginCss = tagId;',
      '  tag.textContent = css;',
      '  document.head.appendChild(tag);',
      '}',
      `export default ${JSON.stringify(classMap)};`,
    ].join('\n')
  },
}

const client: UserConfig = {
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  external: [...CLIENT_EXTERNALS],
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  plugins: [cssModulesInline],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

export default client
