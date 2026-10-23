"use strict";

// 与 lazier 的本地章节规则一致：只收整行标题，章名紧贴正文的不算目录
const MARKED_CHAPTER = /#CH\s*(.+?)\s*#CH/g;
const PLAIN_CHAPTER = /^第(?:[0-9\uFF10-\uFF19]{1,6}|[零〇一二三四五六七八九十百千万两]{1,16})章(?:[ \t\u3000]+.+|[\uFF1A:].+)?$/;

function chapterTitles(text) {
  if (!text || text.length > 120) {
    return [];
  }
  if (text.includes("#CH")) {
    const residue = text.replace(MARKED_CHAPTER, "").trim();
    MARKED_CHAPTER.lastIndex = 0;
    if (residue) {
      return [];
    }
    const titles = [];
    for (const match of text.matchAll(MARKED_CHAPTER)) {
      const title = match[1].trim();
      if (title) {
        titles.push(title);
      }
    }
    MARKED_CHAPTER.lastIndex = 0;
    return titles;
  }
  return PLAIN_CHAPTER.test(text) ? [text] : [];
}

function forEachTextLine(buffer, contentStart, visit) {
  const origin = Math.max(0, contentStart | 0);
  let line = 1;
  let lineStart = origin;
  let index = origin;
  while (index <= buffer.length) {
    const atEnd = index === buffer.length;
    const newline = !atEnd && (buffer[index] === 0x0a || buffer[index] === 0x0d);
    if (!atEnd && !newline) {
      index += 1;
      continue;
    }
    visit({
      line,
      offset: lineStart,
      text: buffer.subarray(lineStart, index).toString("utf8").trim(),
    });
    if (atEnd) {
      return line;
    }
    if (buffer[index] === 0x0d && buffer[index + 1] === 0x0a) {
      index += 1;
    }
    index += 1;
    line += 1;
    lineStart = index;
  }
  return line - 1;
}

function findChapters(buffer, contentStart) {
  const chapters = [];
  forEachTextLine(buffer, contentStart, (row) => {
    for (const title of chapterTitles(row.text)) {
      chapters.push({ title, line: row.line, offset: row.offset });
    }
  });
  return chapters;
}

function findLine(buffer, contentStart, lineNumber) {
  let found = null;
  const lineCount = forEachTextLine(buffer, contentStart, (row) => {
    if (row.line === lineNumber) {
      found = row.offset;
    }
  });
  return { offset: found, lineCount };
}

function lineAtOffset(buffer, contentStart, targetOffset) {
  let line = 1;
  forEachTextLine(buffer, contentStart, (row) => {
    if (row.offset <= targetOffset) {
      line = row.line;
    }
  });
  return line;
}

module.exports = { chapterTitles, findChapters, findLine, lineAtOffset };
