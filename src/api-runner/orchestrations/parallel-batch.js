// orchestrations/parallel-batch.js — Chunk long chapters → parallel tn-writer → merge

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function parsePrompt(prompt) {
  const match = prompt.match(/^(\w{2,3})\s+(\d+)/i);
  if (!match) throw new Error(`Cannot parse book/chapter from prompt: "${prompt}"`);
  const book = match[1].toUpperCase();
  const chapter = parseInt(match[2], 10);
  const ch = book === 'PSA'
    ? String(chapter).padStart(3, '0')
    : String(chapter).padStart(2, '0');
  return { book, chapter, ch };
}

/**
 * @param {{ runSkill: Function, runCustom: Function }} runner
 * @param {{ prompt: string, opts: Object }} params
 */
module.exports = async function parallelBatch(runner, { prompt, opts }) {
  const { book, chapter, ch } = parsePrompt(prompt);
  const cwd = opts.cwd || '/srv/bot/workspace';
  const steps = [];

  console.log(`[parallel-batch] Starting for ${book} ${chapter}`);

  const issuesPath = path.join(cwd, 'output', 'issues', book, `${book}-${ch}.tsv`);
  if (!fs.existsSync(issuesPath)) {
    throw new Error(`Issues TSV not found: ${issuesPath}. Run issue-identification first.`);
  }

  // --- Step 1: Split TSV into chunks ---
  console.log(`[parallel-batch] Splitting issues TSV into chunks`);

  const splitScript = path.join(cwd, '.claude', 'skills', 'parallel-batch', 'scripts', 'split_tsv.py');
  const chunkDir = path.join(cwd, 'tmp', `batch-${book}-${ch}`);
  fs.mkdirSync(chunkDir, { recursive: true });

  try {
    execSync(
      `python3 ${splitScript} ${issuesPath} --output-dir ${chunkDir}`,
      { cwd, encoding: 'utf8', timeout: 30000 }
    );
  } catch (err) {
    throw new Error(`split_tsv.py failed: ${err.stderr || err.message}`);
  }

  // Find chunk files
  const chunkFiles = fs.readdirSync(chunkDir)
    .filter(f => f.endsWith('.tsv'))
    .sort();

  if (chunkFiles.length === 0) {
    throw new Error(`No chunk files produced in ${chunkDir}`);
  }

  console.log(`[parallel-batch] ${chunkFiles.length} chunks: ${chunkFiles.join(', ')}`);

  // --- Step 2: Run tn-writer on each chunk in parallel ---
  console.log(`[parallel-batch] Running tn-writer on ${chunkFiles.length} chunks in parallel`);

  const chunkPromises = chunkFiles.map(chunkFile => {
    // Extract verse range from filename (e.g., PSA-119-v1-24.tsv)
    const rangeMatch = chunkFile.match(/v(\d+)-(\d+)/);
    const rangeStr = rangeMatch ? `${rangeMatch[1]}-${rangeMatch[2]}` : '';

    return runner.runSkill('tn-writer', `${book} ${chapter}${rangeStr ? ':' + rangeStr : ''}`, {
      ...opts,
      systemAppend: `Process only the issues in: ${path.join(chunkDir, chunkFile)}\nWrite output to: ${path.join(chunkDir, chunkFile.replace('.tsv', '-notes.tsv'))}`,
    });
  });

  const chunkResults = await Promise.all(chunkPromises);
  chunkResults.forEach((r, i) => steps.push({ name: `chunk-${i}`, ...r }));

  // --- Step 3: Merge chunk outputs ---
  console.log(`[parallel-batch] Merging chunk outputs`);

  const mergeScript = path.join(cwd, '.claude', 'skills', 'parallel-batch', 'scripts', 'merge_tsvs.py');
  const outputPath = path.join(cwd, 'output', 'notes', book, `${book}-${ch}.tsv`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  try {
    execSync(
      `python3 ${mergeScript} ${chunkDir}/*-notes.tsv --output ${outputPath}`,
      { cwd, encoding: 'utf8', timeout: 30000 }
    );
  } catch (err) {
    throw new Error(`merge_tsvs.py failed: ${err.stderr || err.message}`);
  }

  console.log(`[parallel-batch] Complete — output: ${outputPath}`);

  return { steps };
};
