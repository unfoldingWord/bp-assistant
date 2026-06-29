import re
import csv
import unicodedata
from collections import defaultdict
import sys
import tempfile
import os
import shutil

# ============================================================
# HEBREW NORMALIZATION
# ============================================================

def normalize_hebrew(text):
    """
    Remove Hebrew vowels, accents, joiners, and normalize.
    """
    text = unicodedata.normalize("NFD", text)

    chars = []
    for ch in text:
        name = unicodedata.name(ch, "")

        if (
            "HEBREW POINT" in name
            or "HEBREW ACCENT" in name
            or "MASORA" in name
        ):
            continue

        if ch in ("\u2060", "\u200d", "\ufeff"):
            continue

        chars.append(ch)

    text = "".join(chars)

    text = text.replace("־", "")
    text = text.replace("⁠", "")

    return unicodedata.normalize("NFC", text).strip()


# ============================================================
# PARSE USFM ALIGNMENTS
# ============================================================

def build_alignment_map(usfm_path):
    """
    Returns:

    verse_map["10:1"] = [
        ("ישראל", 1),
        ("בוקק", 2),
        ("גפן", 4),
        ...
    ]
    """

    with open(usfm_path, encoding="utf-8") as f:
        usfm = f.read()

    verse_map = defaultdict(list)

    chapter = None
    verse = None

    token_pattern = re.compile(
        r'\\c\s+(\d+)'
        r'|\\v\s+(\d+)'
        r'|\\zaln-s\b.*?x-content="([^"]+)"'
        r'|\\w\s+([^|\\]+?)\|',
        re.DOTALL,
    )

    english_position = 0
    pending_hebrew = []

    for match in token_pattern.finditer(usfm):

        chap, vrs, hebrew, english = match.groups()

        if chap:
            chapter = chap
            continue

        if vrs:
            verse = f"{chapter}:{vrs}"
            english_position = 0
            pending_hebrew = []
            continue

        if hebrew:
            pending_hebrew.append(normalize_hebrew(hebrew))
            continue

        if english:
            english_position += 1

            if pending_hebrew:
                for hw in pending_hebrew:
                    verse_map[verse].append((hw, english_position))

                pending_hebrew = []

    return verse_map


# ============================================================
# FIND QUOTE POSITION
# ============================================================

def quote_position(quote, verse_alignments):
    """
    verse_alignments:
        [
            ("ישראל", 1),
            ("בוקק", 2),
            ...
        ]

    Returns:
        (position, length)
    """

    quote_parts = [p.strip() for p in quote.split("&")]

    positions = []
    total_words = 0

    hebrew_sequence = [h for h, _ in verse_alignments]
    english_positions = [p for _, p in verse_alignments]

    for part in quote_parts:

        words = [
            normalize_hebrew(w)
            for w in part.split()
            if normalize_hebrew(w)
        ]

        total_words += len(words)

        if not words:
            continue

        found = False

        for i in range(len(hebrew_sequence) - len(words) + 1):

            if hebrew_sequence[i:i + len(words)] == words:

                positions.append(english_positions[i])
                found = True
                break

        if not found:
            # fall back to first word only
            first_word = words[0]

            for i, hw in enumerate(hebrew_sequence):
                if hw == first_word:
                    positions.append(english_positions[i])
                    found = True
                    break

    if not positions:
        return None, total_words

    return min(positions), total_words


# ============================================================
# SORT NOTES
# ============================================================

def sort_notes(tsv_file, verse_map):

    with open(tsv_file, encoding="utf-8") as f:
        reader = csv.reader(f, delimiter="\t")
        header = next(reader)
        rows = list(reader)

    grouped = defaultdict(list)

    for original_index, row in enumerate(rows):

        if not row:
            continue

        reference = row[0]

        grouped[reference].append(
            {
                "row": row,
                "index": original_index,
            }
        )

    sorted_rows = []

    for reference in grouped:

        verse_notes = grouped[reference]

        decorated = []

        for note_index, note in enumerate(verse_notes):

            row = note["row"]

            note_id = row[1]

            quote = row[4].strip() if len(row) > 4 else ""

            verse_alignments = verse_map.get(reference, [])

            pos, quote_len = quote_position(
                quote,
                verse_alignments,
            )

            if pos is None:

                print(f"UNMATCHED: {reference}  {note_id}")

                sort_key = (
                    float("inf"),
                    0,
                    note_index,
                )

            else:

                sort_key = (
                    pos,
                    -quote_len,
                    note_index,
                )

            decorated.append(
                (
                    sort_key,
                    row,
                )
            )

        decorated.sort(key=lambda x: x[0])

        sorted_rows.extend(row for _, row in decorated)

    def safe_write_tsv(tsv_file, rows):
        # 1. Write to temp file in same directory
        dir_name = os.path.dirname(tsv_file)

        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            delete=False,
            dir=dir_name,
            newline="",
        ) as tmp:
            writer = csv.writer(
                tmp,
                delimiter="\t",
                lineterminator="\n",
                quoting=csv.QUOTE_MINIMAL,
            )
            writer.writerows(rows)
            temp_path = tmp.name

        # 2. Backup old file (only AFTER successful write)
        if os.path.exists(tsv_file):
            backup_file = tsv_file + ".old"
            shutil.move(tsv_file, backup_file)

        # 3. Atomic replace
        shutil.move(temp_path, tsv_file)

    safe_write_tsv(tsv_file, [header] + sorted_rows)

# ============================================================
# MAIN
# ============================================================

def sequence_notes(ult_usfm, notes_tsv):

    print("Reading alignments...")
    verse_map = build_alignment_map(ult_usfm)

    print("Sorting notes...")
    sort_notes(
        notes_tsv,
        verse_map,
    )

    print(f"Done. Output written to {notes_tsv}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise ValueError("Usage: script.py ult_usfm notes_tsv")

    ult_usfm = sys.argv[1]
    notes_tsv = sys.argv[2]

    sequence_notes(ult_usfm, notes_tsv)