# token-lens-mcp

MCP server for analyzing and optimizing context window token usage. MCP tool definitions consume 40-72% of context windows before any user work begins — this server helps you measure, compress, and eliminate that waste.

## Install

```bash
npx token-lens-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "token-lens": {
      "command": "npx",
      "args": ["token-lens-mcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add token-lens -- npx token-lens-mcp
```

## Tools

### audit_context_budget

Analyze the token cost of your MCP tool definitions. Estimates tokens per tool using chars/4 approximation on the full JSON definition.

**Params:**
- `tools` — Array of `{name, description, schema}` objects

**Returns:** Per-tool token cost (sorted by cost), total tokens, percentage of 128K/200K/1M context windows.

### optimize_tool_loading

Given a task description, recommend the minimal set of tools needed. Uses keyword matching and category relevance scoring.

**Params:**
- `task_description` — What you're trying to accomplish
- `available_tools` — Array of `{name, description, category?}`

**Returns:** Recommended tools sorted by relevance, excluded tools, estimated tokens saved.

### compress_schema

Compress verbose tool schemas to reduce token usage.

**Params:**
- `tool_name` — Name of the tool
- `schema` — JSON Schema object to compress
- `level` — `"light"` | `"medium"` | `"aggressive"`

**Levels:**
- **light** — Remove descriptions under 20 chars
- **medium** — Shorten descriptions to 50 chars, remove examples
- **aggressive** — Strip all descriptions, keep only types and required fields

**Returns:** Compressed schema, original/compressed token counts, savings percentage.

### analyze_session_usage

Track which tools are actually called vs loaded during a session.

**Params:**
- `session_id` — Unique session identifier
- `action` — `"register_tool"` | `"log_call"` | `"report"`
- `tool_name` — Tool name (required for register_tool/log_call)
- `tool_tokens` — Token cost (for register_tool, default 50)

**Report returns:** Loaded vs used counts, waste percentage, unused tools ranked by token cost.

### suggest_removals

Identify tools that can be safely removed based on usage patterns.

**Params:**
- `usage_history` — Array of `{tool_name, call_count, last_used_days_ago}`

**Scoring:** never_used (priority 3) > not_used_30_days (priority 2) > rarely_used (priority 1)

**Returns:** Removal candidates with reasons and estimated token savings.

### get_optimization_report

Full context window health check combining audit, removal suggestions, and compression recommendations.

**Params:**
- `tools` — Array of tool definitions
- `usage_history` — Optional usage history array

**Returns:** Executive summary with health grade (excellent/good/fair/poor), audit results, removal suggestions, compression opportunities, and actionable recommendations.

## Resources

### token-lens://tips

Best practices guide for reducing MCP context window bloat, including schema design tips, token budget guidelines, and dynamic tool loading strategies.

## Development

```bash
npm install
npm test
npm run dev  # watch mode
```

## License

MIT
