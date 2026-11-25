# Antigravity CLI sessions for Mayoi

Lists [Antigravity CLI](https://antigravity.google) (`agy`) sessions in Mayoi's **Sessions** view,
with its own mark, and resumes one in a terminal tab with `agy --conversation <id>`.

## Install

```sh
mayoi plugin install neithern/mayoi-agy
```

For local development:

```sh
mayoi plugin dev /path/to/mayoi-agy
```

## Requirements

- `sqlite3` on `PATH` (included on macOS, or configure `plugins.agy.sqlitePath`).

## Where sessions are read

Sessions are queried with `PRAGMA query_only = ON` from
`~/.gemini/antigravity-cli/conversation_summaries.db` (and `conversations_fts` for the first user
prompt and archived flag). Subagent conversations and blank sessions with no turns are excluded.
Between polls, the plugin checks `stat` on the database and its `-wal` file so no subprocess runs
while idle.

| What        | Where                                                    |
| ----------- | -------------------------------------------------------- |
| database    | `~/.gemini/antigravity-cli/conversation_summaries.db`    |
| id          | `conversation_summaries.conversation_id`                 |
| title       | `conversation_summaries.title`                           |
| first asked | `conversations_fts.user_body` (`chunk_index = 0`)        |
| folder      | first `file://` URI in `workspace_uris`                  |
| last used   | `last_modified_time` (fallback `last_user_input_time`)   |

## Settings

| Key                             | Default     | Description                                                                                     |
| ------------------------------- | ----------- | ----------------------------------------------------------------------------------------------- |
| `plugins.agy.preferFirstPrompt` | `true`      | Show the first user prompt as the session name instead of Antigravity's auto-generated title    |
| `plugins.agy.dataDir`           | `""`        | Custom Antigravity CLI data directory (`~/.gemini/antigravity-cli`)                             |
| `plugins.agy.includeArchived`   | `false`     | Include archived conversations in **Sessions**                                                  |
| `plugins.agy.sqlitePath`        | `"sqlite3"` | Path to the `sqlite3` binary                                                                    |

## What it does not cover

- **Remote folders.** Sessions are read from this machine's `~/.gemini/antigravity-cli` folder.
- **Transcript files.** Mayoi's plugin `agents.register` API does not expose a transcript file
  path, so right-clicking a session does not offer **Open Transcript**.
