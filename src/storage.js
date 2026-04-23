/**
 * SQLite-backed storage for token-lens session tracking.
 * Tracks which tools are loaded vs actually called per session.
 */

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dataDir = process.env.MCP_DATA_DIR || join(process.cwd(), 'data');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

const dbPath = join(dataDir, 'token-lens.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS loaded_tools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    token_cost INTEGER NOT NULL DEFAULT 0,
    UNIQUE(session_id, tool_name),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
  );
  CREATE TABLE IF NOT EXISTS tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
  );
  CREATE INDEX IF NOT EXISTS idx_loaded_session ON loaded_tools(session_id);
  CREATE INDEX IF NOT EXISTS idx_calls_session ON tool_calls(session_id);
`);

const stmts = {
  ensureSession: db.prepare(`INSERT OR IGNORE INTO sessions (session_id) VALUES (?)`),
  getSession: db.prepare(`SELECT * FROM sessions WHERE session_id = ?`),
  upsertTool: db.prepare(`INSERT OR REPLACE INTO loaded_tools (session_id, tool_name, token_cost) VALUES (?, ?, ?)`),
  getLoadedTools: db.prepare(`SELECT * FROM loaded_tools WHERE session_id = ?`),
  insertCall: db.prepare(`INSERT INTO tool_calls (session_id, tool_name) VALUES (?, ?)`),
  getCalls: db.prepare(`SELECT * FROM tool_calls WHERE session_id = ? ORDER BY id`),
  getCallCount: db.prepare(`SELECT COUNT(*) as cnt FROM tool_calls WHERE session_id = ?`),
  allSessions: db.prepare(`SELECT session_id FROM sessions`),
  dbSize: db.prepare(`SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()`),
  tableCount: db.prepare(`SELECT (SELECT COUNT(*) FROM sessions) as sessions, (SELECT COUNT(*) FROM loaded_tools) as loaded_tools, (SELECT COUNT(*) FROM tool_calls) as tool_calls`),
};

export function registerTool(sessionId, toolName, tokenCost) {
  stmts.ensureSession.run(sessionId);
  stmts.upsertTool.run(sessionId, toolName, tokenCost);
  return { registered: true, tool_name: toolName, token_cost: tokenCost };
}

export function logCall(sessionId, toolName) {
  stmts.ensureSession.run(sessionId);
  stmts.insertCall.run(sessionId, toolName);
  const count = stmts.getCallCount.get(sessionId).cnt;
  return { logged: true, tool_name: toolName, total_calls: count };
}

export function getReport(sessionId) {
  stmts.ensureSession.run(sessionId);
  const session = stmts.getSession.get(sessionId);
  const loadedTools = stmts.getLoadedTools.all(sessionId);
  const calls = stmts.getCalls.all(sessionId);

  const calledToolNames = new Set(calls.map(c => c.tool_name));
  const usedTools = loadedTools.filter(t => calledToolNames.has(t.tool_name));
  const unusedTools = loadedTools.filter(t => !calledToolNames.has(t.tool_name));
  unusedTools.sort((a, b) => b.token_cost - a.token_cost);

  const totalLoadedTokens = loadedTools.reduce((sum, t) => sum + t.token_cost, 0);
  const usedTokens = usedTools.reduce((sum, t) => sum + t.token_cost, 0);
  const wastedTokens = unusedTools.reduce((sum, t) => sum + t.token_cost, 0);

  const callCounts = {};
  for (const call of calls) callCounts[call.tool_name] = (callCounts[call.tool_name] || 0) + 1;

  return {
    session_id: sessionId, created_at: session.created_at,
    tools_loaded: loadedTools.length, tools_used: usedTools.length, tools_unused: unusedTools.length,
    total_loaded_tokens: totalLoadedTokens, used_tokens: usedTokens, wasted_tokens: wastedTokens,
    waste_percentage: totalLoadedTokens > 0 ? parseFloat(((wastedTokens / totalLoadedTokens) * 100).toFixed(1)) : 0,
    total_calls: calls.length, call_frequency: callCounts,
    used_tools: usedTools.map(t => t.tool_name),
    unused_tools_ranked: unusedTools.map(t => ({ name: t.tool_name, tokens: t.token_cost })),
  };
}

export function listSessions() {
  return stmts.allSessions.all().map(r => r.session_id);
}

export function getStorageStats() {
  const counts = stmts.tableCount.get();
  const sizeRow = stmts.dbSize.get();
  return { path: dbPath, size_bytes: sizeRow?.size || 0, ...counts };
}
