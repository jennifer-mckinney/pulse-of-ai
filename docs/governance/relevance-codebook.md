# Relevance codebook v1: what counts as "about AI"

- **Version:** codebook_version: `1.0.0`
- **Status:** v1 draft. The label set and the binary metric are decided. Seven edge cases are OPEN for Jennifer (section 5.1).
- **Date:** 2026-09-30
- **Owner:** Jennifer McKinney
- **Research basis:** the AI-relevance state-of-the-art research of 2026-09-30 ("the research note" below; `docs/research/2026-10-01-ai-relevance-sota.md`).
- **Scope:** Relevance-accuracy Stage 0. This codebook defines the gold set that every later relevance and admission method is measured against. Nothing in the production pipeline reads it yet.

**Code that implements it:**
- `src/gold/codebook.js`: the version, labels, flags and methods. Tests hold the code and this document in step.
- `src/db/migrations/070_relevance_gold_set.sql`: the append-only gold tables.
- `scripts/gold-sample.js`, `scripts/gold-label.js` and `scripts/gold-agreement.js`: the gold-set tools.
- `src/config/ai-lexicon-tiers.js` and `scripts/relevance-eval.js`: the offline tiered lexicon and its harness.

---

## 1. Purpose

Pulse of AI decides, for every collected item, whether it is about artificial intelligence. Two registered methods make that decision today:
- **`admission_filter@1.0.0`** decides what is stored from site-wide and technology feeds.
- **`relevance@1.2.0`** scores every stored post.

Neither has ever been measured against human judgement. This codebook lets people label a sample of real items the same way, so that:
1. the precision and recall of the current methods, and of any replacement, can be measured per category, scope and language;
2. agreement between labellers, and between people and an LLM, can be measured before any label is trusted;
3. published shares can later be corrected with the gold set (research note, section 7).

## 2. The unit of labelling

- One **gold item** is one stored post (`raw_posts`) drawn into one sample (`relevance_gold_items`).
- The labeller judges the post **text as stored**: the title and the body or summary, joined. This is the text the pipeline scores.
- Judge only what the text says. Do not open links. Do not use knowledge of the source to decide; for example, "it is on an AI blog, so it must be about AI" is not a reason.
- The labelling tool shows the source **category**, which gives context for the kind of text. It does **not** show the current relevance decision, the stratum, or any other labeller's label. Labelling is blind. The exception is adjudication (section 7).

## 3. Labels (exactly one per item)

| Label | Meaning | Decision rule |
|---|---|---|
| `AI_CENTRAL` | AI is the main topic. | Remove every AI mention and the text loses its point. |
| `AI_INCIDENTAL` | AI is mentioned substantively, but the main topic is something else. | The AI mention carries information (what the AI does, a claim about AI, AI as a factor), yet the text is mainly about something else. |
| `NOT_AI` | Not about AI. | No AI content, a non-AI sense of an ambiguous word, or a mention so slight that it carries no information about AI (for example a sign-off or a tag list). |

**What "AI" means here.** AI means systems that learn from data or generate or interpret content with learned models. This covers:
- machine learning and deep learning;
- neural networks;
- large language models and chatbots;
- generative image, audio and video models;
- computer vision and speech recognition built on learned models;
- AI agents;
- the companies, products, policy, safety, labour and culture *about* those systems.

**Where the boundary between AI and not-AI is unclear**, it is set in section 5. A labeller who cannot place an item applies the closest rule there and adds a note.

### 3.1 Worked examples

| Text (abridged) | Label | Why |
|---|---|---|
| "OpenAI releases a new reasoning model with a 1M-token context" | `AI_CENTRAL` | An AI product is the topic. |
| "EU parliament adopts the AI Act" | `AI_CENTRAL` | AI regulation is the topic. |
| "Bank's quarterly results: revenue up 4%, cost savings partly from AI-assisted customer service" | `AI_INCIDENTAL` | The topic is the results; AI is a substantive factor. |
| "Hospital staffing crisis deepens; administrators hope automation and AI triage can help" | `AI_INCIDENTAL` | The topic is staffing; AI is a substantive proposal. |
| "Our newsletter: politics, sport, weather. Tags: #AI #news" | `NOT_AI` | A tag only, so no information about AI. |
| "A transformer exploded at the substation; 11 kV lines down" | `NOT_AI` | Electrical transformer. |
| "Gemini horoscope for the week" | `NOT_AI` | Zodiac sign. |
| "Air India flight AI 171 crashed after take-off" | `NOT_AI` | Flight number. |
| "Download the logo as an AI or EPS file" | `NOT_AI` | Adobe Illustrator file format. |
| "Artificial insemination (AI) improves herd fertility" | `NOT_AI` | A different "AI". |
| "人工智能正在改变医疗" ("AI is transforming healthcare") | `AI_CENTRAL` | Judged by meaning, in any language. Add `LANG` if you cannot read it. |

## 4. Flags (zero or more per item, independent of the label)

| Flag | Meaning |
|---|---|
| `SPAM` | Unsolicited promotional or deceptive content. Examples: phone-scam "customer care number" posts, airline-support SEO spam, pump-and-dump promotion, link farms. The label still records the topic; most spam is `NOT_AI`, but AI-themed spam is labelled by topic and flagged. |
| `BOT_GENERATED` | The text was produced by an automated account or process, not written by a person for this post. Examples: dependency-bot pull requests, automated digests, auto-generated issue reports, feed aggregator dumps. |
| `LANG` | The labeller could not judge the text with confidence because of its language. The label is provisional, and the item should be labelled again by someone who reads the language. |

## 5. Edge cases

### 5.1 OPEN: rulings needed from Jennifer

Each case below is labelled **by the label definitions in section 3 until it is ruled**, with a note naming the case, so that relabelling after the ruling is mechanical. The tiered lexicon library tags each one (the tag id is in brackets) and never decides it.

#### 5.1.1 Game AI (`game_ai`)
**Status: OPEN**
- **The case:** "AI" for scripted video-game opponents, NPC behaviour and difficulty settings. For example, "the enemy AI is too easy". These are usually hand-written rules, not learned models.
- **Options:**
  - (a) `NOT_AI` unless the text describes learned or generative systems in games;
  - (b) `AI_INCIDENTAL` whenever game AI is discussed;
  - (c) `AI_CENTRAL` when game AI is the topic.
- **Note for the decision:** option (a) fits the definition in section 3 (learned systems). Options (b) and (c) follow everyday usage of the word.

#### 5.1.2 Robotics without learning (`robotics_without_learning`)
**Status: OPEN**
- **The case:** robots with no stated learning or AI component, such as industrial arms, robot vacuums, warehouse robots, surgical robots and robot competitions.
- **Options:**
  - (a) `NOT_AI` unless learning, perception models or AI are stated;
  - (b) `AI_INCIDENTAL` for any robotics;
  - (c) `AI_CENTRAL` for any robotics.
- **Note for the decision:** `admission_filter@1.0.0` admits every "robot" or "robotics" mention today, so this ruling decides whether those admissions count as correct.

#### 5.1.3 Autonomous vehicles (`autonomous_vehicles`)
**Status: OPEN**
- **The case:** self-driving cars, robotaxis and driver-assistance systems. Examples include Waymo and Tesla FSD stories that never say "AI".
- **Options:**
  - (a) always AI, because autonomy is built on learned perception;
  - (b) AI only when AI, learning or models are stated;
  - (c) `AI_INCIDENTAL` by default and `AI_CENTRAL` when the AI system is the topic.
- **Note for the decision:** `admission_filter@1.0.0` admits "autonomous vehicles" and "autonomous driving".

#### 5.1.4 Algorithmic trading (`algorithmic_trading`)
**Status: OPEN**
- **The case:** algorithmic and high-frequency trading, quant funds and "algos" with no stated machine learning.
- **Options:**
  - (a) `NOT_AI` unless machine learning or AI is stated;
  - (b) `AI_INCIDENTAL`.
- **Note for the decision:** `admission_filter@1.0.0` admits any use of "algorithmic".

#### 5.1.5 Crypto "AI tokens" (`crypto_ai_token`)
**Status: OPEN**
- **The case:** cryptocurrency tokens and coins marketed as AI, such as "AI agent token" presales and memecoins with "AI" in the name.
- **Options:**
  - (a) `NOT_AI` plus `SPAM` when promotional, because "AI" is a brand there, not a subject;
  - (b) label by topic: `AI_INCIDENTAL` when the token's claimed AI function is described, else `NOT_AI`;
  - (c) `AI_INCIDENTAL` always.

#### 5.1.6 Bot-generated GitHub issues and digests (`bot_generated`)
**Status: OPEN**
- **The case:** automated issues, release notes, CI reports and digest posts that mention AI projects. For example, an auto-generated "weekly digest" listing LLM repositories.
- **The question:** whether bot-generated items stay in the population at all.
- **Options:**
  - (a) label by topic and flag `BOT_GENERATED`, and decide later whether flagged items count;
  - (b) always `NOT_AI` plus `BOT_GENERATED`, so they are excluded from AI discourse.
- **Note for the decision:** the `BOT_GENERATED` flag is recorded either way.

#### 5.1.7 SDK dependency bumps (`sdk_dependency_bump`)
**Status: OPEN**
- **The case:** pull requests and issues such as "Bump openai from 1.40.0 to 1.41.2" or "chore(deps): update transformers".
- **The question:** they name AI libraries, but they are maintenance, not discourse.
- **Options:**
  - (a) `NOT_AI` plus `BOT_GENERATED` when made by a bot;
  - (b) `AI_INCIDENTAL`, because the project depends on AI;
  - (c) label by topic like any other item.

### 5.2 Proposed v1 rules (follow from section 3; confirm or amend)

**Status: PROPOSED**

| Case | Proposed v1 rule |
|---|---|
| "Smart" devices (thermostats, phones, TVs) with no AI stated | `NOT_AI` |
| A product story that mentions an AI feature in passing ("the new phone also has AI photo editing") | `AI_INCIDENTAL` if the feature is described; `NOT_AI` if it is only named in a list |
| AI-generated media as the subject ("this viral image was made with Midjourney") | `AI_CENTRAL` |
| Deepfakes, AI voice clones, synthetic media scams | `AI_CENTRAL` |
| Facial recognition and surveillance systems | `AI_CENTRAL` when described as automated recognition; `AI_INCIDENTAL` when it is one point in a wider surveillance story |
| Statistics, data science or analytics with no learning stated | `NOT_AI` |
| Non-English text | Label by meaning. Add `LANG` when unsure. |
| A recommendation algorithm or feed ranking ("the algorithm") | `AI_INCIDENTAL` when learned ranking is described; `NOT_AI` for "algorithm" in the everyday sense |
| AI-themed spam (for example, "AI trading bot guaranteed returns") | Label by topic (usually `AI_INCIDENTAL`) and add `SPAM` |

## 6. The binary metric and agreement

- **Binary metric (decided):** "Central + incidental". `AI_CENTRAL` and `AI_INCIDENTAL` count as **AI**; `NOT_AI` counts as **not AI**. Precision and recall of any method are computed against this binary truth. The three-class label is kept, so the narrower "central only" metric can also be reported.
- **Agreement:** measured with Cohen's κ over the items two labellers share. `npm run gold:agreement` reports:
  - the three-class κ;
  - the binary κ;
  - one κ per flag;
  - the observed agreement;
  - the confusion matrix;
  - an ordinal (linearly weighted) κ, which counts central vs incidental as a smaller disagreement than central vs not-AI;
  - a design-weighted κ (each item counts N_h / n_h times).
- **κ is sample-conditional.** The sample over-samples rare strata on purpose, and κ depends on prevalence, so the κ over the sample is not the population κ. Read the design-weighted κ as the closer estimate of the population value; the sample κ and its interval describe the labelling exercise. The interval is the large-sample (Fleiss, Cohen and Everitt) approximation with chance agreement estimated from the data; it is only indicative at small n, and none is reported when agreement is perfect or the variance is zero, because the approximation is not valid there.
- **Below 300 shared items every reading is indicative only**; the report says so.
- **Thresholds:**

  | κ | Meaning |
  |---|---|
  | ≥ 0.80 | reliable |
  | 2/3 (0.667) to below 0.80 | tentative |
  | < 2/3 | not reliable |

  These are the conventional reliability cut-offs from the research note. Below 2/3 the codebook is revised, and the item is not used as gold until it is relabelled.
- **Double-coding:** at least 300 items are labelled by two people independently before any accuracy figure is published (research note, section 7).

## 7. Methods (`relevance_gold_labels.method`)

| Method | Who | Rules |
|---|---|---|
| `human` | A named person, through `npm run gold:label` | Blind: no other label is visible. |
| `llm_proposed` | An LLM, imported with `npm run gold:label -- --import` | The model id is recorded. The input hash must equal the item's hash. The labeller is always `llm:<model id>`, so a model's labels never share a name with a person; notes in the file are ignored. These rows are proposals: they are never gold on their own, and they are measured against `human` labels before use. |
| `adjudicated` | A named person resolving a disagreement | The other labels are shown. Used for items where human labels disagree. Adjudicated rows are excluded from agreement statistics, because they are not independent. |

**Final gold label for an item:**
- the latest `adjudicated` label if there is one;
- otherwise the human label all human labellers agree on;
- otherwise the item is not gold yet.

**Corrections:** labels are **append-only**. A correction is a new row (`npm run gold:label -- --sample ID --labeller NAME --relabel ITEM_ID`); the row with the highest `seq` per labeller and item counts. A later human correction re-opens an item that was already adjudicated. Database triggers forbid DELETE and every UPDATE except the erasure path in section 8 (migration 070).

## 8. Data handling

- **The gold tables never copy post text.**
  - An item stores the post id, a **keyed** fingerprint of the text the sampler saw (`input_hash` = HMAC-SHA256 with `GOLD_HASH_KEY`, else `AUDIT_HASH_KEY`), and the stratum and design weight. The key is what stops anyone with database access from confirming that a person wrote a guessed text. A `GOLD_HASH_KEY` that is set but invalid (too short, or a template value) is an error and never falls back to `AUDIT_HASH_KEY`; leave it unset to use the audit key. Keep the key unchanged between sampling and labelling: rotating it makes every item read as changed.
  - The labelling tool reads the text from `raw_posts` at labelling time and checks the hash.
  - When retention has removed the text, or the text changed, the item is skipped and not labelled.
  - So text retention, including Jennifer's decision to "remove text of non-AI posts early" when it is wired in a later release, applies to the gold set without exception.
- **The labelling tool is local-only.** `scripts/gold-label.js`:
  - refuses `NODE_ENV=production`, any non-loopback database host, and any database port other than 5433/5434 unless `GOLD_ALLOW_DB_PORT=<port>` acknowledges a local throwaway database (every gold tool, not only the labelling one, applies the same check);
  - prints post text with control characters (terminal escape sequences) replaced;
  - is never served by the API: no route requires the gold modules, and a test enforces this.
- **Exporting text to an LLM for `llm_proposed` labels is not provided by these tools.** Sending post text to a third-party API is a privacy decision that needs its own ruling (research note, decision D2/D3). The import path only records proposals made under such a ruling.
- **Labeller names are stored.** Use a name or a stable pseudonym. Names starting `llm:` are reserved for `llm_proposed` labels.
- **Notes** are at most 200 characters and may not quote the post (25 or more consecutive characters); the tool refuses such a note. Rows are immutable, so a quoted post would outlive its text.
- **Erasure.** Because the rows are append-only and keep the post id and the fingerprint, an erasure request or retention removal needs its own path: `npm run gold:erase -- --post POST_ID` (one post whose text is already gone; an erasure request removes the post's text first, because gold-only erasure of a post that still has text would let a later sample draw it again) or `-- --removed` (every item whose post text is gone). It blanks the post id and fingerprint on the item and the fingerprint and note on its labels and stamps `erased_at`; labels, flags, strata and weights stay, and an erased item can no longer be labelled. Retention (`src/collectors/retention.js`) calls the same erasure in the same transaction that removes a post's text, so the automated path needs no manual step; `--removed` is the catch-up for posts whose text went by any other route (deleted posts, restored backups).
  - **Erasure request for a post that still has text.** `npm run gold:erase -- --post POST_ID --remove-text`. In ONE transaction it does everything retention does for a post: replaces the text with the removal notice, scrubs the `raw_payload` text keys and the url, deletes the post's embedding, erases its gold rows, and writes a `data_retention_log` row (rule "erasure request", GDPR Article 17). Without `--remove-text`, `--post` refuses a post that still has text. Do not hand-write SQL for this.
- **Guard rails, not a boundary.** The append-only and no-TRUNCATE triggers stop accidents and misuse by the tools. The table owner can still alter the tables, so the gold tools must not be given the owning role of a shared database; they are local-only for that reason.

## 9. Sampling design (`npm run gold:sample`)

**Population:**
- every stored, non-demo post whose text is still present;
- optionally only posts collected since a given date.

**Strata:** source category × route scope × current relevance decision × writing script.

| Dimension | Values |
|---|---|
| Category | the 8 canonical categories |
| Scope | `filter`, `ai`, `unknown`, from the source registry |
| Current decision | `relevant`, `not_relevant`, `unscored`, from `relevance_results` |
| Writing script | `latin`, `cjk`, `cyrillic`, `arabic`, `other`: the dominant script of the text by letter count |

**Allocation:**
- Every stratum gets at least `--min-per-stratum` items, capped at its size.
- The rest is shared in proportion to stratum size × stratum weight.
- Weights (`--weight script:cjk=4`, `--weight decision:not_relevant=2`) over-sample rare strata. Each item records its design weight N_h / n_h, so estimates can be re-weighted to the population.

**Draw:**
- deterministic: sha256(seed:post id) within each stratum;
- the same seed over the same posts reproduces the sample;
- the labelling order is the draw order, which interleaves strata.

**Known limitation (recall):**
- Items rejected by `admission_filter@1.0.0` on `filter`-scope feeds are never stored, so this gold set cannot measure the filter's recall on those feeds.
- That needs a pre-filter evaluation sample, which is decision D2 in the research note.
- The `ai`-scope strata *do* contain unfiltered items. This is the population Jennifer's decision to "screen AI-specific feeds too" will act on in a later release.

## 10. Versioning

- A change to a label definition, a flag, or a ruling on an OPEN case is a **new codebook version**: this document's `codebook_version`, together with `CODEBOOK_VERSION` in `src/gold/codebook.js`.
- Every label row records the version it was made under, and `gold:agreement` filters by version.
- Labels from an older version stay. They are relabelled, not edited.

## 11. Commands

```bash
npm run gold:sample -- --total 2000 --seed 2026-10-gold-1 --min-per-stratum 5 \
    --weight script:cjk=4 --weight decision:not_relevant=2            # dry run: prints the allocation
npm run gold:sample -- ... --sample-id gold-2026-10-a --write          # records the items
npm run gold:label -- --sample gold-2026-10-a --labeller jennifer      # interactive, blind
npm run gold:label -- --sample gold-2026-10-a --labeller jennifer --method adjudicated
npm run gold:label -- --sample gold-2026-10-a --labeller jennifer --relabel <item id>   # a correction
npm run gold:label -- --import proposals.jsonl --model <model id>     # labeller becomes llm:<model id>
npm run gold:erase -- --removed                                         # erase gold rows whose post text is gone
npm run gold:agreement -- --sample gold-2026-10-a                       # Cohen's kappa per pair
npm run relevance:eval                                                  # released scorers vs tiered library, per category (read-only)
```

## 12. Open questions for Jennifer

| # | Question | Section |
|---|---|---|
| Q1 | Game AI: `NOT_AI` unless learned systems, or AI? | 5.1.1 |
| Q2 | Robotics without stated learning: `NOT_AI`, or AI? | 5.1.2 |
| Q3 | Autonomous vehicles: always AI, or only when AI is stated? | 5.1.3 |
| Q4 | Algorithmic trading without stated ML: `NOT_AI`, or `AI_INCIDENTAL`? | 5.1.4 |
| Q5 | Crypto "AI tokens": `NOT_AI` + `SPAM`, or labelled by topic? | 5.1.5 |
| Q6 | Bot-generated issues and digests: labelled by topic + flag, or always `NOT_AI`? | 5.1.6 |
| Q7 | SDK dependency bumps: `NOT_AI`, `AI_INCIDENTAL`, or by topic? | 5.1.7 |
| Q8 | Confirm or amend the proposed v1 rules in section 5.2. | 5.2 |
