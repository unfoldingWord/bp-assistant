const { runSkill } = require('./runner');
const { sendMessage, sendDM, addReaction, removeReaction } = require('../zulip-client');
const fs = require('fs');
const path = require('path');
const { door43Push } = require('../door43-push');
const { getDoor43Username, normalizeBookName, buildBranchName, discoverFreshOutput, checkPrerequisites, resolveOutputFile, CSKILLBP_DIR } = require('../pipeline-utils');
const { buildNotesContext, readContext, writeContext } = require('../pipeline-context');
const { extractAlignmentData, prepareNotes, fillOrigQuotes, resolveGlQuotes, flagNarrowQuotes, generateIds } = require('../workspace-tools/tn-tools');
const { createAlignedUsfm, validateAlignedUsfmMarkup, summarizeAlignedUsfmMarkupFindings } = require('../workspace-tools/usfm-tools');
const { checkUltEdits } = require('../check-ult-edits');
const { getProviderSystemAppend } = require('./provider-nudges');

const ALIGNMENT_VALIDATION_RETRIES = 2;

function parseRegexLiteral(literal) {
  if (typeof literal !== 'string') return null;
  const match = literal.match(/^\/(.+)\/([a-z]*)$/);
  if (!match) return null;
  return new RegExp(match[1], match[2]);
}

function extractPrompt(route, content) {
  const regex = parseRegexLiteral(route.match);
  if (!regex) return String(content || '').trim();
  const captures = String(content || '').match(regex);
  if (!captures) return String(content || '').trim();
  if (captures[1]) return String(captures[1]).trim();
  return String(content || '').trim();
}

function parseSkillSpec(spec) {
  const parts = String(spec || '').trim().split(/\s+/).filter(Boolean);
  const skillName = parts.shift() || 'initial-pipeline';
  return { skillName, args: parts.join(' ') };
}

function parseProviderFromMessage(content) {
  const match = String(content || '').match(/--provider\s+([a-z0-9_-]+)/i);
  return match ? match[1].toLowerCase() : null;
}

function parseRuntimeFromMessage(content) {
  const match = String(content || '').match(/--runtime\s+([a-z0-9_-]+)/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Extract book, chapter, and Door43 username from the prompt string.
 * Example: "zec 3 user benjamin-test" -> { book: "ZEC", chapter: 3, username: "benjamin-test" }
 */
function parseBookChapterUser(prompt, senderEmail) {
  const bookMatch = prompt.match(/^([a-z0-9]{2,3}|[a-z]+)\s+(\d+)/i);
  if (!bookMatch) return { book: null, chapter: null, username: null };

  const book = normalizeBookName(bookMatch[1]);
  const chapter = parseInt(bookMatch[2], 10);

  let username = null;
  const userMatch = prompt.match(/\buser\s+([a-z0-9_-]+)/i);
  if (userMatch) {
    username = userMatch[1];
  } else {
    username = getDoor43Username(senderEmail);
  }

  return { book, chapter, username };
}

function findHebrewSourceRelPath(book) {
  const hebrewDir = path.join(CSKILLBP_DIR, 'data/hebrew_bible');
  if (!fs.existsSync(hebrewDir)) return null;
  const match = fs.readdirSync(hebrewDir).find((name) => name.endsWith(`-${book}.usfm`));
  return match ? path.posix.join('data/hebrew_bible', match) : null;
}

function findAlignmentMappingRelPath(book, tag, ust) {
  const candidates = ust
    ? [
        `output/AI-UST/hints/${book}/${tag}.json`,
        `tmp/${tag}-alignment-mapping.json`,
        `tmp/alignments/${book}/${tag}-mapping.json`,
        `output/AI-UST/${book}/${tag}-alignment.json`,
      ]
    : [
        `tmp/alignments/${book}/${tag}-mapping.json`,
        `tmp/${tag}-alignment-mapping.json`,
      ];

  return candidates.find((relPath) => fs.existsSync(path.resolve(CSKILLBP_DIR, relPath))) || null;
}

function bestEffortAlignedOutputRepair({ alignedRelPath, book, chapter, ust, maxRetries = ALIGNMENT_VALIDATION_RETRIES }) {
  let validation = validateAlignedUsfmMarkup({ alignedUsfm: alignedRelPath });
  if (validation.ok) {
    return { ok: true, degraded: false, attempts: 1, findings: [], summary: validation.summary };
  }

  const width = String(book).toUpperCase() === 'PSA' ? 3 : 2;
  const tag = `${book}-${String(chapter).padStart(width, '0')}`;
  const sourceRelPath = alignedRelPath.replace(/-aligned\.usfm$/, '.usfm');
  const mappingRelPath = findAlignmentMappingRelPath(book, tag, ust);
  const hebrewRelPath = findHebrewSourceRelPath(book);
  let attempts = 1;

  if (!fs.existsSync(path.resolve(CSKILLBP_DIR, sourceRelPath)) || !mappingRelPath || !hebrewRelPath) {
    const missing = [];
    if (!fs.existsSync(path.resolve(CSKILLBP_DIR, sourceRelPath))) missing.push(`source=${sourceRelPath}`);
    if (!mappingRelPath) missing.push('mapping');
    if (!hebrewRelPath) missing.push('hebrew');
    const summary = `Alignment markup degraded; no deterministic repair inputs available (${missing.join(', ')}): ${summarizeAlignedUsfmMarkupFindings(validation.findings)}`;
    console.warn(`[api-pipeline] ${alignedRelPath}: ${summary}`);
    return { ok: true, degraded: true, attempts, findings: validation.findings, summary };
  }

  for (let retry = 1; retry <= maxRetries; retry++) {
    attempts++;
    const result = createAlignedUsfm({
      hebrew: hebrewRelPath,
      mapping: mappingRelPath,
      source: sourceRelPath,
      output: alignedRelPath,
      chapter,
      ust,
    });
    if (String(result).startsWith('Error')) {
      console.warn(`[api-pipeline] ${alignedRelPath}: retry ${retry} failed: ${result}`);
      continue;
    }
    validation = validateAlignedUsfmMarkup({ alignedUsfm: alignedRelPath });
    if (validation.ok) {
      return { ok: true, degraded: false, attempts, findings: [], summary: validation.summary };
    }
  }

  const summary = `Alignment markup degraded after ${attempts} attempt(s): ${summarizeAlignedUsfmMarkupFindings(validation.findings)}`;
  console.warn(`[api-pipeline] ${alignedRelPath}: ${summary}`);
  return { ok: true, degraded: true, attempts, findings: validation.findings, summary };
}

async function apiPipeline(route, message) {
  const stream = message.type === 'stream' ? message.display_recipient : null;
  const topic = message.subject || '';
  const msgId = message.id;
  const isDryRun = process.env.DRY_RUN === '1';

  const { skillName, args } = parseSkillSpec(route.skill);
  let prompt = extractPrompt(route, message.content);
  if (args) prompt = `${args} ${prompt}`.trim();

  const provider = parseProviderFromMessage(message.content) || route.provider || 'openai';
  const runtime = parseRuntimeFromMessage(message.content) || route.runtime || null;
  const model = route.model || null;
  let selectedCwd = route.cwd || '/workspace';
  const primarySkillPath = path.join(selectedCwd, '.claude', 'skills', skillName, 'SKILL.md');
  if (!fs.existsSync(primarySkillPath)) {
    const fallbackCwd = '/srv/bot/workspace';
    const fallbackSkillPath = path.join(fallbackCwd, '.claude', 'skills', skillName, 'SKILL.md');
    if (fs.existsSync(fallbackSkillPath)) {
      selectedCwd = fallbackCwd;
    }
  }

  const reply = async (text) => {
    if (stream) {
      const mention = message.sender_full_name ? `@**${message.sender_full_name}** ` : '';
      await sendMessage(stream, topic, mention + text);
    } else {
      await sendDM(message.sender_id, text);
    }
  };

  try {
    await addReaction(msgId, 'working_on_it');

    // --- Notes orchestration for tn-writer skill ---
    if (skillName === 'tn-writer' && !isDryRun) {
      const { book, chapter, username } = parseBookChapterUser(prompt, message.sender_email);
      if (!book || !chapter) throw new Error(`Could not parse book/chapter from prompt: "${prompt}"`);

      // 1. Check prerequisites (decides issue producer path)
      const prereqs = checkPrerequisites(book, chapter);
      const hasAIArtifacts = prereqs.missing.length === 0;

      // 2. Build pipeline context (fetches ULT/UST from Door43 master)
      const alignedUltPath = prereqs.resolved['AI-ULT']
        ? prereqs.resolved['AI-ULT'].replace(/\.usfm$/, '-aligned.usfm')
        : null;
      const alignedExists = alignedUltPath && fs.existsSync(path.resolve(CSKILLBP_DIR, alignedUltPath));

      await reply(`Building notes context for ${book} ${chapter}...`);
      const ctxResult = await buildNotesContext({
        book, chapter,
        issuesPath: hasAIArtifacts ? prereqs.resolved['issues TSV'] : undefined,
      });
      const { dirPath, contextPath } = ctxResult;

      // If aligned ULT exists, point context.sources.ultAligned at it
      if (alignedExists) {
        const ctx = readContext(dirPath);
        ctx.sources.ultAligned = alignedUltPath;
        writeContext(dirPath, ctx);
      }

      // 3. Issue producer
      const skipPer = /--skip-per\b/i.test(message.content);
      let issueResult = null;
      let issuesPath = hasAIArtifacts ? prereqs.resolved['issues TSV'] : null;

      if (skipPer) {
        // Skip all issue identification — use existing issues TSV directly
        if (!issuesPath) throw new Error(`--skip-per requires an existing issues TSV for ${book} ${chapter}, but none was found.`);
        await reply(`--skip-per set — skipping issue identification, using existing issues TSV directly.`);
      } else if (hasAIArtifacts) {
        const diffResult = await checkUltEdits({
          book, chapter,
          workspaceDir: path.resolve(CSKILLBP_DIR),
          pipeDir: dirPath,
        });
        if (diffResult.hasEdits) {
          const ctx = readContext(dirPath);
          ctx.sources.ultMasterPlain = diffResult.masterPath;
          writeContext(dirPath, ctx);
          await reply(`AI artifacts found with human edits — running post-edit-review...`);
          issueResult = await runSkill('post-edit-review',
            `--issues ${issuesPath} --context ${contextPath}`,
            { provider, runtime, model: 'sonnet', thinking: 'medium', maxTurns: 60, timeout: 20, cwd: selectedCwd });
          await reply(`post-edit-review done (turns: ${issueResult.turns}, cost: $${(issueResult.cost || 0).toFixed(4)}).`);
        } else {
          await reply(`AI artifacts found, no human edits — using existing issues TSV.`);
        }
      } else {
        await reply(`No AI artifacts (missing: ${prereqs.missing.join(', ')}) — running deep-issue-id...`);
        issueResult = await runSkill('deep-issue-id',
          `${book} ${chapter} --context ${contextPath}`,
          { provider, runtime, model: route.model || null, thinking: 'medium', maxTurns: 100, timeout: 30, cwd: selectedCwd });
        await reply(`deep-issue-id done (turns: ${issueResult.turns}, cost: $${(issueResult.cost || 0).toFixed(4)}).`);

        // Re-resolve issues path now that deep-issue-id has written it
        const freshPrereqs = checkPrerequisites(book, chapter);
        issuesPath = freshPrereqs.resolved['issues TSV'] || null;
        if (!issuesPath) throw new Error(`deep-issue-id completed but no issues TSV found for ${book} ${chapter}.`);
        const ctx = readContext(dirPath);
        ctx.sources.issues = issuesPath;
        writeContext(dirPath, ctx);
      }

      // 4. Mechanical JS preprocessing
      await reply(`Running mechanical preprocessing...`);
      const ctx = readContext(dirPath);
      const hasAligned = !!(ctx.sources && ctx.sources.ultAligned);

      if (hasAligned) {
        extractAlignmentData({
          alignedUsfm: ctx.sources.ultAligned,
          output: ctx.runtime.alignmentData,
        });
      }

      const prepResult = prepareNotes({
        inputTsv: issuesPath,
        ultUsfm: ctx.sources.ultPlain || ctx.sources.ult,
        ustUsfm: ctx.sources.ustPlain || ctx.sources.ust,
        alignedUsfm: ctx.sources.ultAligned,
        output: ctx.runtime.preparedNotes,
        alignmentJson: ctx.runtime.alignmentData,
      });
      const prepMatch = prepResult.match(/^Prepared (\d+) items/);
      const prepCount = prepMatch ? parseInt(prepMatch[1]) : 0;
      if (prepCount === 0) throw new Error(`Preprocessing produced 0 items for ${book} ${chapter}. Check issues TSV.`);

      if (hasAligned) {
        fillOrigQuotes({
          preparedJson: ctx.runtime.preparedNotes,
          alignmentJson: ctx.runtime.alignmentData,
          masterUltUsfm: ctx.sources.ultAligned,
        });
        resolveGlQuotes({
          preparedJson: ctx.runtime.preparedNotes,
          alignmentJson: ctx.runtime.alignmentData,
        });
      }

      flagNarrowQuotes({ preparedJson: ctx.runtime.preparedNotes });

      const prepPath = path.resolve(CSKILLBP_DIR, ctx.runtime.preparedNotes);
      const prepData = JSON.parse(fs.readFileSync(prepPath, 'utf8'));
      const needsId = (prepData.items || []).filter((item) => !item.id);
      if (needsId.length > 0) {
        const idStr = await generateIds({ book: prepData.book || book, count: needsId.length });
        const newIds = idStr.split('\n').filter(Boolean);
        let idx = 0;
        for (const item of prepData.items || []) {
          if (!item.id) item.id = newIds[idx++] || '';
        }
        fs.writeFileSync(prepPath, JSON.stringify(prepData, null, 2));
      }

      // 5. tn-writer (Opus by default)
      await reply(`Preprocessing done (${prepCount} items). Running tn-writer...`);
      const writerResult = await runSkill('tn-writer',
        `${book} ${chapter} --context ${contextPath}`,
        { provider, runtime, model: route.model || null, thinking: 'medium', maxTurns: route.maxTurns || 150, timeout: route.timeout || 45, cwd: selectedCwd, toolChoice: route.toolChoice });
      await reply(`tn-writer done (turns: ${writerResult.turns}, cost: $${(writerResult.cost || 0).toFixed(4)}). Running tn-quality-check...`);

      // 6. tn-quality-check (Sonnet)
      const qcResult = await runSkill('tn-quality-check',
        `${book} ${chapter} --context ${contextPath}`,
        { provider, runtime, model: 'sonnet', thinking: 'medium', maxTurns: 60, timeout: 20, cwd: selectedCwd });
      await reply(`tn-quality-check done (turns: ${qcResult.turns}, cost: $${(qcResult.cost || 0).toFixed(4)}).`);

      // 7. door43-push (TN)
      if (username) {
        await reply(`Pushing TN to Door43 for user **${username}**...`);
        const chPad = String(chapter).padStart(book.toUpperCase() === 'PSA' ? 3 : 2, '0');
        const sourcePath = resolveOutputFile(`output/notes/${book}/${book}-${chPad}.tsv`, book)
          || `output/notes/${book}/${book}-${chPad}.tsv`;
        const pushRes = await door43Push({
          type: 'tn', book, chapter, username,
          branch: buildBranchName(book, chapter),
          source: sourcePath,
        });
        await reply(`door43-push TN: ${pushRes.branchUrl || pushRes.details || (pushRes.success ? 'ok' : 'failed')}`);
      }

      await removeReaction(msgId, 'working_on_it');
      await addReaction(msgId, 'check');

      const totalCost = [issueResult, writerResult, qcResult]
        .filter(Boolean)
        .reduce((sum, r) => sum + (r.cost || 0), 0);
      await reply(`Notes pipeline complete. Total est. cost: $${totalCost.toFixed(4)}.`);
      return;
    }

    // --- Normal single-skill flow ---
    const runtimeLabel = runtime ? ` via **${runtime}**` : '';
    await reply(`Running **${skillName}** via **${provider}**${runtimeLabel} for \`${prompt}\`...`);

    const startTime = Date.now();
    const skillContext = parseBookChapterUser(prompt, message.sender_email);
    const result = await runSkill(skillName, prompt, {
      provider,
      runtime,
      model,
      thinking: route.thinking || 'medium',
      maxTurns: route.maxTurns || 100,
      timeout: route.timeout || 30,
      cwd: selectedCwd,
      verbose: !!route.verbose,
      dryRun: isDryRun,
      toolChoice: route.toolChoice,
      systemAppend: getProviderSystemAppend(provider, skillName, skillContext),
    });

    await removeReaction(msgId, 'working_on_it');
    await addReaction(msgId, 'check');

    const output = (result.finalText || '(no text response)').trim();
    const summary = `API run complete. Turns: ${result.turns}, input: ${result.inputTokens}, output: ${result.outputTokens}, est cost: $${(result.cost || 0).toFixed(4)}.`;
    await reply(`${summary}\n\n${output}`);

    // --- Automatic Orchestration for initial-pipeline ---
    if (skillName === 'initial-pipeline' && !isDryRun) {
      const { book, chapter, username } = parseBookChapterUser(prompt, message.sender_email);
      if (book && chapter && username) {
        
        // 1. Run Alignment
        await reply(`LLM phase done. Starting **align-all-parallel** for ${book} ${chapter}...`);
        const alignRef = `${book} ${chapter} --ult --ust`; // always align both for now
        const alignResult = await runSkill('align-all-parallel', alignRef, {
          provider,
          runtime,
          model: 'sonnet', // use sonnet for alignment as it's cheaper/faster
          thinking: 'medium',
          maxTurns: 50,
          cwd: selectedCwd,
          systemAppend: getProviderSystemAppend(provider, 'align-all-parallel', { book, chapter }),
        });

        const tag = `${book}-${String(chapter).padStart(book === 'PSA' ? 3 : 2, '0')}`;
        const alignedPattern = new RegExp(`^${tag}(?:-.*)?-aligned\\.usfm$`);
        const ultAligned = discoverFreshOutput('output/AI-ULT', book, alignedPattern, startTime);
        const ustAligned = discoverFreshOutput('output/AI-UST', book, alignedPattern, startTime);
        const alignmentWarnings = [];

        if (!ultAligned && !ustAligned) {
          throw new Error('Alignment phase failed: no aligned USFM files were produced.');
        }

        if (ultAligned) {
          const result = bestEffortAlignedOutputRepair({ alignedRelPath: ultAligned, book, chapter, ust: false });
          if (result.degraded) alignmentWarnings.push(`ULT ${result.summary}`);
        }

        if (ustAligned) {
          const result = bestEffortAlignedOutputRepair({ alignedRelPath: ustAligned, book, chapter, ust: true });
          if (result.degraded) alignmentWarnings.push(`UST ${result.summary}`);
        }

        if (alignmentWarnings.length > 0) {
          await reply(`Alignment completed with defects:\n- ${alignmentWarnings.join('\n- ')}`);
        }

        // 2. Door43 Push
        await reply(`Alignment done (turns: ${alignResult.turns}, cost: $${(alignResult.cost || 0).toFixed(4)}). Starting **door43-push** to user **${username}**...`);

        const pushResults = [];
        if (ultAligned) {
          const res = await door43Push({
            type: 'ult', book, chapter, username,
            branch: buildBranchName(book, chapter),
            source: ultAligned
          });
          pushResults.push(`ULT: ${res.branchUrl || res.details || (res.success ? 'ok' : 'failed')}`);
        }

        if (ustAligned) {
          const res = await door43Push({
            type: 'ust', book, chapter, username,
            branch: buildBranchName(book, chapter),
            source: ustAligned
          });
          pushResults.push(`UST: ${res.branchUrl || res.details || (res.success ? 'ok' : 'failed')}`);
        }

        await reply(`**door43-push** results:\n- ${pushResults.join('\n- ')}`);
      }
    }

  } catch (error) {
    await removeReaction(msgId, 'working_on_it');
    await addReaction(msgId, 'warning');
    await reply(`API run failed for **${skillName}** via **${provider}**${runtime ? ` / **${runtime}**` : ''}: ${error.message}`);
  }
}

module.exports = { apiPipeline };
