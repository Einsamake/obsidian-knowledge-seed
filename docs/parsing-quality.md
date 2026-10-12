# 网页正文与链接质量验证

本次改进针对百科页的站点后缀、语言栏、模板、目录及引文编号混入知识节点的问题。验证对象是实际获取的 HTML 结构；测试不验证百科所述学术结论的真实性，也不表示已经实现全文语义理解。

## 提取规则

- MediaWiki 优先选择 `#mw-content-text .mw-parser-output`，再选择 `.mw-parser-output`，最后使用 `#mw-content-text`。这些查询依次执行，避免父容器先匹配而把正文外的界面内容带入。MediaWiki 官方文档明确指出 `#mw-content-text` 可能包含无关元素，推荐更具体的解析器正文选择器。来源：[官方 IDs and classes 文档](https://www.mediawiki.org/wiki/Manual:Interface/IDs_and_classes)。
- 标题优先使用页面 h1，调用共享的已知站点品牌清理器。`sourceTitle` 保存原始 HTML 标题用于审计；生物学等主题限定词保留。首个有实质内容的正文段落优先于插图说明，以便在限长时先保留定义。
- 移除目录、编辑控件、维护模板、信息框、导航盒、语言栏、版权界面及引文编号。保留普通解释段落、正文列表、图注和数据表；图注不再排在导言前。
- 参考文献、注释、延伸阅读、外部链接、参见等**精确名称**的辅助章节排除。支持传统平铺标题、当前 `.mw-heading` 包装及 Parsoid section 结构；下一个同级或更高级的正文标题保留。类似 `References in linguistics` 的真正解释章节不会因前缀相同而被删。
- 链接必须在保留正文的完整段落中有上下文证据。排除特殊命名空间、编辑/历史/检索端点、语言控件、纯数字编号与已知界面标签；链接去重，最多 100 条。截断段落不能提供完整引用时，不输出该段落的链接。
- 普通站点仍使用 Defuddle；不足时只回退到明确的 `article` / `main` 正文容器。不会执行远程脚本。
- `fetchWebDocument(url, request, signal?, maxChars = 16000)` 新增第四参数。旧调用兼容，调用方可按配置传更长正文限额。

## 离线实页样本

HTML 直接从 Wikipedia 获取并保存在 `tests/fixtures/`，测试不联网。以下时间为实际获取 UTC 时间。保留页面原有来源、修订信息和许可页脚；Wikipedia 页面内容依其原始署名与许可使用，夹具仅用于结构回归验证。

| 夹具 | 来源 | 获取时间 | 字节数 | SHA-256 |
| --- | --- | --- | ---: | --- |
| wikipedia-knowledge-graph.html | [Knowledge Graph](https://en.wikipedia.org/wiki/Knowledge_Graph) | 2026-10-05T13:16:47.139Z | 61,181 | efc85bdd43772329038cbdd7a730c8a7b9e65ebc035220a0ef90bb535deb7c1c |
| wikipedia-google-knowledge-graph.html | [Knowledge Graph (Google)](https://en.wikipedia.org/wiki/Knowledge_Graph_(Google)) | 2026-10-05T13:19:49.584Z | 203,380 | b5df5afc5a66daa41c52971bb68e1c57717ecb7c0b9f33879930a702df31dbb6 |
| wikipedia-neuroscience.html | [Neuroscience](https://en.wikipedia.org/wiki/Neuroscience) | 2026-10-05T13:16:47.957Z | 833,113 | 461009807b5e490aa5be4e963c64c8f49593f44924e51961501bcb91cdb11430 |

用 24,000 字符上限运行当前解析器：

| 来源页 | 清理后标题 | 保留正文字符 | 合格链接 | 标题数 | 截断 |
| --- | --- | ---: | ---: | ---: | --- |
| Knowledge Graph | Knowledge Graph | 342 | 4 | 0 | 否 |
| Knowledge Graph (Google) | Knowledge Graph (Google) | 5,568 | 37 | 7 | 否 |
| Neuroscience | Neuroscience | 24,000 | 100 | 10 | 是 |

这三页的断言检查导言保留、站点品牌去除、原始标题保留、语言栏及资源命名空间排除、引文编号排除，以及每条引用确实出现在保留正文中。知识图谱消歧页内容较短，是页面性质导致，不能据此认定文章缺失。神经科学页同时达到正文与链接上限，输出不能代表完整页面。

## 验证与边界

`tests/web.test.ts` 共 11 个测试通过，覆盖原有 URL/MIME/大小/取消边界、中文百科结构、平铺与嵌套章节、三个真实 HTML 样本、正文截断与第四参数兼容性。网页模块与测试的严格 TypeScript 检查通过。

解析仍是结构与规则驱动。非标准百科模板、其他语言的辅助章节名称、正文中使用普通列表伪装的导航，可能需要增加夹具与规则。短文或登录/动态页面仍明确失败。排除辅助章节会减少来自参见、参考书目的扩展入口，这是首版优先正文证据的取舍。现有公开 URL 验证只检查字面主机，DNS 解析和最终重定向地址的限制由传输层负责；这里没有新增保证。
