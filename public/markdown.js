// Markdown 渲染器（零依赖，浏览器端）
// 支持：标题 / 粗体 / 斜体 / 删除线 / 行内代码 / 围栏代码块（带语言与高亮 class）/
//       有序列表 / 无序列表 / 任务列表 / 嵌套列表 / 引用（可嵌套）/ 表格（对齐）/
//       链接 / 图片 / 自动链接 / 分隔线 / 硬换行 / 转义
//
// 安全策略：先转义 HTML，再解析——不允许内联 HTML；链接协议白名单（挡 javascript:）。
(function () {
  const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ESCAPE[c]);

  const SAFE_PROTO = /^(https?:|mailto:|tel:|#|\/|\.\/|\.\.\/)/i;
  const safeUrl = (url) => {
    const u = String(url || '').trim();
    if (!u) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !SAFE_PROTO.test(u)) return null; // javascript: data: vbscript: …
    return u.replace(/"/g, '%22');
  };

  // ---------------- 行内 ----------------
  function inline(text) {
    const stash = [];
    const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;
    let out = escapeHtml(text);

    // 反斜杠转义必须最先处理：被转义的字符不能再当分隔符（\* \` \_ …）
    out = out.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, (m, ch) => keep(ch));

    // 行内代码（`` 与 ` 都支持，内容不再解析）
    out = out.replace(/(`+)([\s\S]*?)\1/g, (m, ticks, code) => keep(`<code class="inline">${code.replace(/^ | $/g, '')}</code>`));

    // 图片 ![alt](src "title")
    out = out.replace(/!\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+&quot;([^&]*)&quot;)?\s*\)/g, (m, alt, src, title) => {
      const safe = safeUrl(src);
      return safe ? keep(`<img src="${safe}" alt="${alt}"${title ? ` title="${title}"` : ''} loading="lazy">`) : m;
    });

    // 链接 [text](href "title")
    out = out.replace(/\[([^\]]+)\]\(\s*([^\s)]+)(?:\s+&quot;([^&]*)&quot;)?\s*\)/g, (m, txt, href, title) => {
      const safe = safeUrl(href);
      return safe
        ? keep(`<a href="${safe}"${title ? ` title="${title}"` : ''} target="_blank" rel="noreferrer">${txt}</a>`)
        : m;
    });

    // 自动链接 <https://…>（尖括号已被转义成 &lt; &gt;）
    out = out.replace(/&lt;((?:https?|mailto):[^\s&]+)&gt;/g, (m, url) =>
      keep(`<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`),
    );

    // 裸链接
    out = out.replace(/(^|[\s(（[>])(https?:\/\/[^\s<>()"'）]+)/g, (m, pre, url) =>
      `${pre}${keep(`<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`)}`,
    );

    // 强调（先长后短）
    out = out.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, '$1<em>$2</em>');
    out = out.replace(/___([^_\n]+)___/g, '<strong><em>$1</em></strong>');
    out = out.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^_\w])_([^_\n]+)_(?=[^_\w]|$)/g, '$1<em>$2</em>');
    out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

    // 硬换行：行尾两个空格
    out = out.replace(/ {2,}\n/g, '<br>\n');

    return out.replace(/\u0000(\d+)\u0000/g, (m, i) => stash[Number(i)]);
  }

  // ---------------- 块级 ----------------
  const RE = {
    fence: /^ {0,3}(`{3,}|~{3,})[ \t]*([\w+#.-]*)[ \t]*$/,
    hr: /^ {0,3}([-*_])[ \t]*(\1[ \t]*){2,}$/,
    heading: /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/,
    quote: /^ {0,3}>[ \t]?/,
    item: /^(\s*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/,
    tableSep: /^ {0,3}\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/,
  };

  const splitRow = (line) =>
    line
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .split(/(?<!\\)\|/)
      .map((c) => c.replace(/\\\|/g, '|').trim());

  function slug(s) {
    return String(s).toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '');
  }

  function renderBlocks(lines) {
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) {
        i++;
        continue;
      }

      // 围栏代码块
      const fence = RE.fence.exec(line);
      if (fence) {
        const marker = fence[1][0];
        const len = fence[1].length;
        const lang = fence[2] || '';
        const buf = [];
        i++;
        while (i < lines.length) {
          const close = new RegExp(`^ {0,3}${marker === '`' ? '`' : '~'}{${len},}[ \\t]*$`);
          if (close.test(lines[i])) {
            i++;
            break;
          }
          buf.push(lines[i]);
          i++;
        }
        out.push(codeBlock(buf.join('\n'), lang));
        continue;
      }

      // 分隔线
      if (RE.hr.test(line)) {
        out.push('<hr>');
        i++;
        continue;
      }

      // 标题
      const h = RE.heading.exec(line);
      if (h) {
        const lv = h[1].length;
        const text = inline(h[2]);
        out.push(`<h${lv} id="${slug(h[2])}">${text}</h${lv}>`);
        i++;
        continue;
      }

      // 引用（可嵌套、可含其它块）
      if (RE.quote.test(line)) {
        const buf = [];
        while (i < lines.length && (RE.quote.test(lines[i]) || (buf.length && lines[i].trim() && !RE.fence.test(lines[i])))) {
          buf.push(lines[i].replace(/^ {0,3}>[ \t]?/, ''));
          i++;
        }
        out.push(`<blockquote>${renderBlocks(buf)}</blockquote>`);
        continue;
      }

      // 表格
      if (line.includes('|') && i + 1 < lines.length && RE.tableSep.test(lines[i + 1])) {
        const head = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map((c) => {
          const left = c.startsWith(':');
          const right = c.endsWith(':');
          return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
        });
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        const cell = (c, a) => `<td${a ? ` style="text-align:${a}"` : ''}>${inline(c)}</td>`;
        out.push(
          '<div class="table-wrap"><table><thead><tr>' +
            head.map((c, k) => `<th${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${inline(c)}</th>`).join('') +
            '</tr></thead><tbody>' +
            rows.map((r) => `<tr>${head.map((_, k) => cell(r[k] ?? '', aligns[k])).join('')}</tr>`).join('') +
            '</tbody></table></div>',
        );
        continue;
      }

      // 列表
      const li = RE.item.exec(line);
      if (li) {
        const [html, next] = parseList(lines, i);
        out.push(html);
        i = next;
        continue;
      }

      // setext 标题：下一行是 ===（h1）或 ---（h2）
      if (
        i + 1 < lines.length &&
        lines[i].trim() &&
        !RE.item.test(lines[i]) &&
        /^ {0,3}(=+|-+)[ \t]*$/.test(lines[i + 1])
      ) {
        const lv = lines[i + 1].trim()[0] === '=' ? 1 : 2;
        out.push(`<h${lv} id="${slug(lines[i])}">${inline(lines[i])}</h${lv}>`);
        i += 2;
        continue;
      }

      // 段落
      const buf = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !RE.fence.test(lines[i]) &&
        !RE.heading.test(lines[i]) &&
        !RE.hr.test(lines[i]) &&
        !RE.quote.test(lines[i]) &&
        !RE.item.exec(lines[i]) &&
        !(lines[i].includes('|') && RE.tableSep.test(lines[i + 1] || ''))
      ) {
        buf.push(lines[i]);
        i++;
      }
      out.push(`<p>${inline(buf.join('\n'))}</p>`);
    }

    return out.join('\n');
  }

  function codeBlock(code, lang) {
    const label = lang ? `<span class="lang">${escapeHtml(lang)}</span>` : '';
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
    return (
      `<div class="codeblock">${label}<button class="copy" type="button">复制</button>` +
      `<pre><code${cls}>${escapeHtml(code)}</code></pre></div>`
    );
  }

  /** 解析一段列表，返回 [html, 下一行下标] */
  function parseList(lines, start) {
    const first = RE.item.exec(lines[start]);
    const baseIndent = first[1].length;
    const ordered = /^\d/.test(first[2]);
    const startNum = ordered ? parseInt(first[2], 10) : 1;
    const items = [];
    let i = start;
    let cur = null;

    while (i < lines.length) {
      const line = lines[i];
      const m = RE.item.exec(line);

      if (m && m[1].length === baseIndent && /^\d/.test(m[2]) === ordered) {
        cur = { lines: [m[3]], indent: baseIndent };
        items.push(cur);
        i++;
        continue;
      }
      if (!line.trim()) {
        const next = RE.item.exec(lines[i + 1] || '');
        if (next && next[1].length === baseIndent && /^\d/.test(next[2]) === ordered) {
          i++;
          continue;
        }
        break;
      }
      const indent = line.match(/^\s*/)[0].length;
      if (cur && indent > baseIndent) {
        cur.lines.push(line.slice(Math.min(indent, baseIndent + 2)));
        i++;
        continue;
      }
      break;
    }

    const html = items
      .map((it) => {
        let body = it.lines.join('\n');
        let checkbox = '';
        const task = /^\[([ xX])\]\s+([\s\S]*)$/.exec(body);
        if (task) {
          const done = task[1].toLowerCase() === 'x';
          checkbox = `<input type="checkbox" disabled${done ? ' checked' : ''}> `;
          body = task[2];
        }
        const inner = renderBlocks(body.split('\n'));
        // 紧列表：单段落不再包 <p>
        const tight = inner.replace(/^<p>([\s\S]*?)<\/p>$/, '$1');
        return `<li${task ? ' class="task"' : ''}>${checkbox}${tight}</li>`;
      })
      .join('');

    const tag = ordered ? 'ol' : 'ul';
    const attr = ordered && startNum !== 1 ? ` start="${startNum}"` : '';
    return [`<${tag}${attr}>${html}</${tag}>`, i];
  }

  /** 渲染 markdown 为 HTML */
  function render(markdown) {
    if (markdown === null || markdown === undefined) return '';
    return renderBlocks(String(markdown).replace(/\r\n?/g, '\n').split('\n'));
  }

  window.MD = { render, inline, escapeHtml };
})();
