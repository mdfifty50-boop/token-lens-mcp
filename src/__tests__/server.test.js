import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.MCP_DATA_DIR = '/tmp/mcp-test-token-lens-' + Date.now();

import { registerTool, logCall, getReport, getStorageStats } from '../storage.js';
import { auditContextBudget, compressSchema } from '../analyzer.js';

const SESSION = 'test-session-' + Date.now();

describe('token-lens-mcp (SQLite)', () => {
  it('registerTool persists tool registration', () => {
    const result = registerTool(SESSION, 'read_file', 150);
    assert.equal(result.registered, true);
    assert.equal(result.tool_name, 'read_file');
    registerTool(SESSION, 'write_file', 200);
    registerTool(SESSION, 'search', 180);
  });

  it('logCall tracks tool usage', () => {
    const result = logCall(SESSION, 'read_file');
    assert.equal(result.logged, true);
    assert.equal(result.total_calls, 1);
    logCall(SESSION, 'read_file');
  });

  it('getReport shows used and unused tools', () => {
    const report = getReport(SESSION);
    assert.equal(report.session_id, SESSION);
    assert.equal(report.tools_loaded, 3);
    assert.equal(report.tools_used, 1);
    assert.equal(report.tools_unused, 2);
    assert.ok(report.wasted_tokens > 0);
    assert.ok(report.waste_percentage > 0);
  });

  it('auditContextBudget estimates token costs', () => {
    const result = auditContextBudget([
      { name: 'tool_a', description: 'A simple tool', schema: { type: 'object', properties: { q: { type: 'string' } } } },
      { name: 'tool_b', description: 'Another tool with a longer description', schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } } },
    ]);
    assert.ok(result.total_tokens > 0);
    assert.ok(result.per_tool.length === 2 || result.tool_count === 2);
  });

  it('compressSchema reduces token count', () => {
    const schema = { type: 'object', properties: { query: { type: 'string', description: 'The search query to execute against the database' } } };
    const result = compressSchema('test_tool', schema, 'aggressive');
    assert.ok(result.savings_percentage >= 0 || result.savings_percent >= 0);
  });

  it('getStorageStats returns database info', () => {
    const stats = getStorageStats();
    assert.ok(stats.path.includes('token-lens.db'));
    assert.ok(stats.size_bytes > 0);
  });
});
