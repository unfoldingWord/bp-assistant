// workspace-tools/index.js — SDK MCP server for workspace tools
//
// Registers all ported workspace scripts as in-process MCP tools.
// Claude calls these as mcp__workspace-tools__<tool_name> — no shell needed.

const {
  fetchHebrewBible, fetchUlt, fetchUst, fetchMasterUlt, fetchMasterUst, fetchT4t, fetchDoor43,
  fetchGlossary, fetchIssuesResolved, fetchTemplates,
} = require('./fetch-tools');
const { splitTsv, mergeTsvs, fixTrailingNewlines } = require('./tsv-tools');
const { extractUltEnglish, filterPsalms, curlyQuotes, checkUstPassives, createAlignedUsfm, repairAlignmentXContent, readUsfmChapter, mergeAlignedUsfm, planAlignmentBatchesTool, validateAlignmentJson, validateUltBrackets, checkUltVoiceMismatch } = require('./usfm-tools');
const { buildStrongsIndex, buildTnIndex, buildUstIndex } = require('./index-tools');
const { checkTwHeadwords, compareUltUst, detectAbstractNouns } = require('./issue-tools');
const { extractAlignmentData, fixHebrewQuotes, flagNarrowQuotes, generateIds, resolveGlQuotes, verifyAtFit, assembleNotes, updateNoteText, updatePreparedQuote, removeNote, prepareNotes, prepareAndValidate, fixUnicodeQuotes, verifyBoldMatches, fillTsvIds, fillOrigQuotes, prepareATContext, readPreparedNotes } = require('./tn-tools');
const { validateTnTsv, checkTnQuality } = require('./quality-tools');
const { giteaPr, prepareCompare, prepareTq, verifyTq, appendQuickref } = require('./misc-tools');
const { validateUsfmStructure, validateAlignmentIntegrityGate, checkDuplicateIdsGate, preflightDataCheck, runRegressionChecks } = require('./validation-tools');

function asTextToolResult(value) {
  if (typeof value === 'string') return { content: [{ type: 'text', text: value }] };
  if (value == null) return { content: [{ type: 'text', text: '' }] };
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

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
        'Fetch published ULT (Literal Text — word-for-word, form-preserving rendering) USFM files from Door43 into data/published_ult/. Use this for the currently published books when you need the literal rendering; use fetch_ust instead for the simplified/meaning-based rendering. For non-published books use fetch_master_ult. The published set is read from the latest release manifest, not a hardcoded list.',
        {
          books: z.array(z.string()).optional().describe('Specific book codes (must be published, or already present in data/published_ult/). Omit for the full published set plus any file already in the directory.'),
          force: z.boolean().optional().describe('Force re-fetch even if cached today'),
        },
        async (args) => ({
          content: [{ type: 'text', text: await fetchUlt(args) }],
        })
      ),
      tool(
        'fetch_ust',
        'Fetch published UST (Simplified Text — meaning-based, natural-English rendering) USFM files from Door43 into data/published_ust/. Use this for the currently published books when you need the simplified rendering; use fetch_ult instead for the literal/word-for-word rendering. For non-published books use fetch_master_ust. The published set is read from the latest release manifest, not a hardcoded list.',
        {
          books: z.array(z.string()).optional().describe('Specific book codes (must be published, or already present in data/published_ust/). Omit for the full published set plus any file already in the directory.'),
          force: z.boolean().optional().describe('Force re-fetch even if cached today'),
        },
        async (args) => ({
          content: [{ type: 'text', text: await fetchUst(args) }],
        })
      ),
      tool(
        'fetch_master_ult',
        'Fetch ULT (Literal Text — word-for-word, form-preserving rendering) from Door43 master branch for working reference on non-published books. Use this for the literal rendering of a non-published book; use fetch_master_ust instead for the simplified rendering. Always fetches fresh. Stores to data/master_ult/ — not authoritative, not indexed.',
        {
          books: z.array(z.string()).describe('Book codes to fetch (e.g. ["ISA", "JER"]). Required.'),
        },
        async (args) => ({
          content: [{ type: 'text', text: await fetchMasterUlt(args) }],
        })
      ),
      tool(
        'fetch_master_ust',
        'Fetch UST (Simplified Text — meaning-based, natural-English rendering) from Door43 master branch for working reference on non-published books. Use this for the simplified rendering of a non-published book; use fetch_master_ult instead for the literal rendering. Always fetches fresh. Stores to data/master_ust/ — not authoritative, not indexed.',
        {
          books: z.array(z.string()).describe('Book codes to fetch (e.g. ["ISA", "JER"]). Required.'),
        },
        async (args) => ({
          content: [{ type: 'text', text: await fetchMasterUst(args) }],
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

      tool(
        'repair_alignment_x_content',
        'Repair x-content byte order in aligned USFM to match UHB verbatim. The AI alignment pipeline may NFC-normalize Hebrew combining marks (e.g. reordering dagesh U+05BC and vowel points), while the UHB stores them in traditional Tanakh order. This tool reads UHB tokens verbatim and patches any x-content values that differ only in combining-mark order. Run after create_aligned_usfm to ensure byte-identical x-content for downstream tools.',
        {
          alignedUsfm: z.string().describe('Aligned USFM file path relative to workspace'),
          hebrewUsfm: z.string().describe('Hebrew UHB source USFM file path relative to workspace'),
        },
        async (args) => ({
          content: [{ type: 'text', text: repairAlignmentXContent(args) }],
        })
      ),

      tool(
        'read_usfm_chapter',
        'Read a single chapter from a book-level USFM file (returns header + chapter content, much smaller than the full file). Supports verse-range filtering and alignment stripping.',
        {
          file: z.string().describe('USFM file path relative to workspace (e.g. data/t4t/25-LAM.usfm)'),
          chapter: z.number().int().describe('Chapter number to extract'),
          verseStart: z.number().int().optional().describe('Start verse for range filtering (inclusive)'),
          verseEnd: z.number().int().optional().describe('End verse for range filtering (inclusive)'),
          plain: z.boolean().optional().describe('Strip alignment markers (\\zaln, \\w) to return plain readable USFM'),
        },
        async (args) => ({
          content: [{ type: 'text', text: readUsfmChapter(args) }],
        })
      ),

      tool(
        'merge_aligned_usfm',
        'Merge N partial aligned USFM files (from verse-range batches) into a single full-chapter file. Use after split-batch alignment to assemble the final output.',
        {
          parts: z.array(z.string()).describe('Ordered array of partial USFM paths relative to workspace (e.g. ["output/AI-UST/LAM/LAM-04-v01-v11-aligned.usfm", "output/AI-UST/LAM/LAM-04-v12-v22-aligned.usfm"])'),
          output: z.string().describe('Output path for merged file relative to workspace (e.g. output/AI-UST/LAM/LAM-04-aligned.usfm)'),
        },
        async (args) => ({
          content: [{ type: 'text', text: mergeAlignedUsfm(args) }],
        })
      ),

      tool(
        'plan_alignment_batches',
        'Deterministically compute the batch verse-ranges for align-all-parallel (contiguous, non-overlapping, last batch always reaches the final verse). Use instead of computing batch boundaries by hand — prevents dropping the chapter tail on long chapters (see #233).',
        {
          verseCount: z.number().int().optional().describe('Number of verses in the chapter. Provide this OR file+chapter.'),
          file: z.string().optional().describe('USFM file path relative to workspace to count \\v markers from (e.g. data/hebrew_bible/26-EZK.usfm)'),
          chapter: z.number().int().optional().describe('Chapter number (required when using file to count verses)'),
          book: z.string().optional().describe('Book code, for labeling the returned plan (e.g. EZK)'),
          maxBatchSize: z.number().int().optional().describe('Maximum verses per batch (default 18)'),
        },
        async (args) => ({
          content: [{ type: 'text', text: JSON.stringify(planAlignmentBatchesTool(args), null, 2) }],
        })
      ),

      tool(
        'validate_alignment_json',
        'Validate alignment JSON files for ULT/UST-alignment workflow completeness. Checks required fields, sequential Hebrew indices, coverage of all Hebrew words, bracketing rules, and that every English word appears exactly once.',
        {
          files: z.array(z.string()).describe('Array of alignment JSON file paths relative to workspace'),
          ust: z.boolean().optional().describe('UST mode: unaligned Hebrew indices are allowed; entries with empty hebrew_indices must have bracketed words'),
        },
        async (args) => ({
          content: [{ type: 'text', text: validateAlignmentJson(args) }],
        })
      ),

      tool(
        'validate_ult_brackets',
        'Cross-reference {bracketed} words in aligned ULT against Hebrew prefix Strong\'s numbers. Flags words that are bracketed (implied) but actually come from a Hebrew prefix (b:=in, d:=the, c:=and, etc.) — these should not be bracketed.',
        {
          alignedUsfm: z.string().describe('Aligned ULT USFM file path relative to workspace'),
        },
        async (args) => ({
          content: [{ type: 'text', text: validateUltBrackets(args) }],
        })
      ),

      tool(
        'check_ult_voice_mismatch',
        'Detect English passive voice constructions aligned to active Hebrew verb stems (Qal, Piel, Hiphil). Active Hebrew rendered with English passive (be + past participle) is likely a translation error.',
        {
          alignedUsfm: z.string().describe('Aligned ULT USFM file path relative to workspace'),
        },
        async (args) => ({
          content: [{ type: 'text', text: checkUltVoiceMismatch(args) }],
        })
      ),

      // --- Index builders ---
      tool('build_strongs_index', "Build Strong's concordance index from aligned ULT USFM. Use this (not build_ust_index) for ULT/Hebrew word-lookup by Strong's number.", {
        force: z.boolean().optional().describe('Rebuild even if the cached index was already built today'),
        lookup: z.string().optional().describe("Strong's number to look up"),
        stats: z.boolean().optional().describe('Return index build metadata (built date, file/alignment/Strong\'s counts) from the existing cache; if no cache exists yet the index is built first'),
      }, async (args) => ({ content: [{ type: 'text', text: await buildStrongsIndex(args) }] })),
      tool('build_tn_index', 'Build translation notes index from published TN TSV files', {
        force: z.boolean().optional().describe('Rebuild even if the cached index was already built today'),
        lookup: z.string().optional().describe('Keyword to search'),
        issue: z.string().optional().describe('Issue type to query'),
        stats: z.boolean().optional().describe('Return index build metadata (built date, file/note/issue/keyword counts) from the existing cache; if no cache exists yet the index is built first'),
      }, async (args) => ({ content: [{ type: 'text', text: await buildTnIndex(args) }] })),
      tool('build_ust_index', 'Build UST concordance index from aligned UST USFM. Use this (not build_strongs_index) for UST word-lookup by Strong\'s number.', {
        force: z.boolean().optional().describe('Rebuild even if the cached index was already built today'),
        lookup: z.string().optional().describe("Strong's number to look up"),
        stats: z.boolean().optional().describe('Return index build metadata (built date, file/alignment/Strong\'s counts) from the existing cache; if no cache exists yet the index is built first'),
      }, async (args) => ({ content: [{ type: 'text', text: await buildUstIndex(args) }] })),

      // --- Issue identification ---
      tool('check_tw_headwords', 'Check terms against Translation Words headwords index', {
        terms: z.array(z.string()).describe('Terms to check'),
      }, async (args) => ({ content: [{ type: 'text', text: checkTwHeadwords(args) }] })),
      tool('compare_ult_ust', 'Compare ULT and UST verse-by-verse to identify translation differences', {
        ultFile: z.string().describe('ULT USFM path'), ustFile: z.string().describe('UST USFM path'),
        chapter: z.number().int().optional().describe('Restrict comparison to this chapter number, e.g. 3; omit to compare the whole book'),
        format: z.enum(['tsv', 'json']).optional(),
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
        book: z.string().describe('Book code'), chapter: z.string().describe('Chapter number'),
        hebrewUsfm: z.string().optional().describe('Hebrew USFM path relative to workspace (auto-detected from data/hebrew_bible/ by book code if omitted)'),
        output: z.string().optional().describe('Output JSON path. Omit to return content.'),
      }, async (args) => ({ content: [{ type: 'text', text: fixHebrewQuotes(args) }] })),
      tool('flag_narrow_quotes', 'Flag gl_quotes that are too narrow for AT substitution', {
        preparedJson: z.string().describe('Prepared notes JSON path'),
      }, async (args) => ({ content: [{ type: 'text', text: flagNarrowQuotes(args) }] })),
      tool('generate_ids', 'Generate unique 4-char TN IDs avoiding upstream collisions', {
        book: z.string().describe('Book code'), count: z.number().int().describe('Number of IDs'),
      }, async (args) => ({ content: [{ type: 'text', text: await generateIds(args) }] })),
      tool('resolve_gl_quotes', 'Resolve gl_quotes using alignment data to find ULT spans', {
        preparedJson: z.string().describe('Prepared notes JSON path'), alignmentJson: z.string().describe('Alignment data JSON path'),
        dryRun: z.boolean().optional().describe('Compute and log the resolved spans without writing them back into prepared_notes.json'),
      }, async (args) => ({ content: [{ type: 'text', text: resolveGlQuotes(args) }] })),
      tool('verify_at_fit', 'Verify AT substitutions fit correctly in ULT verses', {
        preparedJson: z.string().describe('Prepared notes JSON'), generatedJson: z.string().describe('Generated notes JSON'),
      }, async (args) => ({ content: [{ type: 'text', text: verifyAtFit(args) }] })),
      tool('assemble_notes', 'Assemble generated notes into final TN TSV format', {
        preparedJson: z.string().describe('Prepared notes JSON'), generatedJson: z.string().describe('Generated notes JSON'),
        output: z.string().describe('Output TSV path'),
      }, async (args) => ({ content: [{ type: 'text', text: assembleNotes(args) }] })),
      tool('fill_tsv_ids', 'Fill empty ID columns in an assembled TN TSV with unique generated IDs (for post-merge ID assignment)', {
        tsvFile: z.string().describe('TN TSV file path'),
        book: z.string().optional().describe('Book code (auto-detected from filename if omitted)'),
      }, async (args) => ({ content: [{ type: 'text', text: await fillTsvIds(args) }] })),
      tool('fill_orig_quotes', 'Fill empty orig_quote fields in prepared_notes.json using alignment data. Handles &-separated gl_quotes, uses content-word fallback matching, and falls back to Door43 master ULT alignment markers when AI alignment misses. Updates prepared_notes.json in place.', {
        preparedJson: z.string().describe('Prepared notes JSON path (relative to workspace)'),
        alignmentJson: z.string().describe('Alignment data JSON path (relative to workspace)'),
        hebrewUsfm: z.string().optional().describe('Hebrew USFM path (auto-detected from book code if omitted)'),
        masterUltUsfm: z.string().optional().describe('Master ULT USFM with \\zaln-s alignment markers (auto-detected from door43-repos/en_ult/ if omitted)'),
      }, async (args) => ({ content: [{ type: 'text', text: fillOrigQuotes(args) }] })),
      tool('prepare_notes', 'Prepare issue TSV into structured JSON for note generation', {
        inputTsv: z.string().describe('Issue TSV path'),
        ultUsfm: z.string().optional().describe('ULT USFM path relative to workspace, used to look up each item\'s verse text'),
        ustUsfm: z.string().optional().describe('UST USFM path relative to workspace, used to look up each item\'s verse text'),
        output: z.string().optional().describe('Output path for prepared_notes.json relative to workspace (default: /tmp/claude/prepared_notes.json)'),
        alignedUsfm: z.string().optional().describe('Aligned USFM path relative to workspace; accepted for signature parity with prepare_and_validate but not read directly by this tool'),
        alignmentJson: z.string().optional().describe('Alignment data JSON path relative to workspace, used to filter alignment entries down to the target verses'),
      }, async (args) => ({ content: [{ type: 'text', text: prepareNotes(args) }] })),

      tool('prepare_and_validate', 'Combo: prepare notes + extract alignment + resolve gl_quotes + flag narrow quotes + verify AT fit in one call', {
        inputTsv: z.string().describe('Issue TSV path'),
        ultUsfm: z.string().optional().describe('ULT USFM path relative to workspace, used to look up each item\'s verse text'),
        ustUsfm: z.string().optional().describe('UST USFM path relative to workspace, used to look up each item\'s verse text'),
        alignedUsfm: z.string().optional().describe('Aligned USFM path relative to workspace; when given, alignment data is extracted and gl_quotes are resolved against it'),
        output: z.string().optional().describe('Output path for prepared JSON'),
      }, async (args) => ({ content: [{ type: 'text', text: prepareAndValidate(args) }] })),
      tool('fix_unicode_quotes', 'Fix Hebrew quote Unicode to exactly match UHB source byte order (post-assembly)', {
        tsvFile: z.string().describe('TN TSV file path'),
        hebrewUsfm: z.string().optional().describe('Hebrew USFM path (auto-detected from book code if omitted)'),
        output: z.string().optional().describe('Output path (defaults to in-place overwrite)'),
      }, async (args) => ({ content: [{ type: 'text', text: fixUnicodeQuotes(args) }] })),
      tool('verify_bold_matches', 'Strip invalid bold markers and restore safe opening bold text when it can be derived from prepared note metadata and the ULT (post-assembly)', {
        tsvFile: z.string().describe('TN TSV file path'),
        ultUsfm: z.string().describe('Plain ULT USFM file path for verse text lookup'),
        preparedJson: z.string().optional().describe('Prepared notes JSON path for safe opening-bold repair'),
        output: z.string().optional().describe('Output path (defaults to in-place overwrite)'),
      }, async (args) => ({ content: [{ type: 'text', text: verifyBoldMatches(args) }] })),

      // --- AT generation support ---
      tool('prepare_at_context', 'Build AT writer context packets for items needing alternate translation generation', {
        preparedJson: z.string().describe('Prepared notes JSON path (relative to workspace)'),
        generatedJson: z.string().optional().describe('Generated notes JSON path (relative to workspace)'),
        output: z.string().optional().describe('Output path for AT context JSON (relative to workspace)'),
      }, async (args) => ({ content: [{ type: 'text', text: prepareATContext(args) }] })),
      tool('read_prepared_notes', 'Read a bounded slice of prepared_notes.json items. Use this instead of the raw Read tool to avoid the 10K-token file-read limit. Call with summaryOnly:true first to get total count and IDs, then fetch items in batches of ≤20.', {
        preparedJson: z.string().describe('Prepared notes JSON path (relative to workspace)'),
        start: z.number().int().optional().describe('First item index (0-based, inclusive). Default: 0'),
        end: z.number().int().optional().describe('Last item index (inclusive). Default: start+19'),
        summaryOnly: z.boolean().optional().describe('Return only total count and item IDs — no bodies'),
      }, async (args) => ({ content: [{ type: 'text', text: readPreparedNotes(args) }] })),

      // --- Quality checks ---
      tool('validate_tn_tsv', 'Validate TN TSV against Door43 CI rules (checks 3-13)', {
        file: z.string().describe('TSV file path'), checks: z.array(z.number()).optional().describe('Check numbers to run'),
        maxErrors: z.number().optional().describe('Stop collecting errors once this many are found, e.g. 200 (default: 200)'),
      }, async (args) => ({ content: [{ type: 'text', text: validateTnTsv(args) }] })),
      tool('check_tn_quality', 'Run semantic quality checks on generated translation notes', {
        tsvPath: z.string().describe('Notes TSV path'),
        preparedJson: z.string().optional().describe('Prepared notes JSON path relative to workspace, used to cross-reference each note against its source item'),
        ultUsfm: z.string().optional().describe('ULT USFM path relative to workspace, used to look up verse text for the checks'),
        ustUsfm: z.string().optional().describe('UST USFM path relative to workspace, used to look up verse text for the checks'),
        book: z.string().optional().describe('Book code, e.g. "HAB"; when given, upstream published TN IDs are fetched to check for ID collisions, and book-specific style checks apply (e.g. "the psalmist" for PSA)'),
        hebrewUsfm: z.string().optional().describe('Hebrew USFM path relative to workspace, used for the Hebrew-word cross-check'),
        output: z.string().optional().describe('Output path for findings JSON relative to workspace (default: /tmp/claude/tn_quality_findings.json)'),
      }, async (args) => asTextToolResult(await checkTnQuality(args))),

      // --- Misc tools ---
      tool('gitea_pr', 'Create (and optionally merge) a PR on Door43 Gitea', {
        repo: z.string().describe('Repo name (en_tn, en_ult, en_ust)'), head: z.string().describe('Source branch'),
        base: z.string().describe('Target branch'), title: z.string().describe('PR title'),
        body: z.string().optional().describe('PR description body (default: empty)'),
        merge: z.boolean().optional().describe('Merge the PR immediately after creating (or finding) it'),
        noDelete: z.boolean().optional().describe('Keep the head branch after a successful merge instead of deleting it (only applies when merge is true)'),
        ensureBase: z.boolean().optional().describe('Create the base branch from master first if it does not already exist'),
      }, async (args) => ({ content: [{ type: 'text', text: await giteaPr(args) }] })),
      tool('prepare_compare', 'Prepare AI vs editor verse-by-verse comparison data', {
        book: z.string().describe('Book code'), chapter: z.number().int().describe('Chapter number'),
        type: z.enum(['ult', 'ust']).optional(),
        verses: z.string().optional().describe('Optional verse scope within chapter, e.g. "1-6" or "1,3,5-7"'),
        editorUsfm: z.string().optional().describe('Editor-edited USFM path relative to workspace, compared verse-by-verse against the AI output'),
        output: z.string().optional().describe('Output path for comparison JSON relative to workspace. Omit to return content.'),
      }, async (args) => ({ content: [{ type: 'text', text: prepareCompare(args) }] })),
      tool('prepare_tq', 'Prepare translation questions data for a book/chapter', {
        book: z.string().describe('Book code'),
        chapter: z.number().int().optional().describe('Chapter number to scope the prepared data to. Omit for all chapters (whole book).'),
        wholeBook: z.boolean().optional().describe('Accepted for backward compatibility but not read: whole-book scope is selected by omitting chapter'),
        tqRepo: z.string().optional().describe('Directory containing published TQ TSVs (default: data/published-tqs)'),
        ultPath: z.string().optional().describe('Override ULT USFM path relative to workspace instead of fetching current Door43 master'),
        ustPath: z.string().optional().describe('Override UST USFM path relative to workspace instead of fetching current Door43 master'),
        output: z.string().optional().describe('Output path for prepared_tq.json relative to workspace (default: /tmp/claude/prepared_tq.json)'),
      }, async (args) => ({ content: [{ type: 'text', text: await prepareTq(args) }] })),
      tool('verify_tq', 'Verify translation questions TSV format and content', {
        tsvFile: z.string().describe('TQ TSV file path'),
        inputJson: z.string().optional().describe('prepared_tq.json path relative to workspace, used to check the output row count against the expected row count'),
      }, async (args) => ({ content: [{ type: 'text', text: verifyTq(args) }] })),

      // --- Quick-ref tools ---
      tool('append_quickref', 'Append a vocabulary decision to a quick-ref CSV (deduplicates by Strong number)', {
        file: z.enum(['ult_decisions', 'ust_decisions']).describe('Which quick-ref file'),
        strong: z.string().describe('Strong number (e.g. H4869)'),
        hebrew: z.string().describe('Hebrew word'),
        rendering: z.string().describe('English rendering chosen'),
        book: z.string().optional().describe('Book scope — default ALL'),
        context: z.string().optional().describe('Verse context for the decision'),
        notes: z.string().optional().describe('Rationale for the decision'),
        source: z.enum(['AI', 'human']).optional().describe('Who made this decision — default AI'),
      }, async (args) => ({ content: [{ type: 'text', text: appendQuickref(args) }] })),
    ],
  });
}

/**
 * Per-skill tool sets — register only the tools needed for each skill.
 * Reduces schema overhead from 36+ tools to 5-12 per skill run.
 */
function createTnWriterTools(createSdkMcpServer, tool, z) {
  return createSdkMcpServer({
    name: 'workspace-tools',
    version: '1.0.0',
    tools: [
      tool('prepare_notes', 'Prepare issue TSV into structured JSON for note generation', {
        inputTsv: z.string().describe('Issue TSV path'), ultUsfm: z.string().optional(), ustUsfm: z.string().optional(),
        output: z.string().optional(), alignedUsfm: z.string().optional(), alignmentJson: z.string().optional(),
      }, async (args) => ({ content: [{ type: 'text', text: prepareNotes(args) }] })),
      tool('prepare_and_validate', 'Combo: prepare notes + extract alignment + resolve gl_quotes + flag narrow + verify AT fit', {
        inputTsv: z.string().describe('Issue TSV path'), ultUsfm: z.string().optional(), ustUsfm: z.string().optional(),
        alignedUsfm: z.string().optional(), output: z.string().optional(),
      }, async (args) => ({ content: [{ type: 'text', text: prepareAndValidate(args) }] })),
      tool('extract_alignment_data', 'Extract word-level alignment data from aligned USFM', {
        alignedUsfm: z.string().describe('Aligned USFM file path'), output: z.string().optional(),
      }, async (args) => ({ content: [{ type: 'text', text: extractAlignmentData(args) }] })),
      tool('fix_hebrew_quotes', 'Extract Hebrew superscription words for a chapter', {
        book: z.string(), chapter: z.string(), hebrewUsfm: z.string().optional(),
        output: z.string().optional(),
      }, async (args) => ({ content: [{ type: 'text', text: fixHebrewQuotes(args) }] })),
      tool('resolve_gl_quotes', 'Resolve gl_quotes using alignment data', {
        preparedJson: z.string(), alignmentJson: z.string(), dryRun: z.boolean().optional(),
      }, async (args) => ({ content: [{ type: 'text', text: resolveGlQuotes(args) }] })),
      tool('flag_narrow_quotes', 'Flag gl_quotes too narrow for AT substitution', {
        preparedJson: z.string(),
      }, async (args) => ({ content: [{ type: 'text', text: flagNarrowQuotes(args) }] })),
      tool('verify_at_fit', 'Verify AT substitutions fit in ULT verses', {
        preparedJson: z.string(), generatedJson: z.string(),
      }, async (args) => ({ content: [{ type: 'text', text: verifyAtFit(args) }] })),
      tool('generate_ids', 'Generate unique 4-char TN IDs', {
        book: z.string(), count: z.number().int(),
      }, async (args) => ({ content: [{ type: 'text', text: await generateIds(args) }] })),
      tool('assemble_notes', 'Assemble notes into final TN TSV', {
        preparedJson: z.string(), generatedJson: z.string(), output: z.string(),
      }, async (args) => ({ content: [{ type: 'text', text: assembleNotes(args) }] })),
      tool('curly_quotes', 'Convert straight quotes to curly quotes', {
        input: z.string(), output: z.string().optional(), inPlace: z.boolean().optional(),
      }, async (args) => ({ content: [{ type: 'text', text: curlyQuotes(args) }] })),
      tool('fix_unicode_quotes', 'Fix Hebrew quote Unicode to exactly match UHB source byte order (post-assembly)', {
        tsvFile: z.string().describe('TN TSV file path'),
        hebrewUsfm: z.string().optional().describe('Hebrew USFM path (auto-detected from book code if omitted)'),
        output: z.string().optional().describe('Output path (defaults to in-place overwrite)'),
      }, async (args) => ({ content: [{ type: 'text', text: fixUnicodeQuotes(args) }] })),
      tool('verify_bold_matches', 'Strip invalid bold markers and restore safe opening bold text when it can be derived from prepared note metadata and the ULT (post-assembly)', {
        tsvFile: z.string().describe('TN TSV file path'),
        ultUsfm: z.string().describe('Plain ULT USFM file path for verse text lookup'),
        preparedJson: z.string().optional().describe('Prepared notes JSON path for safe opening-bold repair'),
        output: z.string().optional().describe('Output path (defaults to in-place overwrite)'),
      }, async (args) => ({ content: [{ type: 'text', text: verifyBoldMatches(args) }] })),
      tool('read_prepared_notes', 'Read a bounded slice of prepared_notes.json items. Use this instead of the raw Read tool to avoid the 10K-token file-read limit. Call with summaryOnly:true first to get total count and IDs, then fetch items in batches of ≤20.', {
        preparedJson: z.string().describe('Prepared notes JSON path (relative to workspace)'),
        start: z.number().int().optional().describe('First item index (0-based, inclusive). Default: 0'),
        end: z.number().int().optional().describe('Last item index (inclusive). Default: start+19'),
        summaryOnly: z.boolean().optional().describe('Return only total count and item IDs — no bodies'),
      }, async (args) => ({ content: [{ type: 'text', text: readPreparedNotes(args) }] })),

      // --- Validation gates (logic lives in bp-assistant-skills; see validation-tools.js) ---
      tool('validate_usfm_structure', 'Structural gate for generated USFM: verse completeness (vs Hebrew source when given), duplicate/out-of-order verses, marker balance, empty verses, balanced {braces}. First line of result starts OK:/FAIL:.', {
        usfm: z.string().describe('Generated USFM path (relative to workspace)'),
        source: z.string().optional().describe('Reference USFM (e.g. Hebrew source) whose verse set must match'),
        chapter: z.number().int().optional().describe('Validate only this chapter'),
      }, async (args) => ({ content: [{ type: 'text', text: await validateUsfmStructure(args) }] })),
      tool('validate_alignment_integrity', 'Field-level gate for aligned USFM: byte-exact x-content/x-lemma vs Hebrew source (flags visually-identical Unicode drift), occurrence numbering, Hebrew coverage (ULT mode). Run after create_aligned_usfm/repair. First line starts OK:/FAIL:.', {
        aligned: z.string().describe('Aligned USFM path (relative to workspace)'),
        hebrew: z.string().describe('Hebrew source USFM path (relative to workspace)'),
        chapter: z.number().int().optional().describe('Validate only this chapter'),
        ust: z.boolean().optional().describe('UST mode: unaligned Hebrew words are allowed'),
      }, async (args) => ({ content: [{ type: 'text', text: await validateAlignmentIntegrityGate(args) }] })),
      tool('check_duplicate_ids', 'ID gate for TN/TQ TSVs: format [a-z][a-z0-9]{3}, uniqueness within and across files, optional collision check vs a published book TSV. First line starts OK:/FAIL:.', {
        files: z.array(z.string()).describe('TSV file paths to check together (relative to workspace)'),
        against: z.array(z.string()).optional().describe('Published TSVs to check collisions against'),
      }, async (args) => ({ content: [{ type: 'text', text: await checkDuplicateIdsGate(args) }] })),
      tool('preflight_data_check', 'Loud check that required reference data exists before generation (issues_resolved, glossaries, Hebrew source, T4T, Strong\'s index). First line starts OK:/FAIL: — do not generate on FAIL.', {
        book: z.string().describe('Book code (e.g. NAM)'),
        stage: z.enum(['ult', 'ust', 'tn', 'all']).optional().describe('Which stage\'s requirements to check (default all)'),
      }, async (args) => ({ content: [{ type: 'text', text: await preflightDataCheck(args) }] })),
      tool('run_regression_checks', 'Re-test every mechanizable closed quality bug against a generated file (checks live in the skills repo). FAIL means a previously fixed mistake has returned. First line starts OK:/FAIL:.', {
        stage: z.enum(['ULT', 'UST', 'TN', 'TQ', 'alignment']).describe('Content stage of the file'),
        file: z.string().describe('Generated file path (relative to workspace)'),
        book: z.string().optional().describe('Book code (enables book-scoped checks)'),
        chapter: z.number().int().optional().describe('Chapter number (scopes chapter-pinned checks)'),
      }, async (args) => ({ content: [{ type: 'text', text: await runRegressionChecks(args) }] })),
    ],
  });
}

function createQualityTools(createSdkMcpServer, tool, z) {
  return createSdkMcpServer({
    name: 'workspace-tools',
    version: '1.0.0',
    tools: [
      tool('check_tn_quality', 'Run semantic quality checks on generated translation notes', {
        tsvPath: z.string(), preparedJson: z.string().optional(), ultUsfm: z.string().optional(),
        ustUsfm: z.string().optional(), book: z.string().optional(), hebrewUsfm: z.string().optional(), output: z.string().optional(),
      }, async (args) => asTextToolResult(await checkTnQuality(args))),
      tool('validate_tn_tsv', 'Validate TN TSV against Door43 CI rules', {
        file: z.string(), checks: z.array(z.number()).optional(), maxErrors: z.number().optional(),
      }, async (args) => ({ content: [{ type: 'text', text: validateTnTsv(args) }] })),
      tool('fix_trailing_newlines', 'Fix trailing \\n in TSV Note column', {
        file: z.string(),
      }, async (args) => ({ content: [{ type: 'text', text: fixTrailingNewlines(args) }] })),
      tool('assemble_notes', 'Assemble notes into final TN TSV', {
        preparedJson: z.string(), generatedJson: z.string(), output: z.string(),
      }, async (args) => ({ content: [{ type: 'text', text: assembleNotes(args) }] })),
      tool('curly_quotes', 'Convert straight quotes to curly quotes', {
        input: z.string(), output: z.string().optional(), inPlace: z.boolean().optional(),
      }, async (args) => ({ content: [{ type: 'text', text: curlyQuotes(args) }] })),
      tool('update_note_text', 'Set the note text for one generated note by id (in generated_notes.json). Use this instead of hand-editing the JSON. After updating, re-run assemble_notes + curly_quotes.', {
        generatedJson: z.string().describe('Path to generated_notes.json (runtime.generatedNotes)'),
        id: z.string().describe('The note id to update'),
        note: z.string().describe('The full replacement note text'),
      }, async (args) => ({ content: [{ type: 'text', text: updateNoteText(args) }] })),
      tool('update_prepared_quote', 'Set quote or support-reference fields for one prepared note by id (in prepared_notes.json). Only the provided fields are changed. After updating, re-run assemble_notes + curly_quotes.', {
        preparedJson: z.string().describe('Path to prepared_notes.json (runtime.preparedNotes)'),
        id: z.string().describe('The prepared item id to update'),
        glQuote: z.string().optional().describe('New gl_quote'),
        glQuoteRoundtripped: z.string().optional().describe('New gl_quote_roundtripped'),
        origQuote: z.string().optional().describe('New orig_quote'),
        sref: z.string().optional().describe('New support reference issue type — a valid slug from data/translation-issues.csv (e.g. writing-poetry). The rc:// prefix is stripped if present.'),
      }, async (args) => ({ content: [{ type: 'text', text: updatePreparedQuote(args) }] })),
      tool('remove_note', 'Remove one note by id from generated_notes.json and/or directly from an assembled TSV row. Use for antithetical-parallelism or redundant notes.', {
        id: z.string().describe('The note id to remove'),
        generatedJson: z.string().optional().describe('Path to generated_notes.json (runtime.generatedNotes)'),
        tsvFile: z.string().optional().describe('Path to the assembled TN TSV (removes the row whose ID column matches)'),
      }, async (args) => ({ content: [{ type: 'text', text: removeNote(args) }] })),
      tool('check_duplicate_ids', 'ID gate for TN/TQ TSVs: format, uniqueness within/across files, optional collision vs published. First line starts OK:/FAIL:.', {
        files: z.array(z.string()), against: z.array(z.string()).optional(),
      }, async (args) => ({ content: [{ type: 'text', text: await checkDuplicateIdsGate(args) }] })),
      tool('run_regression_checks', 'Re-test mechanizable closed quality bugs against a generated file. FAIL = a fixed mistake returned. First line starts OK:/FAIL:.', {
        stage: z.enum(['ULT', 'UST', 'TN', 'TQ', 'alignment']), file: z.string(),
        book: z.string().optional(), chapter: z.number().int().optional(),
      }, async (args) => ({ content: [{ type: 'text', text: await runRegressionChecks(args) }] })),
    ],
  });
}

function createIssueIdTools(createSdkMcpServer, tool, z) {
  return createSdkMcpServer({
    name: 'workspace-tools',
    version: '1.0.0',
    tools: [
      tool('check_tw_headwords', 'Check terms against Translation Words headwords index', {
        terms: z.array(z.string()),
      }, async (args) => ({ content: [{ type: 'text', text: checkTwHeadwords(args) }] })),
      tool('compare_ult_ust', 'Compare ULT and UST verse-by-verse', {
        ultFile: z.string(), ustFile: z.string(), chapter: z.number().int().optional(), format: z.enum(['tsv', 'json']).optional(),
      }, async (args) => ({ content: [{ type: 'text', text: compareUltUst(args) }] })),
      tool('detect_abstract_nouns', 'Detect abstract nouns in text', {
        alignmentJson: z.string().optional(), text: z.string().optional(), format: z.enum(['json', 'tsv']).optional(),
      }, async (args) => ({ content: [{ type: 'text', text: detectAbstractNouns(args) }] })),
      tool('fetch_door43', 'Fetch a single USFM file from Door43', {
        book: z.string(), repo: z.string().optional(), branch: z.string().optional(),
        user: z.string().optional(), output: z.string().optional(),
      }, async (args) => ({ content: [{ type: 'text', text: await fetchDoor43(args) }] })),
      tool('fetch_glossary', 'Fetch glossary CSV sheets', {
        sheets: z.array(z.string()).optional(), force: z.boolean().optional(),
      }, async (args) => ({ content: [{ type: 'text', text: await fetchGlossary(args) }] })),
      tool('fetch_issues_resolved', 'Fetch Issues Resolved document', {
        force: z.boolean().optional(),
      }, async (args) => ({ content: [{ type: 'text', text: await fetchIssuesResolved(args) }] })),
      tool('build_tn_index', 'Build translation notes index from published TN TSV files', {
        force: z.boolean().optional(), lookup: z.string().optional().describe('Keyword to search'), issue: z.string().optional().describe('Issue type to query'), stats: z.boolean().optional(),
      }, async (args) => ({ content: [{ type: 'text', text: await buildTnIndex(args) }] })),
    ],
  });
}

module.exports = { createWorkspaceTools, createTnWriterTools, createQualityTools, createIssueIdTools };
