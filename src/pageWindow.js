"use strict";

function bomStart(head) {
  if (head && head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
    return 3;
  }
  return 0;
}

function utf8Width(lead) {
  if (lead < 0x80) {
    return 1;
  }
  if ((lead & 0xe0) === 0xc0) {
    return 2;
  }
  if ((lead & 0xf0) === 0xe0) {
    return 3;
  }
  if ((lead & 0xf8) === 0xf0) {
    return 4;
  }
  return 0;
}

function isContinuation(byte) {
  return (byte & 0xc0) === 0x80;
}

function charStartBefore(bytes, end) {
  let index = end - 1;
  const limit = Math.max(0, end - 4);
  while (index > limit && isContinuation(bytes[index])) {
    index -= 1;
  }
  const width = utf8Width(bytes[index]);
  if (width >= 1 && index + width === end) {
    for (let cursor = 1; cursor < width; cursor += 1) {
      if (!isContinuation(bytes[index + cursor])) {
        return end - 1;
      }
    }
    return index;
  }
  return end - 1;
}

function fitUtf8Prefix(bytes, pageBytes) {
  // 预算按字节，但只收完整字符；汉字通常 3 字节，从中间切开就会变成乱码
  const budget = Math.max(1, pageBytes | 0);
  let end = 0;
  let index = 0;
  while (index < bytes.length) {
    let width = utf8Width(bytes[index]);
    let complete = width >= 1 && index + width <= bytes.length;
    for (let cursor = 1; complete && cursor < width; cursor += 1) {
      complete = isContinuation(bytes[index + cursor]);
    }
    if (!complete) {
      if (end > 0) {
        break;
      }
      width = 1;
    }
    if (end > 0 && index + width > budget) {
      break;
    }
    if (index + width > bytes.length) {
      break;
    }
    end = index + width;
    index = end;
    if (end >= budget) {
      break;
    }
  }
  return end;
}

function takePageMarks(bytes, pageBytes, atEof) {
  // 页尾后留 4 个字节，才能看清下一个汉字有没有被这块读操作截断
  const marks = [];
  let local = 0;
  while (local < bytes.length) {
    const size = fitUtf8Prefix(bytes.subarray(local), pageBytes);
    if (size <= 0) {
      break;
    }
    if (!atEof && local + size + 4 > bytes.length) {
      break;
    }
    local += size;
    marks.push(local);
  }
  return { consumed: local, marks };
}

function extendPageMarks(marks, read, fileSize, page, target, chunkSize = 1024 * 1024) {
  const origin = marks.length ? marks[0] : 0;
  const goal = Math.max(origin, Math.min(target, fileSize));
  let cursor = marks[marks.length - 1];
  let span = Math.max(1, chunkSize | 0);
  const baseSpan = span;
  while (cursor < goal && cursor < fileSize) {
    const atEof = cursor + span >= fileSize;
    const length = Math.min(span, fileSize - cursor);
    const bytes = read(cursor, atEof ? length : length + 4);
    const taken = takePageMarks(bytes, page, atEof);
    if (taken.consumed <= 0) {
      if (atEof || span >= fileSize) {
        break;
      }
      span = Math.max(span * 2, page + 4);
      continue;
    }
    for (const end of taken.marks) {
      marks.push(cursor + end);
    }
    cursor += taken.consumed;
    span = baseSpan;
  }
  return marks;
}

function markBefore(marks, target, fallback) {
  let low = 0;
  let high = marks.length - 1;
  let found = fallback;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (marks[mid] < target) {
      found = marks[mid];
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

function pageStartBefore(bytes, target, pageBytes) {
  let offset = 0;
  if (target <= 0) {
    return 0;
  }
  while (offset < target) {
    const size = fitUtf8Prefix(bytes.subarray(offset), pageBytes);
    if (size <= 0 || offset + size >= target) {
      return offset;
    }
    offset += size;
  }
  return offset;
}

function snapUtf8Offset(bytes, index, origin) {
  const local = index | 0;
  const base = origin | 0;
  if (local <= 0) {
    return base;
  }
  if (local >= bytes.length || !isContinuation(bytes[local])) {
    return base + local;
  }
  return base + charStartBefore(bytes, local + 1);
}

function movePage(direction, cursor, neighbor) {
  const index = cursor.index | 0;
  const count = cursor.count | 0;
  const start = Math.max(0, cursor.start | 0);
  const offset = Math.max(start, cursor.offset | 0);
  if (count <= 0) {
    return { index: 0, offset: 0, moved: false };
  }
  const wrap = cursor.wrap !== false;
  const step = Math.max(0, cursor.step | 0);
  let next = { index, offset };
  if (direction > 0) {
    if (step > 0 && offset + step < cursor.length) {
      next = { index, offset: offset + step };
    } else if (index + 1 < count) {
      next = { index: index + 1, offset: neighbor.start };
    } else if (wrap) {
      next = { index: 0, offset: neighbor.start };
    }
  } else if (direction < 0) {
    if (cursor.previousOffset < offset) {
      next = { index, offset: Math.max(start, cursor.previousOffset) };
    } else if (index > 0) {
      next = { index: index - 1, offset: neighbor.lastOffset };
    } else if (wrap) {
      next = { index: count - 1, offset: neighbor.lastOffset };
    }
  }
  if (next.index === index && next.offset === offset) {
    return { index, offset, moved: false };
  }
  return { index: next.index, offset: next.offset, moved: true };
}

function toStatusText(chunk) {
  // 状态栏只有一行，换行和制表符留在原文里会把这一页挤乱
  return chunk.toString("utf8").replace(/[\u0000-\u001F\u007F]/g, " ");
}

module.exports = {
  bomStart,
  fitUtf8Prefix,
  takePageMarks,
  extendPageMarks,
  markBefore,
  pageStartBefore,
  snapUtf8Offset,
  movePage,
  toStatusText,
};
