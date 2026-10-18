# 严格 Meta CSP 静态验收

无需后端。HTML 使用大小写混合的 META 与数字实体编码的 CSP，原规则为 `default-src 'self'; script-src 'self'; style-src 'self'`。平台只为自身桥接脚本／Shadow DOM 样式添加 nonce，其余规则保留。

选择器：`#meta-title` 标题、`#meta-bar` SVG、`#meta-script-status` 外链脚本状态、`#meta-button`／`#meta-output` 原生交互计数。选择模式应出现正确样式的高亮与批注按钮；退出选择模式后按钮可继续计数。
