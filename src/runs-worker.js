// Works out, away from the page, what each run of the log holds (see
// runTotals in runs.js): the drift angle of a long log takes seconds on a
// phone, and the page must not stand still meanwhile.

import { runTotals } from './runs.js';

self.addEventListener('message', ({ data }) => {
  const { tables, runs } = data;
  try {
    self.postMessage({ runs, totals: runTotals(tables, runs) });
  } catch (error) {
    self.postMessage({ runs, error: error.message });
  }
});
