# 持久化游戏验收示例

这是实际 Node 后端与 SQLite 数据库示例，不是模拟数据。Node22.14内置 SQLite仍有实验性提示，生产部署需固定已验收 Node版本。

可以把此文件夹复制到项目的 `game/`，然后登记 Artifact：root=`game`，entry=`index.html`，command=`["node","server.mjs"]`，port=`4320`，dataPaths=`["game/data"]`。

启动后游戏分数写入 `game/data/game.sqlite`。Artifact 的“创建快照”会先停止应用，再备份声明的数据；恢复保留替换前文件副本，并保持应用停止，需再次启动。
