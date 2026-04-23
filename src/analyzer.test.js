/**
 * Tests for analyzer.js — core analysis and compression functions.
 * Uses node:test and node:assert/strict (no npm deps).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens,
  auditContextBudget,
  optimizeToolLoading,
  compressSchema,
  suggestRemovals,
  getOptimizationReport,
} from './analyzer.js';

// ─────────────────────────────────────────────
// estimateTokens
// ─────────────────────────────────────────────

describe('estimateTokens', () => {
  test('estimates tokens as ceil(chars / 4) for strings', () => {
    // "hello world" = 11 chars -> ceil(11/4) = 3
    assert.equal(estimateTokens('hello world'), 3);
  });

  test('estimates tokens for objects via JSON serialization', () => {
    const obj = { name: 'test', value: 123 };
    const json = JSON.stringify(obj);
    assert.equal(estimateTokens(obj), Math.ceil(json.length / 4));
  });

  test('empty object returns 1 token', () => {
    // "{}" = 2 chars -> ceil(2/4) = 1
    assert.equal(estimateTokens({}), 1);
  });
});

// ─────────────────────────────────────────────
// auditContextBudget
// ─────────────────────────────────────────────

describe('auditContextBudget', () => {
  const sampleTools = [
    {
      name: 'read_file',
      description: 'Read a file from disk',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to read' },
        },
        required: ['path'],
      },
    },
    {
      name: 'web_search',
      description: 'Search the web for information using a query string and optional filters',
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          max_results: { type: 'number', description: 'Maximum number of results to return' },
          language: { type: 'string', description: 'Language filter (ISO 639-1 code)' },
        },
        required: ['query'],
      },
    },
  ];

  test('returns correct tool count and per-tool tokens', () => {
    const result = auditContextBudget(sampleTools);
    assert.equal(result.tool_count, 2);
    assert.equal(result.per_tool.length, 2);
    assert.ok(result.total_tokens > 0);
  });

  test('per_tool entries are sorted by tokens descending', () => {
    const result = auditContextBudget(sampleTools);
    for (let i = 1; i < result.per_tool.length; i++) {
      assert.ok(result.per_tool[i - 1].tokens >= result.per_tool[i].tokens,
        'Should be sorted descending by tokens');
    }
  });

  test('context_window_usage has 128K, 200K, and 1M entries', () => {
    const result = auditContextBudget(sampleTools);
    assert.ok('128K' in result.context_window_usage);
    assert.ok('200K' in result.context_window_usage);
    assert.ok('1M' in result.context_window_usage);
  });

  test('context percentages are correct', () => {
    const result = auditContextBudget(sampleTools);
    const expected128K = parseFloat(((result.total_tokens / 128000) * 100).toFixed(2));
    assert.equal(result.context_window_usage['128K'], expected128K);
  });

  test('top_consumer is the tool with most tokens', () => {
    const result = auditContextBudget(sampleTools);
    assert.equal(result.top_consumer, result.per_tool[0].name);
  });

  test('empty tools array returns zero totals', () => {
    const result = auditContextBudget([]);
    assert.equal(result.tool_count, 0);
    assert.equal(result.total_tokens, 0);
    assert.equal(result.top_consumer, null);
  });
});

// ─────────────────────────────────────────────
// optimizeToolLoading
// ─────────────────────────────────────────────

describe('optimizeToolLoading', () => {
  const tools = [
    { name: 'read_file', description: 'Read a file from the filesystem', category: 'file-system' },
    { name: 'write_file', description: 'Write content to a file', category: 'file-system' },
    { name: 'web_search', description: 'Search the web for information', category: 'search' },
    { name: 'git_commit', description: 'Create a git commit', category: 'git' },
    { name: 'send_email', description: 'Send an email message', category: 'communication' },
  ];

  test('recommends file tools for file-related tasks', () => {
    const result = optimizeToolLoading('Read the config file and write output', tools);
    const recNames = result.recommended_tools.map(t => t.name);
    assert.ok(recNames.includes('read_file'), 'Should recommend read_file');
    assert.ok(recNames.includes('write_file'), 'Should recommend write_file');
  });

  test('excludes irrelevant tools', () => {
    const result = optimizeToolLoading('Read the config file', tools);
    assert.ok(result.excluded_tools.includes('send_email'),
      'Should exclude send_email for a file task');
  });

  test('recommended_tools are sorted by relevance descending', () => {
    const result = optimizeToolLoading('Search the web for git commit patterns in files', tools);
    for (let i = 1; i < result.recommended_tools.length; i++) {
      assert.ok(
        result.recommended_tools[i - 1].relevance_score >= result.recommended_tools[i].relevance_score,
        'Should be sorted by relevance descending'
      );
    }
  });

  test('total counts are correct', () => {
    const result = optimizeToolLoading('Read a file', tools);
    assert.equal(result.total_available, 5);
    assert.equal(result.recommended_count + result.excluded_count, 5);
  });
});

// ─────────────────────────────────────────────
// compressSchema
// ─────────────────────────────────────────────

describe('compressSchema', () => {
  const verboseSchema = {
    type: 'object',
    description: 'A comprehensive tool for searching the web with multiple filters and options available',
    properties: {
      query: {
        type: 'string',
        description: 'The search query string to use for finding relevant results on the internet',
        examples: ['AI news', 'weather in Kuwait'],
      },
      max_results: {
        type: 'number',
        description: 'Max results',  // 11 chars, under 20
      },
      language: {
        type: 'string',
        description: 'Language code filter for restricting search results to a specific language',
        example: 'en',
      },
    },
    required: ['query'],
  };

  test('light level removes descriptions under 20 chars', () => {
    const result = compressSchema('search', verboseSchema, 'light');
    // max_results description is "Max results" (11 chars) — should be removed
    assert.equal(result.compressed_schema.properties.max_results.description, undefined);
    // query description is long — should be kept
    assert.ok(result.compressed_schema.properties.query.description);
  });

  test('medium level shortens descriptions and removes examples', () => {
    const result = compressSchema('search', verboseSchema, 'medium');
    // query description should be truncated to ~50 chars
    assert.ok(result.compressed_schema.properties.query.description.length <= 50);
    // examples should be removed
    assert.equal(result.compressed_schema.properties.query.examples, undefined);
    // example should be removed
    assert.equal(result.compressed_schema.properties.language.example, undefined);
  });

  test('aggressive level strips all descriptions', () => {
    const result = compressSchema('search', verboseSchema, 'aggressive');
    assert.equal(result.compressed_schema.description, undefined);
    assert.equal(result.compressed_schema.properties.query.description, undefined);
    assert.equal(result.compressed_schema.properties.language.description, undefined);
  });

  test('returns correct token counts and savings', () => {
    const result = compressSchema('search', verboseSchema, 'aggressive');
    assert.ok(result.original_tokens > result.compressed_tokens,
      'Compressed should have fewer tokens');
    assert.ok(result.tokens_saved > 0);
    assert.ok(result.savings_percentage > 0);
    assert.ok(result.savings_percentage <= 100);
  });

  test('does not mutate original schema', () => {
    const original = JSON.parse(JSON.stringify(verboseSchema));
    compressSchema('search', verboseSchema, 'aggressive');
    assert.deepEqual(verboseSchema, original, 'Original schema should not be mutated');
  });
});

// ─────────────────────────────────────────────
// suggestRemovals
// ─────────────────────────────────────────────

describe('suggestRemovals', () => {
  test('flags never-used tools with highest priority', () => {
    const history = [
      { tool_name: 'dead_tool', call_count: 0, last_used_days_ago: 90 },
      { tool_name: 'active_tool', call_count: 50, last_used_days_ago: 1 },
    ];
    const result = suggestRemovals(history);
    assert.equal(result.candidate_count, 1);
    assert.equal(result.removal_candidates[0].tool_name, 'dead_tool');
    assert.equal(result.removal_candidates[0].reason, 'never_used');
    assert.equal(result.removal_candidates[0].priority, 3);
  });

  test('flags tools not used in 30+ days', () => {
    const history = [
      { tool_name: 'stale_tool', call_count: 5, last_used_days_ago: 45 },
    ];
    const result = suggestRemovals(history);
    assert.equal(result.candidate_count, 1);
    assert.equal(result.removal_candidates[0].reason, 'not_used_30_days');
    assert.equal(result.removal_candidates[0].priority, 2);
  });

  test('flags rarely used tools (<=2 calls, >7 days)', () => {
    const history = [
      { tool_name: 'rare_tool', call_count: 1, last_used_days_ago: 14 },
    ];
    const result = suggestRemovals(history);
    assert.equal(result.candidate_count, 1);
    assert.equal(result.removal_candidates[0].reason, 'rarely_used');
    assert.equal(result.removal_candidates[0].priority, 1);
  });

  test('does not flag actively used tools', () => {
    const history = [
      { tool_name: 'busy_tool', call_count: 100, last_used_days_ago: 0 },
      { tool_name: 'moderate_tool', call_count: 10, last_used_days_ago: 5 },
    ];
    const result = suggestRemovals(history);
    assert.equal(result.candidate_count, 0);
  });

  test('sorts candidates by priority then estimated savings', () => {
    const history = [
      { tool_name: 'rare', call_count: 1, last_used_days_ago: 10 },
      { tool_name: 'never_used_tool', call_count: 0, last_used_days_ago: 60 },
      { tool_name: 'stale', call_count: 3, last_used_days_ago: 40 },
    ];
    const result = suggestRemovals(history);
    assert.equal(result.removal_candidates[0].reason, 'never_used');
    assert.equal(result.removal_candidates[1].reason, 'not_used_30_days');
    assert.equal(result.removal_candidates[2].reason, 'rarely_used');
  });
});

// ─────────────────────────────────────────────
// getOptimizationReport
// ─────────────────────────────────────────────

describe('getOptimizationReport', () => {
  const tools = [
    {
      name: 'big_tool',
      description: 'A very verbose tool with a long description that takes up many tokens in the context window',
      schema: {
        type: 'object',
        description: 'Schema with lots of verbose descriptions that could be compressed significantly',
        properties: {
          param1: { type: 'string', description: 'A very long description for parameter one that goes on and on' },
          param2: { type: 'number', description: 'Another verbose description for parameter two with unnecessary detail' },
        },
      },
    },
    {
      name: 'small_tool',
      description: 'Minimal',
      schema: { type: 'object', properties: { x: { type: 'string' } } },
    },
  ];

  const usageHistory = [
    { tool_name: 'big_tool', call_count: 5, last_used_days_ago: 2 },
    { tool_name: 'small_tool', call_count: 0, last_used_days_ago: 60 },
  ];

  test('returns executive summary with health grade', () => {
    const report = getOptimizationReport(tools, usageHistory);
    assert.ok(report.executive_summary);
    assert.ok(['excellent', 'good', 'fair', 'poor'].includes(report.executive_summary.health_grade));
    assert.equal(report.executive_summary.total_tools, 2);
    assert.ok(report.executive_summary.total_tokens_used > 0);
  });

  test('includes audit, removal suggestions, and compression opportunities', () => {
    const report = getOptimizationReport(tools, usageHistory);
    assert.ok(report.audit);
    assert.ok(report.removal_suggestions);
    assert.ok(Array.isArray(report.compression_opportunities));
    assert.ok(Array.isArray(report.recommendations));
  });

  test('identifies small_tool as removal candidate (never used)', () => {
    const report = getOptimizationReport(tools, usageHistory);
    const candidates = report.removal_suggestions.removal_candidates;
    const smallToolCandidate = candidates.find(c => c.tool_name === 'small_tool');
    assert.ok(smallToolCandidate, 'small_tool should be a removal candidate');
    assert.equal(smallToolCandidate.reason, 'never_used');
  });

  test('works without usage history', () => {
    const report = getOptimizationReport(tools);
    assert.ok(report.executive_summary);
    assert.equal(report.removal_suggestions.candidate_count, 0);
  });

  test('recommendations array is non-empty', () => {
    const report = getOptimizationReport(tools, usageHistory);
    assert.ok(report.recommendations.length > 0);
  });
});
