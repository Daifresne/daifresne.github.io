# 折腾记录

个人博客的源文件。零依赖静态站：markdown 写文章，`node build.js` 生成 HTML，托管在 GitHub Pages。

## 目录结构

```
├─ posts/            ← 文章（平时只往这里丢文件）
├─ pages/            ← 固定页面，如 about.md → /about.html
├─ assets/           ← 图片等静态资源，原样拷进 public/（没有就不建）
├─ build.js          ← 构建脚本 + 站点配置
├─ template.html     ← 页面骨架（改这里换结构）
├─ style.css         ← 全站样式（改这里换长相）
└─ public/           ← 生成结果，别手改
```

## 日常使用

```bash
# 写一篇新文章：在 posts/ 里建一个文件，文件名前面带上日期
#   posts/2026-09-20-新文章.md
# 然后把下面这个头貼上去，正文随便写
```

```markdown
---
title: 文章标题
date: 2026-09-20
tags: [MSPM0, 电赛]
summary: 一句话摘要，会显示在首页和 RSS 里。
---

正文从这里开始。
```

```bash
node build.js            # 生成到 public/
node build.js --serve    # 生成后起本地预览 http://localhost:8080
```

## 支持的 markdown 语法

标题、段落、**粗体**、*斜体*、~~删除线~~、`行内代码`、围栏代码块、链接、图片、
无序/有序列表（缩进两级嵌套）、任务清单 `- [ ]`、引用、表格、分隔线。

以 `<` 开头的行会按原始 HTML 输出，所以可以直接贴 `<iframe>` 嵌别的东西。

## 部署

推到 GitHub 后由 Actions 自动构建并发布（见 `.github/workflows/deploy.yml`）。
仓库第一次建好后，去 **Settings → Pages → Source** 选 **GitHub Actions**，之后每次 push 都会自动更新。

站点信息（名字、作者、网址、描述）在 `build.js` 顶部的 `CONFIG` 里改。

## 备注

`posts/` 里现有三篇是示例，看懂格式后删掉换成自己的。
