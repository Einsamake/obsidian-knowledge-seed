/** Clean generated labels only. Existing user file names remain their own names. */
export function cleanKnowledgeTitle(input: string): string {
  let title = input.normalize('NFKC').replace(/\s+/g, ' ').trim();
  // IDs belong in metadata, never in the native graph's filename label.
  title = title.replace(/-(?:(?:seed|web|concept|note)-)?[a-f0-9]{8,32}(?:-\d+)?$/i, '').trim();
  const brand = '(?:维基百科(?:[，,、 ]*自由的百科全书)?|維基百科(?:[，,、 ]*自由的百科全書)?|Wikipedia(?:[，, ]*the free encyclopedia)?|百度百科|搜狗百科|互动百科|互動百科|自由的百科全书|自由的百科全書)';
  title = title.replace(new RegExp('\\s*(?:[-–—|｜_·]\\s*|[（(]\\s*)' + brand + '[）)]?\\s*$', 'i'), '').trim();
  return title || input.trim() || '未命名知识';
}

export function isNoiseLabel(input: string): boolean {
  const label = input.normalize('NFKC').trim();
  return !label || /^[a-f0-9]{8,64}$/i.test(label)
    // Bibliographic/resource identifiers stay in source evidence, not as
    // independent concepts. Preserve actual subjects such as DOI, UUID and IL-6.
    || /^(?:doi\s*:\s*|https?:\/\/(?:dx\.)?doi\.org\/)?10\.\d{4,9}\/\S+$/i.test(label)
    || /^(?:urn:uuid:)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(label)
    || /^(?:PMID\s*:?\s*\d{3,}|PMCID\s*:?\s*PMC\d{3,}|PMC\d{5,}|ISBN(?:-1[03])?[\s:]+[\dx -]{10,}|arXiv\s*:\s*(?:\d{4}\.\d{4,5}(?:v\d+)?|[a-z.-]+\/\d{7}(?:v\d+)?))$/i.test(label)
    || /^(?:https?:\/\/|www\.)\S+$/i.test(label)
    || /^(?:[a-z]:[\\/]|\.\.?[\\/]|\/)[^\s]*$/i.test(label)
    || /^(?:[^\s\\/]+[\\/])+[^\s\\/]+\.(?:html?|pdf|png|jpe?g|svg|gif|zip|js|css)$/i.test(label)
    || /^\[?\d+\]?$/.test(label)
    || /^(?:home|about|contact|read more|learn more|edit|contents|references|introduction|overview|see also|privacy policy|terms of use|log in|sign up|jump to navigation|jump to search|外部链接|外部連結|参考文献|參考文獻|编辑|編輯|编辑源代码|編輯原始碼|目录|目錄|首页|首頁|简介|簡介|更多|登录|登入|注册|註冊|来源|來源|隐私政策|隱私政策|免责声明|免責聲明|使用条款|使用條款|维基百科|維基百科|百度百科|搜狗百科|自由的百科全书|自由的百科全書|wikimedia commons|維基共享資源|维基共享资源)$/i.test(label)
    || /^(?:Special|Help|Wikipedia|Template|File|Category|Talk|User|Portal|MediaWiki|Draft|Module|特殊|帮助|幫助|模板|文件|檔案|分类|分類|讨论|討論|用户|使用者|主题|主題):/i.test(label);
}
