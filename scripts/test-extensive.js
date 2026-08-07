#!/usr/bin/env node
// Extensive stress test for the chatbot's classification and output-validation logic.
// Complements test-classify.js (which checks literal keywords) by testing:
//   A. Natural-language paraphrases of every topic keyword (not just the bare keyword),
//      both with the card named explicitly and as a context-only follow-up.
//   A2. Typo/fuzzy-match robustness for single-word English keywords.
//   B. Out-of-scope categories phrased naturally, standalone and right after a card
//      was discussed (must not get pulled into that card's Overview).
//   C. validateGroundedReply: numeric equivalence, large-figure paraphrase, range
//      paraphrase, stopword-bait false matches, and genuinely fabricated replies.
//   D. Multi-card/multi-topic combined replies scored per-chunk, not pooled.
//
// Pulls the real implementation out of index.html (same technique as test-classify.js)
// so it always runs against the deployed code. Exits non-zero with a diagnostic list
// on any failure.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INDEX_PATH = path.join(ROOT, 'index.html');
const DATA_PATH = path.join(ROOT, 'data.json');

function extractTemplate(html) {
  const TEMPLATE_OPEN = '<script type="__bundler/template">';
  const markerIdx = html.indexOf(TEMPLATE_OPEN);
  if (markerIdx === -1) throw new Error('__bundler/template script tag not found in index.html');
  const openQuoteIdx = markerIdx + TEMPLATE_OPEN.length;
  let closeTail = '</script>\r\n</body>\r\n</html>';
  let closeTailIdx = html.lastIndexOf(closeTail);
  if (closeTailIdx === -1) {
    closeTail = '</script>\n</body>\n</html>';
    closeTailIdx = html.lastIndexOf(closeTail);
  }
  if (closeTailIdx === -1) throw new Error('could not find the closing </script></body></html> tail');
  return JSON.parse(html.slice(openQuoteIdx, closeTailIdx));
}

function extractClassifyLogic(template) {
  const startMarker = "const CARD_DATA = JSON.parse(document.getElementById('card-data').textContent);";
  const startIdx = template.indexOf(startMarker);
  if (startIdx === -1) throw new Error('CARD_DATA destructure not found — has index.html been refactored?');
  const endMarker = 'const STRINGS = {';
  const endIdx = template.indexOf(endMarker, startIdx);
  if (endIdx === -1) throw new Error('end-of-logic marker (STRINGS) not found');
  return template.slice(startIdx, endIdx);
}

function buildModule(dataJsonText) {
  const html = fs.readFileSync(INDEX_PATH, 'utf-8');
  const template = extractTemplate(html);
  const logicSrc = extractClassifyLogic(template);
  const stub = `const document = { getElementById: () => ({ textContent: ${JSON.stringify(dataJsonText)} }) };\n`;
  const exportsList = [
    'classifyKeyword', 'classifyAndRespond', 'CARDS', 'GENERAL_SCRIPTS', 'OOS', 'OOS_LABELS',
    'SCRIPT_INDEX', 'slug', 'validateGroundedReply', 'combineScripts', 'detectLang', 'tokenize',
    'cjkBigrams', 'mostSpecificCardMatch', 'resolveContextCardId',
  ];
  const full = stub + logicSrc + `\nconst window = {};\nmodule.exports = { ${exportsList.join(', ')} };\n`;
  const tmpPath = path.join(require('os').tmpdir(), `classify-sim-ext-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(tmpPath, full);
  try {
    return require(tmpPath);
  } finally {
    fs.unlinkSync(tmpPath);
  }
}

async function main() {
  const dataJsonText = fs.readFileSync(DATA_PATH, 'utf-8').trimEnd();
  const mod = buildModule(dataJsonText);
  const {
    classifyKeyword, classifyAndRespond, CARDS, GENERAL_SCRIPTS, OOS, SCRIPT_INDEX,
    slug, validateGroundedReply, combineScripts,
  } = mod;

  const failures = [];
  let checks = 0;
  function fail(section, detail) { failures.push({ section, ...detail }); }

  function hasSegment(label, card, topic) {
    if (!label) return false;
    const expected = `${card.name} — ${topic.topic}`;
    return label.split(' + ').includes(expected);
  }
  const isCjk = (s) => /[一-鿿]/.test(s);

  // ---------------------------------------------------------------------
  // Section A: natural-language paraphrase templates for every topic keyword.
  // ---------------------------------------------------------------------
  const EN_EXPLICIT_TPL = [
    (card, kw) => `Can you tell me about the ${card} ${kw}?`,
    (card, kw) => `What is the ${kw} like on the ${card}?`,
    (card, kw) => `I have a question about ${kw} for my ${card}.`,
    (card, kw) => `Regarding the ${card}, what about ${kw}?`,
  ];
  const EN_CONTEXT_TPL = [
    (kw) => `Can you tell me about the ${kw}?`,
    (kw) => `What is the ${kw}?`,
    (kw) => `I have a question about ${kw}.`,
    (kw) => `What about ${kw}?`,
  ];
  const ZH_EXPLICIT_TPL = [
    (card, kw) => `請問${card}的${kw}是什麼？`,
    (card, kw) => `我想了解${card}的${kw}。`,
    (card, kw) => `關於${card}，${kw}的部分呢？`,
    (card, kw) => `${card}的${kw}怎麼算？`,
  ];
  const ZH_CONTEXT_TPL = [
    (kw) => `請問${kw}是什麼？`,
    (kw) => `我想了解${kw}。`,
    (kw) => `${kw}的部分呢？`,
    (kw) => `${kw}怎麼算？`,
  ];

  for (const card of CARDS) {
    const cardKeyword = card.keywords[0];
    for (const topic of card.topics) {
      if (!topic.keywords.length) continue;
      for (const kw of topic.keywords) {
        const explicitTpls = isCjk(kw) ? ZH_EXPLICIT_TPL : EN_EXPLICIT_TPL;
        const contextTpls = isCjk(kw) ? ZH_CONTEXT_TPL : EN_CONTEXT_TPL;

        for (const tpl of explicitTpls) {
          checks++;
          const msg = tpl(cardKeyword, kw);
          const result = classifyKeyword(msg, []);
          const label = result.script && result.script.label;
          if (!hasSegment(label, card, topic)) {
            fail('A-explicit-paraphrase', {
              card: card.id, topic: topic.topic, keyword: kw, message: msg,
              got: result.script ? label : `no match (${result.kind})`,
            });
          }
        }

        for (const tpl of contextTpls) {
          checks++;
          const msg = tpl(kw);
          const history = [{ role: 'user', content: `Tell me about the ${card.name}` }];
          const ctxResult = classifyKeyword(msg, history);
          if (!hasSegment(ctxResult.script && ctxResult.script.label, card, topic)) {
            fail('A-context-paraphrase (classifyKeyword)', {
              card: card.id, topic: topic.topic, keyword: kw, message: msg,
              got: ctxResult.script ? ctxResult.script.label : `no match (${ctxResult.kind})`,
            });
          }

          checks++;
          const llmResult = await classifyAndRespond(msg, history);
          if (!hasSegment(llmResult.script && llmResult.script.label, card, topic)) {
            fail('A-context-paraphrase (classifyAndRespond safety net)', {
              card: card.id, topic: topic.topic, keyword: kw, message: msg,
              got: llmResult.script ? llmResult.script.label : `no match (${llmResult.kind})`,
            });
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Section A2: typo/fuzzy-match robustness for single-word English keywords
  // (length >= 6, so closeEnough's substitution-typo rule applies).
  // ---------------------------------------------------------------------
  function makeTypo(word) {
    // closeEnough only tolerates a single substitution/insertion/deletion (it scans
    // left-to-right and bails after one mismatch) — an adjacent-letter transposition
    // registers as TWO mismatches under that scan, so it doesn't qualify. Substitute
    // one interior letter with an adjacent QWERTY-ish letter instead, a true 1-edit typo.
    const i = Math.floor(word.length / 2);
    const chars = word.split('');
    const alt = chars[i] === 'e' ? 'r' : 'e';
    chars[i] = alt;
    return chars.join('');
  }

  for (const card of CARDS) {
    for (const topic of card.topics) {
      if (!topic.keywords.length) continue;
      for (const kw of topic.keywords) {
        if (isCjk(kw) || /\s/.test(kw) || kw.length < 6) continue;
        const typo = makeTypo(kw);
        if (typo === kw) continue;
        checks++;
        const msg = `What about ${typo}?`;
        const history = [{ role: 'user', content: `Tell me about the ${card.name}` }];
        const ctxResult = classifyKeyword(msg, history);
        if (!hasSegment(ctxResult.script && ctxResult.script.label, card, topic)) {
          fail('A2-typo-fuzzy (classifyKeyword)', {
            card: card.id, topic: topic.topic, keyword: kw, typo, message: msg,
            got: ctxResult.script ? ctxResult.script.label : `no match (${ctxResult.kind})`,
          });
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Section B: out-of-scope categories, phrased naturally, standalone and
  // right after a card context — must not get pulled into that card's Overview.
  // ---------------------------------------------------------------------
  const EN_OOS_TPL = [
    (kw) => `I need help with ${kw}.`,
    (kw) => `Can you help me with ${kw}?`,
    (kw) => `I have an issue: ${kw}.`,
  ];
  const ZH_OOS_TPL = [
    (kw) => `我需要處理${kw}的問題。`,
    (kw) => `可以幫我${kw}嗎？`,
    (kw) => `關於${kw}，能協助我嗎？`,
  ];

  for (const oos of OOS) {
    for (const kw of oos.keywords) {
      const tpls = isCjk(kw) ? ZH_OOS_TPL : EN_OOS_TPL;
      for (const tpl of tpls) {
        const msg = tpl(kw);

        checks++;
        const standalone = classifyKeyword(msg, []);
        if (!standalone.oos || standalone.oos.label !== oos.label) {
          fail('B-oos-standalone (classifyKeyword)', {
            topic: oos.label, keyword: kw, message: msg,
            got: standalone.oos ? standalone.oos.label : `no oos match (${standalone.kind})`,
          });
        }

        for (const card of CARDS) {
          checks++;
          const history = [{ role: 'user', content: `Tell me about the ${card.name}` }];
          const llmResult = await classifyAndRespond(msg, history);
          if (llmResult.script) {
            fail('B-oos-after-context (classifyAndRespond safety net)', {
              card: card.id, topic: oos.label, keyword: kw, message: msg,
              got: `wrongly matched a card script: ${llmResult.script.label}`,
            });
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Section C: validateGroundedReply — hand-crafted primitive checks.
  // ---------------------------------------------------------------------
  function checkC(desc, reply, script, lang, expectOk, allowTrailing) {
    checks++;
    const result = validateGroundedReply(reply, script, lang, allowTrailing);
    if (result.ok !== expectOk) {
      fail('C-unit', { desc, reply, expectOk, got: result });
    }
  }

  checkC('no script -> always ok', 'anything at all', null, 'en', true);
  checkC('empty reply -> rejected', '', { response: 'The annual fee is NT$1,000.' }, 'en', false);
  checkC(
    'numeric decimal-format equivalence (3% vs 3.0%)',
    'The annual fee waiver requires 3.0% in card spending.',
    { response: 'The annual fee waiver requires 3% in card spending each year.' }, 'en', true
  );
  checkC(
    'numeric comma/decimal equivalence (NT$50,000 vs NT$50000.00)',
    'The minimum spending threshold is NT$50000.00 in card transactions.',
    { response: 'The minimum spending threshold is NT$50,000 in card transactions.' }, 'en', true
  );
  checkC(
    'altered figure is rejected',
    'The annual fee waiver requires 4% in card spending.',
    { response: 'The annual fee waiver requires 3% in card spending each year.' }, 'en', false
  );
  checkC(
    'large-figure paraphrase: word-scale -> full digits',
    'Travel accident insurance coverage goes up to NT$35,000,000 for cardholders.',
    { response: 'Travel accident insurance covers up to NT$35 million for cardholders.' }, 'en', true
  );
  checkC(
    'large-figure paraphrase: full digits -> word-scale',
    'Travel accident insurance covers up to NT$35 million for cardholders.',
    { response: 'Travel accident insurance coverage goes up to NT$35,000,000 for cardholders.' }, 'en', true
  );
  checkC(
    'range paraphrase: explicit prefix on both ends',
    'Cash advance fees run from NT$1,000 to NT$1,500 for cardholders.',
    { response: 'Cash advance fees run from NT$1,000-1,500 for cardholders.' }, 'en', true
  );
  checkC(
    'range paraphrase: altered upper bound is rejected',
    'Cash advance fees run from NT$1,000 to NT$1,600 for cardholders.',
    { response: 'Cash advance fees run from NT$1,000-1,500 for cardholders.' }, 'en', false
  );
  checkC(
    'fabricated unrelated sentence is rejected',
    'This card also includes free unlimited airport lounge visits worldwide for the whole family.',
    { response: 'The annual fee waiver requires 3% in card spending each year.' }, 'en', false
  );
  checkC(
    'trailing escalation sentence exempted when allowTrailingUngrounded',
    'The annual fee waiver requires 3% in card spending each year. I will also connect you with a representative for the rest of your request.',
    { response: 'The annual fee waiver requires 3% in card spending each year.' }, 'en', true, true
  );
  checkC(
    'ungrounded sentence NOT exempted without the flag',
    'The annual fee waiver requires 3% in card spending each year. I will also connect you with a representative for the rest of your request.',
    { response: 'The annual fee waiver requires 3% in card spending each year.' }, 'en', false, false
  );
  checkC(
    'zh numeric equivalence',
    '年費減免需要每年刷卡滿新台幣三萬元。'.replace('三萬', '30000'),
    { responseZh: '年費減免需要每年刷卡滿新台幣30,000元。' }, 'zh', true
  );
  checkC(
    'zh altered figure is rejected',
    '年費減免需要每年刷卡滿新台幣40,000元。',
    { responseZh: '年費減免需要每年刷卡滿新台幣30,000元。' }, 'zh', false
  );
  checkC(
    'large-figure paraphrase, reverse direction: fact full-digit, reply word-scale',
    'Travel accident insurance covers up to NT$35 million for cardholders.',
    { response: 'Travel accident insurance coverage goes up to NT$35,000,000 for cardholders.' }, 'en', true
  );
  checkC(
    'digit swapped between two numbers that both legitimately appear elsewhere in the same fact is rejected',
    'You get up to 2 free days per session at Taoyuan or Kaohsiung airport, 2 sessions per airport.',
    { response: 'You get up to 7 free days per session at Taoyuan or Kaohsiung airport, 2 sessions per airport.' }, 'en', false
  );

  // ---------------------------------------------------------------------
  // Section C2: validateGroundedReply against every REAL script in the library —
  // the approved text itself must always be considered grounded in itself
  // (sanity check that the checker never false-rejects the source of truth),
  // and a single altered digit in it must always be rejected.
  // ---------------------------------------------------------------------
  const NUM_RE_TEST = /(?:NT\$|US\$|\$)?\d[\d,]*(?:\.\d+)?%?/g;
  function canon(raw) {
    const m = raw.match(/^((?:NT\$|US\$|\$)?)([\d,]+(?:\.\d+)?)(%?)$/);
    if (!m) return raw;
    return m[1] + parseFloat(m[2].replace(/,/g, '')) + m[3];
  }
  // Changing one digit can coincidentally reproduce a value that's ALREADY present
  // elsewhere in the same fact text (e.g. "7 free days ... 2 sessions" -> mutate the
  // 7 into a 2), which the set-membership check can't tell apart from the real one —
  // that's a genuine blind spot, tracked separately below, not what this helper is
  // for. This helper picks a mutation that lands on a value absent from the whole
  // text, so it isolates "was this specific digit checked at all".
  function corruptOneDigit(text) {
    const allMatches = text.match(NUM_RE_TEST) || [];
    const existingCanon = new Set(allMatches.map(canon));
    for (let mi = 0; mi < allMatches.length; mi++) {
      const target = allMatches[mi];
      const startIdx = findAllIndicesLocal(text, target)[occurrenceIndex(allMatches, mi, target)];
      const digitIdx = target.search(/\d/);
      if (digitIdx === -1 || startIdx === -1) continue;
      const absIdx = startIdx + digitIdx;
      const origDigit = text[absIdx];
      for (let delta = 1; delta <= 9; delta++) {
        const newDigit = String((parseInt(origDigit, 10) + delta) % 10);
        if (newDigit === origDigit) continue;
        const candidateText = text.slice(0, absIdx) + newDigit + text.slice(absIdx + 1);
        const candidateMatches = candidateText.match(NUM_RE_TEST) || [];
        const candidateToken = candidateMatches[mi];
        if (candidateToken && !existingCanon.has(canon(candidateToken))) {
          return candidateText;
        }
      }
    }
    return null;
  }
  function findAllIndicesLocal(haystack, needle) {
    const idxs = [];
    let i = haystack.indexOf(needle);
    while (i !== -1) { idxs.push(i); i = haystack.indexOf(needle, i + 1); }
    return idxs;
  }
  function occurrenceIndex(allMatches, mi, target) {
    let count = 0;
    for (let k = 0; k < mi; k++) if (allMatches[k] === target) count++;
    return count;
  }

  for (const [id, script] of Object.entries(SCRIPT_INDEX)) {
    if (script.response) {
      checks++;
      const r = validateGroundedReply(script.response, script, 'en');
      if (!r.ok) fail('C2-self-grounded-en', { id, reason: r.reason, text: script.response });

      const corrupted = corruptOneDigit(script.response);
      if (corrupted) {
        checks++;
        const cr = validateGroundedReply(corrupted, script, 'en');
        if (cr.ok) fail('C2-corrupted-digit-should-reject-en', { id, original: script.response, corrupted });
      }
    }
    if (script.responseZh) {
      checks++;
      const r = validateGroundedReply(script.responseZh, script, 'zh');
      if (!r.ok) fail('C2-self-grounded-zh', { id, reason: r.reason, text: script.responseZh });

      const corrupted = corruptOneDigit(script.responseZh);
      if (corrupted) {
        checks++;
        const cr = validateGroundedReply(corrupted, script, 'zh');
        if (cr.ok) fail('C2-corrupted-digit-should-reject-zh', { id, original: script.responseZh, corrupted });
      }
    }
  }

  // ---------------------------------------------------------------------
  // Section D: multi-script combined replies scored per-chunk, not pooled —
  // a reply grounded ONLY in the first script's chunk (nothing from the
  // second) must still pass; a reply corrupting a number from either chunk
  // must still be rejected even though it's "diluted" inside a bigger reply.
  // ---------------------------------------------------------------------
  const allScriptEntries = Object.entries(SCRIPT_INDEX).filter(([, s]) => s.response);
  let pairsTested = 0;
  for (let i = 0; i < allScriptEntries.length && pairsTested < 40; i += 7) {
    const [idA, scriptA] = allScriptEntries[i];
    const [idB, scriptB] = allScriptEntries[(i + 3) % allScriptEntries.length];
    if (idA === idB) continue;
    pairsTested++;
    const combined = {
      label: scriptA.label + ' + ' + scriptB.label,
      response: combineScripts([scriptA, scriptB], 'response'),
    };

    checks++;
    const onlyA = validateGroundedReply(scriptA.response, combined, 'en');
    if (!onlyA.ok) fail('D-single-chunk-of-combined-should-pass', { idA, idB, reply: scriptA.response, reason: onlyA.reason });

    checks++;
    const both = validateGroundedReply(scriptA.response + ' ' + scriptB.response, combined, 'en');
    if (!both.ok) fail('D-both-chunks-of-combined-should-pass', { idA, idB, reason: both.reason });

    const corruptedA = corruptOneDigit(scriptA.response);
    if (corruptedA) {
      checks++;
      const withCorruptA = validateGroundedReply(corruptedA + ' ' + scriptB.response, combined, 'en');
      if (withCorruptA.ok) fail('D-corrupted-chunk-inside-combined-should-reject', { idA, idB, corruptedA });
    }
  }

  // ---------------------------------------------------------------------
  // Section E: stopword-only bait must NOT spuriously match a multi-word
  // keyword whose real content word is absent (regression: 823afe6).
  // ---------------------------------------------------------------------
  const ENGLISH_STOPWORDS = new Set(['how', 'do', 'does', 'did', 'i', 'my', 'me', 'you', 'your', 'is', 'are', 'was', 'were', 'a', 'an', 'the', 'of', 'for', 'to', 'in', 'on', 'at', 'and', 'or', 'it', 'this', 'that', 'what', 'which', 'who', 'can', 'could', 'will', 'would', 'should', 'please', 'want', 'need', 'get', 'got']);
  const multiWordKeywords = [];
  for (const card of CARDS) {
    for (const topic of card.topics) {
      for (const kw of topic.keywords) {
        if (isCjk(kw)) continue;
        const words = kw.toLowerCase().split(/\s+/);
        if (words.length < 2) continue;
        const contentWords = words.filter(w => !ENGLISH_STOPWORDS.has(w));
        if (contentWords.length === words.length) continue; // no stopwords in it, not a bait case
        multiWordKeywords.push({ card, topic, kw, contentWords });
      }
    }
  }
  for (const { card, topic, kw, contentWords } of multiWordKeywords) {
    checks++;
    // Only the keyword's OWN stopwords, shuffled into an unrelated question — its
    // real content word(s) never appear anywhere in the message.
    const bait = `How do I do this for you please?`;
    const history = [{ role: 'user', content: `Tell me about the ${card.name}` }];
    const result = classifyKeyword(bait, history);
    if (hasSegment(result.script && result.script.label, card, topic)) {
      fail('E-stopword-bait-should-not-match', { card: card.id, topic: topic.topic, keyword: kw, message: bait, got: result.script.label });
    }
  }

  // ---------------------------------------------------------------------
  // Section F: a pure out-of-scope request that happens to contain the bare
  // singular word "card" must stay a clean escalation, not get bundled with
  // the full GENERAL_CARD_LIST catalog of all 16 cards. GENERAL_CARD_LIST's
  // own keyword is "cards" (plural); closeEnough('card','cards') is true
  // because it stops scanning once the shorter string is exhausted and never
  // penalizes the leftover trailing 's' — so any OOS message using the
  // ordinary singular ("my card", "cancel my card") silently pulls in the
  // whole card list. Reproduces with NO conversation history at all, so it's
  // broader than (and independent of) the earlier "I lost my card" context
  // incident this codebase already fixed once.
  // ---------------------------------------------------------------------
  const oosSingularCardPhrases = [
    { msg: 'I lost my card', label: 'Lost/stolen card' },
    { msg: 'My card was stolen', label: 'Lost/stolen card' },
    { msg: 'I want to cancel my card', label: 'Cancel card' },
    { msg: "What's my application status for my card?", label: 'Application status' },
  ];
  for (const { msg, label } of oosSingularCardPhrases) {
    checks++;
    const result = classifyKeyword(msg, []);
    if (result.script) {
      fail('F-oos-singular-card-should-not-pull-in-card-list', {
        message: msg, expectedOos: label,
        got: `wrongly matched: ${result.script.label}`,
      });
    }
  }

  // ---------------------------------------------------------------------
  // Section G: regression for a real bug caught live -- "are these all the
  // perks it has" right after discussing the World Card / Infinity Card came
  // back with Overview snippets from SEVEN unrelated cards plus the cross-card
  // Dining Privileges script, because the old grep-based fallback searched the
  // whole catalog's prose for a stray content word instead of staying scoped to
  // the card actually in context. classifyAndRespond's knowledge base is now
  // scoped up front to whichever card is in context before any matching happens
  // (see scopedFactIds/candidateIds), so this must hold for every card: a vague,
  // keyword-free follow-up right after that card was named must never surface
  // another card's facts, and never the cross-card GENERAL_SCRIPTS entries that
  // exist specifically to compare across cards (Dining Privileges, HAPPY GO
  // Points, Card List, Card Recommendation).
  // ---------------------------------------------------------------------
  const VAGUE_FOLLOWUPS = [
    'are these all the perks it has',
    'is that everything?',
    'anything else it offers?',
    '這樣就是全部了嗎？',
  ];
  const CROSS_CARD_GENERAL_LABELS = new Set(['Dining Privileges', 'HAPPY GO Points', 'Card List', 'Card Recommendation']);
  for (const card of CARDS) {
    for (const vague of VAGUE_FOLLOWUPS) {
      checks++;
      const history = [{ role: 'user', content: `Tell me about the ${card.name}` }];
      const result = await classifyAndRespond(vague, history);
      // A vague "is that everything?" follow-up must actually answer from the
      // card's own facts (via VAGUE_SURVEY_RE's deterministic fallback below),
      // not silently escalate just because no single curated topic keyword
      // happened to hit -- that was the immediate next bug caught live after the
      // cross-card leak above was fixed: the escalation was clean (no leakage)
      // but unhelpful, when the card's own data could fully answer it.
      if (!result.script) {
        fail('G2-vague-followup-must-answer-not-escalate', {
          card: card.id, message: vague, got: result.kind,
        });
        continue;
      }
      const segments = result.script.label.split(' + ');
      const leaked = segments.filter(seg => {
        if (seg.startsWith(card.name + ' — ')) return false;
        if (seg === 'Interest Rate / APR' || seg === 'How to Apply') return false;
        return true;
      });
      if (leaked.length) {
        fail('G-vague-context-followup-must-stay-scoped-to-card', {
          card: card.id, message: vague, leaked,
          crossCardGeneralLeaked: leaked.some(seg => CROSS_CARD_GENERAL_LABELS.has(seg)),
          got: result.script.label,
        });
      }
    }
  }

  // ---------------------------------------------------------------------
  console.log(`Ran ${checks} checks.`);
  console.log(`  Section A/A2 (paraphrase + fuzzy): keyword coverage across ${CARDS.length} cards`);
  console.log(`  Section B (out-of-scope phrasing): ${OOS.length} categories`);
  console.log(`  Section C/C2 (output validation): ${Object.keys(SCRIPT_INDEX).length} scripts`);
  console.log(`  Section D (combined-reply scoring): ${pairsTested} pairs`);
  console.log(`  Section E (stopword-bait): ${multiWordKeywords.length} multi-word keywords`);

  if (failures.length) {
    console.error(`\n${failures.length} FAILURE(S) out of ${checks} checks:\n`);
    const bySection = {};
    for (const f of failures) { (bySection[f.section] = bySection[f.section] || []).push(f); }
    for (const [section, fs_] of Object.entries(bySection)) {
      console.error(`--- ${section} (${fs_.length}) ---`);
      for (const f of fs_.slice(0, 15)) {
        console.error('  ' + JSON.stringify(f));
      }
      if (fs_.length > 15) console.error(`  ... and ${fs_.length - 15} more`);
    }
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
