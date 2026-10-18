# Artifact 兼容验收素材

这里是可复验的源文件基线。验收时把这里复制到一个项目目录再运行，不修改这里的原始素材。

| 清单 key | 素材 | 重点 |
| --- | --- | --- |
| article | 阅读与表单 | 长文、跨行文本、按钮、表单、折叠内容、滚动 |
| chart | SVG 数据图表 | 大写 HEAD、根路径 CSS、SVG rect、更新数据 |
| canvas | Canvas 目标游戏 | Canvas 点击、区域框选、PNG 选取证据 |
| dynamic | 动态页面与组件 | 动态 DOM、路由视图、open Shadow DOM、强制全局按钮样式 |
| pages | 多页面与模块 | 原有 base、嵌套页面、根路径模块、相对 import、返回导航 |

在 Studio 中打开本目录即可从 `studio.artifacts.json` 登记五个页面。真实后端数据库另见 `examples/persistent-game`。

复验时在浏览器里检查显示与交互，不发送 CLI 请求。运行环境和服务状态影响结果，素材存在本身不代表测试通过。
