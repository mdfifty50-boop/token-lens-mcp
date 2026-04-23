/**
 * In-memory storage for token-lens session tracking.
 * Tracks which tools are loaded vs actually called per session.
 */

// session_id -> { loaded_tools: Map<name, {name, tokens}>, calls: [{tool_name, timestamp}] }
const sessions = new Map();

/**
 * Ensure a session exists, return its data.
 */
function ensureSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      loaded_tools: new Map(),
      calls: [],
      created_at: new Date().toISOString(),
    });
  }
  return sessions.get(sessionId);
}

/**
 * Register a tool as loaded in a session.
 */
export function registerTool(sessionId, toolName, tokenCost) {
  const session = ensureSession(sessionId);
  session.loaded_tools.set(toolName, { name: toolName, tokens: tokenCost });
  return { registered: true, tool_name: toolName, token_cost: tokenCost };
}

/**
 * Log a tool call in a session.
 */
export function logCall(sessionId, toolName) {
  const session = ensureSession(sessionId);
  session.calls.push({ tool_name: toolName, timestamp: new Date().toISOString() });
  return { logged: true, tool_name: toolName, total_calls: session.calls.length };
}

/**
 * Generate a usage report for a session.
 */
export function getReport(sessionId) {
  const session = ensureSession(sessionId);

  const loadedTools = [...session.loaded_tools.values()];
  const calledToolNames = new Set(session.calls.map(c => c.tool_name));

  const usedTools = loadedTools.filter(t => calledToolNames.has(t.name));
  const unusedTools = loadedTools.filter(t => !calledToolNames.has(t.name));

  // Sort unused by token cost descending (most wasteful first)
  unusedTools.sort((a, b) => b.tokens - a.tokens);

  const totalLoadedTokens = loadedTools.reduce((sum, t) => sum + t.tokens, 0);
  const usedTokens = usedTools.reduce((sum, t) => sum + t.tokens, 0);
  const wastedTokens = unusedTools.reduce((sum, t) => sum + t.tokens, 0);

  // Call frequency per tool
  const callCounts = {};
  for (const call of session.calls) {
    callCounts[call.tool_name] = (callCounts[call.tool_name] || 0) + 1;
  }

  return {
    session_id: sessionId,
    created_at: session.created_at,
    tools_loaded: loadedTools.length,
    tools_used: usedTools.length,
    tools_unused: unusedTools.length,
    total_loaded_tokens: totalLoadedTokens,
    used_tokens: usedTokens,
    wasted_tokens: wastedTokens,
    waste_percentage: totalLoadedTokens > 0
      ? parseFloat(((wastedTokens / totalLoadedTokens) * 100).toFixed(1))
      : 0,
    total_calls: session.calls.length,
    call_frequency: callCounts,
    used_tools: usedTools.map(t => t.name),
    unused_tools_ranked: unusedTools.map(t => ({ name: t.name, tokens: t.tokens })),
  };
}

/**
 * List all tracked sessions.
 */
export function listSessions() {
  return [...sessions.keys()];
}
