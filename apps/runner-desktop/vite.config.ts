import react from '@vitejs/plugin-react';
import type { UserConfig } from 'vite';
import { defineConfig } from 'vite';

// Three builds, each to a folder of its own under `dist`, which the main process finds beside itself:
//  - the renderer is a page, built as the other apps are, with relative addresses since it is served from the app's own scheme;
//  - the main process is an ES module that runs in Electron's Node, with the runner and the libraries inside it. It leaves out what must stay where it
//    is installed: Electron itself, the updater (which reads the feed the packaging wrote beside it), and the Agent SDK that drives Claude Code
//    (Anthropic's, under its own terms, so it is not copied into a bundle; it is read from where it is installed, as the runner's own build does);
//  - the preload is a script of the page's own sandbox, which can load nothing but Electron's own modules: so it is one CommonJS file with everything it uses inside.
export default defineConfig(({ mode }): UserConfig => {
  if (mode === 'main') {
    return {
      ssr: { noExternal: true },
      build: {
        ssr: 'src/main/index.ts',
        target: 'node24',
        outDir: 'dist/main',
        emptyOutDir: true,
        rollupOptions: {
          external: ['electron', 'electron-updater', 'bufferutil', 'utf-8-validate', /^@anthropic-ai\/claude-agent-sdk(\/|$)/],
          output: { entryFileNames: 'index.js' },
        },
      },
    };
  }
  if (mode === 'preload') {
    return {
      ssr: { noExternal: true },
      build: {
        ssr: 'src/preload/index.ts',
        target: 'node24',
        outDir: 'dist/preload',
        emptyOutDir: true,
        rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'index.cjs' } },
      },
    };
  }
  return {
    root: 'src/renderer',
    base: './',
    plugins: [react()],
    build: { outDir: '../../dist/renderer', emptyOutDir: true, target: 'chrome140' },
  };
});
