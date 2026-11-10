// CSV export in the same shape as the Raspberry logger's data/obd_data_*.csv.

import { FIELDS } from './pids.js';

export function toCsv(rows, fields = FIELDS) {
  const lines = [fields.join(',')];
  // Rows logged by an older version are shorter: their missing columns stay empty.
  for (const row of rows) lines.push(fields.map((_, index) => row[index] ?? '').join(','));
  return `${lines.join('\r\n')}\r\n`;
}

const two = (value) => String(value).padStart(2, '0');

/** obd_data_YYYYMMDD_HHMMSS.csv in local time, like the files on the Raspberry. */
export function fileName(date, prefix = 'obd_data', extension = 'csv') {
  const day = `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}`;
  const time = `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
  return `${prefix}_${day}_${time}.${extension}`;
}
