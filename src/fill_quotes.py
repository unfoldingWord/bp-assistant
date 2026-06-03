import re
import csv
from collections import defaultdict
import shutil
import json
import sys
import os
import tempfile

def build_tsv_notes(json_file):
    # Load JSON
    with open(json_file, "r", encoding="utf-8") as f:
        data = json.load(f)
    print(f"Python: path to file: {json_file}")

    headers = [
        "Reference",
        "ID",
        "Tags",
        "SupportReference",
        "Quote",
        "Occurrence",
        "Note",
        "Snippet"
    ]

    rows = []

    for item in data["items"]:

        reference = item.get("reference", "")
        note_id = item.get("id", "")
        tags = ""
        support_reference = item.get("sref", "")

        quote = item.get("gl_quote", "")

        # smart quotes cleanup
        quote = re.sub(r' "', ' “', quote)
        quote = re.sub(r'^"', '“', quote)
        quote = re.sub(r'" ', '” ', quote)
        quote = re.sub(r'"$', '”', quote)

        occurrence = ""
        note = ""
        snippet = quote

        row = {
            "Reference": reference,
            "ID": note_id,
            "Tags": tags,
            "SupportReference": support_reference,
            "Quote": quote,
            "Occurrence": occurrence,
            "Note": note,
            "Snippet": snippet
        }

        rows.append(row)

    return {
        "headers": headers,
        "rows": rows
    }

def read_usfm_data(file_path):
        with open(file_path, "r", encoding="utf-8") as f:
            return f.read()

def create_tsv_ult(ult_usfm):

    data = read_usfm_data(ult_usfm)

    def create_ult(data):
        chapter = None
        verse = None
        verse_words = []
        verse_data = []
        text = data
        text = re.sub(r' \\v', r'\n\\v', text)
        pattern = re.compile(r'\\w ([^|]*?)\||([“‘{(]+)\\|\*([){}.,:;!?…‘’“”\—\- ]+)')
        for line in text.splitlines():
            if line.startswith('\\c '):
                if verse_words:
                    verse_data.append(f'{chapter}:{verse}\t{" ".join(verse_words)}')
                match = re.search(r'\\c\s+(\d+)', line)
                if match:
                    chapter = int(match.group(1))
                verse_words = []
            elif line.startswith('\\v '):
                if verse_words:
                    verse_data.append(f'{chapter}:{verse}\t{" ".join(verse_words)}')
                match = re.search(r'\\v\s+(\d+)', line)
                if match:
                    verse = int(match.group(1))
                verse_words = []
                remainder = line[match.end():].strip()
                matches = pattern.findall(remainder)
                for match in matches:
                    if match[0]:
                        verse_words.extend(word.strip() for word in match[0].split())
                    if match[1]:
                        verse_words.append(match[1])
                    if match[2]:
                        verse_words.append(match[2])
            else:
                matches = pattern.findall(line)
                for match in matches:
                    if match[0]:
                        verse_words.extend(word.strip() for word in match[0].split())
                    if match[1]:
                        verse_words.append(match[1])
                    if match[2]:
                        verse_words.append(match[2])
        if verse_words:
            verse_data.append(f'{chapter}:{verse}\t{" ".join(verse_words)}')
        return verse_data

    def cleanup_lines(verse_data):
        cleaned_data = []
        for line in verse_data:
            line = re.sub(r'( )([.,;:’”?!\—\-})]+)', r'\2', line)
            line = re.sub(r'([({“‘\—\-]+)( )', r'\1', line)
            line = re.sub(r'(\w[’]) (s)', r'\1\2', line)
            line = re.sub(r'  +', r' ', line)
            line = re.sub(r'(\.),[ .,]*([\n])', r'\1\2', line)
            line = re.sub(r'(\.),[ .,]*([\w])', r'\1 \2', line)
            line = re.sub(r'\.\.+', r'.', line)
            line = re.sub(r'(\d,) (\d)', r'\1\2', line)
            line = line.strip()
            cleaned_data.append(line)
        return cleaned_data

    file_content = read_usfm_data(ult_usfm)
    verse_data = create_ult(file_content)
    cleaned_data = cleanup_lines(verse_data)
    headers = ['Reference', 'Verse']
    return {
        "headers": headers,
        "rows": cleaned_data
    }

def parse_verse_ref(verse_ref):
    # Function to split verse_ref into chapter and verse and return as tuple for sorting
    chapter, verse = verse_ref.split(':')
    return int(chapter), int(verse)

def get_hbo(file_name):

    data = read_usfm_data(file_name)

    return data

def find_unique_numbers(combined_text):
    # Initialize variables
    chapter = None
    verse = None
    unique_numbers = []
    current_number = 1  # Initialize a counter for consecutive numbering

    # Split the combined text by "\\v" to get verse chunks
    chunks = combined_text.split('\\v ')

    for chunk in chunks:

        # Find verse in the chunk
        verse_match = re.search(r'(\d+)', chunk)
        if verse_match:
            verse = int(verse_match.group(1))

        # Find Hebrew words in the chunk
        hebrew_words = re.findall(r'\\w (.+?)\|', chunk)

        if chapter is not None and verse is not None:
            verse_ref = f'{chapter}:{verse}'

            # Initialize a dictionary to keep track of word occurrences within the same verse
            word_occurrences = defaultdict(int)

            for word in hebrew_words:
                word_occurrences[word] += 1
                occurrence_number = word_occurrences[word]

                unique_numbers.append((verse_ref, word, current_number, occurrence_number))
                current_number += 1  # Increment the counter

                    # Find chapter in the chunk
        chapter_match = re.search(r'\\c (\d+)', chunk)
        if chapter_match:
            chapter = int(chapter_match.group(1))

    return unique_numbers

def combine_entries(ult_dict):
    # Add an index column starting at 1
    indexed_entries = [[i + 1] + list(entry) for i, entry in enumerate(ult_dict)]

    # Dictionary to store combined entries
    combined_entries = []

    # Group entries by (verse_ref, gloss, chunk_number)
    grouped_entries = defaultdict(list)

    for entry in indexed_entries:
        index, verse_ref, hebrew_word, number, gloss, chunk_number = entry

        key = (verse_ref, gloss, chunk_number)
        grouped_entries[key].append((index, verse_ref, hebrew_word, number, gloss, chunk_number))

    # Process each group
    for key, entries in grouped_entries.items():
        if len(entries) == 1:
            # If there's only one entry, add it directly
            combined_entries.append(entries[0])
        else:
            # Sort entries by index
            entries.sort(key=lambda x: x[0])

            # Check if hebrew_word is the same for all entries in the group
            same_hebrew_word = all(entry[2] == entries[0][2] for entry in entries)

            if same_hebrew_word:
                # If hebrew_word is the same, add each entry separately
                combined_entries.extend(entries)
            else:
                # If hebrew_word differs, combine hebrew_word and number entries
                combined_entry = list(entries[0])  # Start with the first entry
                combined_hebrew_words = [entries[0][2]]  # List to store combined hebrew_words
                combined_numbers = [str(entries[0][3])]  # List to store combined numbers

                for entry in entries[1:]:
                    combined_hebrew_words.append(entry[2])
                    combined_numbers.append(str(entry[3]))  # Convert number to string

                # Combine hebrew_words and numbers
                combined_entry[2] = ' '.join(combined_hebrew_words)
                combined_entry[3] = ' '.join(combined_numbers)

                combined_entries.append(tuple(combined_entry))  # Add as tuple for immutability

    # Sort combined_entries by the index column
    combined_entries.sort(key=lambda x: x[0])

    # Remove the index column
    final_entries = [entry[1:] for entry in combined_entries]

    return final_entries

def construct_ult_dict(file_name, unique_numbers):
    combined_text = read_usfm_data(file_name)

    ult_dict = []
    text_chunks = {}
    chapter = None
    verse = None

    # Split the combined text by "\\v" to get verse chunks
    chunks = combined_text.split('\\v ')

    for chunk in chunks:

        # Find verse in the chunk
        verse_match = re.search(r'(\d+)', chunk)
        if verse_match:
            verse = int(verse_match.group(1))

        if chapter is not None and verse is not None:
            verse_ref = f'{chapter}:{verse}'
            text_chunks[verse_ref] = chunk

        # Find chapter in the chunk
        chapter_match = re.search(r'\\c (\d+)', chunk)
        if chapter_match:
            chapter = int(chapter_match.group(1))

    for verse_ref, hebrew_word, number, occurrence_number in unique_numbers:
        if verse_ref in text_chunks:

            chunk = text_chunks[verse_ref]

            lexeme_chunks = chunk.split('-e\\*')

            chunk_number = 0  # Initialize a counter for consecutive numbering

            for lexeme_chunk in lexeme_chunks:

                chunk_number += 1

                escaped_hebrew_word = re.escape(hebrew_word)
                hebrew_pattern = re.compile(rf'zaln-s.+?x-occurrence="{occurrence_number}" x-occurrences="\d" x-content="{escaped_hebrew_word}".+?\\w\*\\zaln', re.DOTALL)
                matches = hebrew_pattern.findall(lexeme_chunk)

                for match in matches:

                    # Find instances of certain English words within the match
                    gloss_pattern = re.compile(r'\\w \b(.+?)\b\|')
                    gloss_matches = gloss_pattern.findall(match)

                    for gloss in gloss_matches:
                        ult_dict.append([verse_ref, hebrew_word, number, gloss, chunk_number])

    ult_dict_combined = combine_entries(ult_dict)

    # Sort ult_dict_combined by chapter, verse, and then by chunk_number
    ult_dict_sorted = sorted(ult_dict_combined, key=lambda x: (parse_verse_ref(x[0]), x[4]))
    return ult_dict_sorted

def combine_possessives(ult_dict):
    ult_dict_combined = []
    temp_dict = {}

    i = 0
    while i < len(ult_dict):
        entry = list(ult_dict[i])  # Convert tuple to list
        reference = entry[0]
        hebrew_word = entry[1]
        unique_number = entry[2]
        gloss = entry[3]
        chunk_number = entry[4]

        if gloss == 's':
            if i > 0:
                previous_entry = list(ult_dict[i - 1])  # Convert tuple to list
                prev_reference = previous_entry[0]
                prev_hebrew_word = previous_entry[1]
                prev_unique_number = previous_entry[2]
                prev_gloss = previous_entry[3]
                prev_chunk_number = previous_entry[4]

                if (reference == prev_reference and
                    chunk_number == prev_chunk_number and
                    unique_number == prev_unique_number and
                    hebrew_word == prev_hebrew_word):

                    # Add '’s' to the gloss of the previous entry
                    previous_entry[3] = prev_gloss + '’s'
                    # Update the previous entry in ult_dict_combined
                    ult_dict_combined[-1] = previous_entry
                    # Skip the current entry
                    i += 1
                    continue

        ult_dict_combined.append(entry)
        i += 1

    return ult_dict_combined

def is_hebrew(text):
    return bool(re.search(r'[\u0590-\u05FF]', text))

def find_sequence(ult_dict_combined, notes_dict, unique_numbers):
    data = notes_dict
    snippet_data = []

    # Step 1: Create a dictionary with verse_ref as key and concatenated string of gloss words as value
    gloss_dict = {}
    for entry in ult_dict_combined:
        verse_ref = entry[0]
        gloss_word = entry[3]
        chunk_number = entry[4]

        if verse_ref not in gloss_dict:
            gloss_dict[verse_ref] = []

        # Append a tuple of (gloss_word, chunk_number) to the list
        gloss_dict[verse_ref].append((gloss_word, chunk_number))

    # Convert the list of tuples to a concatenated string for each verse_ref
    final_gloss_dict = {verse_ref: ' '.join([f'{gloss_word} {chunk_number}' for gloss_word, chunk_number in gloss_words]) for verse_ref, gloss_words in gloss_dict.items()}

    # Step 2: Find sequences
    for row in data["rows"]:

        if not row.get("Snippet"):
            continue

        verse_ref = row.get("Reference", "")
        id = row.get("ID", "")
        phrase = row.get("Snippet", "").strip()
        quote = row.get("Quote", "").strip()

        # ------------------------------------------------------------------
        # HEBREW QUOTE PATH
        # ------------------------------------------------------------------
        if is_hebrew(quote):

            numbers = []
            chunk_numbers = []

            quote_words = quote.split()

            matched_numbers = []

            for qword in quote_words:
                for entry in unique_numbers:
                    verse_entry = entry[0]
                    hebrew_word = entry[1]
                    unique_num = entry[2]

                    if verse_entry != verse_ref:
                        continue

                    if hebrew_word == qword:
                        matched_numbers.append(int(unique_num))

            numbers.extend(matched_numbers)

            # Find aligned chunk numbers
            for entry in ult_dict_combined:
                entry_ref = entry[0]

                if entry_ref != verse_ref:
                    continue

                entry_nums = [int(n) for n in str(entry[2]).split() if n.isdigit()]

                if any(num in numbers for num in entry_nums):
                    chunk_numbers.append(int(entry[4]))

            numbers = sorted(set(numbers))
            chunk_numbers = sorted(set(chunk_numbers))

            snippet_data.append([verse_ref, phrase, numbers, chunk_numbers, id])

            continue

        # ------------------------------------------------------------------
        # EXISTING ENGLISH PATH
        # ------------------------------------------------------------------
        lower_phrase = phrase.lower()
        mod_phrase = re.sub(r'[.,]’', r'', lower_phrase)
        mod_phrase = re.sub('-', ' ', mod_phrase)
        mod_phrase = re.sub(r'(\d),(\d)', r'\1 \2', mod_phrase)
        mod_phrase = re.sub(r'[{}.,:;”‘“!?—*]', r'', mod_phrase)
        mod_phrase = re.sub('s’', 's', mod_phrase)
        mod_phrase = re.escape(mod_phrase)
        mod_phrase = re.sub(r'[\\ ]*…[\\ ]*', ' )(.+?)(', mod_phrase)
        mod_phrase = re.sub(r'\\\&', ')(.+?)(', mod_phrase)
        mod_phrase = re.sub(r'(\w+)', r'\\b\1\\b', mod_phrase)
        search_phrase = re.sub(r' ', r' \\d+ ', mod_phrase)
        search_phrase = search_phrase + ' \\d+'
        search_phrase = '(' + search_phrase + ')'

        chunk_numbers = []
        numbers = []

        if verse_ref in final_gloss_dict:
            gloss_text = final_gloss_dict[verse_ref].lower()
            matches = list(re.finditer(search_phrase, gloss_text))[:1]
            if matches:
                for match in matches:
                    if match.lastindex and match.lastindex == 3:
                        match = match.group(1) + match.group(3)
                    elif match.lastindex and match.lastindex == 5:
                        match = match.group(1) + match.group(3) + match.group(5)
                    elif match.lastindex and match.lastindex >= 7:
                        match = match.group(1) + match.group(3) + match.group(5) + match.group(7)
                    else:
                        match = match.group(0)
                    pairs = re.findall(r'(\w+) (\d+)', match)
                    if pairs:
                        for gloss_word, chunk_number in pairs:
                            for entry in ult_dict_combined:
                                if entry[0] == verse_ref and entry[3].lower() == gloss_word.lower() and entry[4] == int(chunk_number):
                                    entry_2_str = str(entry[2])
                                    if ' ' in entry_2_str:
                                        for num in entry_2_str.split():
                                            numbers.append(int(num))
                                    else:
                                        numbers.append(int(entry[2]))
                                    chunk_numbers.append(int(entry[4]))
            else:
                forward_text = None
                reversed_text = None
                forward_search_phrase = re.sub(r'(\\d\+) ', r'\1.*?', search_phrase)
                forward_matches = list(re.finditer(forward_search_phrase, gloss_text))[:1]
                for forward_match in forward_matches:
                    forward_text = forward_match.group(0)

                mod_search_phrase = re.sub(r'[\)\(]', '', search_phrase)
                mod_search_phrase = re.sub(r'\\ ', r' ', mod_search_phrase)
                reverse_search_phrase = ' '.join(mod_search_phrase.split()[::-1])
                reverse_search_phrase = re.sub(r' (\\d\+)', r'.*?\1', reverse_search_phrase)
                reverse_search_phrase = '(' + reverse_search_phrase + ')'

                reverse_gloss_text = ' '.join(gloss_text.split()[::-1])

                reverse_matches = list(re.finditer(reverse_search_phrase, reverse_gloss_text))[:1]
                for reverse_match in reverse_matches:

                    reversed_text = reverse_match.group(0)
                    reversed_text = ' '.join(reversed_text.split()[::-1])

                # --- Choose shortest match ---
                candidate_matches = [
                    m for m in [forward_text, reversed_text]
                    if m
                ]

                matches = []

                if candidate_matches:

                    best_match = min(
                        candidate_matches,
                        key=lambda x: len(x.split())
                    )

                    matches = [best_match]

                for match in matches:
                    pairs = re.findall(r'(\w+) (\d+)', match)
                    if pairs:
                        for gloss_word, chunk_number in pairs:
                            for entry in ult_dict_combined:
                                if entry[0] == verse_ref and entry[3].lower() == gloss_word.lower() and entry[4] == int(chunk_number):
                                    entry_2_str = str(entry[2])
                                    if ' ' in entry_2_str:
                                        for num in entry_2_str.split():
                                            numbers.append(int(num))
                                    else:
                                        numbers.append(int(entry[2]))
                                    chunk_numbers.append(int(entry[4]))

            # Sort numbers and chunk_numbers numerically
            numbers.sort()
            chunk_numbers.sort()

            snippet_data.append([verse_ref, phrase, numbers, chunk_numbers, id])
    return snippet_data

def remove_split_snippets(snippet_data, ult_dict_combined):
    # Build dictionaries for quick lookup, keyed by verse
    number_to_chunks_by_verse = {}
    chunk_to_numbers_by_verse = {}

    for ult_row in ult_dict_combined:
        verse = ult_row[0]
        # Split numbers like "8203 8204" into separate ints
        num_parts = [int(p) for p in str(ult_row[2]).split() if p.isdigit()]
        chunk_num = int(ult_row[4])

        number_to_chunks_by_verse.setdefault(verse, {})
        chunk_to_numbers_by_verse.setdefault(verse, {})

        for num in num_parts:
            number_to_chunks_by_verse[verse].setdefault(num, set()).add(chunk_num)
        chunk_to_numbers_by_verse[verse].setdefault(chunk_num, set()).update(num_parts)

    processed_snippet_data = []

    for row in snippet_data:
        verse_ref = row[0]
        phrase = row[1]
        id = row[4]

        # Handle split numbers in snippet_data
        numbers = []
        for n in row[2]:
            for part in str(n).split():
                if part.isdigit():
                    numbers.append(int(part))
        numbers = sorted(set(numbers))

        chunk_numbers = sorted(set(int(cn) for cn in row[3]))

        verse_num_to_chunks = number_to_chunks_by_verse.get(verse_ref, {})
        verse_chunk_to_numbers = chunk_to_numbers_by_verse.get(verse_ref, {})

        # Step 2: expand numbers and chunk_numbers
        added_new = False  # track if step 2 adds anything
        for number in list(numbers):  # copy so we can modify numbers
            if number in verse_num_to_chunks:
                for cn in verse_num_to_chunks[number]:
                    if cn not in chunk_numbers:
                        chunk_numbers.append(cn)
                        numbers.extend(verse_chunk_to_numbers.get(cn, []))
                        added_new = True  # mark that we added new chunks/numbers

        # Step 3: fill gaps only if step 2 added something
        if added_new:
            chunk_numbers = sorted(set(chunk_numbers))
            filled_chunk_numbers = []
            for i in range(len(chunk_numbers) - 1):
                filled_chunk_numbers.append(chunk_numbers[i])
                next_num = chunk_numbers[i + 1]
                if next_num != chunk_numbers[i] + 1:
                    for gap in range(chunk_numbers[i] + 1, next_num):
                        filled_chunk_numbers.append(gap)
                        numbers.extend(verse_chunk_to_numbers.get(gap, []))
            if chunk_numbers:
                filled_chunk_numbers.append(chunk_numbers[-1])

            chunk_numbers = sorted(set(filled_chunk_numbers))

        numbers = sorted(set(numbers))

        processed_snippet_data.append([verse_ref, phrase, numbers, chunk_numbers, id])

    return processed_snippet_data


def write_origl_and_snippet(snippet_data, ult_dict_combined, unique_numbers):
    processed_data = []

    # Step 1: Include each unique number only once within brackets
    for row in snippet_data:
        verse_ref = row[0]
        phrase = row[1]
        numbers = sorted(set(row[2]))  # Remove duplicates
        chunk_numbers = sorted(set(row[3]))  # Remove duplicates
        id = row[4]

        # Step 2: Replace "number" with the corresponding Hebrew word
        hebrew_words = []
        for num in numbers:
            for entry in unique_numbers:
                if entry[2] == num:
                    hebrew_words.append(entry[1])
                    break

        # Step 3: Replace "chunk_number" with the corresponding English words
        # Group English words by chunk number
        chunk_to_english = {}
        for entry in ult_dict_combined:
            entry_verse, chunk_num, eng_word = entry[0], int(entry[4]), entry[3]
            if entry_verse == verse_ref and chunk_num in chunk_numbers:
                chunk_to_english.setdefault(chunk_num, []).append(eng_word)

        # Join hebrew_words with '&' where numbers are not consecutive
        hebrew_phrase = ''
        for i, word in enumerate(hebrew_words):
            if i > 0 and numbers[i] != numbers[i - 1] + 1:
                hebrew_phrase += f' & {word}'
            else:
                hebrew_phrase += f' {word}'

        hebrew_phrase = hebrew_phrase.strip()

        # Build a lookup set of all (verse_ref, chunk_num) in ult_dict_combined
        ult_chunks = {
            (entry[0], int(entry[4]))
            for entry in ult_dict_combined
        }

        # Join words, adding '…' only if skipped chunk(s) actually exist in ult_dict_combined
        english_phrase = ''
        for i, cn in enumerate(chunk_numbers):
            words = chunk_to_english.get(cn, [])
            group = ' '.join(words)

            if i > 0 and cn != chunk_numbers[i - 1] + 1:
                prev_cn = chunk_numbers[i - 1]
                # Check if any missing chunk between prev_cn and cn exists in ult_dict_combined
                missing_exists = any(
                    (verse_ref, missing_cn) in ult_chunks
                    for missing_cn in range(prev_cn + 1, cn)
                )
                if missing_exists:
                    english_phrase += f' … {group}'
                else:
                    english_phrase += f' {group}'
            else:
                english_phrase += f' {group}'


        english_phrase = english_phrase.strip()

        # Append the processed row to processed_data
        processed_data.append([verse_ref, phrase, hebrew_phrase, english_phrase, id])
    return processed_data

def add_punctuation(origl_and_snippet, tsv_ult):
    data = tsv_ult["rows"]
    data_str = '\n'.join([''.join(row) for row in data])

    verse_map = {}

    for line in data_str.splitlines():
        if not line.strip():
            continue

        parts = line.split("\t", 1)

        verse = parts[0].strip()
        text = parts[1].strip() if len(parts) > 1 else ""

        verse_map[verse] = text

    for row in origl_and_snippet:
        verse_ref = row[0]

        if verse_ref not in verse_map:
            continue

        verse_text = verse_map[verse_ref]

        phrase = row[1]
        hebrew_words = row[2]
        english_words = row[3]
        id = row[4]

        if hebrew_words != '':

            # Create a regex pattern to match the phrase with punctuation
            search_phrase = re.sub(r' ', '[ .,;’”“‘!?:}{—–-]+', english_words)
            prepend_phrase = '[“’{]*'
            append_phrase = '[.,:"?!’”“‘}{]*'
            full_search_phrase = prepend_phrase + search_phrase + append_phrase

            # Find all matches of the search phrase in the data string
            matches = re.findall(full_search_phrase, verse_text)
            if matches:

                # Update english_words with the first match found
                row[3] = matches[0]
    return origl_and_snippet

def update_json_from_tsv(json_file, origl_and_snippet):
    """
    Update JSON entries using TSV data.

    Matches entries by:
        - reference
        - id

    Replaces:
        - all orig_quote fields
        - all gl_quote fields
        - all issue_span_gl_quote fields
        - all exact_ult_span fields
    """

    # Load JSON
    with open(json_file, "r", encoding="utf-8") as f:
        data = json.load(f)

    updates = {}

    for row in origl_and_snippet:

        key = (row[0], row[4])  # Reference + ID

        updates[key] = {
            "hebrew_phrase": row[2],
            "english_phrase": row[3]
        }

    # Update JSON entries
    for item in data["items"]:

        key = (item.get("reference", ""), item.get("id", ""))
        sref = item.get("sref", "")

        if key not in updates:
            continue

        update = updates[key]

        hebrew_phrase = update["hebrew_phrase"]
        english_phrase = update["english_phrase"]
        english_phrase = re.sub(r'[“”]', '"', english_phrase)
        english_phrase = re.sub(r'[‘’]', "'", english_phrase)
        if english_phrase.count('"') == 1 and (english_phrase.startswith('"') or english_phrase.endswith('"')):
            english_phrase = english_phrase.replace('"', '')
        english_phrase = re.sub(r'(^")(.+)("$)', r'\2', english_phrase)
        english_phrase = re.sub(r'[.,:;!]$', '', english_phrase)
        if sref != 'figs-rquestion':
            english_phrase = re.sub(r'\?$', '', english_phrase)
        english_phrase = english_phrase.replace('…', '&')

        # Top-level replacements
        if hebrew_phrase != '':
            item["orig_quote"] = hebrew_phrase
            item["gl_quote"] = english_phrase
            item["issue_span_gl_quote"] = english_phrase
            item["exact_ult_span"] = english_phrase

            # Nested writer_packet replacements
            if "writer_packet" in item:
                item["writer_packet"]["orig_quote"] = hebrew_phrase
                item["writer_packet"]["gl_quote"] = english_phrase
                item["writer_packet"]["issue_span_gl_quote"] = english_phrase
                item["writer_packet"]["exact_ult_span"] = english_phrase
        
        if hebrew_phrase == '':
            if english_phrase == '':
                continue
            if item.get('orig_quote', '') != '':
                continue
            else:
                item["orig_quote"] = english_phrase
                item["gl_quote"] = english_phrase
                item["issue_span_gl_quote"] = english_phrase
                item["exact_ult_span"] = english_phrase

                # Nested writer_packet replacements
                if "writer_packet" in item:
                    item["writer_packet"]["orig_quote"] = english_phrase
                    item["writer_packet"]["gl_quote"] = english_phrase
                    item["writer_packet"]["issue_span_gl_quote"] = english_phrase
                    item["writer_packet"]["exact_ult_span"] = english_phrase

    def safe_write_json(json_file, data):
        # 1. Write to temp file in same directory
        dir_name = os.path.dirname(json_file)

        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            delete=False,
            dir=dir_name
        ) as tmp:
            json.dump(data, tmp, ensure_ascii=False, indent=2)
            temp_path = tmp.name

        # 2. Backup old file (only AFTER successful write)
        if os.path.exists(json_file):
            backup_file = json_file + ".bak"
            shutil.move(json_file, backup_file)

        # 3. Atomic replace
        shutil.move(temp_path, json_file)

    safe_write_json(json_file, data)

def fill_quotes(ult_usfm, uhb_usfm, prep_notes):

    ai_notes = build_tsv_notes(prep_notes)

    tsv_ult = create_tsv_ult(ult_usfm)

    combined_text = get_hbo(uhb_usfm)
    unique_numbers = find_unique_numbers(combined_text)

    ult_dict = construct_ult_dict(ult_usfm, unique_numbers)
    ult_dict_combined = combine_possessives(ult_dict)

    snippet_data = find_sequence(ult_dict_combined, ai_notes, unique_numbers)
    processed_snippet_data = remove_split_snippets(snippet_data, ult_dict_combined)

    origl_and_snippet = write_origl_and_snippet(processed_snippet_data, ult_dict_combined, unique_numbers)

    origl_and_snippet = add_punctuation(origl_and_snippet, tsv_ult)

    update_json_from_tsv(prep_notes, origl_and_snippet)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise ValueError("Usage: script.py ult_usfm uhb_usfm prep_notes")

    ult_usfm = sys.argv[1]
    uhb_usfm = sys.argv[2]
    prep_notes = sys.argv[3]

    fill_quotes(ult_usfm, uhb_usfm, prep_notes)
