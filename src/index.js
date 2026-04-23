#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  auditContextBudget,
  optimizeToolLoading,
  compressSchema,
  suggestRemovals,
  getOptimizationReport,
  estimateTokens,
} from './analyzer.js';
import {
  registerTool,
  logCall,
  getReport,
  getStorageStats,
} from './storage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const startTime = Date.now();
let toolCallCount = 0;

function wrap(fn) {
  return async (...args) => {
    toolCallCount++;
    try { return await fn(...args); }
    catch (e) { return { content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }] }; }
  };
}

const server = new McpServer({
  name: 'token-lens-mcp',
  version: pkg.version,
  description: 'Analyze and optimize context window token usage — audit tool definitions, compress schemas, track usage, and reduce bloat',
});

server.tool('health_check', 'Returns server health, uptime, version, and storage stats', {},
  async () => {
    const storage = getStorageStats();
    return { content: [{ type: 'text', text: JSON.stringify({ status: 'healthy', server: 'token-lens-mcp', version: pkg.version, uptime_seconds: Math.floor((Date.now() - startTime) / 1000), tool_calls_served: toolCallCount, storage }, null, 2) }] };
  }
);

// ═══════════════════════════════════════════
// TOOL: audit_context_budget
// ═══════════════════════════════════════════

server.tool(
  'audit_context_budget',
  'Analyze the token cost of MCP tool definitions. Estimates tokens per tool using chars/4 on the full JSON definition. Returns per-tool costs and percentage of common context windows.',
  {
    tools: z.array(z.object({
      name: z.string().describe('Tool name'),
      description: z.string().describe('Tool description'),
      schema: z.record(z.any()).describe('Tool input schema (JSON Schema object)'),
    })).describe('Array of tool definitions to audit'),
  },
  wrap(({ tools }) => {
    return { content: [{ type: 'text', text: JSON.stringify(auditContextBudget(tools), null, 2) }] };
  })
);

// ═══════════════════════════════════════════
// TOOL: optimize_tool_loading
// ═══════════════════════════════════════════

server.tool(
  'optimize_tool_loading',
  'Given a task description, recommend the minimal set of tools needed. Uses keyword matching and category relevance scoring to rank tools.',
  {
    task_description: z.string().describe('Description of the task to perform'),
    available_tools: z.array(z.object({
      name: z.string().describe('Tool name'),
      description: z.string().describe('Tool description'),
      category: z.string().optional().describe('Tool category (e.g., file-system, search, web, git, database, code, ai, monitoring, communication)'),
    })).describe('Array of available tools to filter'),
  },
  wrap(({ task_description, available_tools }) => {
    return { content: [{ type: 'text', text: JSON.stringify(optimizeToolLoading(task_description, available_tools), null, 2) }] };
  })
);

// ═══════════════════════════════════════════
// TOOL: compress_schema
// ═══════════════════════════════════════════

server.tool(
  'compress_schema',
  'Compress a verbose tool schema to reduce token usage. Light: remove short descriptions. Medium: shorten descriptions, remove examples. Aggressive: strip all descriptions.',
  {
    tool_name: z.string().describe('Name of the tool whose schema to compress'),
    schema: z.record(z.any()).describe('The JSON Schema to compress'),
    level: z.enum(['light', 'medium', 'aggressive']).describe('Compression level'),
  },
  wrap(({ tool_name, schema, level }) => {
    return { content: [{ type: 'text', text: JSON.stringify(compressSchema(tool_name, schema, level), null, 2) }] };
  })
);

// ═══════════════════════════════════════════
// TOOL: analyze_session_usage
// ═══════════════════════════════════════════

server.tool(
  'analyze_session_usage',
  'Track which tools are actually called vs loaded in a session. Register tools, log calls, and generate waste reports showing unused tools ranked by token cost.',
  {
    session_id: z.string().describe('Unique session identifier'),
    action: z.enum(['register_tool', 'log_call', 'report']).describe('Action to perform'),
    tool_name: z.string().optional().describe('Tool name (required for register_tool and log_call)'),
    tool_tokens: z.number().int().min(0).optional().describe('Token cost of the tool (for register_tool)'),
  },
  wrap(({ session_id, action, tool_name, tool_tokens }) => {
    let result;

    switch (action) {
      case 'register_tool': {
        if (!tool_name) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ error: 'tool_name is required for register_tool action' }),
            }],
            isError: true,
          };
        }
        const tokens = tool_tokens ?? 50; // Default estimate
        result = registerTool(session_id, tool_name, tokens);
        break;
      }
      case 'log_call': {
        if (!tool_name) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ error: 'tool_name is required for log_call action' }),
            }],
            isError: true,
          };
        }
        result = logCall(session_id, tool_name);
        break;
      }
      case 'report': {
        result = getReport(session_id);
        break;
      }
    }

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  })
);

// ═══════════════════════════════════════════
// TOOL: suggest_removals
// ═══════════════════════════════════════════

server.tool(
  'suggest_removals',
  'Identify tools that can be removed based on usage history. Scores: never_used > not_used_30_days > rarely_used. Returns removal candidates with estimated token savings.',
  {
    usage_history: z.array(z.object({
      tool_name: z.string().describe('Tool name'),
      call_count: z.number().int().min(0).describe('Total number of times this tool has been called'),
      last_used_days_ago: z.number().min(0).describe('Days since last use (0 = today)'),
    })).describe('Usage history for each tool'),
  },
  wrap(({ usage_history }) => {
    return { content: [{ type: 'text', text: JSON.stringify(suggestRemovals(usage_history), null, 2) }] };
  })
);

// ═══════════════════════════════════════════
// TOOL: get_optimization_report
// ═══════════════════════════════════════════

server.tool(
  'get_optimization_report',
  'Full context window health check combining audit, removal suggestions, and compression recommendations. Returns an executive summary with health grade and projected savings.',
  {
    tools: z.array(z.object({
      name: z.string().describe('Tool name'),
      description: z.string().describe('Tool description'),
      schema: z.record(z.any()).describe('Tool input schema'),
    })).describe('Array of tool definitions'),
    usage_history: z.array(z.object({
      tool_name: z.string().describe('Tool name'),
      call_count: z.number().int().min(0).describe('Total call count'),
      last_used_days_ago: z.number().min(0).describe('Days since last use'),
    })).optional().describe('Optional usage history for removal analysis'),
  },
  wrap(({ tools, usage_history }) => {
    return { content: [{ type: 'text', text: JSON.stringify(getOptimizationReport(tools, usage_history), null, 2) }] };
  })
);

// ═══════════════════════════════════════════
// RESOURCES
// ═══════════════════════════════════════════

server.resource(
  'tips',
  'token-lens://tips',
  async () => ({
    contents: [{
      uri: 'token-lens://tips',
      mimeType: 'text/markdown',
      text: `# Token Lens: Reducing MCP Context Window Bloat

## The Problem
MCP tool definitions are serialized into the system prompt on every request.
With 10-30 tools loaded, definitions alone can consume 40-72% of the context
window before any user content is processed.

## Quick Wins

### 1. Audit First
Run \`audit_context_budget\` with your current tool set to see exactly how many
tokens each tool definition costs. Most teams are surprised by the total.

### 2. Compress Verbose Schemas
Use \`compress_schema\` at "medium" level for immediate savings:
- Removes example values (often 30%+ of schema size)
- Shortens descriptions to 50 chars (usually sufficient for LLM understanding)
- Preserves types and required fields (the parts that actually matter)

### 3. Load Only What You Need
Use \`optimize_tool_loading\` before each task to determine the minimal tool set.
A code review task doesn't need email tools. A data analysis task doesn't need
git tools. Dynamic loading can save 50-80% of tool token overhead.

### 4. Remove Dead Tools
Run \`suggest_removals\` against your usage history:
- **Never-used tools**: Remove immediately. Zero risk.
- **Not used in 30+ days**: Likely candidates for removal.
- **Rarely used (<=2 calls, >7 days)**: Consider on-demand loading.

### 5. Track Actual Usage
Use \`analyze_session_usage\` to register tools at session start and log calls
during the session. The waste report shows exactly which tools consumed tokens
without providing value.

## Schema Design Best Practices

### DO:
- Use concise descriptions (under 50 chars per field)
- Omit optional fields that have obvious defaults
- Use \`enum\` instead of long description text for constrained values
- Keep property names short but descriptive

### DON'T:
- Include multi-sentence descriptions per field
- Add example values in the schema (use description instead)
- Nest deeply when flat structures suffice
- Include deprecated or rarely-used parameters

## Token Budget Guidelines

| Context Window | Tool Budget (Recommended) | Max Tools (Avg Size) |
|----------------|--------------------------|---------------------|
| 128K           | 10-15% (12K-19K tokens)  | 15-25 tools         |
| 200K           | 8-12% (16K-24K tokens)   | 20-35 tools         |
| 1M             | 3-5% (30K-50K tokens)    | 40-60 tools         |

Keep tool definitions under 10% of your context window to leave maximum room
for conversation history, documents, and reasoning.

## Advanced: Dynamic Tool Loading

Instead of loading all tools at session start:
1. Start with a minimal "router" tool set (5-8 core tools)
2. Use \`optimize_tool_loading\` when task context becomes clear
3. Load additional tools only when needed
4. Unload tools after task completion

This can reduce average tool token usage by 60-80%.
`,
    }],
  })
);

// ═══════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Token Lens MCP Server running on stdio');
}

main().catch(console.error);
