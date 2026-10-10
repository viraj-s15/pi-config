# `/btw` side questions

Approved by the user: reproduce Claude Code's core `/btw` behavior, explicitly without any fork action.

## Behavior

- `/btw <question>` makes one independent model request using the currently selected model, thinking level, effective system prompt, and a snapshot of the active conversation context.
- Completed user messages, assistant messages, tool results, branch summaries and compaction summaries are available. In-progress assistant output is not included. Incomplete tool-call batches must not create invalid provider requests.
- Side questions have no tools and cannot perform actions. A final request-local instruction explains that they answer from existing context only.
- Neither questions nor answers are appended to the main session, model context, session JSONL or transcript. Do not use `sendMessage`, `sendUserMessage`, `appendEntry`, or session branching.
- The request runs independently while the main agent is busy. Cancelling it must not abort the main turn.
- Answers stream as Markdown in a dismissible overlay, with scrolling, clipboard copying and navigation through earlier side answers. Escape, Enter and Space dismiss; Escape during generation cancels only the side request.
- The last 20 completed side exchanges are held only in memory, per active session. They are replayed with subsequent side questions. Bare `/btw` reopens the latest exchange or shows usage if none exists. `x` clears the side thread.
- Session replacement, branch navigation, reload and shutdown clear ephemeral state and cancel active side work. Only one side request may run at a time.
- Non-TUI invocations report that the command requires interactive mode rather than accidentally writing a main-chat message.
- Provider errors and empty answers are displayed in the overlay and are not retained as successful exchanges.

## Architecture

`extensions/btw/context.ts` prepares immutable provider context using Pi's context projection and message conversion, stripping executable tool declarations and repairing unfinished tool-call pairs. Completed historical tool calls/results are replayed as labelled text, preserving result images, because some providers require declared tools when receiving native tool-use blocks. Earlier side answers are replayed as explicitly labelled context rather than fabricated provider responses.

`extensions/btw/thread.ts` owns the memory-only side thread, independent AbortController, bounded history and streaming request lifecycle.

`extensions/btw/overlay.ts` implements a themed, bounded Markdown overlay with keyboard navigation and clipboard support.

`extensions/btw/index.ts` registers the command and lifecycle cleanup, taking the current session snapshot and connecting the thread and UI.

## Verification

Use Node's test runner and Pi's installed TypeScript loader, without adding production dependencies. Exercise context isolation, tool-result preservation, compaction, pending calls, history limits, cancellation, errors, UI sizing/input and command registration. Load the extension through the installed Pi runtime for a smoke test. A paid live-provider request is not required for automated tests.

Reference: https://code.claude.com/docs/en/interactive-mode#side-questions-with-/btw
