// tools.js — Tool schemas and executors for the API runner
// Tools named identically to Claude SDK so skill prompts work unchanged

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// --- Tool Schemas (canonical, provider-neutral) ---

const TOOL_SCHEMAS = [
  {
    name: 'Read',
    description: 'Read a file from the filesystem. Returns file contents with line numbers.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to read' },
        offset: { type: 'number', description: 'Line number to start reading from (1-based)' },
        limit: { type: 'number', description: 'Maximum number of lines to read' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    description: 'Write content to a file. Creates parent directories if needed. Overwrites existing file.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to write' },
        content: { type: 'string', description: 'The content to write to the file' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'Edit',
    description: 'Replace a string in a file. old_string must match exactly one location in the file.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to edit' },
        old_string: { type: 'string', description: 'The exact text to find and replace' },
        new_string: { type: 'string', description: 'The replacement text' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Bash',
    description: 'Execute a bash command. Returns stdout and stderr.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (max 300000)' },
      },
      required: ['command'],
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
        glob: { type: 'string', description: 'Glob filter for files (e.g. "*.js")' },
      },
      required: ['pattern'],
    },
  },
];

// --- Provider-Specific Format Converters ---

function toGeminiTools(schemas) {
  return [{
    functionDeclarations: schemas.map(s => ({
      name: s.name,
      description: s.description,
      parameters: {
        type: 'OBJECT',
        properties: Object.fromEntries(
          Object.entries(s.parameters.properties).map(([k, v]) => [k, {
            type: v.type.toUpperCase(),
            description: v.description,
          }])
        ),
        required: s.parameters.required || [],
      },
    })),
  }];
}

function toOpenAITools(schemas) {
  return schemas.map(s => ({
    type: 'function',
    function: {
      name: s.name,
      description: s.description,
      parameters: s.parameters,
    },
  }));
}

function toClaudeTools(schemas) {
  return schemas.map(s => ({
    name: s.name,
    description: s.description,
    input_schema: s.parameters,
  }));
}

// --- Tool Executors ---

function resolvePath(filePath, cwd) {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(cwd, filePath);
}

async function executeTool(name, params, cwd) {
  try {
    switch (name) {
      case 'Read': return executeRead(params, cwd);
      case 'Write': return executeWrite(params, cwd);
      case 'Edit': return executeEdit(params, cwd);
      case 'Bash': return executeBash(params, cwd);
      case 'Glob': return executeGlob(params, cwd);
      case 'Grep': return executeGrep(params, cwd);
      default: return `Error: Unknown tool "${name}"`;
    }
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
  const offset = (params.offset || 1) - 1;
  const limit = params.limit || lines.length;
  const slice = lines.slice(offset, offset + limit);
  return slice.map((line, i) => `${String(offset + i + 1).padStart(6)}\t${line}`).join('\n');
}

function executeWrite(params, cwd) {
  const filePath = resolvePath(params.file_path, cwd);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
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

function executeBash(params, cwd) {
  const timeout = Math.min(params.timeout || 300000, 300000);
  try {
    const output = execSync(params.command, {
      cwd,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output || '(no output)';
  } catch (err) {
    const stdout = err.stdout || '';
    const stderr = err.stderr || '';
    const exitCode = err.status ?? 'unknown';
    return `Exit code: ${exitCode}\n${stdout}\n${stderr}`.trim();
  }
}

function executeGlob(params, cwd) {
  const searchDir = params.path ? resolvePath(params.path, cwd) : cwd;
  try {
    // Use find + shell glob via bash for reliability
    const escaped = params.pattern.replace(/'/g, "'\\''");
    const output = execSync(
      `find ${JSON.stringify(searchDir)} -path ${JSON.stringify('*/' + params.pattern)} -o -name ${JSON.stringify(params.pattern)} 2>/dev/null | head -500`,
      { cwd, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 }
    );
    return output.trim() || '(no matches)';
  } catch (err) {
    return err.stdout?.trim() || '(no matches)';
  }
}

function executeGrep(params, cwd) {
  const searchPath = params.path ? resolvePath(params.path, cwd) : cwd;
  const args = ['-rn', '--include', params.glob || '*'];
  const escaped = params.pattern.replace(/'/g, "'\\''");
  try {
    const output = execSync(
      `grep -rn ${params.glob ? `--include=${JSON.stringify(params.glob)}` : ''} -E ${JSON.stringify(params.pattern)} ${JSON.stringify(searchPath)} 2>/dev/null | head -200`,
      { cwd, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 }
    );
    return output.trim() || '(no matches)';
  } catch (err) {
    return err.stdout?.trim() || '(no matches)';
  }
}

module.exports = {
  TOOL_SCHEMAS,
  toGeminiTools,
  toOpenAITools,
  toClaudeTools,
  executeTool,
};
