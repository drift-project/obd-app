// What the phone says about a drift, in Polish with the right forms of the
// words, and in English.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { driftWords, polishPlural, say, voiceLanguage, voiceOnWords } from '../src/voice.js';

const drift = (peak, ms) => ({ from: 1000, to: 1000 + ms, peak });

test('the language follows the browser: Polish when it is Polish, else English', () => {
  assert.equal(voiceLanguage('pl-PL'), 'pl-PL');
  assert.equal(voiceLanguage('pl'), 'pl-PL');
  assert.equal(voiceLanguage('en-GB'), 'en-US');
  assert.equal(voiceLanguage('de-DE'), 'en-US');
  assert.equal(voiceLanguage(undefined), 'en-US');
});

test('Polish words take the form their number asks for', () => {
  const forms = ['stopień', 'stopnie', 'stopni'];
  const cases = { 1: 'stopień', 2: 'stopnie', 4: 'stopnie', 5: 'stopni', 11: 'stopni', 12: 'stopni', 14: 'stopni', 21: 'stopni', 22: 'stopnie', 24: 'stopnie', 25: 'stopni', 32: 'stopnie', 112: 'stopni', 122: 'stopnie' };
  for (const [count, form] of Object.entries(cases)) assert.equal(polishPlural(Number(count), forms), form, count);
});

test('a drift is told by its largest angle, to either side, and its time in whole seconds', () => {
  assert.equal(driftWords(drift(23.4, 3100), 'pl-PL'), '23 stopnie, trzy sekundy');
  assert.equal(driftWords(drift(-25, 1200), 'pl-PL'), '25 stopni, sekunda');
  assert.equal(driftWords(drift(12, 800), 'pl-PL'), '12 stopni, sekunda');
  assert.equal(driftWords(drift(-32.6, 5600), 'pl-PL'), '33 stopnie, sześć sekund');
  assert.equal(driftWords(drift(41, 2400), 'pl-PL'), '41 stopni, dwie sekundy');
  assert.equal(driftWords(drift(18, 12300), 'pl-PL'), '18 stopni, 12 sekund');
  assert.equal(driftWords(drift(-23.4, 3100), 'en-US'), '23 degrees, 3 seconds');
  assert.equal(driftWords(drift(19, 900), 'en-US'), '19 degrees, 1 second');
  assert.equal(voiceOnWords('pl-PL'), 'Głos włączony');
  assert.equal(voiceOnWords('en-US'), 'Voice on');
});

test('the words go to the speech of the browser in their language, and nothing breaks without it', () => {
  const spoken = [];
  class Utterance {
    constructor(text) {
      this.text = text;
    }
  }
  assert.equal(say('23 stopnie, trzy sekundy', 'pl-PL', { speak: (utterance) => spoken.push(utterance) }, Utterance), true);
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, '23 stopnie, trzy sekundy');
  assert.equal(spoken[0].lang, 'pl-PL');
  assert.equal(say('anything', 'en-US', undefined, Utterance), false);
});
