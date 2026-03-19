// workspace-tools/index.js — SDK MCP server for workspace tools
//
// Registers all ported workspace scripts as in-process MCP tools.
// Claude calls these as mcp__workspace-tools__<tool_name> — no shell needed.

const {
  fetchHebrewBible, fetchUlt, fetchUst, fetchT4t, fetchDoor43,
  fetchGlossary, fetchIssuesResolved, fetchTemplates,
} = require('./fetch-tools');
const { splitTsv, mergeTsvs, fixTrailingNewlines } = require('./tsv-tools');
const { extractUltEnglish, filterPsalms, curlyQuotes, checkUstPassives, createAlignedUsfm } = require('./usfm-tools');
const { buildStrongsIndex, buildTnIndex, buildUstIndex } = require('./index-tools');
const { checkTwHeadwords, compareUltUst, detectAbstractNouns } = require('./issue-tools');
const { extractAlignmentData, fixHebrewQuotes, flagNarrowQuotes, generateIds, resolveGlQuotes, verifyAtFit, assembleNotes, prepareNotes } = require('./tn-tools');
const { validateTnTsv, checkTnQuality } = require('./quality-tools');
const { giteaPr, prepareCompare, prepareTq, verifyTq } = require('./misc-tools');

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

      // --- TSV tools ---
      tool(
        'split_tsv',
        'Split a verse-based issue TSV into chunks for parallel processing. Returns absolute paths of chunk files.',
        {
          inputTsv: z.string().describe('Path to input issue TSV (relative to workspace)'),
          chunkSize: z.number().int().optional().describe('Target verses per chunk (default: 40)'),
          ranges: z.string().optional().describe('Explicit ranges like "1-8,9-16,17-24"'),
          outputDir: z.string().optional().describe('Output directory (default: same as input)'),
        },
        async (args) => ({
          content: [{ type: 'text', text: splitTsv(args) }],
        })
      ),
      tool(
        'merge_tsvs',
        'Merge multiple notes TSVs with deduplication and verse sorting. Returns path to merged file.',
        {
          files: z.array(z.string()).optional().describe('Input TSV file paths (relative to workspace)'),
          globPattern: z.string().optional().describe('Glob pattern for input files (e.g. "output/notes/PSA/PSA-119-v*.tsv")'),
          output: z.string().describe('Output file path (relative to workspace)'),
          noSort: z.boolean().optional().describe('Preserve chunk order instead of re-sorting'),
        },
        async (args) => ({
          content: [{ type: 'text', text: mergeTsvs(args) }],
        })
      ),
      tool(
        'fix_trailing_newlines',
        'Fix trailing literal \\n in Note column of a TSV file (in-place)',
        {
          file: z.string().describe('TSV file path (relative to workspace)'),
        },
        async (args) => ({
          content: [{ type: 'text', text: fixTrailingNewlines(args) }],
        })
      ),

      // --- USFM tools ---
      tool(
        'extract_ult_english',
        'Strip alignment markers from ULT USFM files to produce clean English text in data/published_ult_english/',
        {
          books: z.array(z.string()).optional().describe('Specific book codes. Omit for all files.'),
          force: z.boolean().optional().describe('Force re-process even if cached today'),
          inputDir: z.string().optional().describe('Input directory (default: data/published_ult)'),
          outputDir: z.string().optional().describe('Output directory (default: data/published_ult_english)'),
        },
        async (args) => ({
          content: [{ type: 'text', text: extractUltEnglish(args) }],
        })
      ),
      tool(
        'filter_psalms',
        'Filter Psalms USFM files to keep only chapters 1-29, 42-57, 90-118 (modifies files in-place)',
        {},
        async () => ({
          content: [{ type: 'text', text: filterPsalms() }],
        })
      ),
      tool(
        'curly_quotes',
        'Convert straight quotes to typographic curly quotes in text/USFM files',
        {
          input: z.string().describe('Input file path (relative to workspace)'),
          output: z.string().optional().describe('Output file path. Omit to return content.'),
          inPlace: z.boolean().optional().describe('Modify input file in-place'),
        },
        async (args) => ({
          content: [{ type: 'text', text: curlyQuotes(args) }],
        })
      ),
      tool(
        'check_ust_passives',
        'Detect passive voice constructions in UST USFM text',
        {
          file: z.string().describe('UST USFM file path (relative to workspace)'),
        },
        async (args) => ({
          content: [{ type: 'text', text: checkUstPassives(args) }],
        })
      ),

      tool(
        'create_aligned_usfm',
        'Convert alignment mapping JSON to aligned USFM3 (mechanically computes correct x-occurrence/x-occurrences)',
        {
          hebrew: z.string().describe('Hebrew source USFM path (relative to workspace)'),
          mapping: z.string().describe('Alignment mapping JSON path (relative to workspace)'),
          source: z.string().describe('Source ULT/UST USFM path (relative to workspace)'),
          output: z.string().optional().describe('Output aligned USFM path (omit to return content)'),
          chapter: z.number().int().optional().describe('Process only this chapter'),
          verse: z.number().int().optional().describe('Process only this verse (requires chapter)'),
          ust: z.boolean().optional().describe('UST mode: brackets outside milestones'),
        },
        async (args) => ({
          content: [{ type: 'text', text: createAlignedUsfm(args) }],
        })
      ),

      // --- Index builders ---
      tool('build_strongs_index', "Build Strong's concordance index from aligned ULT USFM", {
        force: z.boolean().optional(), lookup: z.string().optional().describe("Strong's number to look up"), stats: z.boolean().optional(),
      }, async (args) => ({ content: [{ type: 'text', text: await buildStrongsIndex(args) }] })),
      tool('build_tn_index', 'Build translation notes index from published TN TSV files', {
        force: z.boolean().optional(), lookup: z.string().optional().describe('Keyword to search'), issue: z.string().optional().describe('Issue type to query'), stats: z.boolean().optional(),
      }, async (args) => ({ content: [{ type: 'text', text: await buildTnIndex(args) }] })),
      tool('build_ust_index', 'Build UST concordance index from aligned UST USFM', {
        force: z.boolean().optional(), lookup: z.string().optional(), stats: z.boolean().optional(),
      }, async (args) => ({ content: [{ type: 'text', text: await buildUstIndex(args) }] })),

      // --- Issue identification ---
      tool('check_tw_headwords', 'Check terms against Translation Words headwords index', {
        terms: z.array(z.string()).describe('Terms to check'),
      }, async (args) => ({ content: [{ type: 'text', text: checkTwHeadwords(args) }] })),
      tool('compare_ult_ust', 'Compare ULT and UST verse-by-verse to identify translation differences', {
        ultFile: z.string().describe('ULT USFM path'), ustFile: z.string().describe('UST USFM path'),
        chapter: z.number().int().optional(), format: z.enum(['tsv', 'json']).optional(),
      }, async (args) => ({ content: [{ type: 'text', text: compareUltUst(args) }] })),
      tool('detect_abstract_nouns', 'Detect abstract nouns in alignment data or text', {
        alignmentJson: z.string().optional().describe('Alignment JSON path'), text: z.string().optional().describe('Text to check'),
        format: z.enum(['json', 'tsv']).optional(),
      }, async (args) => ({ content: [{ type: 'text', text: detectAbstractNouns(args) }] })),

      // --- TN writer pipeline ---
      tool('extract_alignment_data', 'Extract word-level alignment data from aligned USFM', {
        alignedUsfm: z.string().describe('Aligned USFM file path'), output: z.string().optional().describe('Output JSON path'),
      }, async (args) => ({ content: [{ type: 'text', text: extractAlignmentData(args) }] })),
      tool('fix_hebrew_quotes', 'Extract Hebrew superscription words for a chapter', {
        book: z.string().describe('Book code'), chapter: z.string().describe('Chapter number'), hebrewUsfm: z.string().optional(),
      }, async (args) => ({ content: [{ type: 'text', text: fixHebrewQuotes(args) }] })),
      tool('flag_narrow_quotes', 'Flag gl_quotes that are too narrow for AT substitution', {
        preparedJson: z.string().describe('Prepared notes JSON path'),
      }, async (args) => ({ content: [{ type: 'text', text: flagNarrowQuotes(args) }] })),
      tool('generate_ids', 'Generate unique 4-char TN IDs avoiding upstream collisions', {
        book: z.string().describe('Book code'), count: z.number().int().describe('Number of IDs'),
      }, async (args) => ({ content: [{ type: 'text', text: await generateIds(args) }] })),
      tool('resolve_gl_quotes', 'Resolve gl_quotes using alignment data to find ULT spans', {
        preparedJson: z.string().describe('Prepared notes JSON path'), alignmentJson: z.string().describe('Alignment data JSON path'),
        dryRun: z.boolean().optional(),
      }, async (args) => ({ content: [{ type: 'text', text: resolveGlQuotes(args) }] })),
      tool('verify_at_fit', 'Verify AT substitutions fit correctly in ULT verses', {
        preparedJson: z.string().describe('Prepared notes JSON'), generatedJson: z.string().describe('Generated notes JSON'),
      }, async (args) => ({ content: [{ type: 'text', text: verifyAtFit(args) }] })),
      tool('assemble_notes', 'Assemble generated notes into final TN TSV format', {
        preparedJson: z.string().describe('Prepared notes JSON'), generatedJson: z.string().describe('Generated notes JSON'),
        output: z.string().describe('Output TSV path'),
      }, async (args) => ({ content: [{ type: 'text', text: assembleNotes(args) }] })),
      tool('prepare_notes', 'Prepare issue TSV into structured JSON for note generation', {
        inputTsv: z.string().describe('Issue TSV path'), ultUsfm: z.string().optional(), ustUsfm: z.string().optional(),
        output: z.string().optional(), alignedUsfm: z.string().optional(), alignmentJson: z.string().optional(),
      }, async (args) => ({ content: [{ type: 'text', text: prepareNotes(args) }] })),

      // --- Quality checks ---
      tool('validate_tn_tsv', 'Validate TN TSV against Door43 CI rules (checks 3-13)', {
        file: z.string().describe('TSV file path'), checks: z.array(z.number()).optional().describe('Check numbers to run'),
        maxErrors: z.number().optional(),
      }, async (args) => ({ content: [{ type: 'text', text: validateTnTsv(args) }] })),
      tool('check_tn_quality', 'Run semantic quality checks on generated translation notes', {
        tsvPath: z.string().describe('Notes TSV path'), preparedJson: z.string().optional(), ultUsfm: z.string().optional(),
        ustUsfm: z.string().optional(), book: z.string().optional(), hebrewUsfm: z.string().optional(), output: z.string().optional(),
      }, async (args) => ({ content: [{ type: 'text', text: checkTnQuality(args) }] })),

      // --- Misc tools ---
      tool('gitea_pr', 'Create (and optionally merge) a PR on Door43 Gitea', {
        repo: z.string().describe('Repo name (en_tn, en_ult, en_ust)'), head: z.string().describe('Source branch'),
        base: z.string().describe('Target branch'), title: z.string().describe('PR title'),
        body: z.string().optional(), merge: z.boolean().optional(), noDelete: z.boolean().optional(), ensureBase: z.boolean().optional(),
      }, async (args) => ({ content: [{ type: 'text', text: await giteaPr(args) }] })),
      tool('prepare_compare', 'Prepare AI vs editor verse-by-verse comparison data', {
        book: z.string().describe('Book code'), chapter: z.number().int().describe('Chapter number'),
        type: z.enum(['ult', 'ust']).optional(),
        verses: z.string().optional().describe('Optional verse scope within chapter, e.g. "1-6" or "1,3,5-7"'),
        editorUsfm: z.string().optional(), output: z.string().optional(),
      }, async (args) => ({ content: [{ type: 'text', text: prepareCompare(args) }] })),
      tool('prepare_tq', 'Prepare translation questions data for a book/chapter', {
        book: z.string().describe('Book code'), chapter: z.number().int().optional(), wholeBook: z.boolean().optional(),
        tqRepo: z.string().optional(), ultPath: z.string().optional(), ustPath: z.string().optional(), output: z.string().optional(),
      }, async (args) => ({ content: [{ type: 'text', text: prepareTq(args) }] })),
      tool('verify_tq', 'Verify translation questions TSV format and content', {
        tsvFile: z.string().describe('TQ TSV file path'), inputJson: z.string().optional(),
      }, async (args) => ({ content: [{ type: 'text', text: verifyTq(args) }] })),
    ],
  });
}

module.exports = { createWorkspaceTools };
