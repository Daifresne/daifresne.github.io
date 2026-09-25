#!/usr/bin/env node
/**
 * 极简静态博客构建脚本 —— 零依赖，只用 Node 内置模块。
 *
 * 用法：
 *   node build.js            构建一次（输出到 public/）
 *   node build.js --serve    构建后起本地预览服务（默认 http://localhost:8080）
 *   node build.js --serve 3000   指定端口
 *
 * 输入：
 *   site.json       站点配置：站名、导航、分类标签、友链、单篇文章开关
 *   posts/*.md      文章，文件名建议「日期-英文短名.md」
 *   pages/*.md      固定页面，如 about.md → /about.html
 *   template.html   页面骨架（改这里换长相）
 *   style.css       全站样式
 *   assets/         图片等静态资源，原样拷进 public/
 * 输出：
 *   public/         整站文件。每次构建会清空重建，不要手改
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const ROOT = __dirname;
const OUT = path.join(ROOT, "public");

// 样式和图标按内容算个短哈希当版本号拼在 URL 后面。
// GitHub Pages 给静态文件设了 10 分钟缓存且文件名不变，不加这个的话，
// 改了样式后访客的浏览器会拿旧 CSS 配新 HTML，页面看起来就像坏了
const ASSET_VER = (() => {
  const h = crypto.createHash("sha1").update(fs.readFileSync(path.join(ROOT, "style.css")));
  for (const f of ["logo.png", "favicon-64.png"]) {
    const p = path.join(ROOT, "assets", f);
    if (fs.existsSync(p)) h.update(fs.readFileSync(p));
  }
  return h.digest("hex").slice(0, 8);
})();

// ---------- 站点配置：全在 site.json 里，改那个文件 ----------
// 站名、导航、分类标签、友链、单篇文章的开关都归它管，build.js 本身不用动
const KNOWN_KEYS = ["name", "author", "url", "description", "nav", "tags", "links", "posts"];

const DEFAULTS = {
  name: "我的博客",
  author: "",
  // 部署后的地址，用于 RSS 和 sitemap 里的绝对链接
  url: "",
  description: "",
  nav: ["首页", "分类", "友链", "关于", "RSS"],
  tags: [],
  links: [],
  posts: {}
};

const CONFIG = (() => {
  const file = path.join(ROOT, "site.json");
  if (!fs.existsSync(file)) {
    console.warn("⚠️  没找到 site.json，本次按默认值构建。");
    return { ...DEFAULTS };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    // 配置坏了不硬撑着退出：用默认值把站建出来，问题打在脸上，好歹能看出是哪儿的事
    console.warn(`⚠️  site.json 解析失败（${e.message}），本次按默认值构建。`);
    return { ...DEFAULTS };
  }
  const unknown = Object.keys(raw).filter((k) => !KNOWN_KEYS.includes(k));
  if (unknown.length) {
    console.warn(`⚠️  site.json 里有不认识的字段：${unknown.join("、")}（拼错了？能用的有 ${KNOWN_KEYS.join(" / ")}）`);
  }
  return { ...DEFAULTS, ...raw };
})();

// ---------- 导航 ----------
// nav 里写字符串就按内置页面解析；要指到别处（外站、某个分类页）就写 { label, href }
const NAV_BUILTIN = {
  首页: "index.html",
  分类: "tags.html",
  友链: "links.html",
  关于: "about.html",
  RSS: "feed.xml"
};

// pages/ 下有哪些页面，build() 开头填进来 —— 导航要靠它认「关于」这种名字
let PAGES = [];

// 导航项只跟站点有关，跟页面深浅无关（深浅只体现为前面的 root 前缀），
// 所以解析一次就够。顺带让「找不到页面」这类提醒只喊一遍，
// 不然渲染几十个页面就刷几十行同样的警告
let NAV_ITEMS = null;

function resolveNav() {
  if (NAV_ITEMS) return NAV_ITEMS;
  NAV_ITEMS = (CONFIG.nav || []).map((item) => {
    if (item && typeof item === "object") {
      const href = String(item.href || "");
      const absolute = /^(https?:)?\/\//.test(href) || href.startsWith("#") || href.startsWith("/");
      return { label: String(item.label || href), href, absolute };
    }
    const key = String(item);
    if (NAV_BUILTIN[key]) return { label: key, href: NAV_BUILTIN[key], absolute: false };
    if (PAGES.includes(key)) return { label: key, href: `${key}.html`, absolute: false };
    console.warn(`⚠️  导航项「${key}」找不到对应页面：内置的只有 ${Object.keys(NAV_BUILTIN).join(" / ")}，pages/ 里也没有 ${key}.md`);
    return { label: key, href: `${slugify(key)}.html`, absolute: false };
  });
  return NAV_ITEMS;
}

function renderNav(root) {
  return resolveNav()
    .map((it) => `<a href="${escapeHtml(it.absolute ? it.href : root + it.href)}">${escapeHtml(it.label)}</a>`)
    .join("\n      ");
}

// ================= 工具 =================

const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// 把标题/标签变成能当文件名和 URL 用的字符串（中文保留，URL 里会自动百分号编码）
const slugify = (s) =>
  String(s).trim().toLowerCase()
    .replace(/[\\/:*?"<>|#%{}^~[\]`]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "untagged";

const stripInline = (s) => String(s).replace(/`[^`]*`/g, "").replace(/[*_~\[\]]/g, "");

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyDir(from, to) {
  if (!fs.existsSync(from)) return 0;
  let n = 0;
  mkdirp(to);
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) n += copyDir(src, dst);
    else { fs.copyFileSync(src, dst); n++; }
  }
  return n;
}

// ================= Markdown =================
// 只实现写博客真正用得上的语法：
//   标题 / 段落 / 粗体 / 斜体 / 删除线 / 行内代码 / 围栏代码块
//   链接 / 图片 / 无序列表 / 有序列表（支持一层缩进嵌套）/ 引用 / 表格 / 分隔线
//   以 < 开头的行按原始 HTML 输出（方便贴 iframe 之类）

function renderInline(text) {
  const codes = [];
  // 行内代码先挖出来占位，免得里面的 ** 之类被当成语法
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });

  text = escapeHtml(text);

  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    (_, alt, src, title) => `<img src="${src}" alt="${alt}"${title ? ` title="${title}"` : ""} loading="lazy">`);
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    (_, label, href, title) => {
      const external = /^https?:\/\//.test(href);
      return `<a href="${href}"${title ? ` title="${title}"` : ""}${external ? ' target="_blank" rel="noopener"' : ""}>${label}</a>`;
    });

  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  text = text.replace(/ {2,}$/gm, "<br>");

  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[+i]);
}

function renderMarkdown(src) {
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      const lang = fence[1];
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre class="code"${lang ? ` data-lang="${escapeHtml(lang)}"` : ""}><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    if (!line.trim()) { i++; continue; }

    // 原始 HTML 块
    if (/^\s*</.test(line)) {
      const buf = [line];
      i++;
      while (i < lines.length && lines[i].trim()) buf.push(lines[i++]);
      out.push(buf.join("\n"));
      continue;
    }

    // 标题
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      out.push(`<h${level} id="${slugify(stripInline(text))}">${renderInline(text)}</h${level}>`);
      i++;
      continue;
    }

    // 分隔线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push("<hr>"); i++; continue; }

    // 引用
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`);
      continue;
    }

    // 表格（| a | b |  +  | --- | --- |）
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(lines[i]);
      const align = cells(lines[i + 1]).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left");
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        `<div class="table-wrap"><table><thead><tr>` +
        head.map((c, k) => `<th style="text-align:${align[k] || "left"}">${renderInline(c)}</th>`).join("") +
        `</tr></thead><tbody>` +
        rows.map((r) => "<tr>" + r.map((c, k) => `<td style="text-align:${align[k] || "left"}">${renderInline(c)}</td>`).join("") + "</tr>").join("") +
        `</tbody></table></div>`
      );
      continue;
    }

    // 列表（支持 2 空格一级的嵌套）
    if (/^(\s*)([-*+]|\d+\.)\s+/.test(line)) {
      const { html, next } = renderList(lines, i);
      out.push(html);
      i = next;
      continue;
    }

    // 段落
    const buf = [line];
    i++;
    while (
      i < lines.length && lines[i].trim() &&
      !/^(#{1,6}\s|>|\s*([-*+]|\d+\.)\s|```|\s*<|\s*\|)/.test(lines[i])
    ) buf.push(lines[i++]);
    out.push(`<p>${renderInline(buf.join("\n"))}</p>`);
  }

  return out.join("\n");
}

// 递归处理列表。同层换了标记类型（- 换成 1.）就算新列表，不能吞进上一个
function renderList(lines, start) {
  const indentOf = (l) => l.match(/^(\s*)/)[1].length;
  const markerOf = (l) => { const m = l.match(/^\s*([-*+]|\d+\.)\s+/); return m ? m[1] : null; };
  const baseIndent = indentOf(lines[start]);
  const ordered = /^\d/.test(markerOf(lines[start]) || "");
  const sameKind = (marker) => !!marker && /^\d/.test(marker) === ordered;
  const items = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      // 空行后仍然是同层、同类型的列表项，才算同一个列表
      const nextMarker = i + 1 < lines.length ? markerOf(lines[i + 1]) : null;
      if (nextMarker && sameKind(nextMarker) && indentOf(lines[i + 1]) >= baseIndent) { i++; continue; }
      break;
    }

    const m = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (!m) break;

    const indent = m[1].length;
    if (indent < baseIndent) break;

    if (indent > baseIndent) {
      // 更深一层：交给递归，挂在上一个条目里面
      const sub = renderList(lines, i);
      if (items.length) items[items.length - 1] += sub.html;
      else items.push(sub.html);
      i = sub.next;
      continue;
    }

    if (!sameKind(m[2])) break;

    // 支持 - [ ] / - [x] 任务清单
    const task = m[3].match(/^\[([ xX])\]\s+(.*)$/);
    items.push(task
      ? `<span class="task${task[1].trim() ? " done" : ""}">${task[1].trim() ? "☑" : "☐"}</span> ${renderInline(task[2])}`
      : renderInline(m[3]));
    i++;
  }

  const tag = ordered ? "ol" : "ul";
  const html = `<${tag}>` + items.map((t) => `<li>${t}</li>`).join("") + `</${tag}>`;
  return { html, next: i };
}

// ================= front matter =================

function parseFrontMatter(raw) {
  const text = String(raw).replace(/\r\n?/g, "\n");
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { data: {}, body: text };

  const data = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2].trim();
    if (/^\[.*\]$/.test(value)) {
      value = value.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else {
      value = value.replace(/^["']|["']$/g, "");
    }
    data[key] = value;
  }
  return { data, body: text.slice(m[0].length) };
}

// ================= 页面组装 =================

const template = fs.readFileSync(path.join(ROOT, "template.html"), "utf8");

// root 是相对站点根目录的前缀：根目录页面用 ""，深层页面用 "../"
function renderPage({ title, description, content, root = "" }) {
  const vars = {
    title: escapeHtml(title || ""),
    description: escapeHtml(description || CONFIG.description),
    site: escapeHtml(CONFIG.name),
    author: escapeHtml(CONFIG.author),
    url: CONFIG.url,
    root,
    ver: ASSET_VER,
    year: String(new Date().getFullYear()),
    nav: renderNav(root),
    content
  };
  // 用函数形式的替换：字符串形式会把内容里的 $& / $' 当成替换语法，
  // 正文里一出现正则或 shell 变量就会被悄悄吃掉一块。
  // 认不出的占位符原样留着，页面上直接看得见，比默默变空好
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : whole);
}

function formatDate(d) {
  const dt = typeof d === "string" ? new Date(d + "T00:00:00") : d;
  if (isNaN(dt)) return "";
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function readingTime(html) {
  const chars = html.replace(/<[^>]+>/g, "").replace(/\s/g, "").length;
  return Math.max(1, Math.round(chars / 400));
}

function tagChip(tag, root = "", count) {
  const n = count === undefined ? "" : `<b>${count}</b>`;
  return `<a class="chip" href="${root}tags/${slugify(tag)}.html">${escapeHtml(tag)}${n}</a>`;
}

// ================= 主流程 =================

function build() {
  if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true });
  mkdirp(OUT);

  // 先把 pages/ 下的文件名收出来，导航要靠它认「关于」这类项指向哪个页面
  const pagesDir = path.join(ROOT, "pages");
  PAGES = fs.existsSync(pagesDir)
    ? fs.readdirSync(pagesDir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""))
    : [];

  // ---- 读文章 ----
  // site.json 的 posts 段按「文件名去掉 .md」匹配单篇，目前支持 draft / pinned
  const overrides = CONFIG.posts && typeof CONFIG.posts === "object" ? CONFIG.posts : {};
  const matched = new Set();
  const postsDir = path.join(ROOT, "posts");
  const posts = [];
  if (fs.existsSync(postsDir)) {
    for (const file of fs.readdirSync(postsDir).filter((f) => f.endsWith(".md"))) {
      const raw = fs.readFileSync(path.join(postsDir, file), "utf8");
      const { data, body } = parseFrontMatter(raw);
      const base = file.replace(/\.md$/, "");
      const ov = overrides[base] || {};
      matched.add(base);
      if (ov.draft) continue; // 草稿：这次构建里当它不存在，首页/分类/RSS/sitemap 都不会出现
      // 文件名前缀的日期优先，其次用 front matter 里的 date
      const dateFromName = base.match(/^(\d{4}-\d{2}-\d{2})-/);
      const slug = base.replace(/^\d{4}-\d{2}-\d{2}-/, "");
      const date = dateFromName ? dateFromName[1] : formatDate(data.date || new Date());
      const html = renderMarkdown(body);
      posts.push({
        slug,
        date,
        title: data.title || slug,
        summary: data.summary || html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 80) + "…",
        tags: Array.isArray(data.tags) ? data.tags : data.tags ? [data.tags] : [],
        html,
        minutes: readingTime(html),
        pinned: !!ov.pinned
      });
    }
  }
  // 配置里写了、posts/ 里却没有，多半是名字打错了，说一声
  for (const key of Object.keys(overrides)) {
    if (!matched.has(key)) {
      console.warn(`⚠️  site.json 的 posts 里有「${key}」，但 posts/ 下没这个文件（要写文件名去掉 .md）`);
    }
  }

  // 置顶的先排前面，其余按日期新到旧
  posts.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (a.date < b.date ? 1 : -1));

  // ---- 文章页 ----
  mkdirp(path.join(OUT, "posts"));
  posts.forEach((post, idx) => {
    const prev = posts[idx + 1]; // 更旧的一篇
    const next = posts[idx - 1]; // 更新的一篇
    const nav = (prev || next)
      ? `<nav class="post-nav">${
          next ? `<a href="${next.slug}.html">← ${escapeHtml(next.title)}</a>` : "<span></span>"
        }${prev ? `<a href="${prev.slug}.html">${escapeHtml(prev.title)} →</a>` : "<span></span>"}</nav>`
      : "";

    const content = `
<article class="post">
  <header class="post-head">
    <h1>${escapeHtml(post.title)}</h1>
    <p class="meta">
      <time datetime="${post.date}">${post.date}</time>
      <span>·</span><span>约 ${post.minutes} 分钟</span>
      ${post.tags.length ? `<span>·</span><span class="chips">${post.tags.map((t) => tagChip(t, "../")).join("")}</span>` : ""}
    </p>
  </header>
  <div class="prose">${post.html}</div>
  ${nav}
</article>`;

    fs.writeFileSync(
      path.join(OUT, "posts", `${post.slug}.html`),
      renderPage({ title: `${post.title} · ${CONFIG.name}`, description: post.summary, content, root: "../" }),
      "utf8"
    );
  });

  // ---- 首页 ----
  // 分类（就是标签）。site.json 的 tags 决定两件事：哪些写法算同一个、按什么顺序摆。
  // 没登记的标签照样能写、能生成页面，只是排到后面并提醒一句
  const registry = (Array.isArray(CONFIG.tags) ? CONFIG.tags : [])
    .map((t) => (typeof t === "string" ? { name: t, desc: "" } : { name: String(t.name || ""), desc: t.desc || "" }))
    .filter((t) => t.name);
  const rank = new Map(registry.map((t, i) => [t.name, i]));

  const tags = new Map();
  for (const p of posts) for (const t of p.tags) {
    if (!tags.has(t)) tags.set(t, []);
    tags.get(t).push(p);
  }

  const unregistered = [...tags.keys()].filter((t) => !rank.has(t));
  if (unregistered.length) {
    console.warn(`⚠️  这些标签没登记进 site.json 的 tags：${unregistered.join("、")}（页面照常生成，登记一下能固定顺序、免得同一个意思写出好几种叫法）`);
  }

  // 登记过的按登记顺序摆前面，没登记的按文章数排后面
  const tagList = [...tags.entries()].sort((a, b) => {
    const ra = rank.has(a[0]) ? rank.get(a[0]) : Infinity;
    const rb = rank.has(b[0]) ? rank.get(b[0]) : Infinity;
    return ra - rb || b[1].length - a[1].length || a[0].localeCompare(b[0], "zh");
  });

  // 首页分类栏：所有分类平铺，点进去看该分类下的文章
  const catBar = tagList.length
    ? `<nav class="cat-bar">
  <span class="cat-label">分类</span>
  ${tagList.map(([t, l]) => tagChip(t, "", l.length)).join("")}
  <a class="cat-more" href="tags.html">全部 →</a>
</nav>`
    : "";

  // 卡片整体可点靠「拉伸链接」：标题里的 a 铺满整张卡，标签链接再压在上面。
  // 不能直接把整张卡做成 <a>，因为 a 里不能再套 a（标签也是链接）
  const list = posts.map((p) => `
  <li class="post-item">
    <article class="post-card">
      <h2><a class="stretched" href="posts/${p.slug}.html">${escapeHtml(p.title)}</a></h2>
      <p class="meta"><time datetime="${p.date}">${p.date}</time><span>·</span><span>约 ${p.minutes} 分钟</span></p>
      <p class="summary">${escapeHtml(p.summary)}</p>
      ${p.tags.length ? `<p class="chips">${p.tags.map((t) => tagChip(t)).join("")}</p>` : ""}
    </article>
  </li>`).join("");

  const indexContent = `
<section class="hero">
  <h1>${escapeHtml(CONFIG.name)}</h1>
  <p>${escapeHtml(CONFIG.description)}</p>
</section>
${catBar}
<ul class="post-list">${list || '<li class="empty">还没有文章，往 posts/ 里丢一个 .md 试试。</li>'}</ul>`;

  fs.writeFileSync(
    path.join(OUT, "index.html"),
    renderPage({ title: CONFIG.name, content: indexContent, root: "" }),
    "utf8"
  );

  // ---- 固定页面 ----
  if (fs.existsSync(pagesDir)) {
    for (const file of fs.readdirSync(pagesDir).filter((f) => f.endsWith(".md"))) {
      const { data, body } = parseFrontMatter(fs.readFileSync(path.join(pagesDir, file), "utf8"));
      const slug = file.replace(/\.md$/, "");
      const content = `<article class="post"><header class="post-head"><h1>${escapeHtml(data.title || slug)}</h1></header>
        <div class="prose">${renderMarkdown(body)}</div></article>`;
      fs.writeFileSync(
        path.join(OUT, `${slug}.html`),
        renderPage({ title: `${data.title || slug} · ${CONFIG.name}`, description: data.summary, content, root: "" }),
        "utf8"
      );
    }
  }

  // ---- 分类页 ----
  if (tagList.length) {
    mkdirp(path.join(OUT, "tags"));
    for (const [tag, list] of tagList) {
      // tags 里写成 { name, desc } 的话，这行说明会显示在分类页顶部
      const tagDesc = (registry.find((r) => r.name === tag) || {}).desc;
      const content = `
<section class="hero">
  <h1>#${escapeHtml(tag)}</h1>
  <p>${tagDesc ? `${escapeHtml(tagDesc)} · ` : ""}共 ${list.length} 篇 · <a href="../tags.html">← 全部分类</a></p>
</section>
<ul class="post-list">${list.map((p) => `
  <li class="post-item"><article class="post-card">
    <h2><a class="stretched" href="../posts/${p.slug}.html">${escapeHtml(p.title)}</a></h2>
    <p class="meta"><time datetime="${p.date}">${p.date}</time><span>·</span><span>约 ${p.minutes} 分钟</span></p>
    <p class="summary">${escapeHtml(p.summary)}</p>
  </article></li>`).join("")}</ul>`;
      fs.writeFileSync(
        path.join(OUT, "tags", `${slugify(tag)}.html`),
        renderPage({ title: `#${tag} · ${CONFIG.name}`, content, root: "../" }),
        "utf8"
      );
    }
  }

  // ---- 友链 ----（在 site.json 的 links 里维护）
  const links = Array.isArray(CONFIG.links) ? CONFIG.links : [];

  const linksContent = `
<section class="hero">
  <h1>友链</h1>
  <p>${links.length ? `一些常看的博客和朋友们的站点 · 共 ${links.length} 个` : "还没有添加友链"}</p>
</section>
${links.length ? `<ul class="link-grid">${links.map((l) => {
    const name = escapeHtml(l.name || l.url || "未命名");
    const avatar = l.avatar
      ? `<img class="link-avatar" src="${escapeHtml(l.avatar)}" alt="" loading="lazy">`
      : `<span class="link-avatar link-avatar-text">${escapeHtml(String(l.name || "?").trim().charAt(0))}</span>`;
    const host = (() => { try { return new URL(l.url).host; } catch { return l.url; } })();
    return `
  <li><a class="link-card" href="${escapeHtml(l.url || "#")}" target="_blank" rel="noopener">
    ${avatar}
    <span class="link-info">
      <span class="link-name">${name}</span>
      ${l.desc ? `<span class="link-desc">${escapeHtml(l.desc)}</span>` : ""}
      <span class="link-host">${escapeHtml(host)}</span>
    </span>
  </a></li>`;
  }).join("")}</ul>` : ""}
<section class="link-apply">
  <h2>交换友链</h2>
  <p>欢迎交换友链。把「名称 / 地址 / 一句话介绍」发给我就行，联系方式在<a href="about.html">关于</a>页。</p>
</section>`;

  fs.writeFileSync(
    path.join(OUT, "links.html"),
    renderPage({ title: `友链 · ${CONFIG.name}`, description: "友情链接", content: linksContent, root: "" }),
    "utf8"
  );

  // ---- 分类总览页 ----
  const tagsContent = `
<section class="hero">
  <h1>分类</h1>
  <p>共 ${tagList.length} 个分类、${posts.length} 篇文章</p>
</section>
<ul class="cat-grid">${tagList.map(([t, l]) => `
  <li><a class="cat-item" href="tags/${slugify(t)}.html">
    <span class="cat-name">${escapeHtml(t)}</span>
    <span class="cat-count">${l.length} 篇</span>
    <span class="cat-latest">最新：${escapeHtml(l[0].title)}</span>
  </a></li>`).join("")}</ul>`;

  fs.writeFileSync(
    path.join(OUT, "tags.html"),
    renderPage({ title: `分类 · ${CONFIG.name}`, description: "按分类浏览全部文章", content: tagsContent, root: "" }),
    "utf8"
  );

  // ---- RSS ----
  // pubDate 后面那个 Z 不能省：不加的话 "2026-09-12T00:00:00" 按构建机的本地时区解析，
  // 本地（UTC+8）建出来和 Actions 上（UTC）建出来会差 8 小时，同一个站两个时间
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>${escapeHtml(CONFIG.name)}</title>
<link>${CONFIG.url}/</link>
<description>${escapeHtml(CONFIG.description)}</description>
<language>zh-CN</language>
${posts.slice(0, 20).map((p) => `<item>
  <title>${escapeHtml(p.title)}</title>
  <link>${CONFIG.url}/posts/${encodeURIComponent(p.slug)}.html</link>
  <guid>${CONFIG.url}/posts/${encodeURIComponent(p.slug)}.html</guid>
  <pubDate>${new Date(p.date + "T00:00:00Z").toUTCString()}</pubDate>
  <description>${escapeHtml(p.summary)}</description>
</item>`).join("\n")}
</channel></rss>`;
  fs.writeFileSync(path.join(OUT, "feed.xml"), rss, "utf8");

  // ---- sitemap ----
  const urls = [
    "", "about.html", "tags.html", "links.html",
    ...tagList.map(([t]) => `tags/${encodeURIComponent(slugify(t))}.html`),
    ...posts.map((p) => `posts/${encodeURIComponent(p.slug)}.html`)
  ];
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `<url><loc>${CONFIG.url}/${u}</loc></url>`).join("\n")}
</urlset>`;
  fs.writeFileSync(path.join(OUT, "sitemap.xml"), sitemap, "utf8");

  // ---- 静态资源 ----
  const copied = copyDir(path.join(ROOT, "assets"), path.join(OUT, "assets"));
  fs.copyFileSync(path.join(ROOT, "style.css"), path.join(OUT, "style.css"));
  fs.writeFileSync(path.join(OUT, ".nojekyll"), "");
  fs.writeFileSync(path.join(OUT, "404.html"),
    renderPage({
      title: "页面不存在",
      content: `<section class="hero"><h1>404</h1><p>这个地址没有东西，<a href="/">回首页</a>。</p></section>`,
      root: "/"
    }), "utf8");

  console.log(`✅ 构建完成：${posts.length} 篇文章，${tagList.length} 个分类，${copied} 个资源 → public/`);
}

// ================= 本地预览 =================

function serve(port) {
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript", ".xml": "application/xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon" };
  http.createServer((req, res) => {
    let file = req.url.split("?")[0];
    // 浏览器会把中文百分号编码，但直接 curl 过来的没编码，解不开就按原样用（别让它把服务搞崩）
    try { file = decodeURIComponent(file); } catch { /* 保持原样 */ }
    if (file.endsWith("/")) file += "index.html";
    const full = path.join(OUT, path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
    if (!full.startsWith(OUT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>404</h1>");
      return;
    }
    res.writeHead(200, { "Content-Type": types[path.extname(full)] || "application/octet-stream" });
    res.end(fs.readFileSync(full));
  }).listen(port, () => console.log(`🌐 预览：http://localhost:${port}  （Ctrl+C 停止）`));
}

// ================= 入口 =================

build();
const idx = process.argv.indexOf("--serve");
if (idx >= 0) {
  const port = parseInt(process.argv[idx + 1], 10) || 8080;
  serve(port);
}
