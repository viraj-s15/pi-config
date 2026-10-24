---
name: source-to-study-notes
description: Create thorough Markdown learning notes and a short revision recap from lecture PPTs, PDFs, textbooks, and multiple sources. Use when turning course resources or assigned readings into notes, preparing a module for topic-by-topic study, or matching existing course-note style.
---

# Source to study notes

1. Identify the course/module using the current syllabus, not archive names or PDF prefixes. Load any course-specific study skill. Check for existing notes before creating or replacing files; preserve unrelated work.
2. Read representative full notes and short recaps in the repository to match their structure, depth, math, and naming. Confirm the assigned chapters/sections and textbook edition. Do not silently substitute another edition or a current web draft for an unavailable assigned version; record the version and uncertainty.
3. Extract text before viewing pixels. Follow local extraction instructions; try the configured `doc2text` helper, then `pdftotext -layout` if unavailable or size-limited. Extract PPTX text with an available parser. Read every assigned section and slide in bounded chunks, including tables, captions, and substantive appendices. Extraction is not completed reading. For unrecoverable diagrams/equations, use a text-returning visual agent if available or explicitly record the gap.
4. Build a source-to-section coverage map. Reconcile overlap and contradictions; distinguish lecture material, assigned-reading extensions, and optional supplements. Verify printed/PDF page mappings before citing pages. Never infer exam scope from a source's presence.
5. Write self-contained **full notes** at the established path (default `Lecture Notes/Module N.md`): motivation, plain definitions and notation, formulas explained symbol by symbol, worked examples, algorithms/assumptions, common mistakes, source references, and self-checks with answers. Explain reasoning rather than transcribing bullets. Cover the full assigned reading, not only slide topics.
6. Write a genuinely **short recap** (default `short/Module N.md`): recognition terms, essential formulas, decision rules, and high-value pitfalls. Link the full notes; do not duplicate the chapter.
7. Audit coverage, arithmetic, assumptions, source claims, links, math/code delimiters, and missing text. Test tractable numeric examples with code. Report unresolved source gaps honestly. Keep source downloads/extraction caches outside tracked notes unless requested.
8. Finish with file paths, source/version caveats, and readiness for study. Do not start teaching until asked. Preparing notes does not establish learner mastery; preserve existing study progress.
