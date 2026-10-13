// The entry of the runner as a library, for a program that embeds it (the desktop app). It does nothing when it is loaded: the command
// line has an entry of its own (`cli.ts`), which runs.
export { createRunner, resolveStateDirectory, RUNNER_VERSION } from './runner.ts';
export type {
  AgentsControl,
  Confirmations,
  ConnectionControl,
  FoldersControl,
  McpControl,
  PairingControl,
  PauseControl,
  Runner,
  RunnerEvent,
  RunnerOptions,
  TasksControl,
} from './runner.ts';

export { OwnerError } from './application/owner-error.ts';
export type { AgentView } from './application/agents.ts';
export type { ApprovalAnswer, ApprovalPort, ApprovalRequest, CloneApprovalRequest } from './application/approvals.ts';
export { APPROVAL_WAIT_MS } from './application/approvals.ts';
export type { ConnectionEvent, ConnectionState, ConnectionView, DeviceView, RunEnd } from './application/connection-view.ts';
export type { CheckStatus, DoctorCheck, DoctorReport } from './application/doctor.ts';
export { describeDoctor } from './application/doctor.ts';
export type { Followable, Subscribable, Unsubscribe } from './application/feed.ts';
export type { AddFolderOutcome, FolderChanges, FolderQuestion, FolderView, NewFolder, NewWorkspace, UpdateFolderOutcome } from './application/folders.ts';
export { describeFolderChoice } from './application/folders.ts';
export type { ApproveOutcome, McpServerView, McpToolView, NewMcpServer, Question } from './application/mcp-servers.ts';
export type { PairOutcome, PairQuestion } from './application/pair-machine.ts';
export { describePairQuestion } from './application/pair-machine.ts';
export type { DeviceStore } from './application/ports.ts';
export type { RunnerEnd } from './application/runner-connection.ts';
export type { RunnerStatus } from './application/status.ts';
export { describeStatus, describeTaskNote } from './application/status.ts';
export type { EndedTaskView, RunningTaskView, TasksView } from './application/task-board.ts';
export type { AgentDetection, RunnerPolicy } from './application/task-ports.ts';
export type { TaskNote } from './application/task-service.ts';
export { hasHiddenCharacters } from './domain/clean-text.ts';
export type { AllowedFolder, FolderAccess, FolderApproval, FolderIsolation, FolderKind } from './domain/folder-policy.ts';
export type { PairedDevice } from './domain/paired-device.ts';
export { createFileDeviceStore, DEVICE_FILE_NAME, parseStoredDevice, STATE_DIRECTORY_VARIABLE } from './infrastructure/file-device-store.ts';
export type { PrivateFile } from './infrastructure/private-file.ts';
export { privateFile } from './infrastructure/private-file.ts';
