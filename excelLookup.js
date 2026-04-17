const path = require('path');
const XLSX = require('xlsx');

const XLSX_PATH = path.join(__dirname, 'titles.xlsx');

// col A: English title → col B: Korean title
let titleMap = {};
// col C: hymn number → col B: Korean title (green book songs)
let numberMap = {};

function normalize(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isKorean(val) {
  return /[\uAC00-\uD7A3]/.test(val);
}

function loadTitles() {
  try {
    const workbook = XLSX.readFile(XLSX_PATH);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    const newTitleMap = {};
    const newNumberMap = {};
    for (const row of rows) {
      // Two formats:
      // Regular:    [EnglishTitle, KoreanTitle]           (col A=English, col B=Korean)
      // Green book: [null, EnglishTitle, KoreanTitle, N]  (col A=null, col B=English, col C=Korean, col D=number)
      const isGreenBook = (row[0] === null || row[0] === undefined || row[0] === '') && row.length >= 3;
      const englishTitle = isGreenBook ? row[1] : row[0];
      const koreanTitle  = isGreenBook ? row[2] : row[1];
      const hymnNumber   = isGreenBook ? row[3] : undefined;

      if (englishTitle && koreanTitle && isKorean(String(koreanTitle))) {
        newTitleMap[normalize(englishTitle)] = String(koreanTitle).trim();
      }
      if (hymnNumber != null && hymnNumber !== '' && koreanTitle && isKorean(String(koreanTitle))) {
        newNumberMap[String(hymnNumber).trim()] = String(koreanTitle).trim();
      }
    }
    titleMap = newTitleMap;
    numberMap = newNumberMap;
    console.log(`Loaded ${Object.keys(titleMap).length} title entries, ${Object.keys(numberMap).length} hymn numbers from titles.xlsx`);
    return true;
  } catch (err) {
    console.warn(`Could not load titles.xlsx: ${err.message}`);
    return false;
  }
}

function lookupKoreanTitle(englishTitle) {
  return titleMap[normalize(englishTitle)] || null;
}

function lookupKoreanByNumber(number) {
  return numberMap[String(number).trim()] || null;
}

module.exports = { loadTitles, lookupKoreanTitle, lookupKoreanByNumber };
