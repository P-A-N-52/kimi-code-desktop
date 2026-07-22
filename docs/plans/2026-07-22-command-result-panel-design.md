# Command Result Panel Design

**Goal:** Show `/usage` and `/status` in a temporary panel above the composer instead of appending chat messages.

## Decisions

- Placement: between message list and Composer (footer stack), same `max-w-[44rem]` width — “second dialog layer”
- Chat history: no user message, no assistant reply for these two commands
- Close: Esc, close button, or replace when running the other info command
- `/help` and blocked slash remain message-based for this change
- Reuse `formatUsageReport` / `formatStatusReport` plain text; no rich quota bars in v1

## Architecture

1. `useSessionStream.sendMessage` (and/or a dedicated helper) resolves usage/status content without mutating `messages`
2. `ConversationView` owns panel state `{ command, content, loading } | null`
3. New `CommandResultPanel` renders title, body (`whitespace-pre-wrap`), close control
4. Local intercept in `ConversationView.send` so busy sessions do not queue these commands

## Error handling

- Loading: show panel with “查询中…”
- Failure: keep panel open with error text
- Outside click: optional; Esc + close button are required

## Testing

- Unit: sendMessage/local helper does not append messages for `/usage` and `/status`
- Component: panel renders, dismisses on close/Esc
