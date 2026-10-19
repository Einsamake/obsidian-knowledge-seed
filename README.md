<img width="800" height="500" alt="demo" src="https://github.com/user-attachments/assets/52f4f090-fc1a-43e6-9003-870a2835de45" />

# Knowledge Seed

从知识主题、网页或已有笔记出发在 **Obsidian 原生关系图**中探索相关概念

### 做这个插件的动机：
1. ***学习***:这件事究竟意味着什么，2026.10.13日得出的结论是：无非就是了解新的概念以及他们之间的组合罢了。既然如此，只要快速全览新的概念、联系旧的概念，然后学习概念的组合方式，那么学习的效率能否再提高一截
2. ***信息***:想要知道世间万物，想要获取世界上的所有信息，如果有足够的信息，那么人就会更好的决策，也就是，人会做出错误的决策是获取信息不足产生的。另一方面，获取有一定随机性信息能冲破算法带来的信息茧房，同时获取完全不同领域的意见和观点

基于以上的思考及个人想法，一些颇有趣味的扩展功能正在开发中，敬请期待

因为不清楚有没有同类型的插件，所以若发现有相似功能的repo，欢迎分享

以下为安装说明，若不想看可以直接丢给AI

**版本：0.14.4（开发测试版）** · Obsidian ≥ 1.6.0 · 已实测 Windows / Obsidian 1.14.4

感谢**GPT6.1Sol Ultra**对这个仓库做出的无私奉献，你夜以继日的努力我都看在眼里(笑

[下载安装包](https://github.com/Einsamake/obsidian-knowledge-seed/releases/tag/v0.14.4) · [更新记录](https://github.com/Einsamake/obsidian-knowledge-seed/blob/main/CHANGELOG.md) · [反馈问题](https://github.com/Einsamake/obsidian-knowledge-seed/issues) · [验证记录](docs/verification.md)

## 目录

[安装](#安装) · [开始使用](#开始使用) · [常用操作](#常用操作) · [升级与帮助](#升级与帮助)

## 安装

1. [下载安装包](https://github.com/Einsamake/obsidian-knowledge-seed/releases/download/v0.14.4/knowledge-seed-0.14.4.zip)，解压得到 `knowledge-seed` 文件夹。
2. 将文件夹放进笔记库的 `.obsidian/plugins/`，确认以下三个文件直接位于其中：

   `你的笔记库/.obsidian/plugins/knowledge-seed/` → `main.js`、`manifest.json`、`styles.css`

3. Obsidian **设置 → 第三方插件**：按提示关闭受限模式，启用 **Knowledge Seed**。
4. **设置 → 核心插件**：启用 **关系图谱**。

找不到笔记库位置时，右键任意笔记，选择“在系统资源管理器中显示”；看不到 `.obsidian` 时，开启显示隐藏文件。插件未出现时，检查路径后重启 Obsidian。

## 开始使用

1. 按 **Ctrl + P**（Mac：**Cmd + P**），执行 **Knowledge Seed：从网页或主题生成知识地图**。
2. 输入主题（如 `神经科学`）或完整网页地址。已有笔记可直接执行 **从当前笔记生成知识地图**。
3. 保持默认参数，开启 **开始后直接显示关系图**，点击 **开始发现**。

概念图逐步生成，正文在后台补充。点击节点即可阅读；Obsidian 运行期间可以切换笔记。

## 常用操作

| 想做什么 | 在哪里操作 |
| --- | --- |
| 找回关闭的图 | **我的知识图谱 → 选择起点 → 打开关系图** |
| 在大图中局部漫游 | 右键节点 → **进入此处（局部漫游）**；侧栏可调视野、迷雾和返回路线 |
| 右键操作节点 | 在原生图中右键节点，可设为中心、继续探索、查看来源、补正文或剪枝 |
| 沿某个概念深入 | 右键节点 → **沿此节点继续探索**，也可在侧栏填写探索方向 |
| 暂停、继续或停止 | 侧栏 **暂停探索 / 继续探索 / 停止探索** |
| 减少不需要的分支 | 选择节点 → **移出此节点 / 移出此分支**；笔记保留 |
| 调整搜索范围 | **调整探索策略**；想聚焦时选 **围绕主题**，填写探索方向 |
| 节点没有正文 | 设置中开启 **检索公开网页** 和 **后台补充概念正文**；在侧栏 **正文任务** 继续或重试 |

关闭面板不会停止任务；重启 Obsidian 后，未完成的探索需要点 **继续探索**。

## 升级与帮助

停用插件 → 只覆盖 `main.js`、`manifest.json`、`styles.css` → 重新启用。**保留 `data.json`、笔记和 `Runs`。** 从旧 1.4.x 切换到 0.14.x 也按此方法手动安装。

当前主要检索 Wikipedia 和指定网页，不调用 AI 模型；论文语义解析尚未提供。

[完整使用说明](docs/usage.md) · [反馈问题](https://github.com/Einsamake/obsidian-knowledge-seed/issues) · [开发交接](https://github.com/Einsamake/obsidian-knowledge-seed/blob/main/docs/maintenance-handoff.md)

反馈请附：版本、起点、操作步骤和完整报错。
