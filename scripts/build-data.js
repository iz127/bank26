#!/usr/bin/env node
// Regenerates index.html's embedded <script id="card-data"> block from data.json.
// data.json is the single source of truth for CARDS/GENERAL_SCRIPTS/OOS/etc — run
// this after editing data.json instead of hand-editing index.html.
//
// index.html stores its whole app payload as a JSON-encoded string inside
// <script type="__bundler/template">"..."</script> (an artifact of how this file
// gets bundled for hosting). That means editing the payload means: unescape the
// JSON string, edit the plain text, re-escape, splice back in. This script does
// that mechanically so nobody has to redo it by hand.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INDEX_PATH = path.join(ROOT, 'index.html');
const DATA_PATH = path.join(ROOT, 'data.json');

const TEMPLATE_OPEN = '<script type="__bundler/template">';
const CARD_DATA_RE = /<script type="application\/json" id="card-data">\n([\s\S]*?)\n<\/script>/;

function extractTemplate(html) {
  const markerIdx = html.indexOf(TEMPLATE_OPEN);
  if (markerIdx === -1) throw new Error('__bundler/template script tag not found in index.html');
  const openQuoteIdx = markerIdx + TEMPLATE_OPEN.length;
  if (html[openQuoteIdx] !== '"') throw new Error('expected opening " right after the template tag');

  // The closing quote sits right before the outer </script>\r\n</body>\r\n</html> tail.
  // Try CRLF first (what git checkout normalizes to on Windows), then LF.
  let closeTail = '</script>\r\n</body>\r\n</html>';
  let closeTailIdx = html.lastIndexOf(closeTail);
  if (closeTailIdx === -1) {
    closeTail = '</script>\n</body>\n</html>';
    closeTailIdx = html.lastIndexOf(closeTail);
  }
  if (closeTailIdx === -1) throw new Error('could not find the closing </script></body></html> tail');
  if (html[closeTailIdx - 1] !== '"') throw new Error('expected closing " right before the tail');

  const jsonStrWithQuotes = html.slice(openQuoteIdx, closeTailIdx);
  const template = JSON.parse(jsonStrWithQuotes);
  return { template, openQuoteIdx, closeTailIdx };
}

function main() {
  const html = fs.readFileSync(INDEX_PATH, 'utf-8');
  const dataJson = fs.readFileSync(DATA_PATH, 'utf-8').trimEnd();

  // Validate data.json is well-formed before touching index.html.
  const parsedData = JSON.parse(dataJson);
  const requiredKeys = ['CARDS', 'GENERAL_SCRIPTS', 'OOS', 'OOS_DESCRIPTIONS', 'APR_KEYWORDS', 'APR_RESPONSE', 'APR_RESPONSE_ZH', 'STAGE_DEFS', 'QUICK_PROMPTS', 'OOS_LABEL_ZH', 'TOPIC_ZH'];
  for (const k of requiredKeys) {
    if (!(k in parsedData)) throw new Error(`data.json is missing required key: ${k}`);
  }

  const { template, openQuoteIdx, closeTailIdx } = extractTemplate(html);

  if (!CARD_DATA_RE.test(template)) throw new Error('card-data script block not found inside the template payload');

  const newTemplate = template.replace(CARD_DATA_RE, () =>
    `<script type="application/json" id="card-data">\n${dataJson}\n</script>`
  );

  if (newTemplate === template) {
    console.log('No change: index.html already reflects data.json.');
    return;
  }

  const newJsonStrWithQuotes = JSON.stringify(newTemplate);
  const updated = html.slice(0, openQuoteIdx) + newJsonStrWithQuotes + html.slice(closeTailIdx);
  fs.writeFileSync(INDEX_PATH, updated, 'utf-8');
  console.log(`index.html updated from data.json (${parsedData.CARDS.length} cards, ${parsedData.GENERAL_SCRIPTS.length} general topics).`);
}

main();
