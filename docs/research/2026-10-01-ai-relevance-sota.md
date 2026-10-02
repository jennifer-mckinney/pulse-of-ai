# AI-relevance classification, state of the art: research

**Question:** What is the most accurate method that is also open, local, CPU-only, reproducible and auditable for deciding whether a short online text is about artificial intelligence? Pulse of AI uses the answer for admission (`admission_filter`) and for the relevance score (`relevance`). The texts are news items, forum posts, GitHub repo or issue descriptions, paper abstracts, and video titles or descriptions. Sub-questions:
- Which embedding models are candidates?
- Which classifier heads?
- How should LLM-assisted labelling be used?
- What cascade design?
- How should multilingual text be handled?
- How should long text be handled ("embedding depth")?
- How should the classifier be evaluated?
- How do we pin it for audit?

**Dispatched by:** Orchestrator, for Jennifer's requests:
- "consider opening up the key words, phrases and embedding depth to capture more acuracy"
- "research the most cutting edge way to approach this part"

**Date:** 2026-09-30. Every URL below was accessed on that date. Target path: `docs/research/2026-10-01-ai-relevance-sota.md`.

**Baseline read from code** (branch `deps/embedding-1.1.0-st6`):
- **`admission_filter@1.0.0`** is `src/collectors/ai-filter.js`:
  - It is 20 regexes, applied only to feeds with scope `filter`.
  - It includes broad patterns such as `/\balgorithmic\b/i` and `/\brobot(?:s|ics|axis?)?\b/i`, and an upper-case `AI` rule.
- **`relevance@1.2.0`** scores unique matched terms / 21.
  - That fraction is not a probability.
  - A post that matches one term and a post that matches three are both "relevant" (`score > 0`).
- **Embeddings** come from all-MiniLM-L6-v2 on sentence-transformers 6.1.0. They are not used for relevance.

Note: the checked-out worktree (`sweet-driscoll-118bbf`) still pins `sentence-transformers==2.7.0` in `python/requirements.txt`. The ONNX and OpenVINO backends recommended below need sentence-transformers 3.2.0 or later ([release notes](https://github.com/huggingface/sentence-transformers/releases/tag/v3.2.0)). The ST 6.1.0 branch already meets this.

---

## 0. Headline

1. **Recommended approach:** a calibrated three-stage cascade, served entirely from local, pinned artefacts.
   - **Stage 1, lexicon rules:**
     - Keep the lexicon as a high-precision *positive* rule and as features.
     - Stop using it as the only gate.
   - **Stage 2, embedding classifier:**
     - A frozen multilingual embedder with a logistic-regression head.
     - It is trained on a Claude-labelled set that is validated against a human gold set, and calibrated.
     - It produces p(about AI) for every item.
     - It decides admission through two thresholds: admit, reject, or **uncertain**.
     - The calibrated probability becomes the relevance score.
   - **Stage 3, uncertain band (optional and cost-capped):** Claude adjudication, *or* simply an "uncertain" bucket. This is an open decision (§9).
2. **Why the frozen-embedding + logistic-regression design fits:**
   - MTEB's own Classification task is exactly this setup: a logistic regression with at most 100 iterations, trained on frozen embeddings ([MTEB paper, arXiv 2210.07316](https://arxiv.org/abs/2210.07316)).
   - So MTEB classification scores are a directly relevant proxy for choosing the embedder.
   - It is also the cheapest design to pin, replay and retrain.
3. **Embedder shortlist** (exact revisions in §5):
   - **Primary candidate: `Qwen/Qwen3-Embedding-0.6B`** (Apache-2.0).
     - It has the best published multilingual classification score among open-licence models under 1B: MMTEB Classification 66.83 against 64.94 for multilingual-e5-large-instruct ([model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)).
   - **Encoder alternative: `intfloat/multilingual-e5-large-instruct`** (MIT, ONNX shipped).
   - **Light challenger: `ibm-granite/granite-embedding-311m-multilingual-r2`** (Apache-2.0, released 2026-04-29, ONNX and OpenVINO shipped).
     - Its classification score is **not published**, so it must win on our own gold set to be chosen.
   - **The final pick is decided by a bake-off on our gold set, not by MTEB.**
4. **CPU is not the constraint at our volume.**
   - 300 posts/h is one post every 12 s.
   - A 0.6B model at even 1 s per post on one core uses about 8% of one core. This is arithmetic, not a benchmark; it is measured in rollout step R1.
   - What matters instead:
     - memory (about 2.4 GB in fp32 for 0.6B parameters, at 4 bytes per parameter);
     - backfill and replay throughput;
     - determinism.
5. **LLM distillation is evidence-backed and audit-friendly** when the LLM is used only offline:
   - Classifiers fine-tuned on GPT-4 labels performed comparably to those trained on human labels across 14 social-science tasks ([Pangakis & Wolken 2024](https://aclanthology.org/2024.nlpcss-1.9/)).
   - Labelling a 20k-item training set with Claude Sonnet 5.5 through the Batch API costs about $25–60 (§3.3).
   - The served model is a pinned local artefact, and the LLM labels are stored as a frozen, hashed dataset.
   - Claude cannot be the deterministic component: models after Opus 4.6 reject `temperature` other than 1.0, and even temperature 0 "will not be fully deterministic" ([Messages API docs](https://platform.claude.com/docs/en/api/messages)).
6. **Use a gold set for both evaluation and measurement.**
   - Any classifier's raw counts are biased estimates of "share of AI talk".
   - Pulse publishes prevalence by category. It should use a gold-set correction ([prediction-powered inference, Science 2023](https://www.science.org/doi/10.1126/science.adi6000); [DSL, NeurIPS 2023](https://arxiv.org/pdf/2306.04746)) or adjusted classify-and-count ([QuaPy](https://arxiv.org/pdf/2106.11057)).
   - DSL showed that surrogate labels with 80–90% accuracy still give "substantial bias and invalid confidence intervals" in downstream estimates.
7. **The hard constraint is privacy, not technology.**
   - Measuring recall needs a random sample of items *before* the filter, including items it would reject.
   - Current policy is that rejected items' text is not retained.
   - Jennifer has to decide on a narrow, time-limited evaluation-sample exception (§9, decision D2).

---

## 1. Findings: embedding models (question 1)

MMTEB = MTEB(Multilingual, v2). The scores are copied from the cited source; different sources ran different evaluations, so compare within a column only when the source is the same. Licence, size and revision come from the Hugging Face model API (`https://huggingface.co/api/models/<id>`), fetched 2026-09-30.

| Model (HF id) | Params | Context | Dims (Matryoshka) | Languages | MMTEB mean | MMTEB Classif. | MMTEB Clust. | Licence | Source / notes |
|---|---|---|---|---|---|---|---|---|---|
| `Qwen/Qwen3-Embedding-0.6B` | 596M (decoder, 28 layers) | 32k | 1024 (MRL 32–1024) | 100+ | 64.33 | **66.83** | 52.33 | Apache-2.0 | [model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B). Instruction-aware. No ONNX in repo. |
| `intfloat/multilingual-e5-large-instruct` | 560M (XLM-R large) | 512 | 1024 | ~100 | 63.22 | 64.94 | 50.75 | MIT | Qwen card table + [EmbeddingGemma paper table](https://arxiv.org/html/2509.20354). Truncates at 512 ([card](https://huggingface.co/intfloat/multilingual-e5-large-instruct)). ONNX in repo. |
| `google/embeddinggemma-300m` | 308M | 2048 | 768 (512/256/128) | 100+ | 61.15 | 60.90 | 51.17 | **Gemma Terms (not OSI)**, gated | [paper](https://arxiv.org/html/2509.20354), [card](https://huggingface.co/google/embeddinggemma-300m). No fp16. |
| `BAAI/bge-m3` | 568M | 8192 | 1024 + sparse + ColBERT | 100+ | 59.56 | 60.35 / 61.83 | 40.88 / 49.75 | MIT | Two sources disagree: [EmbeddingGemma paper](https://arxiv.org/html/2509.20354) vs [Qwen card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B). [card](https://huggingface.co/BAAI/bge-m3) |
| `Alibaba-NLP/gte-multilingual-base` | 305M | 8192 | 768 (128–768) | 70+ | 58.24 | 57.17 | 44.33 | Apache-2.0 | [EmbeddingGemma paper](https://arxiv.org/html/2509.20354). **Needs `trust_remote_code=True`** ([card](https://huggingface.co/Alibaba-NLP/gte-multilingual-base)). |
| `ibm-granite/granite-embedding-311m-multilingual-r2` | 311M (ModernBERT) | 32k | 768 (512/384/256/128) | 200+ (52 enhanced) | not published | **not published** | not published | Apache-2.0 | [card](https://huggingface.co/ibm-granite/granite-embedding-311m-multilingual-r2), [paper 2605.13521](https://arxiv.org/abs/2605.13521). Multilingual retrieval 65.2. ONNX and OpenVINO in repo. |
| `ibm-granite/granite-embedding-97m-multilingual-r2` | 97M | 32k | 768 | 200+ | n/p | n/p | n/p | Apache-2.0 | [paper](https://arxiv.org/html/2605.13521). Multilingual retrieval 60.3. |
| `jinaai/jina-embeddings-v5-text-nano` | 239M | 8k | 768 (MRL to 32) | multilingual | 65.5 | see note | see note | **CC BY-NC 4.0** | [Jina release, 2026-02-19](https://jina.ai/news/jina-embeddings-v5-text-distilling-4b-quality-into-sub-1b-multilingual-embeddings/), [arXiv 2602.15547](https://arxiv.org/html/2602.15547v2). The per-task columns did not extract cleanly, so they are not reported here. |
| `jinaai/jina-embeddings-v3` | 572M | 8192 | 1024 (MRL) + classification LoRA | 89 | 58.4 | — | — | **CC BY-NC 4.0** | [arXiv 2409.10173](https://arxiv.org/html/2409.10173v3), [Jina page](https://jina.ai/models/jina-embeddings-v3/) |
| `Snowflake/snowflake-arctic-embed-l-v2.0` | 568M | 8192 | 1024 (MRL) | 74 | 57.0 | — | — | Apache-2.0 | Mean from [Jina v5 paper table](https://arxiv.org/html/2602.15547v2). Retrieval-tuned. |
| `nomic-ai/nomic-embed-text-v2-moe` | 475M total / 305M active | **512** | 768 (to 256) | ~100 | — | — | — | Apache-2.0 | [Docker Hub card](https://hub.docker.com/r/ai/nomic-embed-text-v2-moe). Retrieval-focused, short context. |
| `minishlab/potion-multilingual-128M` (static) | 128M lookup | unbounded | 256 | 101 | 47.31 | — | — | MIT | [card](https://huggingface.co/minishlab/potion-multilingual-128M). Distilled from bge-m3. Static models reach "30k or more samples/sec on CPU" ([Model2Vec](https://github.com/MinishLab/model2vec)). |
| `sentence-transformers/all-MiniLM-L6-v2` (current) | 23M | 256 | 384 | **English only** | — | — | — | Apache-2.0 | Current baseline. |

Bigger models exist. For example, Qwen3-Embedding-8B reports 70.58 MMTEB mean and 74.00 classification ([Qwen card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)). They are excluded because the cost of an 8B model on a CPU-only image is not justified by about 7 points on a binary topic task.

**Compression evidence.** Most of the quality survives int8 quantisation and moderate Matryoshka truncation:
- EmbeddingGemma's MMTEB mean was 61.15 at bf16, 60.93 at int8 and 60.62 at int4 ([paper](https://arxiv.org/html/2509.20354)).
- Under Matryoshka truncation it was 61.2 at 768 dimensions, 60.7 at 512, 59.7 at 256 and 58.2 at 128.

---

## 2. Findings: classifier heads (question 2)

| Approach | Accuracy evidence | Labels needed | CPU cost at 300/h | Multilingual | Licence | Determinism |
|---|---|---|---|---|---|---|
| **Frozen embedder + logistic regression (linear probe)** | This is the MTEB Classification protocol ([MTEB](https://arxiv.org/abs/2210.07316)), so the §1 classification column applies directly. A 2026 multilingual hate-speech study found frozen multilingual embeddings with a supervised head robust, and PCA to 64 dimensions cost little ([arXiv 2604.14907](https://arxiv.org/abs/2604.14907)). | Hundreds to low thousands | Embedder forward pass plus a dot product. Negligible. | Inherits the embedder's | Embedder's plus scikit-learn (BSD) | High. LR is well calibrated by design ([scikit-learn calibration](https://scikit-learn.org/stable/modules/calibration.html)). The head is a small file you can hash. |
| **SetFit** (contrastive fine-tune of the body + head) | With 8 labelled examples per class it matched full fine-tuning on CR. On RAFT it beat GPT-3 by 8.6 points ([Tunstall et al. 2022](https://arxiv.org/abs/2209.11055)). It matched vanilla fine-tuning in an active-learning benchmark ([small-text](https://arxiv.org/pdf/2107.10314)). | 8–64 per class to start; scales up | Same as the embedder (a new fine-tuned body) | Works with multilingual bodies | Apache-2.0. setfit 1.2.0 was released 2026-09-04 ([PyPI](https://pypi.org/project/setfit/)). | The fine-tuned body becomes *our* artefact: pin it by sha256. |
| **Zero-shot NLI cross-encoder** | Mean F1 over 28 tasks: deberta-v3-large-zeroshot-v2.0 0.673, multilingual bge-m3-zeroshot-v2.0 0.59, bart-large-mnli 0.497 ([card](https://huggingface.co/MoritzLaurer/deberta-v3-large-zeroshot-v2.0)). Political DEBATE: 10–25 labelled documents can beat supervised classifiers and LLMs ([Burnham et al.](https://arxiv.org/abs/2409.02078)). | 0 (zero-shot) or 10–25 (few-shot) | One cross-encoder pass per hypothesis (1 for a binary task). About 435–568M parameters. | bge-m3 variant only | MIT | High once pinned |
| **GLiClass** | gliclass-large-v3.0 F1 0.7193 vs 0.6821 for the deberta zero-shot model, about 16x throughput with many labels ([paper](https://huggingface.co/papers/2508.07662)). But gliclass-modern-base-v3.0 averages 0.5577 vs deberta-v3-base 0.6559 ([card](https://huggingface.co/knowledgator/gliclass-modern-base-v3.0)). | 0, or about 8 per label | Low | **English-focused benchmarks** | Apache-2.0 | High |
| **Full fine-tune of a modern encoder** (mmBERT / ModernBERT) | mmBERT-base surpasses XLM-R on NLU benchmarks across 1,800+ languages ([arXiv 2509.06888](https://arxiv.org/abs/2509.06888)). The "Text classification in the LLM era" study (32 datasets, 8 languages) finds small fine-tuned models remain competitive with zero-shot LLMs ([arXiv 2502.11830](https://arxiv.org/abs/2502.11830)). | Thousands | About 300M parameters | Yes | MIT (`jhu-clsp/mmBERT-base`) | High once pinned. Training is heavier to reproduce. |
| **Zero-shot LLM at serve time** (Claude) | Strong annotator ([Gilardi et al., PNAS 2023](https://www.pnas.org/doi/10.1073/pnas.2305016120)). But it is not deterministic and is an API call per item. | 0 | API cost and latency | Yes | Proprietary API | **Low**. Temperature is rejected on post-4.6 models ([Messages API](https://platform.claude.com/docs/en/api/messages)). |
| **Static embeddings + LR** (Model2Vec) | 47.31 MMTEB mean, well below transformer embedders ([card](https://huggingface.co/minishlab/potion-multilingual-128M)) | Hundreds | Near zero | Yes | MIT | High. Usable only as a pre-filter. |

**Synthesis:**
- For a binary "about AI or not" task with modest labels, the median evidence favours a **frozen strong multilingual embedder with a linear head**. It is the cheapest to audit.
- **SetFit** is the next step if the linear probe plateaus, and **full encoder fine-tuning** is the ceiling.
- **Outliers:**
  - Zero-shot NLI and GLiClass are useful for cold start (labelling with no data), not as the served model. They score lower, and the multilingual one is weaker.
  - Serve-time LLMs are the most accurate per item, but they break determinism.

---

## 3. Findings: LLM-assisted labelling and distillation (question 3)

### 3.1 Evidence

| Source | Finding | URL |
|---|---|---|
| Pangakis & Wolken, NLP+CSS 2024 | Across 14 classification tasks, classifiers fine-tuned on GPT-4 labels "perform comparably" to those fine-tuned on human labels | https://aclanthology.org/2024.nlpcss-1.9/ |
| Gilardi, Alizadeh, Kubli, PNAS 2023 | On relevance, stance, topic and frame tasks, ChatGPT zero-shot beat crowd workers by about 25 points, with higher intercoder agreement, at under $0.003 per annotation | https://www.pnas.org/doi/10.1073/pnas.2305016120 |
| Wang et al. 2021, "Want to reduce labeling cost? GPT-3 can help" | 50–96% lower labelling cost for the same downstream performance. Low-confidence items are routed to humans. | https://www.semanticscholar.org/paper/Want-To-Reduce-Labeling-Cost-GPT-3-Can-Help-Wang-Liu/4e263b4cd6998bff2501dd143e685f413179b12d |
| LLMaAA, 2023 | With the LLM as annotator inside an active-learning loop, students trained on hundreds of examples can outperform their teacher LLM | https://arxiv.org/pdf/2310.19596 |
| Egami et al., NeurIPS 2023 (DSL) | Using surrogate (LLM) labels directly in downstream statistics gives substantial bias even at 80–90% accuracy. The fix is to combine them with a gold sample. | https://arxiv.org/pdf/2306.04746 |
| Angelopoulos et al., Science 2023 (PPI) | Provably valid confidence intervals for means and proportions from a small labelled set plus many model predictions | https://www.science.org/doi/10.1126/science.adi6000 |

### 3.2 Audit implications

- The LLM runs **once, offline**. Its outputs are frozen as `training_labels@vN`. Each row stores:
  - the input text hash;
  - the label and rationale;
  - the model id, prompt version and batch id;
  - the time.
- The file's sha256 is recorded in the methodology row.
- The served classifier is a pure function of three things: the pinned embedder revision, the head file sha256, and the thresholds. Replay re-runs it locally.
- The LLM cannot be re-run deterministically ([Messages API](https://platform.claude.com/docs/en/api/messages)). So the stored labels *are* the record. This mirrors how `npm run replay` treats non-re-runnable stages.
- The training set holds text, so the privacy policy for training data has to be written down. It should be built from admitted posts plus an explicitly retained evaluation sample (§9 D2).

### 3.3 Cost of the one-off labelling

Prices are from the [Anthropic pricing page](https://platform.claude.com/docs/en/about-claude/pricing), and the Batch API is 50% off.

**Assumptions:**
- 20,000 items.
- About 850 input tokens each: a 600-token instruction block plus a 250-token item.
- About 60 output tokens of JSON.
- The 4.7-and-later tokenizer produces "approximately 30% more tokens" (same page), so the figures below include a 30% margin.

| Model | Batch rate (in/out per MTok) | Estimate |
|---|---|---|
| Claude Haiku 4.5 | $0.50 / $2.50 | ~$12 |
| Claude Sonnet 5.5 | $1 / $5 | ~$25–30, rising toward ~$60 if adaptive-thinking output tokens are large |
| Claude Opus 5.5 | $2 / $10 | ~$50–120 |

- Prompt caching of the fixed instruction block lowers these figures further. Cache reads cost 0.1x the base input price, and caching stacks with batch (same page).
- **Dual-labelling with disagreement routed to humans** (for example Sonnet 5.5 plus Opus 5.5) costs under about $150 in total, and gives a free active-learning signal.

---

## 4. Findings: cascades, calibration, abstention, active learning (question 4)

| Element | Evidence | Recommendation for Pulse |
|---|---|---|
| Cascade (cheap model first, escalate only when unsure) | FrugalGPT matched GPT-4 with up to 98% cost reduction ([arXiv 2305.05176](https://arxiv.org/pdf/2305.05176)) | **Stage 1** lexicon as high-precision positive rules. **Stage 2** embedding classifier for everything. **Stage 3** only for the uncertain band, with a hard daily cap. |
| Calibration | Platt (sigmoid) for under ~1,000 calibration samples; isotonic above that. Logistic regression is often already well calibrated ([scikit-learn](https://scikit-learn.org/stable/modules/calibration.html)). | Fit LR. Check a reliability diagram and the Brier score on held-out gold. Add a sigmoid calibrator only if needed, and store its parameters in the methodology config. |
| Abstention / "uncertain" bucket | Uncertainty-based query strategies perform strongly for both BERT and SetFit ([small-text, EACL 2023](https://arxiv.org/pdf/2107.10314)) | Two thresholds: `t_admit` chosen for precision ≥ target on gold, and `t_reject` chosen for recall ≥ target. The band between them is "uncertain". |
| Active learning | LLM-in-the-loop active learning reduces labels needed ([LLMaAA](https://arxiv.org/pdf/2310.19596); [small-text](https://arxiv.org/pdf/2107.10314)) | Monthly. Send to humans the uncertain-band items plus the items where the lexicon and the model disagree, then add them to the gold or training set. |

**Lexicon role after the change:**
- A lexicon hit becomes either a feature or a positive override, and only for unambiguous terms ("large language model", "ChatGPT", "machine learning").
- Broad patterns stay out of the override set, for example `\brobot…\b` and `\balgorithmic\b` in `admission_filter@1.0.0`.
  - These are where an embedding classifier adds precision, for example robot vacuums or algorithmic trading.
  - This is an inference from the pattern list, to be confirmed by measuring disagreement on the gold set.

---

## 5. Recommended architecture and exact pins

```
item (title + summary/description, normalised)
  │
  ├─ L0  language id  ── GlotLID v3 (pinned) → lang, confidence  [stratification + monitoring only]
  │
  ├─ S1  lexicon rules (admission_filter lexicon, narrowed to unambiguous terms) → rule_hits[]
  │        unambiguous hit ⇒ admit (path = "rule"), still scored by S2 for the relevance value
  │
  ├─ S2  embedder (pinned revision, fixed threads) → vector (full dims)
  │        logistic-regression head (sha256-pinned) [+ optional sigmoid calibrator] → p_ai
  │        p_ai ≥ t_admit ⇒ admit ; p_ai ≤ t_reject ⇒ reject ; else ⇒ uncertain
  │
  └─ S3  (optional, decision D3) uncertain ⇒ Claude adjudication, daily cap N, verdict stored as artefact
           or ⇒ "uncertain" bucket (counted, not admitted / admitted-with-flag per D5)

relevance score := calibrated p_ai  (replaces matched/21)
```

### 5.1 Shortlist to bake off

Pin the **full 40-character commit SHA**. Hugging Face requires the full hash for commit pinning ([HF Hub download guide](https://huggingface.co/docs/huggingface_hub/guides/download)). SHAs below are from the HF API, 2026-09-30.

| Role | Model id | Revision (commit) | Licence | Why |
|---|---|---|---|---|
| Embedder, primary candidate | `Qwen/Qwen3-Embedding-0.6B` | `97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3` | Apache-2.0 | Top published MMTEB classification under 1B with an open licence (66.83) |
| Embedder, encoder candidate | `intfloat/multilingual-e5-large-instruct` | `274baa43b0e13e37fafa6428dbc7938e62e5c439` | MIT | 64.94 classification. Encoder, ONNX shipped, mature. |
| Embedder, light challenger | `ibm-granite/granite-embedding-311m-multilingual-r2` | `44399559930365213510b1ee2eb15ded83374f0e` | Apache-2.0 | Newest (2026-04-29), 32k context, ONNX and OpenVINO shipped. Classification unpublished, so it must prove itself on gold. |
| Embedder, budget fallback | `intfloat/multilingual-e5-base` | `d128750597153bb5987e10b1c3493a34e5a4502a` | MIT | 278M, ONNX and OpenVINO shipped |
| Baseline (current) | `sentence-transformers/all-MiniLM-L6-v2` | `1110a243fdf4706b3f48f1d95db1a4f5529b4d41` | Apache-2.0 | Control arm, English only |
| Cold-start / second-opinion labeller (offline) | `MoritzLaurer/bge-m3-zeroshot-v2.0` | `9abf1c8aaeb82a2447809c20753ed0b106b76652` | MIT | Multilingual zero-shot NLI, 8k context |
| Fine-tune ceiling (phase 3, optional) | `jhu-clsp/mmBERT-base` | `c5955035435e2bf121cde7f3c8863ef52ff35d82` | MIT | Modern multilingual encoder |
| Language ID | `cis-lmu/glotlid` (file `model_v3.bin`) | `85cd6716494360367b75f642b5bc78667605d0b4` | Apache-2.0 plus notices ([card](https://huggingface.co/cis-lmu/glotlid)) | Beats CLD3, fastText-176, OpenLID and NLLB on F1/FPR ([GlotLID paper](https://arxiv.org/abs/2310.16248)). fastText `lid.176` is CC BY-SA 3.0 and covers 176 languages ([fastText](https://fasttext.cc/docs/en/language-identification.html)). |

**Excluded, with reason:**
- **`google/embeddinggemma-300m`**: technically strong, but under the Gemma Terms:
  - they are not OSI-approved;
  - use restrictions must be passed on;
  - Google reserves the right to restrict usage "remotely or otherwise" ([Gemma Terms, modified 2026-04-01](https://ai.google.dev/gemma/terms)).
  - This conflicts with open-source-first. It is decision D4 if Jennifer wants it in the bake-off.
- **Jina v3 and v5**: CC BY-NC 4.0. Non-commercial use fits today, but it forecloses any future commercial path.
- **`Alibaba-NLP/gte-multilingual-base`**: needs `trust_remote_code`, which executes repository code at load time and so is an audit and supply-chain risk. It also scores lower (57.17).
- **`nomic-embed-text-v2-moe`**: 512-token, retrieval-tuned.

### 5.2 Serving

- **Library:** sentence-transformers 6.1.0.
- **Backend:**
  - Keep the PyTorch fp32 backend for the first version: the simplest path to determinism.
  - Evaluate `backend="openvino"` or `"onnx"` as a *separate* methodology version.
  - The ST benchmark recommends OpenVINO int8 on CPU when "a small accuracy loss" is acceptable, and plain OpenVINO or ONNX otherwise ([ST efficiency docs](https://sbert.net/docs/sentence_transformer/usage/efficiency.html)).
- **Input string:** `title + "\n" + summary`, normalised, truncated to 512 tokens. Use the model's documented classification prompt or instruction:
  - for Qwen3 and e5-instruct, an `Instruct: … Query:` prefix ([e5 card](https://huggingface.co/intfloat/multilingual-e5-large-instruct));
  - the instruction string goes into the methodology config.
- **Dimensions:** use **full dimensions for the classifier**. Truncation costs about 1–3 MMTEB points (EmbeddingGemma: 61.2 at 768 dimensions vs 58.2 at 128). If storage matters, store a Matryoshka-truncated copy (for example 256 dimensions) for similarity search only.

---

## 6. Multilingual, long text and "embedding depth" (questions 5 and 6)

**Multilingual:**
- **Use one multilingual embedder.**
- Translate-then-classify can be competitive when the MT system is strong and the train/test mismatch is handled. But "the optimal approach is highly task dependent" ([Artetxe et al., EMNLP 2023](https://aclanthology.org/2023.emnlp-main.399/)).
- Translation would also add:
  - a second large model;
  - a second source of non-determinism;
  - per-item latency.
- Use language ID (GlotLID) for three things:
  1. stratifying the gold set;
  2. reporting per-language precision and recall;
  3. monitoring drift.
- Do not use language ID for routing.

**Long text:**
- Most items are short: titles, abstracts, video descriptions.
- MTEB-style evaluations of these models mostly ran at 512 tokens ([EmbeddingGemma paper](https://arxiv.org/html/2509.20354)).
- For long READMEs and issue bodies:
  - classify **title plus the first ~512 tokens**;
  - optionally take the **max of the per-chunk p_ai** ("any substantial section is about AI");
  - record the chunking rule in config.
- This is a design inference, not verified by a published classification benchmark.

**Late chunking and late interaction:**
- Late chunking is a *retrieval* technique: chunking after a long-context encoder pass, before pooling ([arXiv 2409.04701](https://arxiv.org/abs/2409.04701)).
- ColBERT-style multi-vector output (available in bge-m3, [card](https://huggingface.co/BAAI/bge-m3)) targets retrieval.
- I found no evidence that either improves single-label topic classification. **Not recommended:** extra storage and complexity with no demonstrated gain.

**"Embedding depth" in Jennifer's sense: more capacity and better representations.** What lifts accuracy, in order:
1. A stronger multilingual embedder: up to about +10 classification points over older models (§1).
2. Labelled data from our own domain.
3. Calibrated thresholds.
4. SetFit or fine-tuning.

Raising output dimensions beyond the model's native size is not a lever.

---

## 7. Evaluation and gold-set plan (question 7)

1. **Codebook (v1).** Define "about AI" with written examples and edge cases:
   - robot vacuums;
   - "algorithmic" feeds;
   - "smart" devices;
   - products that merely mention an AI feature;
   - AI-generated media;
   - non-English product names.
   - Labels: `core` (AI is the main topic), `peripheral` (substantive mention), `none`.
   - Admission policy is decision D1.
2. **Sampling.**
   - Stratify by source category (8) and by language (English vs non-English, plus the top non-English languages).
   - **Sample before the admission filter**, so recall can be measured (decision D2).
   - Target **about 2,000 items**: about 200 per category plus about 400 non-English.
   - Rationale: with p ≈ 0.85, n ≈ 196 positives gives a ±5-point 95% interval on precision or recall per stratum (1.96² × 0.85 × 0.15 / 0.05²). This is arithmetic.
3. **Annotation.**
   - Two human annotators double-code ≥ 300 items.
   - Report Krippendorff's α. Rely at ≥ 0.800, treat as tentative at 0.667–0.800, discard below 0.667 ([Krippendorff thresholds](https://www.cogn-iq.org/learn/theory/krippendorff-alpha/)).
   - Reconcile disagreements into the codebook.
   - Then measure Claude-vs-human agreement on the same items before trusting Claude labels at scale.
4. **Splits.**
   - The gold set is **never trained on**.
   - Split it into a calibration/threshold set and a held-out test set, stratified.
   - The training set is LLM labels on separate items.
5. **Metrics.**
   - Precision, recall and F1 per category and per language, with **stratified bootstrap 95% CIs**.
   - Calibration: reliability diagram and Brier score ([scikit-learn](https://scikit-learn.org/stable/modules/calibration.html)).
   - Uncertain-band rate.
   - Report the lexicon `admission_filter@1.0.0` on the same gold set as the baseline.
6. **Prevalence (what the map shows).**
   - Publish category shares with a **gold-corrected estimator**: PPI ([Science 2023](https://www.science.org/doi/10.1126/science.adi6000)) or DSL ([NeurIPS 2023](https://arxiv.org/pdf/2306.04746)).
   - Adjusted classify-and-count ([QuaPy](https://arxiv.org/pdf/2106.11057)) is the simpler option.
   - This needs counts of rejected items per category. *Counts* can be retained without text.
7. **Drift monitoring (weekly):**
   - the p_ai distribution per category;
   - the uncertain-band rate;
   - the lexicon-vs-model disagreement rate;
   - an embedding two-sample test against the training window. Two-sample tests on pre-trained representations were the best shift detectors in [Failing Loudly (NeurIPS 2019)](https://mlanthology.org/neurips/2019/rabanser2019neurips-failing/).
8. **Re-labelling (monthly):**
   - About 200 fresh stratified items are human-labelled.
   - If F1 falls outside the release CI, or the drift alarms fire, retrain. The retrained model ships as a new minor version.

---

## 8. Reproducibility and audit (question 8)

**What reproducibility actually covers:**
- PyTorch states that reproducible results "are not guaranteed across PyTorch releases, individual commits, or different platforms", nor between CPU and GPU ([PyTorch randomness notes, 2.14](https://docs.pytorch.org/docs/2.14/notes/randomness.html)).
- Multithreaded floating-point reduction order can also change low-order bits ([onnxruntime thread discussion](https://github.com/microsoft/onnxruntime/issues/19384)).
- So "replayable" means: same image digest, same thread count, same pinned weights → identical decisions. Scores must match within a tolerance.

**Per methodology version, record:**
- the embedder id and full commit SHA, plus the sha256 of the weight files;
- the backend and precision (torch-fp32 / onnx / openvino-int8);
- the instruction string;
- the max tokens and the chunking rule;
- the head sha256, the calibrator parameters, and `t_admit` / `t_reject`;
- the training-labels dataset sha256 and the gold-set version;
- the library versions (torch, transformers, sentence-transformers, onnxruntime) and the Docker image digest;
- `torch.set_num_threads(N)` fixed.

**Per decision, record:**
- the methodology version id;
- the input text hash;
- the language and its confidence;
- the rule hits;
- p_ai to 6 decimals;
- the decision path (`rule` / `model` / `llm` / `uncertain`);
- for S3, the stored LLM verdict, model id and prompt version.

**Replay:**
- Re-embed and re-score locally.
- PASS when the decision is identical and |Δp| ≤ 1e-4.
- Flag any item within 1e-4 of a threshold.
- The S3 stage is NOT RE-RUNNABLE by design; it is verified from the stored verdict.

**Quantisation:**
- An int8 or ONNX model is a **different methodology version**, validated on gold before cutover.
- Quality loss is small (EmbeddingGemma: 61.15 → 60.93 MMTEB at int8, [paper](https://arxiv.org/html/2509.20354)), but scores change, so it cannot share a version.

---

## 9. Rollout path (fits the versioned-methodology rules)

| Step | What | Exit criterion |
|---|---|---|
| R0 | Codebook v1 + gold-set sampling (needs D1, D2) + human double-coding | α ≥ 0.800 on the overlap |
| R1 | Offline bake-off: four embedders × LR head on gold; measure CPU latency, RAM and backfill throughput **inside the CPU Docker image** | Pick the model with the best F1 lower CI bound, with p95 latency < 2 s per item and RAM within budget |
| R2 | Claude batch labelling of the training set (dual-model optional); measure Claude-vs-gold agreement | Agreement reported; disagreements adjudicated |
| R3 | Train the head, calibrate, set thresholds on the calibration split, report on test | Precision and recall targets met with CIs (targets are D6) |
| R4 | Register `admission_filter@2.0.0` and `relevance@2.0.0` (or `@1.3.0` if the score semantics are kept) in `methodology-registry.js` plus a migration, field for field. Run in **shadow mode**: new decisions stored alongside the old, text kept only for admitted posts. | 2–4 weeks of shadow agreement/disagreement reported by category |
| R5 | Cutover. Posts keep the version they were admitted under. Mark the methodology break on time-series charts (D7). | Replay PASS on a sample; health drawer shows the new version |
| R6 | Monthly monitoring, re-labelling and active learning. A retrained head ships as a new version. | Drift dashboard green or retrain triggered |

**Asymmetry to note:**
- Rejected texts are not retained, so a new filter **cannot retroactively admit** history it previously rejected.
- Back-scoring is possible only for already-admitted posts.
- This is why the time-series break needs labelling.

---

## 10. Risks

1. **LLM label bias.**
   - Claude's notion of "about AI" may differ from the codebook.
   - Mitigation: measure Claude against gold before training, and use DSL/PPI for published prevalence ([Egami et al.](https://arxiv.org/pdf/2306.04746)).
2. **Codebook ambiguity** (robotics, "algorithmic", automation). It caps achievable agreement, and a low α invalidates any accuracy claim.
3. **Privacy.**
   - The gold set needs pre-filter text.
   - Any online S3 sends rejected-candidate text to a third-party API.
   - Both need explicit policy.
4. **Licence drift.** Model repos can change licence or gating. Pin revisions and mirror the weights into our own artefact store.
5. **Multilingual unevenness.** Low-resource languages will underperform. Per-language metrics make this visible, but small strata give wide confidence intervals.
6. **Determinism across hosts.** Scores can differ across CPUs and library builds ([PyTorch notes](https://docs.pytorch.org/docs/2.14/notes/randomness.html)). Pin the image digest, fix the thread count, and use a tolerance-based replay.
7. **Concept drift.** New product names and new AI subfields appear. Embeddings generalise better than regexes, but monthly re-labelling is still required.
8. **Proxy over-reliance.**
   - MTEB classification is an average over unrelated tasks, and Granite R2 has no published classification score.
   - The bake-off on our gold set is the deciding evidence.
9. **Memory footprint.** 0.6B fp32 is about 2.4 GB RAM. Check the Docker memory limit before choosing Qwen3.
10. **`trust_remote_code` models** run repository code on load. They are excluded for this reason.
11. **Methodology break** in public charts if the cutover is not annotated.

---

## 11. Open decisions for Jennifer

| # | Decision | Options | My default if asked |
|---|---|---|---|
| D1 | What counts as "about AI" for admission | (a) core only; (b) core plus peripheral; (c) store both labels and filter at display time | (c): admit core plus peripheral, store the label |
| D2 | Privacy exception for evaluation | Retain a random ~1% pre-filter sample (including would-be rejects) for labelling, deleted after N days; or no exception (then recall cannot be measured) | Retain the sample, 90-day deletion, documented in the privacy notice |
| D3 | Online LLM adjudication (S3) | (a) none, offline only; (b) Claude for the uncertain band with a daily cap and verdicts stored | (a) at launch; revisit after the shadow data |
| D4 | Licence stance | Allow Gemma Terms or CC BY-NC models into the bake-off, or OSI/permissive only | Permissive only (Apache/MIT) |
| D5 | Uncertain bucket | Reject / admit-with-flag / hold for review | Admit-with-flag, excluded from headline shares until reviewed |
| D6 | Targets | Minimum precision and recall at admission (for example P ≥ 0.90, R ≥ 0.85) | Set after R1 shows the attainable frontier |
| D7 | Time-series break | Annotate the break only, or also back-score admitted history | Annotate, and back-score admitted posts as a separate series |
| D8 | Labelling model and budget | Haiku 4.5 / Sonnet 5.5 / Opus 5.5, single or dual labeller | Sonnet 5.5 plus Opus 5.5 dual labelling on 20k items, about $150 cap |
| D9 | Human annotators | Who double-codes the gold set | Jennifer plus one independent coder |

---

## Recommendation

**Proposal:**
- Replace the lexicon-only admission gate and the matched/21 relevance score with a **calibrated cascade**:
  - lexicon high-precision rules;
  - a pinned multilingual embedder plus a logistic-regression head, trained on Claude-labelled and human-validated data, with two thresholds and an uncertain band;
  - an optional, capped LLM step only for that band.
- **Bake off** `Qwen/Qwen3-Embedding-0.6B@97b0c614…`, `intfloat/multilingual-e5-large-instruct@274baa43…` and `ibm-granite/granite-embedding-311m-multilingual-r2@44399559…` on a ~2,000-item stratified human gold set, and ship the winner as `admission_filter@2.0.0` / `relevance@2.0.0` after shadow mode.

**Trade-off:**
- The gain is measured accuracy, cross-lingual recall and a real probability for "relevance".
- The costs:
  - a gold-set effort (about 2,000 labels, ≥ 300 double-coded);
  - a one-off labelling spend of about $25–150;
  - 1–2.5 GB of extra RAM;
  - a privacy-policy decision (D2);
  - a methodology break in the time series.

**Confidence:**
- **MEDIUM-HIGH** on the architecture (linear probe, LLM distillation, calibration, gold-corrected prevalence). The evidence base is multiple peer-reviewed sources.
- **MEDIUM** on which embedder wins. The public scores are proxies, and Granite R2's classification score is unpublished; the R1 bake-off settles it.
- **LOW** on the CPU-latency figures. They are arithmetic estimates and not measured here; R1 measures them in the Docker image.
