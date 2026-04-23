/**
 * Core analysis functions for token-lens-mcp.
 * All token estimation uses chars/4 approximation on JSON-serialized schemas.
 */

// ═══════════════════════════════════════════
// TOKEN ESTIMATION
// ═══════════════════════════════════════════

/**
 * Estimate token count for a value by serializing to JSON and dividing by 4.
 */
export function estimateTokens(value) {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.ceil(json.length / 4);
}

// ═══════════════════════════════════════════
// AUDIT CONTEXT BUDGET
// ═══════════════════════════════════════════

const CONTEXT_WINDOWS = {
  '128K': 128000,
  '200K': 200000,
  '1M': 1000000,
};

/**
 * Analyze token cost of an array of tool definitions.
 */
export function auditContextBudget(tools) {
  const perTool = tools.map(tool => {
    const fullDef = { name: tool.name, description: tool.description, schema: tool.schema };
    const tokens = estimateTokens(fullDef);
    return { name: tool.name, tokens, chars: JSON.stringify(fullDef).length };
  });

  // Sort by cost descending
  perTool.sort((a, b) => b.tokens - a.tokens);

  const totalTokens = perTool.reduce((sum, t) => sum + t.tokens, 0);

  const contextPercentages = {};
  for (const [label, size] of Object.entries(CONTEXT_WINDOWS)) {
    contextPercentages[label] = parseFloat(((totalTokens / size) * 100).toFixed(2));
  }

  return {
    tool_count: tools.length,
    total_tokens: totalTokens,
    per_tool: perTool,
    context_window_usage: contextPercentages,
    top_consumer: perTool.length > 0 ? perTool[0].name : null,
  };
}

// ═══════════════════════════════════════════
// OPTIMIZE TOOL LOADING
// ═══════════════════════════════════════════

/**
 * Category relevance keywords mapping.
 */
const CATEGORY_KEYWORDS = {
  'file-system': ['file', 'read', 'write', 'directory', 'folder', 'path', 'create', 'delete', 'move', 'copy', 'rename'],
  'search': ['search', 'find', 'query', 'lookup', 'grep', 'glob', 'pattern', 'match'],
  'web': ['web', 'http', 'url', 'fetch', 'download', 'api', 'request', 'browse', 'scrape'],
  'git': ['git', 'commit', 'branch', 'merge', 'push', 'pull', 'diff', 'log', 'repository', 'repo'],
  'database': ['database', 'db', 'sql', 'query', 'table', 'insert', 'update', 'select', 'schema'],
  'code': ['code', 'compile', 'build', 'test', 'lint', 'format', 'refactor', 'debug', 'run', 'execute'],
  'ai': ['ai', 'llm', 'model', 'generate', 'prompt', 'token', 'embedding', 'completion', 'inference'],
  'monitoring': ['monitor', 'trace', 'log', 'metric', 'alert', 'observe', 'track', 'audit', 'report'],
  'communication': ['email', 'message', 'notify', 'slack', 'discord', 'chat', 'send', 'telegram'],
};

/**
 * Score a tool's relevance to a task description.
 */
function scoreToolRelevance(tool, taskWords) {
  let score = 0;

  // Direct keyword match in tool name
  const nameWords = tool.name.toLowerCase().split(/[_\-\s]+/);
  for (const word of nameWords) {
    if (taskWords.has(word)) score += 3;
  }

  // Keyword match in description
  if (tool.description) {
    const descWords = tool.description.toLowerCase().split(/[^a-z0-9]+/);
    for (const word of descWords) {
      if (taskWords.has(word)) score += 1;
    }
  }

  // Category relevance
  if (tool.category) {
    const categoryKws = CATEGORY_KEYWORDS[tool.category] || [];
    for (const kw of categoryKws) {
      if (taskWords.has(kw)) {
        score += 2;
        break; // Only count category match once
      }
    }
  }

  return score;
}

/**
 * Given a task description, recommend the minimal tool set.
 */
export function optimizeToolLoading(taskDescription, availableTools) {
  const taskWords = new Set(
    taskDescription.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2)
  );

  const scored = availableTools.map(tool => ({
    ...tool,
    relevance_score: scoreToolRelevance(tool, taskWords),
  }));

  // Recommended = score > 0, sorted by relevance descending
  const recommended = scored
    .filter(t => t.relevance_score > 0)
    .sort((a, b) => b.relevance_score - a.relevance_score);

  const excluded = scored
    .filter(t => t.relevance_score === 0)
    .map(t => t.name);

  // Estimate token savings from excluded tools
  const excludedTokens = scored
    .filter(t => t.relevance_score === 0)
    .reduce((sum, t) => {
      // Rough estimate: 50 tokens per excluded tool definition
      return sum + 50;
    }, 0);

  return {
    task_description: taskDescription,
    total_available: availableTools.length,
    recommended_tools: recommended.map(t => ({
      name: t.name,
      category: t.category || 'uncategorized',
      relevance_score: t.relevance_score,
    })),
    excluded_tools: excluded,
    recommended_count: recommended.length,
    excluded_count: excluded.length,
    estimated_tokens_saved: excludedTokens,
  };
}

// ═══════════════════════════════════════════
// COMPRESS SCHEMA
// ═══════════════════════════════════════════

/**
 * Deep clone a value (JSON-safe).
 */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Recursively compress a JSON schema at the given level.
 */
function compressSchemaObject(schema, level) {
  if (!schema || typeof schema !== 'object') return schema;

  const result = deepClone(schema);

  if (level === 'light' || level === 'medium' || level === 'aggressive') {
    // Light: remove short descriptions (under 20 chars)
    stripShortDescriptions(result, 20);
  }

  if (level === 'medium' || level === 'aggressive') {
    // Medium: shorten remaining descriptions to 50 chars, remove examples
    shortenDescriptions(result, 50);
    removeExamples(result);
  }

  if (level === 'aggressive') {
    // Aggressive: strip ALL descriptions, keep only types and required
    stripAllDescriptions(result);
  }

  return result;
}

function stripShortDescriptions(obj, maxLen) {
  if (!obj || typeof obj !== 'object') return;
  if (typeof obj.description === 'string' && obj.description.length < maxLen) {
    delete obj.description;
  }
  if (obj.properties) {
    for (const key of Object.keys(obj.properties)) {
      stripShortDescriptions(obj.properties[key], maxLen);
    }
  }
  if (obj.items) stripShortDescriptions(obj.items, maxLen);
  if (Array.isArray(obj.anyOf)) obj.anyOf.forEach(s => stripShortDescriptions(s, maxLen));
  if (Array.isArray(obj.oneOf)) obj.oneOf.forEach(s => stripShortDescriptions(s, maxLen));
  if (Array.isArray(obj.allOf)) obj.allOf.forEach(s => stripShortDescriptions(s, maxLen));
}

function shortenDescriptions(obj, maxLen) {
  if (!obj || typeof obj !== 'object') return;
  if (typeof obj.description === 'string' && obj.description.length > maxLen) {
    obj.description = obj.description.slice(0, maxLen - 3) + '...';
  }
  if (obj.properties) {
    for (const key of Object.keys(obj.properties)) {
      shortenDescriptions(obj.properties[key], maxLen);
    }
  }
  if (obj.items) shortenDescriptions(obj.items, maxLen);
  if (Array.isArray(obj.anyOf)) obj.anyOf.forEach(s => shortenDescriptions(s, maxLen));
  if (Array.isArray(obj.oneOf)) obj.oneOf.forEach(s => shortenDescriptions(s, maxLen));
  if (Array.isArray(obj.allOf)) obj.allOf.forEach(s => shortenDescriptions(s, maxLen));
}

function removeExamples(obj) {
  if (!obj || typeof obj !== 'object') return;
  delete obj.examples;
  delete obj.example;
  if (obj.properties) {
    for (const key of Object.keys(obj.properties)) {
      removeExamples(obj.properties[key]);
    }
  }
  if (obj.items) removeExamples(obj.items);
  if (Array.isArray(obj.anyOf)) obj.anyOf.forEach(removeExamples);
  if (Array.isArray(obj.oneOf)) obj.oneOf.forEach(removeExamples);
  if (Array.isArray(obj.allOf)) obj.allOf.forEach(removeExamples);
}

function stripAllDescriptions(obj) {
  if (!obj || typeof obj !== 'object') return;
  delete obj.description;
  if (obj.properties) {
    for (const key of Object.keys(obj.properties)) {
      stripAllDescriptions(obj.properties[key]);
    }
  }
  if (obj.items) stripAllDescriptions(obj.items);
  if (Array.isArray(obj.anyOf)) obj.anyOf.forEach(stripAllDescriptions);
  if (Array.isArray(obj.oneOf)) obj.oneOf.forEach(stripAllDescriptions);
  if (Array.isArray(obj.allOf)) obj.allOf.forEach(stripAllDescriptions);
}

/**
 * Compress a tool schema at the specified level.
 */
export function compressSchema(toolName, schema, level) {
  const originalTokens = estimateTokens(schema);
  const compressed = compressSchemaObject(schema, level);
  const compressedTokens = estimateTokens(compressed);

  const savings = originalTokens - compressedTokens;

  return {
    tool_name: toolName,
    level,
    compressed_schema: compressed,
    original_tokens: originalTokens,
    compressed_tokens: compressedTokens,
    tokens_saved: savings,
    savings_percentage: originalTokens > 0
      ? parseFloat(((savings / originalTokens) * 100).toFixed(1))
      : 0,
  };
}

// ═══════════════════════════════════════════
// SUGGEST REMOVALS
// ═══════════════════════════════════════════

/**
 * Analyze usage history and suggest tools for removal.
 */
export function suggestRemovals(usageHistory) {
  const candidates = [];

  for (const tool of usageHistory) {
    let reason = null;
    let priority = 0;

    if (tool.call_count === 0) {
      reason = 'never_used';
      priority = 3;
    } else if (tool.last_used_days_ago > 30) {
      reason = 'not_used_30_days';
      priority = 2;
    } else if (tool.call_count <= 2 && tool.last_used_days_ago > 7) {
      reason = 'rarely_used';
      priority = 1;
    }

    if (reason) {
      // Estimate tokens: use name length * 10 as rough proxy if no schema info
      const estimatedTokens = Math.ceil(tool.tool_name.length * 10);
      candidates.push({
        tool_name: tool.tool_name,
        reason,
        priority,
        call_count: tool.call_count,
        last_used_days_ago: tool.last_used_days_ago,
        estimated_tokens_saved: estimatedTokens,
      });
    }
  }

  // Sort by priority descending, then by estimated savings descending
  candidates.sort((a, b) => b.priority - a.priority || b.estimated_tokens_saved - a.estimated_tokens_saved);

  const totalSavings = candidates.reduce((sum, c) => sum + c.estimated_tokens_saved, 0);

  return {
    total_tools_analyzed: usageHistory.length,
    removal_candidates: candidates,
    candidate_count: candidates.length,
    total_estimated_tokens_saved: totalSavings,
  };
}

// ═══════════════════════════════════════════
// GET OPTIMIZATION REPORT
// ═══════════════════════════════════════════

/**
 * Full context window health check combining audit + removals + compression recommendations.
 */
export function getOptimizationReport(tools, usageHistory) {
  // Run audit
  const audit = auditContextBudget(tools);

  // Run removal suggestions if history provided
  const removals = usageHistory && usageHistory.length > 0
    ? suggestRemovals(usageHistory)
    : { removal_candidates: [], candidate_count: 0, total_estimated_tokens_saved: 0 };

  // Check compression potential on the top 3 most expensive tools
  const compressionOpportunities = audit.per_tool.slice(0, 3).map(t => {
    const toolDef = tools.find(td => td.name === t.name);
    if (!toolDef || !toolDef.schema) return null;
    const compressed = compressSchema(t.name, toolDef.schema, 'medium');
    return {
      tool_name: t.name,
      current_tokens: t.tokens,
      compressed_tokens: compressed.compressed_tokens,
      potential_savings: compressed.tokens_saved,
      savings_percentage: compressed.savings_percentage,
    };
  }).filter(Boolean);

  const totalCompressionSavings = compressionOpportunities.reduce(
    (sum, c) => sum + c.potential_savings, 0
  );

  // Build executive summary
  const totalTokens = audit.total_tokens;
  const pctOf200K = audit.context_window_usage['200K'];
  let healthGrade;
  if (pctOf200K < 5) healthGrade = 'excellent';
  else if (pctOf200K < 15) healthGrade = 'good';
  else if (pctOf200K < 30) healthGrade = 'fair';
  else healthGrade = 'poor';

  return {
    executive_summary: {
      health_grade: healthGrade,
      total_tools: tools.length,
      total_tokens_used: totalTokens,
      context_window_usage: audit.context_window_usage,
      top_consumer: audit.top_consumer,
      removal_candidates: removals.candidate_count,
      compression_opportunities: compressionOpportunities.length,
      total_projected_savings: removals.total_estimated_tokens_saved + totalCompressionSavings,
    },
    audit: audit,
    removal_suggestions: removals,
    compression_opportunities: compressionOpportunities,
    recommendations: generateRecommendations(audit, removals, compressionOpportunities),
  };
}

function generateRecommendations(audit, removals, compressionOps) {
  const recs = [];

  if (removals.candidate_count > 0) {
    const neverUsed = removals.removal_candidates.filter(c => c.reason === 'never_used');
    if (neverUsed.length > 0) {
      recs.push(`Remove ${neverUsed.length} never-used tool(s): ${neverUsed.map(c => c.tool_name).join(', ')}`);
    }
    const stale = removals.removal_candidates.filter(c => c.reason === 'not_used_30_days');
    if (stale.length > 0) {
      recs.push(`Review ${stale.length} tool(s) not used in 30+ days: ${stale.map(c => c.tool_name).join(', ')}`);
    }
  }

  if (compressionOps.length > 0) {
    const totalSavings = compressionOps.reduce((s, c) => s + c.potential_savings, 0);
    recs.push(`Compress top ${compressionOps.length} schema(s) to save ~${totalSavings} tokens`);
  }

  if (audit.tool_count > 20) {
    recs.push('Consider dynamic tool loading — load tools only when task context requires them');
  }

  if (audit.context_window_usage['200K'] > 20) {
    recs.push('Tool definitions consume >20% of a 200K context window — aggressive optimization recommended');
  }

  if (recs.length === 0) {
    recs.push('Context window usage is healthy — no immediate action needed');
  }

  return recs;
}
