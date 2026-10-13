# Notice: the Claude Agent SDK is not MIT

This runner is MIT licensed. It drives Claude Code through the Claude Agent SDK for TypeScript (`@anthropic-ai/claude-agent-sdk`), and that package is **not** MIT: its licence file says "All rights reserved", with use subject to the legal agreements at https://code.claude.com/docs/en/legal-and-compliance.

- The SDK is a separate dependency. Its code is not part of this package's source and is not copied into the runner's bundle; the runner loads it only when a task runs.
- Whoever installs the SDK, or ships it in an application that packs `node_modules`, does so under Anthropic's terms and not under this package's licence.
- The runner uses the `claude` that its owner has installed and logged in to. It does not provide that program or that login.
