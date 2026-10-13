# Escritoriio Runner

The Escritoriio Runner is a program you install on your own computer. It lets an AI member of an Escritoriio office (a virtual office for remote teams) do work on your machine, **in folders you choose**, by driving a coding agent that you already have installed, such as Claude Code.

This repository holds everything that runs on your computer: the runner itself (`apps/runner`), the desktop app that wraps it (`apps/runner-desktop`) and the messages it exchanges with the office (`packages/runner-protocol`). It is public so that you can read what you are installing. Releases are built here, from this source, by the workflows in `.github/workflows`.

## What it does

1. You pair the app with one AI member of an office. Pairing gives the app a token that works for that one AI member and for you only.
2. The app keeps a connection **to** the office server. The server never connects to your computer, and the app opens no port.
3. When **you** ask that AI member, in the office, to do something in one of your folders, the app starts a coding agent in that folder, shows you what it does, and sends back what happened.

## The six rules

These are the rules the design is built on. They are written in plain words here, and the code and the tests keep them.

1. **Only you can give it work.** The instruction comes from your own message to the AI member, never from what somebody else wrote in chat, a meeting transcript or a note. Somebody else's request is only a suggestion on your screen, and it runs only if you approve it there.
2. **Your machine decides, not the server.** The folders the app may touch, how much it may do in each (read only, or edit) and which coding agents it may start are kept in a file on your computer that only the app's own screens change. They are checked again for every task, whatever the server offers. The office learns only the names you give your folders, never their paths.
3. **Your choice, with a guard.** A folder you allow runs your requests without asking each time, unless you set it to ask first, in which case the task waits until you approve the exact text on screen.
4. **Layers of containment, none trusted alone.** A task runs inside the allowed folder (links that lead out are refused, and so are your home folder and the root of a drive), by default in a separate git worktree on its own branch so your checked-out files are not touched, with the coding agent's own sandbox or permissions set as narrow as the folder's access allows, with a time limit, a limit on the output kept, and an environment built from nothing: none of your secrets reach it. The app never pushes, never opens pull requests and never touches other folders by itself.
5. **You can stop it at once.** Cancel a task from the app or from the office, pause the whole machine from either side, or remove the machine in the office. A paused or removed machine never starts anything.
6. **Counts are logged, contents are not.** The office keeps the instruction, a capped result and the state of a task for a short time, visible to you and to the workspace's admins. It does not keep what the agent read on your disk.

## Install

Download the file for your system from the [latest release](https://github.com/iuriandreazza/escritoriio-runner/releases/latest):

| System | File |
| --- | --- |
| macOS | the `.dmg` (the `.zip` is for the updater) |
| Windows | the `.exe` installer |
| Linux | the `.AppImage`, or the `.deb` |

The coding agent is not part of the app. Install and log in to Claude Code yourself; the app uses the one it finds on your computer, and shows what it found and how that tool is contained on your system.

### Signed or unsigned

The release notes say, for each system, whether that build is signed. Signing needs paid developer accounts that this project may not have yet. An **unsigned** build still works but your system warns you the first time: on macOS, open the app with Control-click, then Open; on Windows, choose More info, then Run anyway. If you would rather not do that, build it yourself (below) or wait for a signed release. Automatic updates on macOS only work on a properly signed app; an unsigned build asks you to download the new version by hand.

## Pair

In the office, open **My machines**, pick the AI member and ask for a pairing code. The office shows a link and an eight-character code, valid for ten minutes.

- Open the link: the app starts and asks you to confirm *which* AI member, of which workspace, on which server. Read it. Confirm only if it is what you expected.
- Or type it in a terminal: `escritoriio-runner pair <server> <code>`.

## Verify a download

Every release carries a file called `SHA256SUMS` and a signed provenance attestation made by GitHub Actions, which says that the file was built from this repository by its release workflow, at a given commit.

Check the checksum (run it in the folder with the files you downloaded):

```sh
sha256sum --check --ignore-missing SHA256SUMS       # Linux
shasum -a 256 --check --ignore-missing SHA256SUMS   # macOS
```

Check the attestation with the [GitHub CLI](https://cli.github.com/):

```sh
gh attestation verify <the file you downloaded> --repo iuriandreazza/escritoriio-runner
```

A checksum alone only proves the download was not damaged: it comes from the same place as the file. The attestation is the one that ties the file to this source.

## Build it yourself

You need Node 24 and pnpm (the version in `package.json`).

```sh
pnpm install --frozen-lockfile
pnpm build       # type-checks and bundles the runner and the app
pnpm test
pnpm package     # makes the installers of the system you are on, unsigned, in apps/runner-desktop/release
```

## About the Claude Agent SDK

This code is MIT licensed, but the Claude Agent SDK that it uses to drive Claude Code is **not**: it is Anthropic's, all rights reserved, used under Anthropic's own terms. It is a separate dependency, installed from its own package, and it is not part of this repository's source. See `apps/runner/NOTICE.md`.

## Security

Please read [SECURITY.md](SECURITY.md) to report a vulnerability. Anyone can write a program that speaks the protocol in `packages/runner-protocol`; the server therefore trusts nothing a runner says beyond what its token entitles it to, and nothing in this repository is secret.

## Licence

[MIT](LICENSE), except for the dependencies, which have their own.
