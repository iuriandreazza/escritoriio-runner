import { defineConfig } from 'vite';

// Two plain JavaScript files, each of which needs nothing installed beside it: they run on any Node from 22.18, and on the one inside an app
// that brings its own, and none of them is asked to read TypeScript or to find a package.
//  - `cli.js` is the command line, with its shebang.
//  - `index.js` is the library that an app embeds, which does nothing when it is loaded.
// They are two builds and not two entries of one, since two entries would share a chunk and neither would be one file.
// The one exception is the Agent SDK that drives Claude Code. It is Anthropic's, under its own terms and not under the runner's licence, so
// it is not copied into the bundle: it is read from where it is installed, when a task needs it, and it brings its own peers.
export default defineConfig(({ mode }) => {
  const library = mode === 'library';
  return {
    ssr: { noExternal: true },
    build: {
      ssr: library ? 'src/index.ts' : 'src/cli.ts',
      target: 'node22',
      outDir: 'dist',
      // The second build adds to what the first made.
      emptyOutDir: !library,
      rollupOptions: {
        external: [
          // ws tries these two native speed-ups and does without them when they are not there.
          'bufferutil',
          'utf-8-validate',
          /^@anthropic-ai\/claude-agent-sdk(\/|$)/,
        ],
        output: library ? { entryFileNames: 'index.js' } : { entryFileNames: 'cli.js', banner: '#!/usr/bin/env node' },
      },
    },
  };
});
