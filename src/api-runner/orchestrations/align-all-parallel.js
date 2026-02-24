// orchestrations/align-all-parallel.js — ULT + UST alignment in parallel

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
module.exports = async function alignAllParallel(runner, { prompt, opts }) {
  const { book, chapter, ch } = parsePrompt(prompt);
  const cwd = opts.cwd || '/srv/bot/workspace';

  console.log(`[align-all-parallel] Starting ULT + UST alignment for ${book} ${chapter}`);

  const [ultResult, ustResult] = await Promise.all([
    runner.runSkill('ULT-alignment', `${book} ${chapter}`, opts),
    runner.runSkill('UST-alignment', `${book} ${chapter}`, opts),
  ]);

  console.log(`[align-all-parallel] Complete for ${book} ${chapter}`);

  return {
    steps: [
      { name: 'ult-alignment', ...ultResult },
      { name: 'ust-alignment', ...ustResult },
    ],
  };
};
