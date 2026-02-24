// orchestrations/initial-pipeline.js — 7-wave ULT → issues → UST pipeline
// File-based multi-agent orchestration (replaces SDK team protocol)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Parse "BOOK CHAPTER" from prompt string.
 * e.g. "PSA 133" → { book: 'PSA', chapter: 133, ch: '133' }
 */
function parsePrompt(prompt) {
  const match = prompt.match(/^(\w{2,3})\s+(\d+)/i);
  if (!match) throw new Error(`Cannot parse book/chapter from prompt: "${prompt}"`);
  const book = match[1].toUpperCase();
  const chapter = parseInt(match[2], 10);
  // PSA uses 3-digit padding, others use 2-digit
  const ch = book === 'PSA'
    ? String(chapter).padStart(3, '0')
    : String(chapter).padStart(2, '0');
  return { book, chapter, ch };
}

function fileHash(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * @param {{ runSkill: Function, runCustom: Function }} runner
 * @param {{ prompt: string, opts: Object }} params
 */
module.exports = async function initialPipeline(runner, { prompt, opts }) {
  const { book, chapter, ch } = parsePrompt(prompt);
  const cwd = opts.cwd || '/srv/bot/workspace';
  const tmp = path.join(cwd, 'tmp', `pipeline-${book}-${ch}`);
  const steps = [];

  console.log(`[initial-pipeline] Starting for ${book} ${chapter} (${ch})`);
  fs.mkdirSync(tmp, { recursive: true });

  // --- Wave 1: ULT Draft ---
  console.log(`[initial-pipeline] Wave 1: ULT generation`);
  const wave1 = await runner.runSkill('ULT-gen', `${book} ${chapter}`, opts);
  steps.push({ name: 'wave1-ult', ...wave1 });

  const ultPath = path.join(cwd, 'output', 'AI-ULT', book, `${book}-${ch}.usfm`);
  if (!fs.existsSync(ultPath)) {
    throw new Error(`Wave 1 failed: ULT not written at ${ultPath}`);
  }
  const ultHashBefore = fileHash(ultPath);

  // --- Wave 2: Issue Identification (2 analysts in parallel) ---
  console.log(`[initial-pipeline] Wave 2: Issue identification (structure + rhetoric)`);

  const structureAppend = [
    `You are the STRUCTURE analyst. Focus on: clause structure, word order, construct chains,`,
    `participles, verbal sequences, discourse markers, ellipsis, and grammatical issues`,
    `(abstract nouns, passive voice, possession, nominal adjectives).`,
    `Write your findings to: ${tmp}/wave2_structure.tsv`,
  ].join('\n');

  const rhetoricAppend = [
    `You are the RHETORIC analyst. Focus on: figurative language (metaphor, metonymy,`,
    `synecdoche, simile, personification, hyperbole, litotes, irony, euphemism, idiom),`,
    `doublets/hendiadys, parallelism, rhetorical questions, and discourse-level patterns.`,
    `Write your findings to: ${tmp}/wave2_rhetoric.tsv`,
  ].join('\n');

  const [wave2a, wave2b] = await Promise.all([
    runner.runSkill('issue-identification', `${book} ${chapter}`, {
      ...opts,
      systemAppend: structureAppend,
    }),
    runner.runSkill('issue-identification', `${book} ${chapter}`, {
      ...opts,
      systemAppend: rhetoricAppend,
    }),
  ]);
  steps.push({ name: 'wave2-structure', ...wave2a });
  steps.push({ name: 'wave2-rhetoric', ...wave2b });

  // --- Wave 3a: Challenger reads all findings ---
  console.log(`[initial-pipeline] Wave 3a: Challenger reviews findings`);

  const challengerPrompt = [
    `# Challenger Agent`,
    ``,
    `You are the adversarial challenger for translation issue identification.`,
    ``,
    `## Your Task`,
    `1. Read the ULT draft at: ${ultPath}`,
    `2. Read structure analyst findings at: ${tmp}/wave2_structure.tsv`,
    `3. Read rhetoric analyst findings at: ${tmp}/wave2_rhetoric.tsv`,
    `4. For each issue found, assess:`,
    `   - Is this the right issue type? Could it be a commonly confused alternative?`,
    `   - Does the ULT rendering already handle this issue (making the note unnecessary)?`,
    `   - Are there duplicates across the two analysts?`,
    `5. Write challenges as JSON to: ${tmp}/wave3_challenges.json`,
    `   Format: { "analyst-structure": [...challenges], "analyst-rhetoric": [...challenges], "ult-agent": [...questions] }`,
    `   Each challenge: { "verse": "v3", "phrase": "...", "currentType": "...", "challenge": "...", "suggestedAction": "KEEP|DROP|RECLASSIFY|MERGE_DUPLICATE" }`,
    ``,
    `## Rules`,
    `- Grammar issues (abstract nouns, passives) are independent — cannot be merged with figurative issues`,
    `- If Hebrew has a named grammatical structure, ULT should preserve it literally`,
    `- DO NOT find new issues — only challenge existing ones`,
  ].join('\n');

  const wave3a = await runner.runCustom(challengerPrompt, `Review findings for ${book} ${chapter}`, opts);
  steps.push({ name: 'wave3a-challenger', ...wave3a });

  // --- Wave 3b: Challenged parties defend (parallel) ---
  console.log(`[initial-pipeline] Wave 3b: Defenses`);

  const challengesPath = path.join(tmp, 'wave3_challenges.json');
  let challenges = {};
  if (fs.existsSync(challengesPath)) {
    try { challenges = JSON.parse(fs.readFileSync(challengesPath, 'utf8')); } catch { challenges = {}; }
  }

  const defensePrompts = [];
  const defenseNames = [];

  if (challenges['analyst-structure']?.length > 0) {
    defensePrompts.push(runner.runCustom(
      `You are the STRUCTURE analyst defending your findings.\nRead your original findings at: ${tmp}/wave2_structure.tsv\nRead the challenges directed at you.\nWrite your defense to: ${tmp}/wave3_defense_structure.json\nFor each challenge, respond with: { "verse": "...", "response": "ACCEPT|REJECT", "reasoning": "..." }`,
      `Challenges: ${JSON.stringify(challenges['analyst-structure'])}`,
      opts
    ));
    defenseNames.push('wave3b-defense-structure');
  }

  if (challenges['analyst-rhetoric']?.length > 0) {
    defensePrompts.push(runner.runCustom(
      `You are the RHETORIC analyst defending your findings.\nRead your original findings at: ${tmp}/wave2_rhetoric.tsv\nRead the challenges directed at you.\nWrite your defense to: ${tmp}/wave3_defense_rhetoric.json\nFor each challenge, respond with: { "verse": "...", "response": "ACCEPT|REJECT", "reasoning": "..." }`,
      `Challenges: ${JSON.stringify(challenges['analyst-rhetoric'])}`,
      opts
    ));
    defenseNames.push('wave3b-defense-rhetoric');
  }

  if (challenges['ult-agent']?.length > 0) {
    defensePrompts.push(runner.runCustom(
      `You are the ULT translator. Read the ULT at: ${ultPath}\nAnswer questions about your rendering decisions.\nWrite your responses to: ${tmp}/wave3_defense_ult.json\nFor each question, respond with: { "verse": "...", "answer": "...", "revisionNeeded": true|false, "revisionDetail": "..." }`,
      `Questions: ${JSON.stringify(challenges['ult-agent'])}`,
      opts
    ));
    defenseNames.push('wave3b-defense-ult');
  }

  if (defensePrompts.length > 0) {
    const defenseResults = await Promise.all(defensePrompts);
    defenseResults.forEach((r, i) => steps.push({ name: defenseNames[i], ...r }));
  }

  // --- Wave 3c: Final rulings ---
  console.log(`[initial-pipeline] Wave 3c: Final rulings`);

  const rulingsPrompt = [
    `# Final Rulings`,
    ``,
    `Read all defense files in ${tmp}/wave3_defense_*.json`,
    `For each challenged issue, make a final ruling: KEEP, DROP, RECLASSIFY, or MERGE_DUPLICATE.`,
    `Write rulings TSV to: ${tmp}/wave3_rulings.tsv`,
    `Format: verse<tab>phrase<tab>original_type<tab>ruling<tab>new_type_if_reclassified<tab>reasoning`,
    ``,
    `Rules:`,
    `- If analyst accepted the challenge → apply the challenger's suggestion`,
    `- If analyst rejected and reasoning is strong → KEEP the original`,
    `- Grammar issues survive alongside figurative issues (independent layers)`,
    `- Note any ULT revision requests from the ult-agent's responses`,
  ].join('\n');

  const wave3c = await runner.runCustom(rulingsPrompt, `Finalize rulings for ${book} ${chapter}`, opts);
  steps.push({ name: 'wave3c-rulings', ...wave3c });

  // --- Wave 4a: Merge (JS logic, no LLM) ---
  console.log(`[initial-pipeline] Wave 4a: Merging issues`);

  // Read wave2 TSVs and rulings, merge them
  const mergePrompt = [
    `# Merge Issues`,
    ``,
    `1. Read structure findings: ${tmp}/wave2_structure.tsv`,
    `2. Read rhetoric findings: ${tmp}/wave2_rhetoric.tsv`,
    `3. Read Wave 3 rulings: ${tmp}/wave3_rulings.tsv`,
    `4. Apply rulings: DROP removes the issue, RECLASSIFY changes the type, MERGE_DUPLICATE keeps one copy`,
    `5. Deduplicate: same phrase + same issue type = keep one`,
    `6. Order: first-to-last by ULT position within each verse, longest-to-shortest when nested`,
    `7. Write merged issues to: ${tmp}/merged_issues.tsv`,
  ].join('\n');

  const wave4a = await runner.runCustom(mergePrompt, `Merge issues for ${book} ${chapter}`, opts);
  steps.push({ name: 'wave4a-merge', ...wave4a });

  // --- Wave 4b: ULT Revision ---
  console.log(`[initial-pipeline] Wave 4b: ULT revision`);

  const ultDefensePath = path.join(tmp, 'wave3_defense_ult.json');
  let revisionInstructions = '';
  if (fs.existsSync(ultDefensePath)) {
    try {
      const defenses = JSON.parse(fs.readFileSync(ultDefensePath, 'utf8'));
      const revisions = (Array.isArray(defenses) ? defenses : [defenses])
        .filter(d => d.revisionNeeded);
      if (revisions.length > 0) {
        revisionInstructions = revisions.map(r =>
          `- ${r.verse}: ${r.revisionDetail || r.answer}`
        ).join('\n');
      }
    } catch { /* no revisions */ }
  }

  // Also check rulings for revision requests
  const rulingsPath = path.join(tmp, 'wave3_rulings.tsv');
  if (fs.existsSync(rulingsPath) && !revisionInstructions) {
    revisionInstructions = 'Review the rulings at ' + rulingsPath + ' and apply any ULT changes indicated.';
  }

  if (revisionInstructions) {
    const wave4b = await runner.runSkill('ULT-gen', `${book} ${chapter}`, {
      ...opts,
      systemAppend: [
        `This is a REVISION pass. Read the existing ULT at: ${ultPath}`,
        `Apply these specific revisions:`,
        revisionInstructions,
        `Write the revised ULT to the same path: ${ultPath}`,
      ].join('\n'),
    });
    steps.push({ name: 'wave4b-ult-revision', ...wave4b });
  } else {
    console.log(`[initial-pipeline] Wave 4b: No revisions needed, skipping`);
  }

  // --- Wave 5: Verification (conditional) ---
  const ultHashAfter = fileHash(ultPath);
  const ultChanged = ultHashBefore !== ultHashAfter;

  if (ultChanged) {
    console.log(`[initial-pipeline] Wave 5: Verification (ULT was revised)`);

    const [wave5a, wave5b] = await Promise.all([
      runner.runCustom(
        `You are the STRUCTURE analyst. Re-check your original findings at ${tmp}/wave2_structure.tsv against the revised ULT at ${ultPath}. Drop anything that no longer applies. Flag anything new. Write verification to: ${tmp}/wave5_structure.tsv`,
        `Verify structure findings for ${book} ${chapter}`,
        opts
      ),
      runner.runCustom(
        `You are the RHETORIC analyst. Re-check your original findings at ${tmp}/wave2_rhetoric.tsv against the revised ULT at ${ultPath}. Drop anything that no longer applies. Flag anything new. Write verification to: ${tmp}/wave5_rhetoric.tsv`,
        `Verify rhetoric findings for ${book} ${chapter}`,
        opts
      ),
    ]);
    steps.push({ name: 'wave5-verify-structure', ...wave5a });
    steps.push({ name: 'wave5-verify-rhetoric', ...wave5b });
  } else {
    console.log(`[initial-pipeline] Wave 5: Skipped (ULT unchanged)`);
  }

  // --- Finalize: Write final issues ---
  console.log(`[initial-pipeline] Finalizing issues`);

  const finalIssuesPath = path.join(cwd, 'output', 'issues', book, `${book}-${ch}.tsv`);
  fs.mkdirSync(path.dirname(finalIssuesPath), { recursive: true });

  // Copy merged issues to final location (wave5 updates already written inline)
  const mergedPath = path.join(tmp, 'merged_issues.tsv');
  if (fs.existsSync(mergedPath)) {
    fs.copyFileSync(mergedPath, finalIssuesPath);
  }

  // --- Wave 6: UST Generation ---
  console.log(`[initial-pipeline] Wave 6: UST generation`);

  const wave6 = await runner.runSkill('UST-gen', `${book} ${chapter}`, {
    ...opts,
    systemAppend: [
      `Read the final ULT at: ${ultPath}`,
      `Read the final issues at: ${finalIssuesPath}`,
      `The UST should model how to handle each identified issue.`,
    ].join('\n'),
  });
  steps.push({ name: 'wave6-ust', ...wave6 });

  // --- Wave 7: Gemini Review (optional) ---
  // Gemini review is a Python script, run via Bash if available
  console.log(`[initial-pipeline] Wave 7: Gemini review (skipped — run manually if needed)`);
  console.log(`  python3 .claude/skills/utilities/scripts/gemini_review.py --stage ult --book ${book} --chapter ${chapter}`);
  console.log(`  python3 .claude/skills/utilities/scripts/gemini_review.py --stage issues --book ${book} --chapter ${chapter}`);
  console.log(`  python3 .claude/skills/utilities/scripts/gemini_review.py --stage ust --book ${book} --chapter ${chapter}`);

  console.log(`[initial-pipeline] Complete for ${book} ${chapter}`);

  return { steps };
};
