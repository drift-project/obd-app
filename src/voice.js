// Says each drift aloud when it is over, so that the driver need not look at
// the phone: its largest angle and how long it lasted, in the language of the
// phone when that is Polish, else in English.

// The time is said in words: a number before "sekunda" is read by the speech engine as a man's number
// ("dwa sekundy") more often than not.
const POLISH_SECONDS = ['', 'sekunda', 'dwie sekundy', 'trzy sekundy', 'cztery sekundy', 'pięć sekund', 'sześć sekund', 'siedem sekund', 'osiem sekund', 'dziewięć sekund', 'dziesięć sekund'];

/** The language the drifts are told in, from the language of the browser: 'pl-PL' or 'en-US'. */
export const voiceLanguage = (browserLanguage = '') => (browserLanguage.toLowerCase().startsWith('pl') ? 'pl-PL' : 'en-US');

/** The Polish form of a noun after a whole number: 1 stopień, 2 to 4 stopnie (and 22, 23, 24...), 5 stopni. */
export function polishPlural(count, [one, few, many]) {
  if (count === 1) return one;
  const units = count % 10;
  const tens = count % 100;
  return units >= 2 && units <= 4 && (tens < 12 || tens > 14) ? few : many;
}

/** What is said about a drift (`{ from, to, peak }`, see DriftTracker): "23 stopnie, trzy sekundy" or "23 degrees, 3 seconds". */
export function driftWords(drift, language) {
  const angle = Math.round(Math.abs(drift.peak));
  const seconds = Math.max(1, Math.round((drift.to - drift.from) / 1000));
  if (language.toLowerCase().startsWith('pl')) {
    const time = seconds < POLISH_SECONDS.length ? POLISH_SECONDS[seconds] : `${seconds} ${polishPlural(seconds, ['sekunda', 'sekundy', 'sekund'])}`;
    return `${angle} ${polishPlural(angle, ['stopień', 'stopnie', 'stopni'])}, ${time}`;
  }
  return `${angle} ${angle === 1 ? 'degree' : 'degrees'}, ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

/** What is said when the voice is switched on, so that the driver hears how loud it is. */
export const voiceOnWords = (language) => (language.toLowerCase().startsWith('pl') ? 'Głos włączony' : 'Voice on');

/**
 * Say `text` in `language` with the speech of the browser. False where the browser has none. Chrome speaks
 * only on a page that has been tapped at least once, which the button that starts a session is.
 */
export function say(text, language, speech = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance) {
  if (!speech || !Utterance) return false;
  const utterance = new Utterance(text);
  utterance.lang = language;
  utterance.rate = 1.1;
  speech.speak(utterance);
  return true;
}
