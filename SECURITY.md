# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Use the private report of GitHub: on this repository open the **Security** tab and choose **Report a vulnerability**. You will get an answer as soon as possible, normally within a few days. If you can, include the version, your system, and steps to reproduce.

## What matters most here

The runner is a program that can start a coding agent on somebody's computer, so the reports that matter most are the ones that show a way to:

- run something without the owner's own request (a task started by anybody but the owner, or by a pairing link, a message from the server, a file in a folder);
- reach outside an allowed folder, or reach a secret of the machine (the device token, the environment of the app, other folders);
- make the app load or run content that is not its own (a remote page, a script in the window, a call across the preload that it should have refused);
- bypass the pause, the approvals or the folder policy;
- tamper with an update or with the installer.

## Supported versions

Only the latest release is supported. Updates are announced in the app and installed only when the owner accepts them.

## Verifying what you run

Releases carry `SHA256SUMS` and a build provenance attestation; see the README for how to check them with `gh attestation verify`. A file that does not verify must not be installed: report it.
