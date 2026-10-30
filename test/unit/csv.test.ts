// The sheet's spreadsheet (csv.ts): RFC 4180 quoting, CRLF, a byte order mark, and no cell a spreadsheet would run as a
// formula (T26). Pure functions; the database query is tested with the routes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { csvCell, csvText } from '../../src/lib/csv';

test('T26: a cell starting with = + - @, a tab or a carriage return starts with an apostrophe instead', () => {
  assert.equal(csvCell('=HYPERLINK("http://x.example","click")'), `"'=HYPERLINK(""http://x.example"",""click"")"`);
  for (const start of ['=', '+', '-', '@', '\t', '\r']) assert.equal(csvCell(`${start}1`), `"'${start}1"`);
  assert.equal(csvCell('+1 415 555 0134'), `"'+1 415 555 0134"`);
  assert.equal(csvCell("Mike's family"), `"Mike's family"`);
  assert.equal(csvCell(' =1'), '" =1"', 'only the first character counts, as in a spreadsheet');
});

test('every cell quoted, quotes doubled, commas and line breaks kept inside; CRLF after each row; a byte order mark first', () => {
  const text = csvText([
    ['Name', 'Note'],
    ['A "quoted" name', 'one, two\nthree']
  ]);
  assert.equal(text, '\uFEFF"Name","Note"\r\n"A ""quoted"" name","one, two\nthree"\r\n');
});
