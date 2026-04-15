function chapterTag(book, chapter) {
  const normalizedBook = String(book || 'BOOK').toUpperCase();
  const width = normalizedBook === 'PSA' ? 3 : 2;
  const numericChapter = Number.isFinite(Number(chapter)) ? Number(chapter) : chapter;
  return `${normalizedBook}-${String(numericChapter ?? '00').padStart(width, '0')}`;
}

function buildInitialPipelineNudge(extraLines, book, chapter) {
  const normalizedBook = String(book || 'BOOK').toUpperCase();
  const tag = chapterTag(normalizedBook, chapter);
  return `
CRITICAL: You are a multi-step pipeline orchestrator. Do NOT stop after reading source data.
Your task is NOT complete until ALL of the following files exist in the workspace:
- output/AI-ULT/${normalizedBook}/${tag}.usfm  (ULT plain text)
- output/AI-UST/${normalizedBook}/${tag}.usfm  (UST plain text)
- output/issues/${normalizedBook}/${tag}.tsv   (issues TSV)
Use those exact canonical filenames, including the zero-padded chapter tag "${tag}".
Do NOT invent unpadded variants such as "${normalizedBook}-${Number(chapter)}.usfm".
Keep calling tools — writing files, delegating to sub-agents — until all three files are written.
${extraLines}
`.trim();
}

function getProviderSystemAppend(provider, skillName, context = {}) {
  if (skillName !== 'initial-pipeline') return '';
  const { book, chapter } = context;

  if (provider === 'openai') {
    return buildInitialPipelineNudge(
      'Verify they exist with a Glob or Read before declaring the task complete.',
      book,
      chapter
    );
  }

  if (provider === 'xai') {
    return buildInitialPipelineNudge(
      [
        'Do NOT collapse the issues TSV to a header-only file just because candidate notes resemble published TN notes.',
        'Published notes are reference material; keep concrete issue rows for note-worthy translation problems in this chapter.',
        'Verify the issues TSV has at least one data row before declaring the pipeline complete.',
      ].join('\n'),
      book,
      chapter
    );
  }

  return '';
}

module.exports = {
  getProviderSystemAppend,
};
