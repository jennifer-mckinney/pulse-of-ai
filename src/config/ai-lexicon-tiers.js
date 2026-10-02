// src/config/ai-lexicon-tiers.js
// Relevance-accuracy Stage 0 (P5): a TIERED AI lexicon, as an offline
// LIBRARY. It is NOT wired to production and is NOT registered methodology.
//
// Why a new module: the released lexicon (src/config/ai-lexicon.js), the
// relevance scorers (src/pipeline/relevance.js, relevance@1.0.0–1.2.0) and
// the admission filter (src/collectors/ai-filter.js, admission_filter@1.0.0)
// must stay byte-for-byte as released so `npm run replay` reproduces every
// recorded decision. Nothing under src/ requires this file
// (tests/unit/pure/aiLexiconTiers.test.js enforces it); only the offline
// harness scripts/relevance-eval.js and the tests do. Wiring it in later is a
// NEW methodology version with its own migration, after the gold set
// (docs/governance/relevance-codebook.md) has measured it.
//
// Tiers:
//   STRONG          unambiguous English terms and AI product / lab names;
//                   one hit is AI evidence.
//   CONTEXT         ambiguous terms (transformer, Gemini, Claude, Llama,
//                   robot, algorithm, …) that count only when a co-term from
//                   their own list appears in the same text.
//   NEGATIVE        disambiguators: when their condition holds they MASK one
//                   term's spans (transformer + voltage, Gemini + horoscope,
//                   Claude + Monet / Van Damme, Llama + alpaca, "AI 171"
//                   flight numbers, Adobe ".ai file", "artificial
//                   insemination"). Masking removes that term's hit only;
//                   any other evidence in the text still counts.
//   SPAM_SIGNATURES phone-scam support numbers and airline-support SEO spam;
//                   a hit proposes the SPAM flag. It does NOT change `ai`: the
//                   codebook labels AI-themed spam by topic and flags it, and
//                   whether spam counts is Stage 1's decision (the eval reports
//                   tiered_ai_nonspam beside tiered_ai so the effect is visible).
//   MULTILINGUAL    strong terms in zh, ja, ko, es, pt, fr, de, ru, ar.
//                   CJK terms match as SUBSTRINGS of the text with all
//                   whitespace removed (no word boundaries in CJK; Korean
//                   spacing varies); Arabic as substrings (clitics such as
//                   و / ب / ل attach to the word); Latin-script and Cyrillic
//                   terms with Unicode-aware boundaries (JS \b is ASCII-only).
//   EDGE_CASES      tags for the codebook's OPEN questions (game AI, robotics
//                   without learning, autonomous vehicles, algorithmic
//                   trading, crypto "AI tokens", bot-generated text, SDK
//                   dependency bumps). Tags never change the decision: the
//                   ruling is Jennifer's (codebook v1, section 5). The CONTEXT
//                   co-term defaults for robot, algorithm and autonomous
//                   vehicles are PROVISIONAL, not rulings: each is a library
//                   default that the eval can compare, and the codebook's OPEN
//                   questions stay open until she rules.
//
// Pure and deterministic: no I/O, no clock, no randomness. Text is
// normalised with NFKC (full-width "ＡＩ" → "AI"), Arabic diacritics and
// tatweel are removed. Global regexes are created per call, so no lastIndex
// state leaks between calls.

'use strict';

const { AI_ACRONYM_RE } = require('./ai-lexicon');

/** Library version — NOT a methodology version (offline draft only). */
const TIERS_LIBRARY_VERSION = '0.1.0-draft';

// Evidence weights for the bounded score (documented, not a probability).
const WEIGHT = Object.freeze({ strong: 1, multilingual: 1, context: 0.5 });
const SCORE_SATURATION = 2;

const freezeAll = (rows) => Object.freeze(rows.map(r => Object.freeze(r)));

// ─── STRONG (English, unambiguous) ───────────────────────────────────────────
const STRONG = freezeAll([
    { id: 'ai_acronym', re: AI_ACRONYM_RE },
    { id: 'artificial_intelligence', re: /\bartificial[\s-]+intelligence\b/i },
    { id: 'machine_learning', re: /\bmachine[\s-]+learning\b/i },
    { id: 'deep_learning', re: /\bdeep[\s-]+learning\b/i },
    { id: 'neural_network', re: /\bneural[\s-]+net(?:work)?s?\b/i },
    { id: 'large_language_model', re: /\blarge[\s-]+language[\s-]+models?\b/i },
    { id: 'language_model', re: /\blanguage[\s-]+models?\b/i },
    { id: 'llm', re: /\bLLMs?\b/i },
    { id: 'generative_ai', re: /\bgen(?:erative)?[\s-]?AI\b/i },
    { id: 'chatgpt', re: /\bchatgpt\b/i },
    { id: 'openai', re: /\bopenai\b/i },
    { id: 'anthropic', re: /\bAnthropic\b/ },
    { id: 'deepmind', re: /\bdeepmind\b/i },
    { id: 'hugging_face', re: /\bhugging[\s-]?face\b/i },
    { id: 'stable_diffusion', re: /\bstable[\s-]+diffusion\b/i },
    { id: 'midjourney', re: /\bmidjourney\b/i },
    { id: 'mistral_ai', re: /\bmistral[\s-]+ai\b/i },
    { id: 'agi', re: /\bAGI\b/ },
    { id: 'gpt_versioned', re: /\bGPT-?\d+(?:\.\d+)?o?\b/i },
    { id: 'chatbot', re: /\bchat[\s-]?bots?\b/i },
    { id: 'deepfake', re: /\bdeep[\s-]?fakes?\b/i },
    { id: 'diffusion_model', re: /\bdiffusion[\s-]+models?\b/i },
    { id: 'reinforcement_learning', re: /\breinforcement[\s-]+learning\b/i },
    { id: 'computer_vision', re: /\bcomputer[\s-]+vision\b/i },
    { id: 'foundation_model', re: /\bfoundation[\s-]+models?\b/i },
    { id: 'deepseek', re: /\bdeepseek\b/i },
    { id: 'ollama', re: /\bollama\b/i },
    { id: 'pytorch', re: /\bpytorch\b/i },
    { id: 'tensorflow', re: /\btensorflow\b/i },
    { id: 'rag', re: /\bretrieval[\s-]+augmented[\s-]+generation\b/i },
    { id: 'prompt_engineering', re: /\bprompt[\s-]+engineer(?:ing|s)?\b/i },
    { id: 'transformer_architecture', re: /\btransformer[\s-]+(?:models?|architectures?|networks?|based|layers?)\b/i },
    { id: 'text_to_media', re: /\btext[\s-]+to[\s-]+(?:image|video|3d|music)\b/i },
    { id: 'apple_intelligence', re: /\bApple Intelligence\b/ },
    { id: 'xai', re: /\bxAI\b/ },
]);

// ─── CONTEXT (ambiguous; a co-term is required) ──────────────────────────────
const CONTEXT = freezeAll([
    { id: 'transformer', re: /\btransformers?\b/i,
        co: /\b(?:attention|self-attention|neural|models?|LLMs?|NLP|BERT|GPT|tokens?|tokeni[sz]er|encoder|decoder|pre-?trained|embeddings?|inference|training|parameters)\b/i },
    { id: 'gemini', re: /\bGemini\b/,
        co: /\b(?:Google|DeepMind|Bard|models?|LLMs?|chatbot|assistant|multimodal|Nano|Ultra|Flash|API|prompts?)\b/ },
    { id: 'claude', re: /\bClaude\b/,
        co: /\b(?:Anthropic|models?|LLMs?|chatbot|assistant|Sonnet|Opus|Haiku|prompts?|API|Code)\b/ },
    { id: 'llama', re: /\bllamas?(?:[\s-]?\d+(?:\.\d+)?)?\b/i,
        co: /\b(?:Meta|models?|LLMs?|weights|parameters|fine-?tun\w*|inference|GGUF|quanti[sz]\w*|tokens?)\b/i },
    { id: 'copilot', re: /\bCopilot\b/,
        co: /\b(?:GitHub|Microsoft|Windows|Office|365|code|coding|assistant|Edge|Bing)\b/i },
    { id: 'grok', re: /\bgrok\b/i,
        co: /\b(?:xAI|Musk|chatbot|models?|LLMs?|X\.com)\b/i },
    { id: 'sora', re: /\bSora\b/,
        co: /\b(?:OpenAI|video|models?|text-to-video|generat\w+)\b/i },
    { id: 'perplexity', re: /\bperplexity\b/i,
        co: /\b(?:search|answer engine|chatbot|startup|Comet|models?|LLMs?)\b/i },
    { id: 'mistral', re: /\bMistral\b/,
        co: /\b(?:models?|LLMs?|Le Chat|open-weights?|open-source|startup|Mixtral)\b/i },
    { id: 'gpt_bare', re: /\bGPTs?\b/,
        co: /\b(?:OpenAI|models?|chatbot|LLMs?|prompts?|tokens?|custom|store)\b/i },
    { id: 'nlp', re: /\bNLP\b/i,
        co: /\b(?:language models?|models?|text|tokens?|corpus|corpora|BERT|transformers?|embeddings?|classification|sentiment|named entit\w+|parsing)\b/i },
    { id: 'bert', re: /\bBERT\b/,
        co: /\b(?:models?|NLP|language|transformers?|embeddings?|fine-?tun\w*|pre-?train\w*|tokens?|encoder|sentiment)\b/i },
    { id: 'embeddings', re: /\bembeddings?\b/i,
        co: /\b(?:vectors?|semantic|models?|retrieval|similarity|tokens?|word2vec|sentence|RAG|LLMs?)\b/i },
    { id: 'agentic', re: /\bagentic\b/i,
        co: /\b(?:workflows?|LLMs?|models?|coding|tools?|autonomous)\b/i },
    { id: 'robot', re: /\brobot(?:s|ics|ic)?\b/i,
        co: /\b(?:learning|learned|neural|vision|humanoids?|LLMs?|models?|trained|training|foundation)\b/i },
    { id: 'algorithm', re: /\balgorithm(?:s|ic)?\b/i,
        co: /\b(?:learning|neural|models?|recommendations?|recommender|trained|training|predictive)\b/i },
    { id: 'autonomous_vehicle', re: /\b(?:self-driving|autonomous[\s-]+(?:vehicles?|cars?|driving|trucks?)|robotaxis?|driverless)\b/i,
        co: /\b(?:neural|learning|models?|end-to-end|vision|perception|trained|training|FSD)\b/i },
]);

// ─── NEGATIVE (disambiguators: mask one term's spans when the condition holds) ─
// `mask` lists the spans to blank; `when` (optional) must match the ORIGINAL
// normalised text for the mask to apply, and `unless` (optional) vetoes it when
// it matches (an AI cue that overrides a non-AI sense). Masked spans become spaces, so the
// term no longer matches; every other term still does.
const AVIATION = /\b(?:flights?|Air India|airports?|airlines?|aircraft|planes?|Boeing|Airbus|Dreamliner|passengers?|crash(?:ed|es)?|pilots?|cockpit|runway|take-?off|landing|departure|diverted|DGCA|Heathrow)\b/i;
const NEGATIVE = freezeAll([
    { id: 'ai_flight_number', target: 'ai_acronym', mask: [/\bAI[\s-]?\d{2,4}\b/], when: AVIATION },
    { id: 'ai_file_format', target: 'ai_acronym',
        // A `when` clause must never be satisfiable by the masked span itself:
        // "AI vector search" is AI discourse, so `vector(s)` is in neither list.
        mask: [/\.ai\s+(?:files?|formats?|extension)\b/i, /\bAI\s+(?:files?|formats?)\b/,
            /\b(?:EPS|SVG|PDF|PSD|CDR|DXF|PNG|JPE?G)\s*(?:,|\/|and|or|&)\s*AI\b/, /\bAI\s*(?:,|\/|and|or|&)\s*(?:EPS|SVG|PDF|PSD|CDR|DXF)\b/],
        when: /\b(?:Adobe|Illustrator|EPS|SVG|PSD|CorelDRAW|Inkscape|download|templates?|clip ?art|logos?|printable)\b/i },
    { id: 'artificial_insemination', target: 'ai_acronym',
        mask: [/\bartificial[\s-]+insemination\b/i, AI_ACRONYM_RE], when: /\bartificial[\s-]+insemination\b/i },
    // Hardware cues only: "transformer models to forecast electricity demand on
    // the grid" is ML for power systems, so grid / electricity / utilities are
    // NOT cues, and `unless` lets any ML cue veto the mask.
    { id: 'transformer_power', target: 'transformer', mask: [/\btransformers?\b/i],
        when: /\b(?:voltage|kV|kilovolts?|substations?|megawatts?|MVA|kVA|transmission lines?|step-(?:down|up)|windings?|exploded|explosion)\b/i,
        unless: /\b(?:attention|neural|LLMs?|BERT|GPT|machine learning|deep learning|training|fine-?tun\w*|pre-?trained|tokens?|forecast\w*|transformer[\s-]+(?:models?|architectures?|networks?|based))\b/i },
    { id: 'transformer_franchise', target: 'transformer', mask: [/\btransformers?\b/i],
        when: /\b(?:Optimus Prime|Bumblebee|Autobots?|Decepticons?|Hasbro|Michael Bay|box office)\b/i },
    { id: 'gemini_astrology', target: 'gemini', mask: [/\bGemini\b/],
        // Astrology cue words only: sign names are ordinary names and brands
        // ("Leo said Google Gemini ...", Libra), so they are not cues.
        when: /\b(?:horoscopes?|zodiac|astrolog\w*|star signs?|moon sign|rising sign)\b/i },
    // "AGI" is also adjusted gross income; an AI cue vetoes the mask.
    { id: 'agi_tax', target: 'agi', mask: [/\bAGI\b/],
        when: /\b(?:adjusted gross income|taxes|tax|IRS|deductions?|1040|tax return|filing status)\b/i,
        unless: /\b(?:AI|artificial general|superintelligence|OpenAI|Anthropic|DeepMind|alignment)\b/ },
    { id: 'claude_person', target: 'claude', mask: [/\bJean-Claude\b/, /\bClaude\b/],
        when: /\b(?:Monet|Van Damme|Debussy|L[ée]vi-Strauss|Jean-Claude|Makel[ée]l[ée]|Chabrol|Lelouch|Shannon|Rains)\b/ },
    { id: 'llama_animal', target: 'llama', mask: [/\bllamas?\b/i],
        when: /\b(?:alpacas?|wool|farms?|ranch|camelids?|herds?|fleece|petting zoo|Andes|Peru|vicu[ñn]as?|guanacos?|trekking)\b/i },
    { id: 'gpt_partition', target: 'gpt_bare', mask: [/\bGPT\b/],
        when: /\b(?:partitions?|MBR|UEFI|disks?|BIOS|boot|sectors?|GUID)\b/i },
    { id: 'mistral_wind', target: 'mistral', mask: [/\bMistral\b/],
        when: /\b(?:wind|winds|gusts?|Provence|Rh[ôo]ne|weather|M[ée]t[ée]o|storms?)\b/i },
    { id: 'nlp_neuro_linguistic', target: 'nlp', mask: [/\bNLP\b/i], when: /\bneuro-?linguistic\b/i },
]);

// ─── SPAM SIGNATURES (force NOT_AI, propose SPAM) ────────────────────────────
const PHONE_CANDIDATE = /\+?\d[\d\s().-]{8,}\d/g;
// ISO dates and clock times are digit runs too ("2024-10-01 12:30:45"); blank them first.
const DATE_OR_TIME = /\b\d{4}-\d{2}-\d{2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?)?\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
function hasPhoneNumber(text) {
    const t = text.replace(DATE_OR_TIME, ' ');
    for (const m of t.matchAll(PHONE_CANDIDATE)) {
        const digits = m[0].replace(/\D/g, '').length;
        if (digits >= 10 && digits <= 15) return true;
    }
    return false;
}
const SUPPORT_PHRASE = /\b(?:customer (?:care|service|support)(?: (?:number|line|phone))?|helpline|help ?desk|toll[- ]?free|support (?:number|phone|line)|contact number|call (?:now|us|at)|hotline)\b/i;
const AIRLINE = /\b(?:airlines?|airways|Expedia)\b/i;
const AIRLINE_SUPPORT = /\b(?:customer (?:service|care|support) (?:number|line)|live (?:person|agent)|(?:speak|talk) to (?:a|someone)|reservations? (?:number|desk|line)|change (?:a |my )?flight|cancel(?:l?ation)? (?:policy|number)|refund (?:policy|number))\b/i;
const SPAM_SIGNATURES = freezeAll([
    { id: 'spam_phone_support', test: (t) => hasPhoneNumber(t) && SUPPORT_PHRASE.test(t) },
    { id: 'spam_airline_support', test: (t) => AIRLINE.test(t) && AIRLINE_SUPPORT.test(t) },
]);

// ─── MULTILINGUAL STRONG ─────────────────────────────────────────────────────
// kind 'cjk'   : substring of the whitespace-stripped text (zh, ja, ko)
// kind 're'    : Unicode-aware regex (es, pt, fr, de, ru); the Arabic terms are
//                compiled to one too, with any whitespace run between words
const L = '(?<![\\p{L}\\p{N}])';   // left boundary (Unicode)
const R = '(?![\\p{L}\\p{N}])';    // right boundary (Unicode)
const u = (src, flags = 'iu') => new RegExp(src, flags);
// "IA" / "KI" must stay case-sensitive ("ia" is a Portuguese verb form), so the
// function words around them are made case-insensitive one letter at a time:
// caps('la|el') -> '[Ll]a|[Ee]l' (JS has no inline (?i:) groups).
const caps = (words) => words.split('|').map(w => `[${w[0].toUpperCase()}${w[0].toLowerCase()}]${w.slice(1)}`).join('|');
// A sentence start (start of text, or after . ! ? and Spanish inverted marks).
const SENT = '(?:^|[.!?\\u00A1\\u00BF]\\s*)';
const cjk = (lang, terms) => terms.map(term => ({ id: `${lang}:${term}`, lang, kind: 'cjk', term: term.replace(/\s+/g, '') }));
// Substring terms (Arabic): spaces match any whitespace run, so a double space or a newline between the words still hits.
const sub = (lang, terms) => terms.map(term => ({ id: `${lang}:${term}`, lang, kind: 're', re: new RegExp(term.replace(/ /g, '\\s+'), 'u') }));
const rx = (lang, rows) => rows.map(([name, re]) => ({ id: `${lang}:${name}`, lang, kind: 're', re }));

const MULTILINGUAL = freezeAll([
    ...cjk('zh', ['人工智能', '人工智慧', '机器学习', '機器學習', '深度学习', '深度學習', '神经网络', '神經網路', '神經網絡',
        '大语言模型', '大型语言模型', '大語言模型', '大模型', '生成式人工智能', '自然语言处理', '自然語言處理', '计算机视觉', '電腦視覺']),
    ...cjk('ja', ['人工知能', '機械学習', '深層学習', 'ディープラーニング', 'ニューラルネットワーク', '大規模言語モデル', '生成AI',
        '自然言語処理', '画像生成AI']),
    ...cjk('ko', ['인공지능', '머신러닝', '기계 학습', '딥러닝', '신경망', '대규모 언어 모델', '대형 언어 모델', '거대 언어 모델',
        '생성형 AI', '자연어 처리', '컴퓨터 비전']),
    ...rx('es', [
        ['inteligencia artificial', u(`${L}inteligencia\\s+artificial${R}`)],
        ['aprendizaje automático', u(`${L}aprendizaje\\s+autom[aá]tico${R}`)],
        ['aprendizaje profundo', u(`${L}aprendizaje\\s+profundo${R}`)],
        ['red neuronal', u(`${L}redes?\\s+neuronal(?:es)?${R}`)],
        ['modelo de lenguaje', u(`${L}modelos?\\s+(?:grandes?\\s+)?de\\s+lenguaje${R}`)],
        ['IA', u(`${L}(?:(?:${caps('la|el|una|un|las|los|de|del|con|por|para|sobre|sin|en|y|que|al')})\\s+)IA${R}|${SENT}IA\\s+(?:es|est[aá]n?|ha|han|puede|pueden|va|vamos|seguir[aá]|cambia|y)${R}|${L}IA\\s+generativa${R}`, 'mu')],
        ['procesamiento del lenguaje natural', u(`${L}procesamiento\\s+del\\s+lenguaje\\s+natural${R}`)],
    ]),
    ...rx('pt', [
        ['inteligência artificial', u(`${L}intelig[êe]ncia\\s+artificial${R}`)],
        ['aprendizado de máquina', u(`${L}(?:aprendizado|aprendizagem)\\s+(?:de\\s+m[áa]quina|autom[áa]tic[ao])${R}`)],
        ['aprendizado profundo', u(`${L}(?:aprendizado\\s+profundo|aprendizagem\\s+profunda)${R}`)],
        ['rede neural', u(`${L}redes?\\s+neura(?:l|is)${R}`)],
        ['modelo de linguagem', u(`${L}modelos?\\s+(?:grandes?\\s+)?de\\s+linguagem${R}`)],
        ['IA', u(`${L}(?:(?:${caps('a|da|na|pela|com|sem|sobre|e|uma|das|nas|que')})\\s+)IA${R}|${SENT}IA\\s+(?:[eé]|est[aá]|vai|pode|j[aá]|n[aã]o|generativa)${R}`, 'mu')],
        ['processamento de linguagem natural', u(`${L}processamento\\s+de\\s+linguagem\\s+natural${R}`)],
    ]),
    ...rx('fr', [
        ['intelligence artificielle', u(`${L}intelligence\\s+artificielle${R}`)],
        ['apprentissage automatique', u(`${L}apprentissage\\s+(?:automatique|profond)${R}`)],
        ['réseau de neurones', u(`${L}r[ée]seaux?\\s+(?:de\\s+neurones|neuronaux|neuronal)${R}`)],
        ['modèle de langage', u(`${L}(?:grands?\\s+)?mod[èe]les?\\s+de\\s+langage${R}`)],
        ['IA', u(`(?:${L}(?:${caps('une|des|du|sur|par|avec|dans|et|sans|pour')})\\s+|${L}[ldLD]['’])IA${R}|${SENT}IA\\s+(?:est|va|peut|ont)${R}|${L}IA\\s+g[ée]n[ée]rative${R}`, 'mu')],
        ['traitement du langage naturel', u(`${L}traitement\\s+(?:automatique\\s+)?du\\s+langage(?:\\s+naturel)?${R}`)],
    ]),
    ...rx('de', [
        ['künstliche Intelligenz', u(`${L}k[üu]nstlich\\p{L}*\\s+Intelligenz${R}`)],
        ['maschinelles Lernen', u(`${L}maschinell\\p{L}*\\s+Lern\\p{L}*`)],
        ['neuronales Netz', u(`${L}neuronal\\p{L}*\\s+Netz\\p{L}*`)],
        ['Sprachmodell', u(`Sprachmodell\\p{L}*`)],
        ['KI', u(`${L}(?:${caps('die|der|den|dem|des|mit|durch|und|von|zur|zum|per|ohne|gegen')}|[Ff](?:ü|u|ue)r|(?:[Üü]|[Uu]e?)ber|[Ee]ine[mnrs]?)\\s+KI${R}|${SENT}KI\\s+(?:ist|kann|wird|hat|macht|und|ver[äa]ndert)${R}|${L}KI-\\p{L}|${L}generativ\\p{L}*\\s+KI${R}`, 'mu')],
    ]),
    ...rx('ru', [
        ['искусственный интеллект', u(`${L}искусственн\\p{L}*\\s+интеллект\\p{L}*`)],
        ['машинное обучение', u(`${L}машинн\\p{L}*\\s+обучени\\p{L}*`)],
        ['глубокое обучение', u(`${L}глубок\\p{L}*\\s+обучени\\p{L}*`)],
        ['нейросеть', u(`${L}нейросет\\p{L}*`)],
        ['нейронная сеть', u(`${L}нейронн\\p{L}*\\s+сет\\p{L}*`)],
        ['языковая модель', u(`${L}языков\\p{L}*\\s+модел\\p{L}*`)],
        ['ИИ', u(`${L}ИИ${R}`, 'u')],
    ]),
    ...sub('ar', ['الذكاء الاصطناعي', 'ذكاء اصطناعي', 'التعلم الآلي', 'تعلم الآلة', 'التعلم العميق', 'الشبكات العصبية',
        'شبكة عصبية', 'نماذج اللغة الكبيرة', 'النماذج اللغوية الكبيرة']),
]);

// ─── EDGE CASES (codebook v1 OPEN questions; tags only) ──────────────────────
const CRYPTO = /\b(?:crypto(?:currenc(?:y|ies))?|memecoins?|altcoins?|airdrops?|pre-?sales?|DeFi|blockchain|Solana|Ethereum|Bitcoin|BNB Chain|token (?:sale|launch|price)|market cap)\b/i;
const EDGE_CASES = freezeAll([
    { id: 'game_ai', test: (t) => /\b(?:[Gg]ame|[Ee]nemy|NPC|[Oo]pponent|[Cc]ompanion|[Ss]quad)\s+AI\b|\bAI\s+(?:opponents?|enemies|difficulty|director|companions?|teammates?|pathfinding)\b/.test(t) },
    { id: 'robotics_without_learning', test: (t, r) => r.unresolved.includes('robot') },
    { id: 'autonomous_vehicles', test: (t) => CONTEXT.find(c => c.id === 'autonomous_vehicle').re.test(t) || /\b(?:Waymo|Cruise|Zoox|Tesla FSD)\b/.test(t) },
    { id: 'algorithmic_trading', test: (t) => /\b(?:algorithmic trading|algo[\s-]?trading|quant(?:itative)? trading|HFT|high-frequency trading)\b/i.test(t) },
    { id: 'crypto_ai_token',
        test: (t, r) => CRYPTO.test(t) && (r.strong.length + r.multilingual.length + r.context.length > 0 || /\bAI[\s-](?:tokens?|coins?)\b/.test(t)) },
    { id: 'bot_generated', flag: 'BOT_GENERATED',
        test: (t) => /\[bot\]|\b(?:dependabot|renovate bot|automated (?:digest|summary|report|newsletter)|auto-?generated|(?:automatically|auto-) ?generated)\b/i.test(t) },
    { id: 'sdk_dependency_bump',
        test: (t) => /\b(?:bump|bumps|bumped|upgrade|update)\s+(?:the\s+)?[@\w./-]+\s+from\s+v?\d[\w.+-]*\s+to\s+v?\d/i.test(t) || /\bchore\(deps\)/i.test(t) },
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Harakat U+064B-U+065F, superscript alef U+0670 and tatweel U+0640 only: not
// the Arabic-Indic digits (U+0660-U+0669) or letters in between.
const ARABIC_MARKS = /[\u064B-\u065F\u0670\u0640]/g;

/**
 * Normalise text for matching: NFKC, Arabic diacritics and tatweel removed.
 * @param {unknown} text
 * @returns {string}
 */
function normalizeText(text) {
    if (typeof text !== 'string') return '';
    return text.normalize('NFKC').replace(ARABIC_MARKS, '');
}

/** A fresh global copy of a regex (never mutates the shared object's lastIndex). */
function globalOf(re) {
    return new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
}

function blank(text, re) {
    return text.replace(globalOf(re), m => ' '.repeat(m.length));
}

function emptyResult() {
    return {
        ai: false, label: 'NOT_AI', score: 0,
        strong: [], context: [], unresolved: [], suppressed: [], multilingual: [], spam: [],
        proposedFlags: [], edgeCases: [],
    };
}

/**
 * Classify a text with the tiered library. Pure and deterministic.
 *
 * @param {unknown} text  title + summary/body of an item
 * @returns {{ ai: boolean, label: 'AI'|'NOT_AI', score: number,
 *             strong: string[], context: string[], unresolved: string[],
 *             suppressed: string[], multilingual: string[], spam: string[],
 *             proposedFlags: string[], edgeCases: string[] }}
 *   ai          true when there is strong, multilingual or satisfied-context
 *               evidence (spam does not change it: it only proposes SPAM);
 *   score       min(1, (strong + multilingual + 0.5 × context) / 2) —
 *               bounded evidence strength, NOT a probability;
 *   unresolved  context terms present without a co-term;
 *   suppressed  negative disambiguators that fired;
 *   edgeCases   codebook OPEN-question tags (never change `ai`).
 */
function classifyTiered(text) {
    const t = normalizeText(text);
    const r = emptyResult();
    if (!t.trim()) return r;

    // 1. Negative disambiguators: mask the target term's spans.
    let masked = t;
    for (const n of NEGATIVE) {
        if (n.when && !n.when.test(t)) continue;
        if (n.unless && n.unless.test(t)) continue;
        let fired = false;
        for (const re of n.mask) {
            if (re.test(masked)) { fired = true; masked = blank(masked, re); }
        }
        if (fired) r.suppressed.push(n.id);
    }

    // 2. Strong (English) on the masked text.
    for (const s of STRONG) if (s.re.test(masked)) r.strong.push(s.id);

    // 3. Context: the term AND one of its co-terms.
    for (const c of CONTEXT) {
        if (!c.re.test(masked)) continue;
        // The co-term must appear outside the term's own spans.
        if (c.co.test(blank(masked, c.re))) r.context.push(c.id);
        else r.unresolved.push(c.id);
    }

    // 4. Multilingual strong.
    const squeezed = masked.replace(/\s+/g, '');
    for (const m of MULTILINGUAL) {
        const hit = m.kind === 'cjk' ? squeezed.includes(m.term) : m.re.test(masked);
        if (hit) r.multilingual.push(m.id);
    }

    // 5. Spam signatures (on the unmasked text).
    for (const s of SPAM_SIGNATURES) if (s.test(t)) r.spam.push(s.id);

    // 6. Edge-case tags (never change the decision).
    for (const e of EDGE_CASES) {
        if (e.test(t, r)) {
            r.edgeCases.push(e.id);
            if (e.flag && !r.proposedFlags.includes(e.flag)) r.proposedFlags.push(e.flag);
        }
    }

    const evidence = r.strong.length * WEIGHT.strong + r.multilingual.length * WEIGHT.multilingual
        + r.context.length * WEIGHT.context;
    // Spam proposes the SPAM flag only: the codebook labels AI-themed spam by
    // topic and flags it, so `ai` and `score` stay topic-based.
    if (r.spam.length) r.proposedFlags.unshift('SPAM');
    r.score = Math.round(Math.min(1, evidence / SCORE_SATURATION) * 1e6) / 1e6;
    r.ai = evidence > 0;
    r.label = r.ai ? 'AI' : 'NOT_AI';
    return r;
}

/** Every rule id across the tiers (documentation and uniqueness tests). */
function allRuleIds() {
    return [STRONG, CONTEXT, NEGATIVE, SPAM_SIGNATURES, MULTILINGUAL, EDGE_CASES].flatMap(rows => rows.map(x => x.id));
}

module.exports = {
    TIERS_LIBRARY_VERSION,
    STRONG,
    CONTEXT,
    NEGATIVE,
    SPAM_SIGNATURES,
    MULTILINGUAL,
    EDGE_CASES,
    WEIGHT,
    SCORE_SATURATION,
    normalizeText,
    classifyTiered,
    allRuleIds,
};
