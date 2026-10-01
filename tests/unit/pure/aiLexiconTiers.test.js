// tests/unit/pure/aiLexiconTiers.test.js
// Relevance-accuracy Stage 0 (P5): the TIERED lexicon library
// (src/config/ai-lexicon-tiers.js). It is an offline library only: nothing
// in production requires it, and the released lexicon (ai-lexicon.js), the
// relevance scorers and the admission filter stay untouched so replay of
// every released decision is unchanged.
//
// Covers: the strong / context / negative / multilingual tiers, the spam
// signatures, the codebook edge-case tags, CJK substring matching,
// determinism, and a battery of false-positive cases.

'use strict';

const fs = require('fs');
const path = require('path');
const tiers = require('../../../src/config/ai-lexicon-tiers');
const { classifyTiered, normalizeText, TIERS_LIBRARY_VERSION } = tiers;

const ai = (t) => classifyTiered(t).ai;

describe('library identity and shape', () => {
    it('declares a library version that is NOT a methodology version (offline draft)', () => {
        expect(TIERS_LIBRARY_VERSION).toMatch(/^0\.\d+\.\d+-draft$/);
    });

    it('every rule id is unique across tiers', () => {
        const ids = tiers.allRuleIds();
        expect(ids.length).toBeGreaterThan(60);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('the rule tables are frozen', () => {
        for (const k of ['STRONG', 'CONTEXT', 'NEGATIVE', 'SPAM_SIGNATURES', 'MULTILINGUAL', 'EDGE_CASES']) {
            expect(Object.isFrozen(tiers[k])).toBe(true);
        }
    });

    it('covers the nine required languages in the multilingual tier', () => {
        const langs = new Set(tiers.MULTILINGUAL.map(r => r.lang));
        for (const l of ['zh', 'ja', 'ko', 'es', 'pt', 'fr', 'de', 'ru', 'ar']) expect(langs.has(l)).toBe(true);
    });

    it('returns the empty result for non-strings and empty text', () => {
        for (const v of [undefined, null, 42, {}, '', '   ']) {
            const r = classifyTiered(v);
            expect(r).toMatchObject({ ai: false, label: 'NOT_AI', score: 0, strong: [], context: [], multilingual: [], spam: [] });
        }
    });

    it('is deterministic: the same input gives a deep-equal result every time', () => {
        const t = 'OpenAI and Anthropic ship new LLMs; 人工智能 adoption grows; la IA generativa avanza.';
        const a = classifyTiered(t);
        for (let i = 0; i < 5; i++) expect(classifyTiered(t)).toEqual(a);
    });

    it('does not leak regex state between calls (global-flag lastIndex)', () => {
        const t = 'AI 171 crashed after take-off, the flight had 242 passengers';
        expect(classifyTiered(t).ai).toBe(false);
        expect(classifyTiered(t).ai).toBe(false);
        expect(classifyTiered('The AI Act passed').ai).toBe(true);
        expect(classifyTiered('The AI Act passed').ai).toBe(true);
    });

    it('score is bounded in [0, 1] and grows with evidence', () => {
        const one = classifyTiered('A transformer model with attention').score;
        const many = classifyTiered('machine learning, deep learning and large language models from OpenAI').score;
        expect(one).toBeGreaterThan(0);
        expect(many).toBeGreaterThan(one);
        expect(many).toBeLessThanOrEqual(1);
    });
});

describe('normalizeText', () => {
    it('applies NFKC (full-width ＡＩ becomes AI)', () => {
        expect(normalizeText('ＡＩ技術')).toBe('AI技術');
    });

    it('strips Arabic diacritics and tatweel', () => {
        expect(normalizeText('الذَّكاء الاصطـناعي')).toBe('الذكاء الاصطناعي');
    });

    it('returns empty string for non-strings', () => {
        expect(normalizeText(null)).toBe('');
    });
});

describe('strong tier (unambiguous English)', () => {
    it.each([
        ['ai_acronym', 'The AI Act passed in Brussels'],
        ['artificial_intelligence', 'Artificial intelligence in schools'],
        ['machine_learning', 'a machine-learning pipeline'],
        ['deep_learning', 'Deep learning for weather'],
        ['neural_network', 'training neural networks'],
        ['large_language_model', 'large language models hallucinate'],
        ['language_model', 'a small language model on device'],
        ['llm', 'Which LLM is best?'],
        ['generative_ai', 'GenAI budgets rise'],
        ['chatgpt', 'ChatGPT outage'],
        ['openai', 'OpenAI board'],
        ['anthropic', 'Anthropic raises'],
        ['deepmind', 'DeepMind protein folding'],
        ['hugging_face', 'models on Hugging Face'],
        ['stable_diffusion', 'Stable Diffusion XL'],
        ['midjourney', 'Midjourney v7'],
        ['mistral_ai', 'Mistral AI releases'],
        ['agi', 'when will AGI arrive'],
        ['gpt_versioned', 'GPT-4o pricing'],
        ['chatbot', 'customer chatbots fail'],
        ['deepfake', 'deepfakes in the election'],
        ['diffusion_model', 'diffusion models for video'],
        ['reinforcement_learning', 'reinforcement learning from human feedback'],
        ['computer_vision', 'computer vision at the edge'],
        ['foundation_model', 'foundation models act'],
        ['deepseek', 'DeepSeek R2 released'],
        ['ollama', 'run it with ollama'],
        ['pytorch', 'PyTorch 3.0'],
        ['tensorflow', 'TensorFlow is deprecated'],
        ['rag', 'retrieval-augmented generation explained'],
        ['prompt_engineering', 'prompt engineering tips'],
        ['transformer_architecture', 'the transformer architecture'],
        ['text_to_media', 'a text-to-video tool'],
        ['apple_intelligence', 'Apple Intelligence features'],
        ['xai', 'xAI raises money'],
    ])('%s: %s', (id, text) => {
        const r = classifyTiered(text);
        expect(r.strong).toContain(id);
        expect(r.ai).toBe(true);
        expect(r.label).toBe('AI');
    });
});

describe('context tier (ambiguous terms need a co-term)', () => {
    it.each([
        ['transformer', 'transformer with self-attention over tokens'],
        ['gemini', 'Google Gemini assistant update'],
        ['claude', 'Claude Sonnet now writes code via the API'],
        ['llama', 'Llama 4 weights released by Meta'],
        ['copilot', 'GitHub Copilot for code review'],
        ['grok', 'Grok chatbot from Musk'],
        ['sora', 'Sora video generation'],
        ['perplexity', 'Perplexity search engine startup'],
        ['mistral', 'Mistral open-weight model'],
        ['gpt_bare', 'build custom GPTs with a prompt'],
        ['nlp', 'NLP text classification corpus'],
        ['bert', 'fine-tuning BERT for sentiment'],
        ['embeddings', 'embeddings for semantic retrieval'],
        ['agentic', 'agentic coding workflows'],
        ['robot', 'humanoid robots trained with learning'],
        ['algorithm', 'a recommendation algorithm trained on clicks'],
        ['autonomous_vehicle', 'self-driving cars use neural perception'],
    ])('%s is satisfied with a co-term: %s', (id, text) => {
        const r = classifyTiered(text);
        expect(r.context).toContain(id);
        expect(r.ai).toBe(true);
    });

    it.each([
        ['transformer', 'a transformer toy for kids'],
        ['gemini', 'Gemini constellation tonight'],
        ['claude', 'Claude, the baker down the street'],
        ['llama', 'a llama crossed the road'],
        ['copilot', 'Copilot seat'],
        ['grok', 'I grok the idea'],
        ['sora', 'Sora is a popular name'],
        ['perplexity', 'He stared in perplexity'],
        ['mistral', 'a Mistral sailboat'],
        ['nlp', 'NLP coaching weekend'],
        ['bert', 'BERT and ERNIE'],
        ['embeddings', 'the embeddings of a graph in a surface'],
        ['robot', 'robot vacuum on sale'],
        ['algorithm', 'a sorting algorithm in C'],
        ['autonomous_vehicle', 'driverless trains in Copenhagen'],
    ])('%s alone is unresolved, not AI: %s', (id, text) => {
        const r = classifyTiered(text);
        expect(r.context).not.toContain(id);
        expect(r.unresolved).toContain(id);
        expect(r.ai).toBe(false);
    });
});

describe('negative tier: disambiguators suppress one term, never other evidence', () => {
    it.each([
        ['transformer_power', 'transformer', 'A transformer exploded at the substation; 11 kV lines down, model of failure unclear'],
        ['transformer_franchise', 'transformer', 'Transformers movie: Optimus Prime returns, a new model toy line'],
        ['gemini_astrology', 'gemini', 'Gemini horoscope: your zodiac assistant says love is near'],
        ['claude_person', 'claude', 'Claude Monet painted water lilies; a model exhibition opens'],
        ['claude_person', 'claude', 'Jean-Claude Van Damme stars in a new film assistant role'],
        ['llama_animal', 'llama', 'Llama and alpaca farm opens; wool model shearing'],
        ['gpt_partition', 'gpt_bare', 'Convert MBR to GPT partition table for the boot disk store'],
        ['mistral_wind', 'mistral', 'The Mistral wind blows across Provence; weather model warns'],
        ['nlp_neuro_linguistic', 'nlp', 'NLP (neuro-linguistic programming) course on language text'],
    ])('%s suppresses %s', (negId, termId, text) => {
        const r = classifyTiered(text);
        expect(r.suppressed).toContain(negId);
        expect(r.context).not.toContain(termId);
        expect(r.ai).toBe(false);
    });

    it.each([
        ['ai_flight_number', 'Air India flight AI 171 crashed after take-off'],
        ['ai_flight_number', 'AI-302 delayed at Heathrow airport'],
        ['ai_file_format', 'Download the logo as an AI file or EPS for Illustrator'],
        ['ai_file_format', 'vector template in EPS, AI and SVG formats'],
        ['ai_file_format', 'open a .ai file without Adobe Illustrator'],
        ['artificial_insemination', 'Artificial insemination (AI) improves dairy herd fertility; AI technicians trained'],
    ])('%s removes the "AI" acronym hit: %s', (negId, text) => {
        const r = classifyTiered(text);
        expect(r.suppressed).toContain(negId);
        expect(r.strong).not.toContain('ai_acronym');
        expect(r.ai).toBe(false);
    });

    it('a suppressed term does not hide other AI evidence in the same text', () => {
        const r = classifyTiered('AI data centres strain grid transformers at the substation (kV)');
        expect(r.suppressed).toContain('transformer_power');
        expect(r.strong).toContain('ai_acronym');
        expect(r.ai).toBe(true);
    });

    it('the AI 2027 forecast is not a flight number', () => {
        expect(classifyTiered('The AI 2027 scenario on superintelligence').ai).toBe(true);
    });

    it('xAI / Character.ai domains are not treated as Illustrator files', () => {
        expect(classifyTiered('character.ai chatbot lawsuit').ai).toBe(true);
    });
});

describe('spam signatures (propose the SPAM flag, force NOT_AI)', () => {
    it.each([
        ['spam_phone_support', 'Coinbase customer care number +1-855-555-0199 call now for AI wallet help'],
        ['spam_phone_support', 'QuickBooks helpline 1 (800) 555 0123 toll-free AI support'],
        ['spam_airline_support', 'How do I speak to a live person at Expedia airlines? AI chatbot can not help'],
        ['spam_airline_support', 'Delta Airlines reservations number: change my flight fast'],
    ])('%s: %s', (id, text) => {
        const r = classifyTiered(text);
        expect(r.spam).toContain(id);
        expect(r.proposedFlags).toContain('SPAM');
        expect(r.ai).toBe(false);
        expect(r.label).toBe('NOT_AI');
        expect(r.score).toBe(0);
    });

    it('a phone number alone (no support phrasing) is not spam', () => {
        const r = classifyTiered('Call our AI lab on +44 20 7946 0958 to book a demo');
        expect(r.spam).toEqual([]);
        expect(r.ai).toBe(true);
    });

    it('airline news without support phrasing is not spam', () => {
        expect(classifyTiered('United Airlines uses machine learning to schedule crews').spam).toEqual([]);
    });
});

describe('multilingual strong tier', () => {
    it.each([
        ['zh', '人工智能正在改变医疗'],
        ['zh', '人工智慧與機器學習'],
        ['zh', '大语言模型的安全评估'],
        ['zh', '深度学习框架'],
        ['ja', '人工知能の規制について'],
        ['ja', '機械学習エンジニア募集'],
        ['ja', '大規模言語モデルを活用'],
        ['ja', 'ディープラーニング入門'],
        ['ko', '인공지능 규제 법안'],
        ['ko', '기계 학습 모델'],
        ['ko', '기계학습 모델'],
        ['ko', '대규모 언어 모델 발표'],
        ['es', 'La inteligencia artificial en la educación'],
        ['es', 'aprendizaje automático para todos'],
        ['es', 'el avance de la IA en Europa'],
        ['pt', 'A inteligência artificial no Brasil'],
        ['pt', 'aprendizado de máquina e redes neurais'],
        ['pt', 'regulação da IA generativa'],
        ['fr', "L'intelligence artificielle et l'emploi"],
        ['fr', "les risques de l'IA générative"],
        ['fr', 'réseaux de neurones profonds'],
        ['de', 'Künstliche Intelligenz in der Schule'],
        ['de', 'Die KI-Verordnung der EU'],
        ['de', 'maschinelles Lernen für Ärzte'],
        ['ru', 'Искусственный интеллект в медицине'],
        ['ru', 'развитие искусственного интеллекта'],
        ['ru', 'ИИ меняет рынок труда'],
        ['ru', 'нейросеть нарисовала картину'],
        ['ar', 'الذكاء الاصطناعي في التعليم'],
        ['ar', 'وبالذكاء الاصطناعي يتغير العالم'],
        ['ar', 'التعلم الآلي والشبكات العصبية'],
    ])('%s: %s', (lang, text) => {
        const r = classifyTiered(text);
        expect(r.multilingual.some(id => id.startsWith(`${lang}:`))).toBe(true);
        expect(r.ai).toBe(true);
    });

    it('matches CJK as a substring inside running text with no spaces', () => {
        expect(classifyTiered('我们公司正在研究人工智能技术的应用').ai).toBe(true);
        expect(classifyTiered('最新の人工知能チップが発表された').ai).toBe(true);
    });

    it('matches full-width ＡＩ in Japanese after NFKC', () => {
        expect(classifyTiered('生成ＡＩの活用').strong).toContain('ai_acronym');
    });

    it.each([
        'Iowa (IA) caucus results',
        'IA is the postal code of Iowa',
        'KIA motors quarterly results',
        'Kiribati (KI) fishing rights',
        'интеллигенция и культура',
        'the word inteligente is Spanish',
        '人工湖の水位',
        '智能手机销量增长',
    ])('false positive guard: %s', (text) => {
        expect(ai(text)).toBe(false);
    });
});

describe('codebook OPEN edge cases are TAGGED, never decided by the library', () => {
    it.each([
        ['game_ai', 'The enemy AI in the new shooter is too easy', true],
        ['robotics_without_learning', 'Industrial robot arms welding car frames', false],
        ['autonomous_vehicles', 'Waymo robotaxis expand to Austin', false],
        ['algorithmic_trading', 'Algorithmic trading firms and HFT profits', false],
        ['crypto_ai_token', 'New AI token presale on Solana, memecoin traders pile in', true],
        ['bot_generated', 'dependabot[bot]: automated digest of updates', false],
        ['sdk_dependency_bump', 'Bump openai from 1.40.0 to 1.41.2', true],
        ['sdk_dependency_bump', 'chore(deps): update transformers to v5', false],
    ])('%s: %s', (tag, text, expectAi) => {
        const r = classifyTiered(text);
        expect(r.edgeCases).toContain(tag);
        expect(r.ai).toBe(expectAi);
    });

    it('bot-generated text proposes the BOT_GENERATED flag', () => {
        expect(classifyTiered('This issue was automatically generated by a bot').proposedFlags).toContain('BOT_GENERATED');
    });

    it('LLM "tokens" are not crypto', () => {
        expect(classifyTiered('LLM context window of 1M tokens').edgeCases).not.toContain('crypto_ai_token');
    });

    it('every edge-case tag is one of the codebook OPEN items', () => {
        const ids = tiers.EDGE_CASES.map(e => e.id).sort();
        expect(ids).toEqual(['algorithmic_trading', 'autonomous_vehicles', 'bot_generated', 'crypto_ai_token',
            'game_ai', 'robotics_without_learning', 'sdk_dependency_bump'].sort());
    });
});

describe('false-positive battery (none of these are AI)', () => {
    it.each([
        'HIV/AIDS funding cut',
        'AIG shares fall after earnings',
        'Thailand travel guide',
        'said the maid to the gardener',
        'The Transformers: Rise of the Beasts box office',
        'Power transformer fire leaves 10,000 without electricity',
        'Gemini season horoscope for Taurus',
        'Claude Debussy piano recital',
        'Llama trekking in Peru',
        'Bert from Sesame Street',
        'robot vacuum cleaner deal',
        'Algorithmic trading desk hires quants',
        'GPT partition vs MBR on Windows 11',
        'artificial insemination of cattle',
        'Air India AI 101 diverted to Vienna airport',
        'Save as .ai file for Adobe Illustrator',
        'Book your Southwest Airlines flight: speak to a live person 1-800-555-0100',
        'neural tube defects in newborns',
        'a smart thermostat saves energy',
        'Mistral wind warning for the Rhône valley',
        'perplexity of the crowd',
    ])('%s', (text) => {
        expect(ai(text)).toBe(false);
    });
});

describe('isolation from production (released methodology untouched)', () => {
    const SRC = path.join(__dirname, '../../../src');

    function walk(dir) {
        return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
            const p = path.join(dir, e.name);
            return e.isDirectory() ? walk(p) : (p.endsWith('.js') ? [p] : []);
        });
    }

    it('no production module requires the tiered library or the gold-set modules', () => {
        const offenders = walk(SRC)
            .filter(f => !f.endsWith(path.join('config', 'ai-lexicon-tiers.js')))
            .filter(f => !f.includes(`${path.sep}gold${path.sep}`))
            .filter(f => /ai-lexicon-tiers|['"/]gold\//.test(fs.readFileSync(f, 'utf8')));
        expect(offenders).toEqual([]);
    });

    it('the released relevance scorer and admission filter give the same answers as before', () => {
        const { computeRelevance } = require('../../../src/pipeline/relevance');
        const { isAiRelated } = require('../../../src/collectors/ai-filter');
        // "transformer" alone still scores under relevance@1.2.0; the tiered
        // library would not count it. The released rules are not changed.
        expect(computeRelevance('a transformer toy').matchedKeywords).toEqual(['transformer']);
        expect(isAiRelated('robot vacuum on sale')).toBe(true);
    });
});
