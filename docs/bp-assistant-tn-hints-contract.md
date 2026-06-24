# TN Note Hints — bible-editor ↔ bp-assistant Contract

> Shared, authoritative contract for the **`options.hints`** field on
> `POST /api/pipeline/start` with `pipelineType: "notes"`. Both repos
> (`bible-editor` and `bp-assistant`) work from this file. It is the hint-
> specific companion to the full pipeline API spec in
> `pipeline-api-contract.md` (§3.1); where they overlap, this file is the
> source of truth for hint validation and behavior.
>
> Server-side implementation: `src/api/pipeline.js` (`HintSchema`,
> `StartBodySchema`), `src/workspace-tools/tn-tools.js`
> (`applyHintsToPreparedNotes`), `src/notes-pipeline.js` (application point).

---

## 1. What a hint is

A hint is the translator (via bible-editor) saying: *"I have already decided
there should be a TN note here, framed like this — produce it, and don't let
the AI generate a competing note for the same spot."*

The editor marks a row in its chapter view; bp-assistant expands it into a
full, house-style TN row **and preserves the row's id**, so bible-editor can
reconcile the result back into its store by id rather than by diffing prose.

Hints are only valid on `pipelineType: "notes"`.

---

## 2. What bible-editor sends

```ts
interface PipelineHint {
  rowId: string;              // ^[a-z][a-z0-9]{3}$  — see §3
  verse: number;              // 1..200, 1-based
  quote: string;              // source-language phrase; may be "" (see §4)
  supportReference: string | null;  // rc:// TA link, or null
  seed: string | null;        // prose framing the writer expands; see §4
}
```

Sent as `options.hints: PipelineHint[]` (max 50) on the start request:

```json
{
  "pipelineType": "notes",
  "book": "HOS",
  "startChapter": 7,
  "endChapter": 7,
  "username": "stephen-wunrow",
  "sessionKey": "bible-editor/123/9f1c...",
  "options": {
    "hints": [
      {
        "rowId": "k7p2",
        "verse": 4,
        "quote": "חַסְדְּכֶם",
        "supportReference": "rc://*/ta/man/translate/figs-metaphor",
        "seed": "Their loyalty is as fleeting as morning dew — keep the dew image."
      }
    ]
  }
}
```

Field meanings:

- **`rowId`** — the stable TN row identifier. Preserved verbatim as TSV
  column 1 (`ID`) on the produced row. This is the reconciliation key.
- **`verse`** — which verse the note targets. Hints carry a verse but **no
  chapter**, which is why a hint request must be single-chapter (§3).
- **`quote`** — the source-language (Hebrew/Greek) phrase the note anchors
  to. Used both to suppress the competing AI note and as the produced row's
  `OrigWords`. May be `""` for a whole-verse general note (§4).
- **`supportReference`** — the rc:// TA article link, or `null`. Part of the
  suppression match key.
- **`seed`** — prose framing the `tn-writer` skill expands into a complete
  note. `null`/empty means "write from scratch" — only valid when `quote`
  is non-empty (§4).

---

## 3. Validation rules (enforced server-side)

Every rule below is enforced per-hint; a violation returns
`400 validation_failed`. The response carries the **full `issues[]` array** —
a single request can fail on several hints at once, so read **all** of them,
not just `issues[0]`. Each issue's `path` carries the offending hint's index,
e.g. `["options","hints",1,"rowId"]`.

| Rule | Detail |
|---|---|
| `pipelineType` must be `"notes"` | Hints are rejected on `generate`/`tqs`. |
| Single-chapter scope | `startChapter === endChapter` (or `endChapter` omitted). Hints carry a verse but no chapter, so a multi-chapter scope would be ambiguous. |
| `rowId` grammar `^[a-z][a-z0-9]{3}$` | **First char must be a lowercase letter**, then 3 lowercase-alphanumerics. This is the canonical TN TSV `ID` grammar — verified against production data, 0 of 8,666 real TN IDs start with a digit. A digit-first id (e.g. `"4mte"`) cannot legally exist in a TN TSV and is rejected. **bible-editor's row-id generator must produce letter-first ids.** |
| `rowId` unique within the request | Duplicate ids would produce ambiguous matches on the apply side. |
| At least one of `quote` / `seed` non-empty | See §4. A hint with `quote: ""` **and** empty/null `seed` is rejected. |
| ≤ 50 hints per request | Body cap is 32 KB. |
| `quote` ≤ 500 chars, `seed` ≤ 4000 chars, `supportReference` ≤ 200 chars | Per-field caps. |
| No unknown keys on the hint object | `HintSchema` is `.strict()`. |

---

## 4. Empty quote, empty seed, and the "general note" case

`quote` and `seed` are each independently optional-ish, but **never both
empty**:

| `quote` | `seed` | Meaning | Valid? |
|---|---|---|---|
| non-empty | non-empty | Phrase-anchored note, with framing. | ✅ |
| non-empty | `null`/`""` | Phrase-anchored note; writer chooses the angle from quote + supportReference. | ✅ |
| `""` | non-empty | **General-information note** for the whole verse (no specific phrase), framed by the seed. | ✅ |
| `""` | `null`/`""` | Nothing to anchor, nothing to expand — the writer has no signal. | ❌ `400` |

For a **general-information note** (no specific source phrase), send
`quote: ""` **with a non-empty `seed`**. The seed is the only thing telling
`tn-writer` what the note should say, so it is required in this case. An
empty-quote + empty-seed hint is a client error, not a silently-produced
empty note.

> bible-editor note: when coercing a general-info hint, send `quote: ""`
> (empty string), **not** `null` — `quote` is a non-nullable string. And
> always include a real `seed`.

---

## 5. What bp-assistant does with a hint

Hints are applied after mechanical note-prep and before the `tn-writer`
skill. For each hint:

1. **Suppress** — delete any AI-prepared note matching the hint on
   `(verse, supportReference, fuzzy-quote)`. The quote match is fuzzy
   (token-overlap ≥ 0.6 after Hebrew cantillation/whitespace normalization),
   so the editor's quote need not be byte-identical. An **empty `quote`**
   matches on `(verse, supportReference)` alone — note that an empty-quote,
   `null`-supportReference hint suppresses **every** no-supportReference note
   at that verse, then replaces them with the single pinned note.
2. **Inject** — add a synthetic prepared row carrying `rowId` (→ TSV `ID`),
   `quote` (→ `OrigWords`), `supportReference`, and `seed`. `tn-writer`
   expands `seed` into a complete, house-style note.

**Dropped hints are not an error.** A hint whose `verse` falls outside the
chapter's actual scope is skipped and the run still succeeds. Dropped hints
are reported in the bot's run log, not as a request error. Design for "N
hints in, ≤ N rows pinned" and reconcile by `rowId` presence (§6).

---

## 6. Reconciling the result

There is **no per-hint result in the API** (v1). The `GET /api/pipeline/{jobId}`
status does not echo which hints applied / suppressed / dropped — that detail
is only in the bot's run log.

The observable outcome is the produced TSV (pulled from Door43 `master`; see
`pipeline-api-contract.md` §6). Reconcile by matching the `rowId`s you sent
against the column-1 `ID`s in the pulled `tn_{BOOK}.tsv`:

- `rowId` present → the hint was expanded into that row; `UPDATE … WHERE id = rowId`.
- `rowId` absent → the hint was dropped (out-of-scope verse) or never applied.

Because the whole-book TSV is mutated in place, import only the rows for the
requested chapter; don't replace the whole book.

---

## 7. Worked rejection example

bible-editor sent (HOS 7):

```json
"hints": [
  { "rowId": "sych", "verse": 12, "quote": null, "supportReference": null, "seed": "" },
  { "rowId": "4mte", "verse": 13, "quote": "And I, I would redeem them,", "supportReference": "rc://*/ta/man/translate/writing-pronouns", "seed": "explicit" }
]
```

Response — `400 validation_failed`, full `issues[]`:

```json
[
  { "code":"invalid_type", "expected":"string",
    "path":["options","hints",0,"quote"],
    "message":"Invalid input: expected string, received null" },
  { "code":"invalid_format", "format":"regex",
    "pattern":"/^[a-z][a-z0-9]{3}$/",
    "path":["options","hints",1,"rowId"],
    "message":"Invalid string: must match pattern /^[a-z][a-z0-9]{3}$/" }
]
```

Two independent failures: hint 0's `quote` was `null` (must be a string;
send `""`), and hint 1's `rowId` `"4mte"` is digit-first (must be
letter-first). Note also that after fixing the `quote` to `""`, hint 0 would
*then* fail the §4 rule because its `seed` is also `""` — a general note
needs a non-empty seed.

---

## 8. Versioning

This contract tracks pipeline API v1. Non-breaking additions (new optional
hint fields, new validation that only tightens an already-ambiguous case)
won't bump the version. Breaking changes land alongside the pipeline API's
own v2.
