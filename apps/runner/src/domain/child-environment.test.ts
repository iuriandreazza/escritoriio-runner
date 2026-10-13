import { describe, expect, it } from 'vitest';
import { childEnvironment } from './child-environment.ts';

const shell = {
  PATH: '/usr/bin:/bin',
  HOME: '/Users/ana',
  USER: 'ana',
  LANG: 'en_US.UTF-8',
  TERM: 'xterm-256color',
  TMPDIR: '/var/folders/x',
  ANTHROPIC_API_KEY: 'sk-ant-a-key-in-the-shell',
  ANTHROPIC_AUTH_TOKEN: 'token',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
  OPENAI_API_KEY: 'sk-openai',
  CODEX_API_KEY: 'codex',
  GITHUB_TOKEN: 'ghp_x',
  AWS_SECRET_ACCESS_KEY: 'aws',
  SSH_AUTH_SOCK: '/tmp/agent.sock',
  NODE_OPTIONS: '--require /tmp/evil.js',
  ESCRITORIIO_RUNNER_HOME: '/Users/ana/runner-state',
  HTTPS_PROXY: 'http://user:pass@proxy:3128',
  EMPTY: undefined,
};

describe('the environment a coding agent starts with', () => {
  it('holds what a program needs to find its files, its login and a terminal', () => {
    expect(childEnvironment(shell, false)).toEqual({ PATH: '/usr/bin:/bin', HOME: '/Users/ana', USER: 'ana', LANG: 'en_US.UTF-8', TERM: 'xterm-256color', TMPDIR: '/var/folders/x' });
  });

  it('holds no key, token or secret of the shell it was started from, so that the login of the person is what is used', () => {
    const names = Object.keys(childEnvironment(shell, false)).join(' ');
    for (const forbidden of ['ANTHROPIC', 'CLAUDE_CODE_OAUTH', 'OPENAI', 'CODEX', 'GITHUB', 'AWS', 'SSH_AUTH', 'NODE_OPTIONS', 'ESCRITORIIO', 'PROXY']) expect(names).not.toContain(forbidden);
  });

  it('keeps the place the person put the settings of the coding agent, which is where its login lives', () => {
    expect(childEnvironment({ CLAUDE_CONFIG_DIR: '/Users/ana/.claude-work', HOME: '/Users/ana' }, false)).toEqual({ CLAUDE_CONFIG_DIR: '/Users/ana/.claude-work', HOME: '/Users/ana' });
  });

  it('is built the same way on Windows, whatever the case its variables are written in', () => {
    const env = childEnvironment({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\ana', ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', ComSpec: 'cmd.exe' }, true);
    expect(env).toEqual({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\ana', ComSpec: 'cmd.exe' });
  });

  it('does not take the names of one system for the other', () => {
    expect(childEnvironment({ SHELL: '/bin/zsh', PATH: '/bin' }, true)).toEqual({ PATH: '/bin' });
    expect(childEnvironment({ SYSTEMROOT: 'C:\\Windows', PATH: '/bin' }, false)).toEqual({ PATH: '/bin' });
  });
});
