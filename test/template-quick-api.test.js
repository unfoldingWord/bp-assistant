// template-quick API — schema, invariants, and prompt helpers (no live model calls).
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  BodySchema,
  buildUserMessage,
  sanitizeModelOutput,
  checkTemplateInvariants,
  extractStructuralTokens,
  extractNumbering,
  extractBoldRuns,
  lineBreakSignature,
  resolveRequestBudgetMs,
  MAX_BODY_BYTES,
  REQUEST_BUDGET_MS,
  EDITOR_CLIENT_CEILING_MS,
  DEFAULT_REQUEST_BUDGET_MS,
} = require('../src/api/template-quick');

const validBody = {
  templateId: 'figs-metaphor-01',
  supportRef: 'figs-metaphor',
  type: 'self',
  sourceMd: 'SPEAKER is speaking of himself in the third person as **text** to show humility. Alternate translation: [text]',
  targetMd: null,
  targetLang: 'ar',
  targetOrg: 'BSOJ',
  direction: 'rtl',
};

describe('BodySchema', () => {
  test('accepts a minimal valid payload from the contract', () => {
    const r = BodySchema.safeParse(validBody);
    assert.equal(r.success, true);
    assert.equal(r.data.model, 'sonnet');
  });

  test('accepts built-in template rows', () => {
    const r = BodySchema.safeParse({
      ...validBody,
      templateId: 'builtin-tcm',
      supportRef: '(built-in)',
      type: 'quick-fill',
      sourceMd: '(1) First option\n(2) Second option',
      direction: 'ltr',
      targetLang: 'es-419',
    });
    assert.equal(r.success, true);
  });

  test('accepts null type and a non-null targetMd (revision path)', () => {
    const r = BodySchema.safeParse({
      ...validBody,
      type: null,
      targetMd: 'مسودة موجودة مع SPEAKER و [text]',
    });
    assert.equal(r.success, true);
    assert.equal(r.data.targetMd.startsWith('مسودة'), true);
  });

  test('rejects missing sourceMd / bad direction / bad lang', () => {
    assert.equal(BodySchema.safeParse({ ...validBody, sourceMd: '' }).success, false);
    assert.equal(BodySchema.safeParse({ ...validBody, direction: 'vertical' }).success, false);
    assert.equal(BodySchema.safeParse({ ...validBody, targetLang: 'ARABIC' }).success, false);
    assert.equal(BodySchema.safeParse({ ...validBody, targetOrg: 'bad org!' }).success, false);
  });

  test('rejects empty string targetMd (must be null or non-empty)', () => {
    assert.equal(BodySchema.safeParse({ ...validBody, targetMd: '' }).success, false);
  });

  test('accepts sourceMd longer than 16k when under the 64 KiB contract ceiling', () => {
    const sourceMd = 'x'.repeat(16_001);
    const r = BodySchema.safeParse({ ...validBody, sourceMd });
    assert.equal(r.success, true);
  });

  test('rejects a markdown field that exceeds the 64 KiB ceiling', () => {
    const sourceMd = 'x'.repeat(MAX_BODY_BYTES + 1);
    assert.equal(BodySchema.safeParse({ ...validBody, sourceMd }).success, false);
  });
});

describe('buildUserMessage', () => {
  test('includes source and asks for a fresh translation when targetMd is null', () => {
    const msg = buildUserMessage(BodySchema.parse(validBody));
    assert.match(msg, /English source template/);
    assert.match(msg, /SPEAKER is speaking/);
    assert.match(msg, /Translate the English source template into Arabic/);
    assert.doesNotMatch(msg, /Existing draft translation/);
  });

  test('asks to revise when targetMd is present', () => {
    const msg = buildUserMessage(BodySchema.parse({
      ...validBody,
      targetMd: 'مسودة',
    }));
    assert.match(msg, /Existing draft translation/);
    assert.match(msg, /Revise the existing draft/);
    assert.match(msg, /مسودة/);
  });

  test('mentions placeholder-preservation instruction', () => {
    const msg = buildUserMessage(BodySchema.parse(validBody));
    assert.match(msg, /Preserve every placeholder token exactly/);
  });

  test('includes repair block when previous draft failed invariants', () => {
    const msg = buildUserMessage(BodySchema.parse(validBody), {
      previous: 'المتحدث يقول [نص]',
      violations: ['placeholders: expected [SPEAKER, **text**, [text]] but got []'],
    });
    assert.match(msg, /FAILED structural checks/);
    assert.match(msg, /placeholders: expected/);
    assert.match(msg, /المتحدث يقول/);
  });
});

describe('sanitizeModelOutput', () => {
  test('trims and unwraps a single markdown fence', () => {
    assert.equal(sanitizeModelOutput('  hello  '), 'hello');
    assert.equal(
      sanitizeModelOutput('```md\nSPEAKER says [text]\n```'),
      'SPEAKER says [text]',
    );
  });

  test('leaves multi-line prose alone', () => {
    const prose = '(1) First\n(2) Second';
    assert.equal(sanitizeModelOutput(prose), prose);
  });
});

describe('checkTemplateInvariants', () => {
  test('extracts ordered placeholders including relative link paths', () => {
    const md = 'See SPEAKER and **text** then [ALT] and [text]; also [Genesis 1:1](../01/01.md) and {book}.';
    assert.deepEqual(extractStructuralTokens(md), [
      'SPEAKER',
      '**text**',
      '[ALT]',
      '[text]',
      'link:../01/01.md',
      '{book}',
    ]);
  });

  test('passes when placeholders and numbering are preserved (labels may change)', () => {
    const source = 'SPEAKER as **text**. (1) One (2) Two. See [Genesis 1:1](../01/01.md). Alternate: [text]';
    const target = 'SPEAKER كما **text**. (1) واحد (2) اثنان. انظر [تكوين 1:1](../01/01.md). بديل: [text]';
    const r = checkTemplateInvariants(source, target);
    assert.equal(r.ok, true);
    assert.deepEqual(r.violations, []);
  });

  test('fails when SPEAKER is translated', () => {
    const source = 'SPEAKER is speaking as **text**. Alternate: [text]';
    const target = 'المتحدث يتكلم كما **text**. بديل: [text]';
    const r = checkTemplateInvariants(source, target);
    assert.equal(r.ok, false);
    assert.match(r.violations.join(' '), /placeholders/);
  });

  test('fails when [text] is reordered relative to **text**', () => {
    const source = 'Keep **text** before [text].';
    const target = 'Keep [text] before **text**.';
    const r = checkTemplateInvariants(source, target);
    assert.equal(r.ok, false);
    assert.match(r.violations.join(' '), /placeholders/);
  });

  test('fails when a relative link path changes', () => {
    const source = 'See [Genesis 1:1](../01/01.md).';
    const target = 'انظر [تكوين 1:1](../01/02.md).';
    const r = checkTemplateInvariants(source, target);
    assert.equal(r.ok, false);
    assert.match(r.violations.join(' '), /placeholders/);
  });

  test('fails when numbering is dropped or reordered', () => {
    assert.deepEqual(extractNumbering('(1) a (2) b'), ['1', '2']);
    const source = '(1) First\n(2) Second';
    const dropped = checkTemplateInvariants(source, 'First\nSecond');
    assert.equal(dropped.ok, false);
    assert.match(dropped.violations.join(' '), /numbering/);

    const reordered = checkTemplateInvariants(source, '(2) Second\n(1) First');
    assert.equal(reordered.ok, false);
    assert.match(reordered.violations.join(' '), /numbering/);
  });

  test('fails when directional controls are inserted', () => {
    const source = 'SPEAKER and [text]';
    const target = `SPEAKER\u200F and [text]`; // RLM
    const r = checkTemplateInvariants(source, target);
    assert.equal(r.ok, false);
    assert.match(r.violations.join(' '), /directional_controls/);
  });

  test('fails when a line break is collapsed', () => {
    const source = 'SPEAKER says **important words** to [text].\nThen continue.';
    const collapsed = 'SPEAKER says **important words** to [text]. Then continue.';
    const r = checkTemplateInvariants(source, collapsed);
    assert.equal(r.ok, false);
    assert.match(r.violations.join(' '), /line_breaks/);
  });

  test('passes when line-break structure is preserved (including an internal blank line)', () => {
    const source = 'SPEAKER says **important words** to [text].\n\nThen continue.';
    const target = 'SPEAKER يقول **كلمات مهمة** إلى [text].\n\nثم تابع.';
    assert.deepEqual(lineBreakSignature(source), ['text', 'blank', 'text']);
    const r = checkTemplateInvariants(source, target);
    assert.equal(r.ok, true, r.violations.join('; '));
  });

  test('fails when ordinary bold markers are removed', () => {
    const source = 'SPEAKER says **important words** to [text].';
    const target = 'SPEAKER says important words to [text].';
    const r = checkTemplateInvariants(source, target);
    assert.equal(r.ok, false);
    assert.match(r.violations.join(' '), /bold_runs/);
  });

  test('passes when ordinary bold content is translated but markers remain', () => {
    const source = 'SPEAKER says **important words** as **text** then [text].';
    const target = 'SPEAKER يقول **كلمات مهمة** كما **text** ثم [text].';
    assert.deepEqual(
      extractBoldRuns(source).map((b) => (b.isSlot ? 'slot' : 'bold')),
      ['bold', 'slot'],
    );
    const r = checkTemplateInvariants(source, target);
    assert.equal(r.ok, true, r.violations.join('; '));
  });

  test('fails when **text** slot inner content is translated inside bold', () => {
    const source = 'Keep **text** here.';
    const target = 'Keep **نص** here.';
    const r = checkTemplateInvariants(source, target);
    assert.equal(r.ok, false);
    assert.ok(
      /placeholders|bold_runs/.test(r.violations.join(' ')),
      r.violations.join('; '),
    );
  });
});

describe('limits', () => {
  test('body cap matches the editor 64 KiB ceiling', () => {
    assert.equal(MAX_BODY_BYTES, 64 * 1024);
  });

  test('request budget defaults under the editor 120 s ceiling', () => {
    assert.equal(DEFAULT_REQUEST_BUDGET_MS, 90_000);
    assert.equal(EDITOR_CLIENT_CEILING_MS, 120_000);
    assert.ok(REQUEST_BUDGET_MS > 0);
    assert.ok(REQUEST_BUDGET_MS <= EDITOR_CLIENT_CEILING_MS);
  });

  test('resolveRequestBudgetMs caps env overrides at the 120 s editor ceiling', () => {
    assert.equal(resolveRequestBudgetMs('180000'), EDITOR_CLIENT_CEILING_MS);
    assert.equal(resolveRequestBudgetMs('60000'), 60_000);
    assert.equal(resolveRequestBudgetMs('0'), DEFAULT_REQUEST_BUDGET_MS);
    assert.equal(resolveRequestBudgetMs('nope'), DEFAULT_REQUEST_BUDGET_MS);
    assert.equal(resolveRequestBudgetMs(''), DEFAULT_REQUEST_BUDGET_MS);
  });
});
