import { agents, platform, process as proc, settings, workspace, type AgentSession } from "mayoi";

const AGENT_ID = "agy.agent";
const DB_NAME = "conversation_summaries.db";
const DEFAULT_SUBDIR = ".gemini/antigravity-cli";
const QUERY_TIMEOUT_MS = 4000;
const MAX_INLINE_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

interface SummaryRow {
  conversation_id: string;
  title?: string;
  preview?: string;
  step_count?: number;
  last_modified_time?: string;
  last_user_input_time?: string;
  workspace_uris?: string;
  archived?: number;
  first_prompt?: string;
  prompt_offsets?: string;
}

const SQL_FULL = `
SELECT
  s.conversation_id,
  s.title,
  s.preview,
  s.step_count,
  s.last_modified_time,
  s.last_user_input_time,
  s.workspace_uris,
  COALESCE((
    SELECT f.archived
    FROM conversations_fts f
    WHERE f.conversation_id = s.conversation_id AND f.chunk_index = -1
    LIMIT 1
  ), 0) AS archived,
  COALESCE((
    SELECT substr(f.user_body, 1, 1024)
    FROM conversations_fts f
    WHERE f.conversation_id = s.conversation_id AND f.chunk_index = 0
    LIMIT 1
  ), '') AS first_prompt,
  COALESCE((
    SELECT f.user_step_byte_offsets
    FROM conversations_fts f
    WHERE f.conversation_id = s.conversation_id AND f.chunk_index = 0
    LIMIT 1
  ), '') AS prompt_offsets
FROM conversation_summaries s
WHERE s.parent_conversation_id = ''
  AND s.nesting_depth = 0
  AND NOT EXISTS (
    SELECT 1 FROM conversation_parents p
    WHERE p.conversation_id = s.conversation_id
  )
ORDER BY s.last_modified_time DESC;
`.trim();

const SQL_BASIC = `
SELECT
  conversation_id,
  title,
  preview,
  step_count,
  last_modified_time,
  last_user_input_time,
  workspace_uris
FROM conversation_summaries
WHERE parent_conversation_id = ''
  AND nesting_depth = 0
ORDER BY last_modified_time DESC;
`.trim();

let cachedHome: string | null = null;
let lastCacheKey = "";
let lastSessions: AgentSession[] = [];
const transcriptPromptCache = new Map<string, string>();

settings.onChange(() => {
  lastCacheKey = "";
});

async function localCwd(): Promise<string | undefined> {
  if (platform !== "windows") return "/";
  return (await workspace.isRemote()) ? "C:\\" : undefined;
}

async function resolveHome(): Promise<string> {
  if (cachedHome !== null) return cachedHome;
  const cwd = await localCwd();
  const res =
    platform === "windows"
      ? await proc.run("cmd", ["/c", "echo", "%USERPROFILE%"], { cwd, timeout: 2000 })
      : await proc.run("sh", ["-c", 'printf "%s" "$HOME"'], { cwd, timeout: 2000 });
  const home = res.stdout.trim();
  if (res.code !== 0 || !home || home === "%USERPROFILE%") {
    throw new Error(`could not resolve home directory: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
  cachedHome = home;
  return home;
}

function joinPath(a: string, b: string): string {
  const sep = platform === "windows" ? "\\" : "/";
  const left = a.replace(/[\\/]+$/, "");
  const right = b.replace(/^[\\/]+/, "").replace(/\//g, sep);
  return `${left}${sep}${right}`;
}

async function resolvePaths(): Promise<{ dataDir: string; dbPath: string }> {
  const rawDir = (settings.get<string>("dataDir") ?? "").trim();
  if (!rawDir) {
    const dataDir = joinPath(await resolveHome(), DEFAULT_SUBDIR);
    return { dataDir, dbPath: joinPath(dataDir, DB_NAME) };
  }
  let dir = rawDir;
  if (dir === "~" || dir.startsWith("~/") || dir.startsWith("~\\")) {
    dir = joinPath(await resolveHome(), dir.slice(2));
  }
  if (dir.endsWith(".db")) {
    const idx = Math.max(dir.lastIndexOf("/"), dir.lastIndexOf("\\"));
    return { dataDir: idx > 0 ? dir.slice(0, idx) : dir, dbPath: dir };
  }
  return { dataDir: dir, dbPath: joinPath(dir, DB_NAME) };
}

function toSqliteImmutableUri(path: string): string {
  let p = path.replace(/\\/g, "/");
  if (/^[a-zA-Z]:\//.test(p)) {
    p = "/" + p;
  }
  const encoded = p.replace(/%/g, "%25").replace(/\?/g, "%3f").replace(/#/g, "%23");
  return `file:${encoded}?immutable=1`;
}

function fileUriToPath(uri: string): string {
  const trimmed = uri.trim();
  if (!trimmed) return "";
  if (!trimmed.startsWith("file://")) {
    return trimmed;
  }
  let rest = trimmed.slice("file://".length);
  if (rest.startsWith("localhost/")) {
    rest = rest.slice("localhost".length);
  }
  let decoded = rest;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    // Keep raw path if percent-encoding is malformed.
  }
  // Windows file:///C:/foo -> C:/foo
  if (/^\/[a-zA-Z]:\//.test(decoded)) {
    decoded = decoded.slice(1);
    if (platform === "windows") {
      decoded = decoded.replace(/\//g, "\\");
    }
  }
  if (decoded.length > 1) {
    decoded = decoded.replace(/[\\/]+$/, "");
  }
  return decoded;
}

function parseFolder(workspaceUris?: string): string | undefined {
  if (!workspaceUris) return undefined;
  let list: unknown;
  try {
    list = JSON.parse(workspaceUris);
  } catch {
    return undefined;
  }
  if (!Array.isArray(list)) return undefined;
  for (const item of list) {
    if (typeof item === "string") {
      const p = fileUriToPath(item);
      if (p) return p;
    }
  }
  return undefined;
}

function parseTimestamp(raw?: string): number | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (!s || s.startsWith("0001-01-01")) return undefined;
  // Normalize SQLite datetime like "2026-11-24 02:52:06.795103+00:00" to RFC3339 ms.
  const iso = s
    .replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T")
    .replace(/(\.\d{3})\d+/, "$1")
    .replace(/\+00:00$/, "Z");
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return ms;
}

function sliceUtf8Bytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    const code = text.codePointAt(i)!;
    const step = code > 0xffff ? 2 : 1;
    const width = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes + width > maxBytes) break;
    bytes += width;
    i += step;
  }
  return text.slice(0, i);
}

function firstTurnFromFts(userBody?: string, offsetsRaw?: string): string {
  if (!userBody) return "";
  let slice = userBody;
  if (offsetsRaw) {
    try {
      const offsets = JSON.parse(offsetsRaw);
      if (Array.isArray(offsets) && offsets.length >= 2 && Array.isArray(offsets[1])) {
        const secondByteOffset = Number(offsets[1][1]);
        if (Number.isFinite(secondByteOffset) && secondByteOffset > 0) {
          slice = sliceUtf8Bytes(userBody, secondByteOffset);
        }
      }
    } catch {
      // Fall back to full snippet if offsets JSON is unexpected.
    }
  }
  return cleanPrompt(slice);
}

function parseFirstUserPromptFromJsonl(text: string): string {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && i < 20; i++) {
    const line = lines[i].trim();
    if (!line || line[0] !== "{") continue;
    try {
      const entry = JSON.parse(line) as { type?: string; content?: string };
      if (entry.type === "USER_INPUT" && typeof entry.content === "string") {
        const cleaned = cleanPrompt(entry.content);
        if (cleaned) return cleaned;
      }
    } catch {
      // Skip malformed line.
    }
  }
  return "";
}

async function readTranscriptFirstPrompt(dataDir: string, id: string): Promise<string> {
  const key = `${dataDir}|${id}`;
  const cached = transcriptPromptCache.get(key);
  if (cached !== undefined) return cached;

  const transcriptPath = joinPath(dataDir, `brain/${id}/.system_generated/logs/transcript.jsonl`);
  const st = await workspace.stat(transcriptPath);
  if (!st || st.isDir || st.size <= 0) return "";

  let raw = "";
  try {
    if (st.size <= MAX_INLINE_TRANSCRIPT_BYTES) {
      raw = await workspace.readFile(transcriptPath);
    } else if (platform !== "windows") {
      const res = await proc.run("head", ["-n", "20", transcriptPath], {
        cwd: await localCwd(),
        timeout: 2000,
      });
      if (res.code === 0) raw = res.stdout;
    }
  } catch {
    return "";
  }

  const prompt = parseFirstUserPromptFromJsonl(raw);
  if (prompt) {
    transcriptPromptCache.set(key, prompt);
  }
  return prompt;
}

function cleanPrompt(raw?: string): string {
  if (!raw) return "";
  let text = raw.trim();
  // Unwrap context-transfer "[CURRENT REQUEST ...]\n...\n[/CURRENT REQUEST]" blocks.
  const currentReq = text.match(/\[CURRENT REQUEST[^\]]*\]\s*([\s\S]*?)\s*\[\/CURRENT REQUEST\]/);
  if (currentReq && currentReq[1].trim()) {
    text = currentReq[1].trim();
  }
  // Unwrap "<USER_REQUEST>...</USER_REQUEST>" if present.
  const userReq = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  if (userReq && userReq[1].trim()) {
    text = userReq[1].trim();
  }
  return text.replace(/\s+/g, " ").trim();
}

async function execSqlite(sqliteBin: string, target: string, sql: string): Promise<SummaryRow[]> {
  const cwd = await localCwd();
  const res = await proc.run(
    sqliteBin,
    ["-json", "-cmd", ".timeout 1000", "-cmd", "PRAGMA query_only = ON;", target, sql],
    { cwd, timeout: QUERY_TIMEOUT_MS }
  );
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || `sqlite3 exited with code ${res.code}`);
  }
  const out = res.stdout.trim();
  if (!out) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? (parsed as SummaryRow[]) : [];
}

async function querySqlite(sqliteBin: string, dbPath: string, sql: string): Promise<SummaryRow[]> {
  // Open WAL databases without ?mode=ro (SQLite returns SQLITE_CANTOPEN (14) on
  // read-only connections when -shm is absent) and enforce read-only via query_only.
  try {
    return await execSqlite(sqliteBin, dbPath, sql);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("unable to open database file") || msg.includes("readonly")) {
      return await execSqlite(sqliteBin, toSqliteImmutableUri(dbPath), sql);
    }
    throw err;
  }
}

async function readRows(sqliteBin: string, dbPath: string): Promise<SummaryRow[]> {
  try {
    return await querySqlite(sqliteBin, dbPath, SQL_FULL);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("no such table")) {
      return await querySqlite(sqliteBin, dbPath, SQL_BASIC);
    }
    throw err;
  }
}

function buildCacheKey(
  dbPath: string,
  sqliteBin: string,
  includeArchived: boolean,
  preferFirstPrompt: boolean,
  dbStat: { mtime: number; size: number },
  walStat: { isDir: boolean; mtime: number; size: number } | null
): string {
  return [
    dbPath,
    sqliteBin,
    includeArchived ? "1" : "0",
    preferFirstPrompt ? "1" : "0",
    `${dbStat.mtime}:${dbStat.size}`,
    walStat && !walStat.isDir ? `${walStat.mtime}:${walStat.size}` : "none",
  ].join("|");
}

async function listSessions(): Promise<AgentSession[]> {
  const { dataDir, dbPath } = await resolvePaths();
  const [dbStat, walStat] = await Promise.all([
    workspace.stat(dbPath),
    workspace.stat(`${dbPath}-wal`),
  ]);
  if (!dbStat || dbStat.isDir) {
    lastCacheKey = "";
    lastSessions = [];
    return [];
  }

  const includeArchived = Boolean(settings.get<boolean>("includeArchived"));
  const preferFirstPrompt = settings.get<boolean>("preferFirstPrompt") ?? true;
  const sqliteBin = (settings.get<string>("sqlitePath") ?? "").trim() || "sqlite3";
  const cacheKey = buildCacheKey(
    dbPath,
    sqliteBin,
    includeArchived,
    preferFirstPrompt,
    dbStat,
    walStat
  );

  if (cacheKey === lastCacheKey) {
    return lastSessions;
  }

  const rows = await readRows(sqliteBin, dbPath);
  const sessions: AgentSession[] = [];

  for (const row of rows) {
    const id = (row.conversation_id ?? "").trim();
    if (!id) continue;
    if (!includeArchived && Number(row.archived ?? 0) !== 0) continue;

    const autoTitle = (row.title ?? "").replace(/\s+/g, " ").trim();
    const stepCount = Number(row.step_count ?? 0);
    let firstPrompt = firstTurnFromFts(row.first_prompt, row.prompt_offsets);
    if (!firstPrompt && (stepCount > 0 || autoTitle)) {
      firstPrompt = await readTranscriptFirstPrompt(dataDir, id);
    }
    const fallbackPrompt = firstPrompt || cleanPrompt(row.preview);

    // Skip blank sessions where nothing has been asked yet.
    if (stepCount <= 0 && !autoTitle && !fallbackPrompt) continue;

    const session: AgentSession = { id };
    if (preferFirstPrompt && firstPrompt) {
      session.title = firstPrompt;
      if (autoTitle && autoTitle !== firstPrompt) {
        session.prompt = autoTitle;
      }
    } else {
      if (autoTitle) session.title = autoTitle;
      if (fallbackPrompt) session.prompt = fallbackPrompt;
    }

    const folder = parseFolder(row.workspace_uris);
    if (folder) session.folder = folder;

    const updated =
      parseTimestamp(row.last_modified_time) ?? parseTimestamp(row.last_user_input_time);
    if (updated !== undefined) session.updated = updated;

    sessions.push(session);
  }

  const postWalStat = walStat ? walStat : await workspace.stat(`${dbPath}-wal`);
  lastCacheKey = buildCacheKey(
    dbPath,
    sqliteBin,
    includeArchived,
    preferFirstPrompt,
    dbStat,
    postWalStat
  );
  lastSessions = sessions;
  return sessions;
}

agents.register(AGENT_ID, listSessions);
