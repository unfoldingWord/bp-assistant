const { runSkill } = require('./runner');
const { sendMessage, sendDM, addReaction, removeReaction } = require('../zulip-client');
const fs = require('fs');
const path = require('path');
const { door43Push } = require('../door43-push');
const { getDoor43Username, normalizeBookName, buildBranchName, discoverFreshOutput, checkPrerequisites, CSKILLBP_DIR } = require('../pipeline-utils');
const { buildNotesContext, readContext, writeContext } = require('../pipeline-context');
const { extractAlignmentData, prepareNotes, fillOrigQuotes, resolveGlQuotes, flagNarrowQuotes } = require('../workspace-tools/tn-tools');
const { checkUltEdits } = require('../check-ult-edits');

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

async function apiPipeline(route, message) {
  const stream = message.type === 'stream' ? message.display_recipient : null;
  const topic = message.subject || '';
  const msgId = message.id;
  const isDryRun = process.env.DRY_RUN === '1';

  const { skillName, args } = parseSkillSpec(route.skill);
  let prompt = extractPrompt(route, message.content);
  if (args) prompt = `${args} ${prompt}`.trim();

  const provider = parseProviderFromMessage(message.content) || route.provider || 'openai';
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
            { provider, model: 'sonnet', thinking: 'medium', maxTurns: 60, timeout: 20, cwd: selectedCwd });
          await reply(`post-edit-review done (turns: ${issueResult.turns}, cost: $${(issueResult.cost || 0).toFixed(4)}).`);
        } else {
          await reply(`AI artifacts found, no human edits — using existing issues TSV.`);
        }
      } else {
        await reply(`No AI artifacts (missing: ${prereqs.missing.join(', ')}) — running deep-issue-id...`);
        issueResult = await runSkill('deep-issue-id',
          `${book} ${chapter} --context ${contextPath}`,
          { provider, model: route.model || null, thinking: 'medium', maxTurns: 100, timeout: 30, cwd: selectedCwd });
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
        });
        resolveGlQuotes({
          preparedJson: ctx.runtime.preparedNotes,
          alignmentJson: ctx.runtime.alignmentData,
        });
      }

      flagNarrowQuotes({ preparedJson: ctx.runtime.preparedNotes });

      // 5. tn-writer (Opus by default)
      await reply(`Preprocessing done (${prepCount} items). Running tn-writer...`);
      const writerResult = await runSkill('tn-writer',
        `${book} ${chapter} --context ${contextPath}`,
        { provider, model: route.model || null, thinking: 'medium', maxTurns: route.maxTurns || 150, timeout: route.timeout || 45, cwd: selectedCwd, toolChoice: route.toolChoice });
      await reply(`tn-writer done (turns: ${writerResult.turns}, cost: $${(writerResult.cost || 0).toFixed(4)}). Running tn-quality-check...`);

      // 6. tn-quality-check (Sonnet)
      const qcResult = await runSkill('tn-quality-check',
        `${book} ${chapter} --context ${contextPath}`,
        { provider, model: 'sonnet', thinking: 'medium', maxTurns: 60, timeout: 20, cwd: selectedCwd });
      await reply(`tn-quality-check done (turns: ${qcResult.turns}, cost: $${(qcResult.cost || 0).toFixed(4)}).`);

      // 7. door43-push (TN)
      if (username) {
        await reply(`Pushing TN to Door43 for user **${username}**...`);
        const chPad = String(chapter).padStart(book.toUpperCase() === 'PSA' ? 3 : 2, '0');
        const pushRes = await door43Push({
          type: 'tn', book, chapter, username,
          branch: buildBranchName(book, chapter),
          source: `output/notes/${book}/${book}-${chPad}.tsv`,
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
    await reply(`Running **${skillName}** via **${provider}** for \`${prompt}\`...`);

    const startTime = Date.now();
    const result = await runSkill(skillName, prompt, {
      provider,
      model,
      thinking: route.thinking || 'medium',
      maxTurns: route.maxTurns || 100,
      timeout: route.timeout || 30,
      cwd: selectedCwd,
      verbose: !!route.verbose,
      dryRun: isDryRun,
      toolChoice: route.toolChoice,
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
          model: 'sonnet', // use sonnet for alignment as it's cheaper/faster
          thinking: 'medium',
          maxTurns: 50,
          cwd: selectedCwd,
        });

        const tag = `${book}-${String(chapter).padStart(book === 'PSA' ? 3 : 2, '0')}`;
        const ultAligned = discoverFreshOutput('output/AI-ULT', book, new RegExp(`^${tag}-.*-aligned\\.usfm$`), startTime);
        const ustAligned = discoverFreshOutput('output/AI-UST', book, new RegExp(`^${tag}-.*-aligned\\.usfm$`), startTime);

        if (!ultAligned && !ustAligned) {
          throw new Error('Alignment phase failed: no aligned USFM files were produced.');
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
    await reply(`API run failed for **${skillName}** via **${provider}**: ${error.message}`);
  }
}

module.exports = { apiPipeline };
