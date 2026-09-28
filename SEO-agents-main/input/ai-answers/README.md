# Pasted chat-assistant answers — operator protocol

`input/data-access.md` marks chat assistants **no** (no API, no authenticated
multi-turn session). No agent in this repo may simulate, paraphrase or predict an
assistant answer. The only answers that exist are the ones an operator pastes here.

## File naming — one file per assistant per date

```
input/ai-answers/chatgpt-YYYY-MM-DD.md
input/ai-answers/claude-YYYY-MM-DD.md
input/ai-answers/perplexity-YYYY-MM-DD.md
input/ai-answers/gemini-YYYY-MM-DD.md
```

## How to run

1. Open the prompt set in `output/smoke/2026-09-25/conversational-query-researcher.md`.
2. Start a **fresh chat with no memory / no personalisation** for each prompt
   (a warmed session contaminates the result).
3. Send the prompt verbatim. Do not add "in the US" or any other steer unless the
   prompt says to.
4. Paste the answer **verbatim**, including the citation list. Do not summarise.
5. For the 10 prompts marked FOLLOW-UP, send turn 2 and turn 3 in the same chat
   and paste all three turns.
6. Record web-access mode (browsing on/off) — it changes everything.

## Block template — copy once per prompt

```markdown
### PROMPT_ID: <e.g. HC-03>
- **Assistant:** chatgpt | claude | perplexity | gemini
- **Model / mode:** <e.g. GPT-5 Thinking, browsing ON>
- **Date run (YYYY-MM-DD):**
- **Session:** fresh / continued
- **Prompt sent (verbatim):**
> <paste the exact prompt text>

**Answer turn 1 (verbatim, unedited):**
<paste>

**Answer turn 2 (verbatim) — FOLLOW-UP prompts only:**
<paste or: n/a>

**Answer turn 3 (verbatim) — FOLLOW-UP prompts only:**
<paste or: n/a>

**Cited URLs (full URLs, in the order shown):**
1.
2.

**Operator notes:** <refusals, "I can't browse", truncation, anything odd>
```

## Rules for the analysing agent

- A prompt with no pasted block is `[not checked — operator run pending]`.
  It is **never** "brand not mentioned".
- Absence of a paste is never absence in the answer.
