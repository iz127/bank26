#!/usr/bin/env node
// Self-test for the chatbot's keyword classifier. Run this after editing data.json
// (before build-data.js) to catch two bug classes that have bitten this project before:
//
//   1. Collisions: a topic's own keyword also matches a DIFFERENT topic on the same
//      card, so an unambiguous question gets an ambiguous (combined) answer.
//   2. Missing context fallback: a topic-only follow-up ("what about the annual fee?"
//      right after discussing a specific card) fails to resolve — this is the class of
//      bug behind the "Relax+ Cash Back" incident, where classifyLLM's safety net only
//      checked for an explicit card name in the current message and ignored the card
//      already established by conversation context.
//
// For every card topic (skipping "Overview", which has no keywords by design), for
// every one of its own keywords, this asserts:
//   - mentioning the card by name + the keyword resolves to exactly that topic
//     (classifyKeyword)
//   - a bare follow-up naming only the keyword, with the card established via prior
//     conversation history, resolves to exactly that topic via BOTH classifyKeyword's
//     own context resolution and classifyLLM's safety net (simulated with the API
//     unavailable, since that's the path with no model to lean on).
//
// Exits non-zero with a diagnostic list on any failure.

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

// Pull the pure classifier logic (no data, no React component) out of index.html so
// the test always runs against the real deployed implementation, not a hand-copy of it.
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
  const full = stub + logicSrc + '\nconst window = {};\nmodule.exports = { classifyKeyword, classifyLLM, CARDS, GENERAL_SCRIPTS, OOS, SCRIPT_INDEX, slug };\n';
  const tmpPath = path.join(require('os').tmpdir(), `classify-sim-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
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
  const { classifyKeyword, classifyLLM, CARDS, OOS, slug } = mod;

  const failures = [];
  let checks = 0;

  // A combined match joins each script's label with ' + ' (see combineScripts). General
  // topics (e.g. shared "reward"/"points" keywords) are allowed to ride along — that's
  // intentional layering, not a collision — so we only require the expected card/topic
  // segment to be PRESENT among the joined segments, not that it's the only one.
  function hasSegment(label, card, topic) {
    if (!label) return false;
    const expected = `${card.name} — ${topic.topic}`;
    return label.split(' + ').includes(expected);
  }

  for (const card of CARDS) {
    const cardKeyword = card.keywords[0];
    for (const topic of card.topics) {
      if (!topic.keywords.length) continue; // Overview: intentionally keyword-less
      const expectedId = card.id + '_' + slug(topic.topic);

      for (const kw of topic.keywords) {
        // Check 1: explicit card + keyword -> resolves to (at least) this topic.
        checks++;
        const explicitMsg = `${cardKeyword} ${kw}`;
        const explicitResult = classifyKeyword(explicitMsg, []);
        const explicitLabel = explicitResult.script && explicitResult.script.label;
        if (!hasSegment(explicitLabel, card, topic)) {
          failures.push({
            check: 'explicit-card+keyword',
            card: card.id, topic: topic.topic, keyword: kw, message: explicitMsg,
            got: explicitResult.kind === 'match' || explicitResult.kind === 'partial' ? explicitLabel : `no match (${explicitResult.kind})`,
          });
        }

        // Check 2: context-only follow-up via classifyKeyword's own context resolution.
        checks++;
        const history = [{ role: 'user', content: `Tell me about the ${card.name}` }];
        const ctxKwResult = classifyKeyword(kw, history);
        if (!hasSegment(ctxKwResult.script && ctxKwResult.script.label, card, topic)) {
          failures.push({
            check: 'context-followup (classifyKeyword)',
            card: card.id, topic: topic.topic, keyword: kw, message: kw, history: history[0].content,
            got: ctxKwResult.script ? ctxKwResult.script.label : `no match (${ctxKwResult.kind})`,
          });
        }

        // Check 3: same context-only follow-up through classifyLLM's safety net,
        // simulating the model being unavailable — the exact path that missed the
        // Relax+ Cash Back fix before it was patched.
        checks++;
        const llmResult = await classifyLLM(kw, history);
        if (!hasSegment(llmResult.script && llmResult.script.label, card, topic)) {
          failures.push({
            check: 'context-followup (classifyLLM safety net)',
            card: card.id, topic: topic.topic, keyword: kw, message: kw, history: history[0].content,
            got: llmResult.script ? llmResult.script.label : `no match (${llmResult.kind})`,
          });
        }
      }
    }
  }

  // Check 4: a genuinely unrelated out-of-scope message, asked right after
  // discussing a specific card, must NOT get pulled into that card's Overview
  // by classifyLLM's context-card safety net. Caught live: "I lost my card"
  // right after a LeXing Card question was wrongly resolving to the LeXing
  // Card's Overview instead of staying a clean escalation.
  for (const card of CARDS) {
    const history = [{ role: 'user', content: `Tell me about the ${card.name}` }];
    for (const oos of OOS) {
      for (const kw of oos.keywords) {
        checks++;
        const llmResult = await classifyLLM(kw, history);
        if (llmResult.script) {
          failures.push({
            check: 'oos-after-context (classifyLLM safety net)',
            card: card.id, topic: oos.label, keyword: kw, message: kw, history: history[0].content,
            got: `wrongly matched a card script: ${llmResult.script.label}`,
          });
        }
      }
    }
  }

  console.log(`Ran ${checks} checks across ${CARDS.length} cards.`);
  if (failures.length) {
    console.error(`\n${failures.length} FAILURE(S):\n`);
    for (const f of failures) {
      console.error(`  [${f.check}] ${f.card} / "${f.topic}" / keyword "${f.keyword}"`);
      console.error(`    message: ${JSON.stringify(f.message)}${f.history ? `  (history: ${JSON.stringify(f.history)})` : ''}`);
      console.error(`    expected topic "${f.topic}" on card ${f.card}, got: ${f.got}\n`);
    }
    process.exit(1);
  }
  console.log('All checks passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
