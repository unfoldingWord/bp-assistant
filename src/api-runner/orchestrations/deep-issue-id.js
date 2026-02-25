// orchestrations/deep-issue-id.js — Adversarial issue ID against human ULT/UST
// Same as Waves 2-4a of initial-pipeline, but reads human text from Door43

const fs = require('fs');
const path = require('path');

function parsePrompt(prompt) {
  // "PSA 133" or "PSA 119 --verses 1-40"
  const match = prompt.match(/^(\w{2,3})\s+(\d+)/i);
  if (!match) throw new Error(`Cannot parse book/chapter from prompt: "${prompt}"`);
  const book = match[1].toUpperCase();
  const chapter = parseInt(match[2], 10);
  const ch = book === 'PSA'
    ? String(chapter).padStart(3, '0')
    : String(chapter).padStart(2, '0');

  // Optional verse range
  const verseMatch = prompt.match(/--verses?\s+(\d+)-(\d+)/i);
  const verses = verseMatch ? { start: parseInt(verseMatch[1], 10), end: parseInt(verseMatch[2], 10) } : null;

  return { book, chapter, ch, verses };
}

/**
 * @param {{ runSkill: Function, runCustom: Function }} runner
 * @param {{ prompt: string, opts: Object }} params
 */
module.exports = async function deepIssueId(runner, { prompt, opts }) {
  const { book, chapter, ch, verses } = parsePrompt(prompt);
  const cwd = opts.cwd || '/srv/bot/workspace';
  const verseSuffix = verses ? `-v${verses.start}-${verses.end}` : '';
  const tmp = path.join(cwd, 'tmp', 'deep-issue-id', `${book}-${ch}${verseSuffix}`);
  const steps = [];

  console.log(`[deep-issue-id] Starting for ${book} ${chapter}${verses ? ` verses ${verses.start}-${verses.end}` : ''}`);
  fs.mkdirSync(tmp, { recursive: true });

  function skip(label, ...files) {
    const done = files.every(f => fs.existsSync(f));
    if (done) console.log(`[deep-issue-id] Skipping ${label} (output files already exist)`);
    return done;
  }

  // --- Setup: Fetch and parse human ULT/UST ---
  const verseFlag = verses ? `--verse ${verses.start}-${verses.end}` : '';

  if (!skip('setup', `${tmp}/alignments.json`, `${tmp}/ult_plain.usfm`, `${tmp}/detected_issues.tsv`)) {
    console.log(`[deep-issue-id] Setup: Fetching and parsing`);
    const setupPrompt = [
      `# Setup: Fetch and Parse`,
      `Run these commands in sequence:`,
      ``,
      '```bash',
      `python3 .claude/skills/utilities/scripts/fetch_door43.py ${book} > ${tmp}/book_ult.usfm`,
      `python3 .claude/skills/utilities/scripts/fetch_door43.py ${book} --type ust > ${tmp}/book_ust.usfm 2>/dev/null || true`,
      ``,
      `node .claude/skills/utilities/scripts/usfm/parse_usfm.js ${tmp}/book_ult.usfm \\`,
      `  --chapter ${chapter} ${verseFlag} \\`,
      `  --output-json ${tmp}/alignments.json \\`,
      `  --output-plain ${tmp}/ult_plain.usfm`,
      ``,
      `node .claude/skills/utilities/scripts/usfm/parse_usfm.js ${tmp}/book_ust.usfm \\`,
      `  --chapter ${chapter} ${verseFlag} \\`,
      `  --plain-only > ${tmp}/ust_plain.usfm 2>/dev/null || true`,
      ``,
      `python3 .claude/skills/issue-identification/scripts/compare_ult_ust.py \\`,
      `  ${tmp}/ult_plain.usfm ${tmp}/ust_plain.usfm \\`,
      `  --chapter ${chapter} --output ${tmp}/ult_ust_diff.tsv`,
      ``,
      `python3 .claude/skills/issue-identification/scripts/detection/detect_abstract_nouns.py \\`,
      `  ${tmp}/alignments.json --format tsv > ${tmp}/detected_issues.tsv`,
      ``,
      `python3 .claude/skills/utilities/scripts/build_tn_index.py`,
      '```',
      ``,
      `Run all of these commands. Report which files were created.`,
    ].join('\n');
    const setupResult = await runner.runCustom(setupPrompt, `Setup for ${book} ${chapter}`, opts);
    steps.push({ name: 'setup', ...setupResult });
  }

  // --- Wave 2: Issue Identification (2 analysts in parallel) ---
  const wave2Tasks = [];

  if (!skip('wave2-structure', `${tmp}/wave2_structure.tsv`)) {
    console.log(`[deep-issue-id] Wave 2: Structure analyst`);
    wave2Tasks.push(['wave2-structure', runner.runSkill('issue-identification', `${book} ${chapter}`, {
      ...opts,
      systemAppend: [
        `You are the STRUCTURE analyst. Focus on: clause structure, word order, construct chains,`,
        `participles, verbal sequences, discourse markers, ellipsis, and grammatical issues.`,
        `Read human ULT at: ${tmp}/ult_plain.usfm`,
        `Read human UST at: ${tmp}/ust_plain.usfm (if available)`,
        `Read alignment JSON at: ${tmp}/alignments.json`,
        `Read ULT/UST divergence patterns at: ${tmp}/ult_ust_diff.tsv`,
        `Read automated detections at: ${tmp}/detected_issues.tsv`,
        `The human ULT/UST is authoritative. Flag issues in the text, not defects in the text.`,
        `Write your findings to: ${tmp}/wave2_structure.tsv`,
      ].join('\n'),
    })]);
  }

  if (!skip('wave2-rhetoric', `${tmp}/wave2_rhetoric.tsv`)) {
    console.log(`[deep-issue-id] Wave 2: Rhetoric analyst`);
    wave2Tasks.push(['wave2-rhetoric', runner.runSkill('issue-identification', `${book} ${chapter}`, {
      ...opts,
      systemAppend: [
        `You are the RHETORIC analyst. Focus on: figurative language (metaphor, metonymy,`,
        `synecdoche, simile, personification, hyperbole, litotes, irony, euphemism, idiom),`,
        `doublets/hendiadys, parallelism, rhetorical questions, and discourse-level patterns.`,
        `Read human ULT at: ${tmp}/ult_plain.usfm`,
        `Read human UST at: ${tmp}/ust_plain.usfm (if available)`,
        `Read alignment JSON at: ${tmp}/alignments.json`,
        `Read ULT/UST divergence patterns at: ${tmp}/ult_ust_diff.tsv`,
        `The human ULT/UST is authoritative. Flag issues in the text, not defects in the text.`,
        `Write your findings to: ${tmp}/wave2_rhetoric.tsv`,
      ].join('\n'),
    })]);
  }

  if (wave2Tasks.length > 0) {
    const results = await Promise.all(wave2Tasks.map(([, p]) => p));
    wave2Tasks.forEach(([name], i) => steps.push({ name, ...results[i] }));
  }

  // --- Wave 3: Challenge and Defend ---
  if (!skip('wave3-challenger', `${tmp}/wave3_challenges.json`)) {
    console.log(`[deep-issue-id] Wave 3: Challenger`);
    const wave3a = await runner.runCustom([
      `# Challenger Agent`,
      ``,
      `You are the adversarial challenger for translation issue identification.`,
      `The ULT/UST is HUMAN-AUTHORED and authoritative.`,
      ``,
      `1. Read the human ULT at: ${tmp}/ult_plain.usfm`,
      `2. Read structure findings at: ${tmp}/wave2_structure.tsv`,
      `3. Read rhetoric findings at: ${tmp}/wave2_rhetoric.tsv`,
      `4. Challenge misclassifications, duplicates, and issues the human text already handles.`,
      `5. Write challenges to: ${tmp}/wave3_challenges.json`,
      `   Format: { "analyst-structure": [...], "analyst-rhetoric": [...] }`,
      `   Each: { "verse": "...", "phrase": "...", "currentType": "...", "challenge": "...", "suggestedAction": "KEEP|DROP|RECLASSIFY|MERGE_DUPLICATE" }`,
      ``,
      `If the human rendering already resolves a potential issue, DROP it.`,
      `Grammar issues are independent — keep both layers.`,
    ].join('\n'), `Challenge findings for ${book} ${chapter}`, opts);
    steps.push({ name: 'wave3-challenger', ...wave3a });
  }

  // Wave 3b: Defenses
  const challengesPath = path.join(tmp, 'wave3_challenges.json');
  let challenges = {};
  if (fs.existsSync(challengesPath)) {
    try { challenges = JSON.parse(fs.readFileSync(challengesPath, 'utf8')); } catch { challenges = {}; }
  }

  const defensePromises = [];
  const defenseNames = [];

  if (!skip('wave3b-defense-structure', `${tmp}/wave3_defense_structure.json`) && challenges['analyst-structure']?.length > 0) {
    defensePromises.push(runner.runCustom(
      `You are the STRUCTURE analyst defending your findings.\nOriginal findings: ${tmp}/wave2_structure.tsv\nWrite defense to: ${tmp}/wave3_defense_structure.json`,
      `Challenges: ${JSON.stringify(challenges['analyst-structure'])}`,
      opts
    ));
    defenseNames.push('wave3b-defense-structure');
  }

  if (!skip('wave3b-defense-rhetoric', `${tmp}/wave3_defense_rhetoric.json`) && challenges['analyst-rhetoric']?.length > 0) {
    defensePromises.push(runner.runCustom(
      `You are the RHETORIC analyst defending your findings.\nOriginal findings: ${tmp}/wave2_rhetoric.tsv\nWrite defense to: ${tmp}/wave3_defense_rhetoric.json`,
      `Challenges: ${JSON.stringify(challenges['analyst-rhetoric'])}`,
      opts
    ));
    defenseNames.push('wave3b-defense-rhetoric');
  }

  if (defensePromises.length > 0) {
    const defenseResults = await Promise.all(defensePromises);
    defenseResults.forEach((r, i) => steps.push({ name: defenseNames[i], ...r }));
  }

  // Wave 3c: Final rulings
  if (!skip('wave3c-rulings', `${tmp}/wave3_rulings.tsv`)) {
    console.log(`[deep-issue-id] Wave 3c: Final rulings`);
    const wave3c = await runner.runCustom([
      `# Final Rulings`,
      `Read all defense files in ${tmp}/wave3_defense_*.json`,
      `Make final ruling for each challenged issue: KEEP, DROP, RECLASSIFY, or MERGE_DUPLICATE.`,
      `Write rulings to: ${tmp}/wave3_rulings.tsv`,
      `Format: verse<tab>phrase<tab>original_type<tab>ruling<tab>new_type_if_reclassified<tab>reasoning`,
      `Grammar issues survive alongside figurative issues.`,
    ].join('\n'), `Finalize rulings for ${book} ${chapter}`, opts);
    steps.push({ name: 'wave3c-rulings', ...wave3c });
  }

  // --- Wave 4a: Merge ---
  const outputDir = path.join(cwd, 'output', 'issues', book);
  const outputTsv = path.join(outputDir, `${book}-${ch}${verseSuffix}.tsv`);
  fs.mkdirSync(outputDir, { recursive: true });

  if (!skip('wave4a-merge', outputTsv)) {
    console.log(`[deep-issue-id] Wave 4a: Merging issues`);
    const mergePrompt = [
      `# Merge Issues`,
      `1. Read structure findings: ${tmp}/wave2_structure.tsv`,
      `2. Read rhetoric findings: ${tmp}/wave2_rhetoric.tsv`,
      `3. Read rulings: ${tmp}/wave3_rulings.tsv`,
      `4. Apply rulings (DROP, RECLASSIFY, MERGE_DUPLICATE)`,
      `5. Deduplicate: same phrase + same issue type = keep one`,
      `6. Order: first-to-last by ULT position, longest-to-shortest when nested`,
      `7. Write to: ${outputTsv}`,
      `8. Only read files in ${tmp}/ — do not read any files outside that directory or output/issues/`,
    ].join('\n');
    const wave4a = await runner.runCustom(mergePrompt, `Merge issues for ${book} ${chapter}`, opts);
    steps.push({ name: 'wave4a-merge', ...wave4a });
  }

  console.log(`[deep-issue-id] Complete for ${book} ${chapter}`);

  return { steps };
};
