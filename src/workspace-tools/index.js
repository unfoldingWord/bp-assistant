// workspace-tools/index.js — SDK MCP server for workspace tools
//
// Registers all ported workspace scripts as in-process MCP tools.
// Claude calls these as mcp__workspace-tools__<tool_name> — no shell needed.

const {
  fetchHebrewBible, fetchUlt, fetchUst, fetchT4t, fetchDoor43,
  fetchGlossary, fetchIssuesResolved, fetchTemplates,
} = require('./fetch-tools');

/**
 * Create the SDK MCP server config. Must be called after the SDK is loaded
 * (ESM dynamic import), so callers pass createSdkMcpServer and tool as args.
 */
function createWorkspaceTools(createSdkMcpServer, tool, z) {
  return createSdkMcpServer({
    name: 'workspace-tools',
    version: '1.0.0',
    tools: [
      // --- Fetch tools ---
      tool(
        'fetch_hebrew_bible',
        'Fetch Hebrew USFM source files from Door43 UHB repository into data/hebrew_bible/',
        {
          books: z.array(z.string()).optional().describe('Specific book codes (e.g. ["PSA","ISA"]). Omit for all 39 OT books.'),
          force: z.boolean().optional().describe('Force re-fetch even if cached today'),
        },
        async (args) => ({
          content: [{ type: 'text', text: await fetchHebrewBible(args) }],
        })
      ),
      tool(
        'fetch_ult',
        'Fetch published ULT (Literal Translation) USFM files from Door43 into data/published_ult/',
        {
          books: z.array(z.string()).optional().describe('Specific book codes. Omit for all 25 v88 published books.'),
          force: z.boolean().optional().describe('Force re-fetch even if cached today'),
        },
        async (args) => ({
          content: [{ type: 'text', text: await fetchUlt(args) }],
        })
      ),
      tool(
        'fetch_ust',
        'Fetch published UST (Simplified Translation) USFM files from Door43 into data/published_ust/',
        {
          books: z.array(z.string()).optional().describe('Specific book codes. Omit for all 25 v88 published books.'),
          force: z.boolean().optional().describe('Force re-fetch even if cached today'),
        },
        async (args) => ({
          content: [{ type: 'text', text: await fetchUst(args) }],
        })
      ),
      tool(
        'fetch_t4t',
        'Fetch T4T (Translation for Translators) USFM files from Door43 into data/t4t/',
        {
          books: z.array(z.string()).optional().describe('Specific book codes. Omit for all 39 OT books.'),
          force: z.boolean().optional().describe('Force re-fetch even if cached today'),
        },
        async (args) => ({
          content: [{ type: 'text', text: await fetchT4t(args) }],
        })
      ),
      tool(
        'fetch_door43',
        'Fetch a single USFM file from any Door43 repo/branch/user fork',
        {
          book: z.string().describe('Book code or name (e.g. PSA, Genesis, 1JN)'),
          repo: z.string().optional().describe('Repository name (default: en_ult)'),
          branch: z.string().optional().describe('Branch name (default: master)'),
          user: z.string().optional().describe('Door43 username for user fork (default: unfoldingWord)'),
          output: z.string().optional().describe('Output file path relative to workspace. Omit for content in response.'),
        },
        async (args) => ({
          content: [{ type: 'text', text: await fetchDoor43(args) }],
        })
      ),
      tool(
        'fetch_glossary',
        'Fetch glossary CSV sheets from Google Sheets into data/glossary/. Sheets: hebrew_ot_glossary, biblical_measurements, psalms_reference, sacrifice_terminology, biblical_phrases',
        {
          sheets: z.array(z.string()).optional().describe('Specific sheet names. Omit for all 5 sheets.'),
          force: z.boolean().optional().describe('Force refresh regardless of cache'),
        },
        async (args) => ({
          content: [{ type: 'text', text: await fetchGlossary(args) }],
        })
      ),
      tool(
        'fetch_issues_resolved',
        'Fetch the Content Meeting "Issues Resolved" document from Google Docs into data/issues_resolved.txt',
        {
          force: z.boolean().optional().describe('Force refresh regardless of cache'),
        },
        async (args) => ({
          content: [{ type: 'text', text: await fetchIssuesResolved(args) }],
        })
      ),
      tool(
        'fetch_templates',
        'Fetch TN templates or other Google Sheets as CSV/TSV',
        {
          sheetId: z.string().optional().describe('Google Sheets ID (default: Sample TN Templates)'),
          gid: z.string().optional().describe('Specific sheet tab gid'),
          output: z.string().optional().describe('Output file path relative to workspace. Omit for content in response.'),
          format: z.enum(['csv', 'tsv']).optional().describe('Export format (default: csv)'),
          force: z.boolean().optional().describe('Force fetch even if cached today'),
        },
        async (args) => ({
          content: [{ type: 'text', text: await fetchTemplates(args) }],
        })
      ),
    ],
  });
}

module.exports = { createWorkspaceTools };
