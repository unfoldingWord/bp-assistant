// orchestrations/makeBP.js — Full book package: 4 phases with dependency graph
// Phase 1: initial-pipeline → ULT + issues + UST
// Phase 2: chapter-intro + tq-writer + ULT-alignment + UST-alignment (parallel)
// Phase 3: tn-writer (needs intro + alignments)
// Phase 4: 4x repo-insert (parallel)

const fs = require('fs');
const path = require('path');

const initialPipeline = require('./initial-pipeline');

function parsePrompt(prompt) {
  // "PSA 133" or "PSA 133 deferredreward"
  const match = prompt.match(/^(\w{2,3})\s+(\d+)(?:\s+(\S+))?/i);
  if (!match) throw new Error(`Cannot parse book/chapter from prompt: "${prompt}"`);
  const book = match[1].toUpperCase();
  const chapter = parseInt(match[2], 10);
  const ch = book === 'PSA'
    ? String(chapter).padStart(3, '0')
    : String(chapter).padStart(2, '0');
  const username = match[3] || 'ai-pipeline';
  return { book, chapter, ch, username };
}

/**
 * @param {{ runSkill: Function, runCustom: Function }} runner
 * @param {{ prompt: string, opts: Object }} params
 */
module.exports = async function makeBP(runner, { prompt, opts }) {
  const { book, chapter, ch, username } = parsePrompt(prompt);
  const cwd = opts.cwd || '/srv/bot/workspace';
  const allSteps = [];

  console.log(`[makeBP] Starting full book package for ${book} ${chapter} (user: ${username})`);

  // ========== Phase 1: Initial Pipeline ==========
  console.log(`[makeBP] Phase 1: Initial pipeline (ULT + issues + UST)`);

  const phase1 = await initialPipeline(runner, { prompt: `${book} ${chapter}`, opts });
  allSteps.push(...(phase1.steps || []).map(s => ({ ...s, phase: 1 })));

  // Verify Phase 1 outputs
  const ultPath = path.join(cwd, 'output', 'AI-ULT', book, `${book}-${ch}.usfm`);
  const ustPath = path.join(cwd, 'output', 'AI-UST', book, `${book}-${ch}.usfm`);
  const issuesPath = path.join(cwd, 'output', 'issues', book, `${book}-${ch}.tsv`);

  for (const [label, p] of [['ULT', ultPath], ['UST', ustPath], ['Issues', issuesPath]]) {
    if (!fs.existsSync(p)) {
      throw new Error(`Phase 1 failed: ${label} not found at ${p}`);
    }
  }

  // ========== Phase 2: Parallel Generation ==========
  console.log(`[makeBP] Phase 2: Parallel generation (intro, TQ, ULT-align, UST-align)`);

  const [introResult, tqResult, ultAlignResult, ustAlignResult] = await Promise.all([
    runner.runSkill('chapter-intro', `${book} ${chapter}`, opts),
    runner.runSkill('tq-writer', `${book} ${chapter}`, opts),
    runner.runSkill('ULT-alignment', `${book} ${chapter}`, opts),
    runner.runSkill('UST-alignment', `${book} ${chapter}`, opts),
  ]);

  allSteps.push({ name: 'phase2-chapter-intro', phase: 2, ...introResult });
  allSteps.push({ name: 'phase2-tq-writer', phase: 2, ...tqResult });
  allSteps.push({ name: 'phase2-ult-alignment', phase: 2, ...ultAlignResult });
  allSteps.push({ name: 'phase2-ust-alignment', phase: 2, ...ustAlignResult });

  // Validate aligned ULT brackets (between Phase 2 and 3)
  const alignedUltPath = path.join(cwd, 'output', 'AI-ULT', book, `${book}-${ch}-aligned.usfm`);
  const validateScript = path.join(cwd, '.claude', 'skills', 'utilities', 'scripts', 'validate_ult_brackets.py');
  if (fs.existsSync(validateScript) && fs.existsSync(alignedUltPath)) {
    console.log(`[makeBP] Validating aligned ULT brackets`);
    const validateResult = await runner.runCustom(
      `Run this validation and fix any issues found:\npython3 ${validateScript} ${alignedUltPath}\nIf issues are found, fix the aligned USFM (remove curly braces from words that align to prefixed Strong's numbers).`,
      `Validate brackets for ${book} ${chapter}`,
      opts
    );
    allSteps.push({ name: 'phase2-validate-brackets', phase: 2, ...validateResult });
  }

  // ========== Phase 3: TN Writer ==========
  console.log(`[makeBP] Phase 3: TN writer`);

  const tnResult = await runner.runSkill('tn-writer', `${book} ${chapter}`, opts);
  allSteps.push({ name: 'phase3-tn-writer', phase: 3, ...tnResult });

  // Verify TN output
  const tnPath = path.join(cwd, 'output', 'notes', book, `${book}-${ch}.tsv`);
  if (!fs.existsSync(tnPath)) {
    console.warn(`[makeBP] Warning: TN output not found at ${tnPath}`);
  }

  // ========== Phase 4: Repo Insert (parallel) ==========
  console.log(`[makeBP] Phase 4: Repo insert (4 repos in parallel)`);

  const alignedUstPath = path.join(cwd, 'output', 'AI-UST', book, `${book}-${ch}-aligned.usfm`);
  const tqPath = path.join(cwd, 'output', 'tq', book, `${book}-${chapter}.tsv`);

  const repoInserts = [
    { name: 'ULT', source: alignedUltPath, repo: 'en_ult', type: 'usfm' },
    { name: 'UST', source: alignedUstPath, repo: 'en_ust', type: 'usfm' },
    { name: 'TN', source: tnPath, repo: 'en_tn', type: 'tsv' },
    { name: 'TQ', source: tqPath, repo: 'en_tq', type: 'tsv' },
  ];

  const insertPromises = repoInserts
    .filter(r => fs.existsSync(r.source))
    .map(r => {
      return runner.runSkill('repo-insert', `${book} ${chapter}`, {
        ...opts,
        systemAppend: [
          `Insert ${r.name} content into Door43 repo: unfoldingWord/${r.repo}`,
          `Source file: ${r.source}`,
          `Content type: ${r.type}`,
          `Branch: AI-${book}-${ch}`,
          `Username for attribution: ${username}`,
        ].join('\n'),
      });
    });

  if (insertPromises.length > 0) {
    const insertResults = await Promise.all(insertPromises);
    const insertNames = repoInserts.filter(r => fs.existsSync(r.source));
    insertResults.forEach((r, i) => {
      allSteps.push({ name: `phase4-repo-insert-${insertNames[i].name}`, phase: 4, ...r });
    });
  } else {
    console.warn(`[makeBP] No files available for repo insert`);
  }

  console.log(`[makeBP] Complete for ${book} ${chapter}`);

  return { steps: allSteps };
};
