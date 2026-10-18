# 严格 CSP 后端验收

Node.js 原生 HTTP fixture，无安装依赖。HTML 响应头：`default-src 'self'; script-src 'self'; style-src 'self'`。网页仅使用外链脚本／样式；平台为自己的桥接脚本与 Shadow DOM 样式添加 nonce。

注册为 root=`strict-backend`、entry=`index.html`、command=`["node","server.mjs"]`，指定一个空闲后端端口。不包含永久业务数据；计数仅用于运行时验收。

验收选择器：`#strict-title` 标题、`#strict-bar` SVG 柱形、`#script-status` 外链 JS 状态；`#note`／`#form-submit` 原生 POST 与 303 重定向；`#cookie-button`／`#cookie-output` Fetch 及 HttpOnly cookie 往返；`#stream-button`／`#stream-output li` 三条 SSE 事件。选择模式下，应可选标题／SVG 且显示批注控件；退出选择模式后表单和按钮正常工作。
