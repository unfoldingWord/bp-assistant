// tools.js — Tool schemas and executors for the API runner
// Chainguard-safe: no shell or child_process usage.

const fs = require('fs');
const path = require('path');
const fg = require('fast-glob');
const z = require('zod');
const { createWorkspaceTools } = require('../workspace-tools');
const { VERSE_DATA_TOOL_SCHEMAS, executeVerseDataTool, isVerseDataTool } = require('./verse-data');
const { AGENT_TOOL_SCHEMAS, executeAgentTool, isAgentTool } = require('./agent-tools');

const MCP_PREFIX = 'mcp__workspace-tools__';

const CORE_TOOL_SCHEMAS = [
  {
    name: 'Read',
    description: 'Read a file from the filesystem. Returns file contents with line numbers.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute or relative path to the file to read' },
        offset: { type: 'number', description: 'Line number to start reading from (1-based)' },
        limit: { type: 'number', description: 'Maximum number of lines to read' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'Write',
    description: 'Write content to a file. Creates parent directories if needed. Overwrites existing file.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute or relative path to the file to write' },
        content: { type: 'string', description: 'The content to write to the file' },
      },
      required: ['file_path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'Edit',
    description: 'Replace a string in a file. old_string must match exactly one location in the file.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute or relative path to the file to edit' },
        old_string: { type: 'string', description: 'The exact text to find and replace' },
        new_string: { type: 'string', description: 'The replacement text' },
      },
      required: ['file_path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  {
    name: 'Glob',
    description: 'Find files matching a glob pattern. Returns matching file paths.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match (e.g. "**/*.js")' },
        path: { type: 'string', description: 'Directory to search in' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'Grep',
    description: 'Search file contents with a regex pattern. Returns matching lines with file paths and line numbers.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'File or directory to search in' },
        glob: { type: 'string', description: 'Glob filter for files (e.g. "**/*.js")' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
];

const WORKSPACE_TOOL_REGISTRY = buildWorkspaceToolRegistry();
const TOOL_SCHEMAS = [
  ...CORE_TOOL_SCHEMAS,
  ...VERSE_DATA_TOOL_SCHEMAS,
  ...AGENT_TOOL_SCHEMAS,
  ...WORKSPACE_TOOL_REGISTRY.schemas,
];

function buildWorkspaceToolRegistry() {
  const workspaceToolsServer = createWorkspaceTools(
    (config) => config,
    (name, description, inputSchema, handler) => ({ name, description, inputSchema, handler }),
    z
  );

  const schemas = [];
  const handlers = {};

  for (const toolDef of workspaceToolsServer.tools || []) {
    const jsonSchema = toJsonSchemaFromZodShape(toolDef.inputSchema || {});
    const names = [toolDef.name, `${MCP_PREFIX}${toolDef.name}`];
    for (const name of names) {
      schemas.push({
        name,
        description: toolDef.description,
        parameters: jsonSchema,
      });
      handlers[name] = toolDef.handler;
    }
  }

  return { schemas, handlers };
}

function toJsonSchemaFromZodShape(shape) {
  const objectSchema = z.object(shape);
  const jsonSchema = z.toJSONSchema(objectSchema);
  if (!jsonSchema || typeof jsonSchema !== 'object') {
    return { type: 'object', properties: {}, additionalProperties: true };
  }
  if (!jsonSchema.type) jsonSchema.type = 'object';
  if (!jsonSchema.properties) jsonSchema.properties = {};
  return jsonSchema;
}

// --- Provider-Specific Format Converters ---

function toGeminiTools(schemas) {
  return [{
    functionDeclarations: schemas.map((schema) => ({
      name: schema.name,
      description: schema.description,
      parametersJsonSchema: schema.parameters,
    })),
  }];
}

function toOpenAITools(schemas) {
  return schemas.map((schema) => ({
    type: 'function',
    function: {
      name: schema.name,
      description: schema.description,
      parameters: strictifySchema(schema.parameters),
      strict: true,
    },
  }));
}

/**
 * OpenAI strict mode requires every property in `required`.
 * For optional params (not in `required`), make them nullable
 * and add them to `required` — OpenAI's documented pattern.
 */
function strictifySchema(params) {
  if (!params || !params.properties) return params;
  const props = { ...params.properties };
  const required = new Set(params.required || []);
  for (const key of Object.keys(props)) {
    if (!required.has(key)) {
      // Make optional property nullable
      props[key] = { ...props[key], type: [props[key].type, 'null'] };
      required.add(key);
    }
  }
  return { ...params, properties: props, required: [...required], additionalProperties: false };
}

function toClaudeTools(schemas) {
  return schemas.map((schema) => ({
    name: schema.name,
    description: schema.description,
    input_schema: schema.parameters,
  }));
}

function listToolNames() {
  return TOOL_SCHEMAS.map((schema) => schema.name);
}

function getToolDescriptions() {
  return TOOL_SCHEMAS.map((schema) => ({ name: schema.name, description: schema.description }));
}

// --- Tool Executors ---

function resolvePath(filePath, cwd) {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(cwd, filePath);
}

/**
 * Execute a tool by name.
 *
 * @param {string} name - Tool name
 * @param {Object} params - Tool parameters
 * @param {string} cwd - Working directory
 * @param {Object} [agentContext] - Context for agent tools: { parentOpts, runAgentLoopFn }
 * @returns {Promise<string>} Tool result
 */
async function executeTool(name, params, cwd, agentContext) {
  try {
    // Core file tools
    switch (name) {
      case 'Read': return executeRead(params, cwd);
      case 'Write': return executeWrite(params, cwd);
      case 'Edit': return executeEdit(params, cwd);
      case 'Glob': return executeGlob(params, cwd);
      case 'Grep': return executeGrep(params, cwd);
    }

    // Verse data tools
    if (isVerseDataTool(name)) {
      return executeVerseDataTool(name, params);
    }

    // Agent/team tools
    if (isAgentTool(name)) {
      if (!agentContext) {
        return `Error: Agent tools require agent context (not available in this execution mode)`;
      }
      return executeAgentTool(name, params, agentContext);
    }

    // Workspace tools (MCP-style)
    if (WORKSPACE_TOOL_REGISTRY.handlers[name]) {
      return executeWorkspaceTool(name, params);
    }

    return `Error: Unknown tool "${name}"`;
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

function executeRead(params, cwd) {
  const filePath = resolvePath(params.file_path, cwd);
  if (!fs.existsSync(filePath)) {
    return `Error: File not found: ${filePath}`;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const offset = Math.max((params.offset || 1) - 1, 0);
  const limit = params.limit || lines.length;
  const slice = lines.slice(offset, offset + limit);
  return slice.map((line, index) => `${String(offset + index + 1).padStart(6)}\t${line}`).join('\n');
}

function executeWrite(params, cwd) {
  const filePath = resolvePath(params.file_path, cwd);
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(filePath, params.content, 'utf8');
  return `Successfully wrote ${params.content.length} bytes to ${filePath}`;
}

function executeEdit(params, cwd) {
  const filePath = resolvePath(params.file_path, cwd);
  if (!fs.existsSync(filePath)) {
    return `Error: File not found: ${filePath}`;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const count = content.split(params.old_string).length - 1;
  if (count === 0) {
    return `Error: old_string not found in ${filePath}`;
  }
  if (count > 1) {
    return `Error: old_string found ${count} times in ${filePath} — must be unique`;
  }
  const newContent = content.replace(params.old_string, params.new_string);
  fs.writeFileSync(filePath, newContent, 'utf8');
  return `Successfully edited ${filePath}`;
}

function executeGlob(params, cwd) {
  const searchDir = params.path ? resolvePath(params.path, cwd) : cwd;
  if (!fs.existsSync(searchDir)) {
    return `Error: Path not found: ${searchDir}`;
  }
  const pattern = params.pattern || '**/*';
  const matches = fg.sync(pattern, {
    cwd: searchDir,
    absolute: true,
    dot: true,
    onlyFiles: false,
    unique: true,
    followSymbolicLinks: false,
  }).slice(0, 500);
  return matches.length > 0 ? matches.join('\n') : '(no matches)';
}

function executeGrep(params, cwd) {
  const searchPath = params.path ? resolvePath(params.path, cwd) : cwd;
  if (!fs.existsSync(searchPath)) {
    return `Error: Path not found: ${searchPath}`;
  }

  let regex;
  try {
    regex = new RegExp(params.pattern);
  } catch (error) {
    return `Error: Invalid regex "${params.pattern}": ${error.message}`;
  }

  const files = resolveSearchFiles(searchPath, params.glob || '**/*');
  const output = [];

  for (const filePath of files) {
    const content = safeReadUtf8(filePath);
    if (content == null) continue;
    const lines = content.split('\n');
    for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
      const line = lines[lineNumber];
      regex.lastIndex = 0;
      if (regex.test(line)) {
        output.push(`${filePath}:${lineNumber + 1}:${line}`);
        if (output.length >= 200) {
          return output.join('\n');
        }
      }
    }
  }

  return output.length > 0 ? output.join('\n') : '(no matches)';
}

function resolveSearchFiles(searchPath, globPattern) {
  const stat = fs.statSync(searchPath);
  if (stat.isFile()) return [searchPath];
  return fg.sync(globPattern, {
    cwd: searchPath,
    absolute: true,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
    unique: true,
    ignore: ['**/node_modules/**', '**/.git/**'],
  });
}

function safeReadUtf8(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function executeWorkspaceTool(name, params) {
  const handler = WORKSPACE_TOOL_REGISTRY.handlers[name];
  if (!handler) {
    return `Error: Workspace tool "${name}" is not registered`;
  }

  const result = await handler(params || {});
  const contentBlocks = result?.content || [];
  if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) {
    return '(no output)';
  }

  const textParts = [];
  for (const block of contentBlocks) {
    if (block && typeof block.text === 'string') {
      textParts.push(block.text);
    } else if (block != null) {
      textParts.push(JSON.stringify(block));
    }
  }
  return textParts.join('\n');
}

module.exports = {
  TOOL_SCHEMAS,
  toGeminiTools,
  toOpenAITools,
  toClaudeTools,
  executeTool,
  listToolNames,
  getToolDescriptions,
  strictifySchema,
};
