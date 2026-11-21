# Changelog

## [0.0.1] - 2026-11-21

### Added

- Foreground priority: model-issued `bash` commands are rewritten through a `tool_call` hook to run under `nice`, with a one-time probe and a fail-open fallback.
- Background task tools: `background_task`/`backgroundTask` and `manage_background_task`/`manageBackgroundTask`, with tail-capped logs, `nice`/`ionice` priorities, kill and stdin control, and follow-up notifications.
- Background task UI: the below-editor dock, the expanded single-scroll task page with mouse/keyboard navigation and drag resize, the `/tasks` command, and a custom notification renderer.
- Session replay: `bg-task-state` entries rebuild the task list after resume, fork, or `/tree` navigation.

### Changed

- Support Pi 1.6.0: extension components follow the `render(): readonly string[]` contract, and the development dependency on `@earendil-works/pi-coding-agent` is now `^1.6.0`.
- Tool parameter schemas remain compatible with Pi 1.5+ validation on `@earendil-works/pi-schema`.
- Keep the `pi-tui` coalesced-mouse-input workaround, which is still required in 1.6.0.

### Fixed

- Each task transition appends exactly one `bg-task-state` entry; the terminal notification no longer duplicates the terminal entry.
