// Cell-based screen buffer with truecolor styles. All text is plain (no ANSI);
// styling is per-cell so composition never has to parse escape codes.

const toRgb = (h) => {
  const n = parseInt(h.slice(1), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
};

export const C = {
  text: '#c3c7d8',
  dim: '#6a7090',
  faint: '#3d4157',
  white: '#eef0f7',
  orange: '#e8915f',
  blue: '#7da6ff',
  purple: '#b9a3f5',
  green: '#93d18f',
  red: '#ef7b84',
  yellow: '#e6c27a',
  hlbg: '#2b2e3e',
  greenbg: '#1f3326',
  purplebg: '#2a2542',
  orangebg: '#3a2a20',
};

// Style string = SGR params. S('#fff', {bold:true, bg:'#000'})
export function S(fg, o = {}) {
  const p = [];
  if (fg) p.push(`38;2;${toRgb(fg)}`);
  if (o.bg) p.push(`48;2;${toRgb(o.bg)}`);
  if (o.bold) p.push('1');
  if (o.italic) p.push('3');
  if (o.underline) p.push('4');
  return p.join(';');
}

const WIDE =
  /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1F000}-\u{1FFFF}]|[\u{20000}-\u{3FFFD}]/gu;

// Make arbitrary (model-produced) text safe for a 1-cell-per-char grid.
export function clean(s) {
  return String(s ?? '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\p{M}/gu, '')
    .replace(/[​-‍️]/g, '')
    .replace(WIDE, '?');
}

export const segLen = (segs) => segs.reduce((n, [t]) => n + [...clean(t)].length, 0);

export function wrap(text, w) {
  const out = [];
  for (const para of String(text ?? '').split('\n')) {
    const words = clean(para).split(' ');
    let line = '';
    for (let word of words) {
      while ([...word].length > w) {
        if (line) { out.push(line); line = ''; }
        out.push([...word].slice(0, w).join(''));
        word = [...word].slice(w).join('');
      }
      if (!line) line = word;
      else if ([...line].length + 1 + [...word].length <= w) line += ' ' + word;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

const BOX = {
  single: '┌┐└┘─│',
  heavy: '┏┓┗┛━┃',
  round: '╭╮╰╯─│',
  dashed: '┌┐└┘╌╎',
  double: '╔╗╚╝═║',
};

export class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.ch = Array.from({ length: h }, () => Array(w).fill(' '));
    this.st = Array.from({ length: h }, () => Array(w).fill(''));
  }

  put(x, y, text, style = '', maxW = Infinity) {
    if (y < 0 || y >= this.h) return 0;
    if (this.clip && (y < this.clip[0] || y >= this.clip[1])) return 0;
    let n = 0;
    for (const c of text) {
      if (n >= maxW) break;
      const xx = x + n;
      if (xx >= this.w) break;
      if (xx >= 0) {
        this.ch[y][xx] = c;
        this.st[y][xx] = style;
      }
      n++;
    }
    return n;
  }

  // Draw styled segments, truncating with an ellipsis if they exceed maxW.
  segs(x, y, segs, maxW = Infinity) {
    const total = segLen(segs);
    const limit = total > maxW ? maxW - 1 : Infinity;
    let n = 0;
    let last = '';
    for (const [t, s] of segs) {
      if (n >= limit) break;
      n += this.put(x + n, y, clean(t), s, Math.min(limit, this.w) - n);
      last = s;
    }
    if (total > maxW && maxW > 0) n += this.put(x + n, y, '…', last);
    return n;
  }

  center(x, y, w, segs) {
    const len = Math.min(segLen(segs), w);
    return this.segs(x + Math.max(0, Math.floor((w - len) / 2)), y, segs, w);
  }

  right(x, y, w, segs) {
    const len = Math.min(segLen(segs), w);
    return this.segs(x + w - len, y, segs, w);
  }

  hline(x, y, w, ch, style) {
    for (let i = 0; i < w; i++) this.put(x + i, y, ch, style);
  }

  vline(x, y, h, ch, style) {
    for (let i = 0; i < h; i++) this.put(x, y + i, ch, style);
  }

  // Add a background colour to a run of cells, keeping their foreground.
  bg(x, y, w, bgHex) {
    if (y < 0 || y >= this.h) return;
    const p = `48;2;${toRgb(bgHex)}`;
    for (let i = 0; i < w; i++) {
      const xx = x + i;
      if (xx < 0 || xx >= this.w) continue;
      const s = this.st[y][xx].replace(/(^|;)48;2;\d+;\d+;\d+/, '');
      this.st[y][xx] = s ? `${s};${p}` : p;
    }
  }

  box(x, y, w, h, style, kind = 'single', title = null) {
    if (w < 2 || h < 2) return;
    const [tl, tr, bl, br, hz, vt] = [...BOX[kind]];
    this.put(x, y, tl, style);
    this.hline(x + 1, y, w - 2, hz, style);
    this.put(x + w - 1, y, tr, style);
    for (let i = 1; i < h - 1; i++) {
      this.put(x, y + i, vt, style);
      this.put(x + w - 1, y + i, vt, style);
    }
    this.put(x, y + h - 1, bl, style);
    this.hline(x + 1, y + h - 1, w - 2, hz, style);
    this.put(x + w - 1, y + h - 1, br, style);
    if (title) {
      this.put(x + 2, y, ' ', style);
      const n = this.segs(x + 3, y, title, w - 6);
      this.put(x + 3 + n, y, ' ', style);
    }
  }

  clearRect(x, y, w, h) {
    for (let j = 0; j < h; j++) this.put(x, y + j, ' '.repeat(Math.max(0, w)), '');
  }

  toString() {
    return this.rows().join('\r\n');
  }

  rows() {
    const rows = [];
    for (let y = 0; y < this.h; y++) {
      let out = '\x1b[0m';
      let cur = null;
      for (let x = 0; x < this.w; x++) {
        const s = this.st[y][x];
        if (s !== cur) {
          out += s ? `\x1b[0;${s}m` : '\x1b[0m';
          cur = s;
        }
        out += this.ch[y][x];
      }
      rows.push(out + '\x1b[0m');
    }
    return rows;
  }
}
