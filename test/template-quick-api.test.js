// template-quick API — schema and prompt helpers (no live model calls).
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  BodySchema,
  buildUserMessage,
  sanitizeModelOutput,
  MAX_BODY_BYTES,
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

describe('limits', () => {
  test('body cap matches the editor 64 KiB ceiling', () => {
    assert.equal(MAX_BODY_BYTES, 64 * 1024);
  });
});
