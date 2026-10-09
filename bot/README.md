# Telegram 黄历查询与 DeepSeek 解读

复用仓库原有 `lunar.js`，不抓取网页，也不让 AI 计算干支或宜忌。Node.js 22+，无第三方 npm 依赖，私聊文字版，长轮询运行，无须域名或入站端口。

## 命令

- `/id`：显示自己的 Telegram 数字用户 ID（无需授权）。
- `/today`：北京时间今天的黄历，不调用 AI。
- `/date 2026-10-18` 或直接输入 `2026-10-18`：指定日期，支持 1900–2100 年。
- `/ask 2026-10-18 解释当天宜忌`：查询后交给 DeepSeek 解读。
- `/ask 解释今天宜忌`：按北京时间今天解读。无跨消息记忆，每次需自行指定日期。
- `/help`：使用说明。

网页为控制排版会截取部分宜忌；机器人显示同一计算规则 `getDayYi(1)` / `getDayJi(1)` 的完整列表，故项目数量可能多于网页。

## Linux 服务器部署

1. 在 Telegram 的 @BotFather 创建一个**独立的新机器人**，取得令牌。不要与现有轮询服务共用同一个令牌。
2. 将仓库下载到服务器，确保 Node.js 22+ 已安装且能访问 Telegram 和 DeepSeek。
3. 在仓库根目录执行 `sudo sh bot/install.sh`。
4. 用服务器编辑器打开 `/etc/oldalmanac-bot.env`，填写：

```ini
TELEGRAM_BOT_TOKEN=自己的机器人令牌
DEEPSEEK_API_KEY=自己的DeepSeek密钥
DEEPSEEK_MODEL=deepseek-flash
ALLOWED_USER_IDS=自己的数字用户ID
MAX_DAILY_AI_REQUESTS=30
STATE_FILE=/var/lib/oldalmanac-bot/state.json
```

5. `sudo systemctl enable --now oldalmanac-bot`。如果不知道用户 ID，可先留空白名单，启动后向机器人发送 `/id`，再填写并 `sudo systemctl restart oldalmanac-bot`。
6. `sudo systemctl status oldalmanac-bot` 查看状态；`sudo journalctl -u oldalmanac-bot -n 30 --no-pager` 查看日志。

安装脚本不覆盖已存在的配置，不自动启动服务；重复安装会更新代码，随后需手动重启。服务账号为 `oldalmanac-bot`，代码位于 `/opt/oldalmanac-bot`。停止可用 `sudo systemctl disable --now oldalmanac-bot`。

## 本地运行

复制 `bot/.env.example` 到 `bot/.env` 并填写配置，本地将 STATE_FILE 改成 `./bot/data/state.json`。仓库根目录运行：

```sh
node --env-file=bot/.env bot/server.cjs
node --test bot/test.cjs
```

## 费用、数据与限制

- 白名单为空时，除 `/id` 外无人可用；仅私聊，群组忽略。
- 只有 `/ask` 调用 DeepSeek，单人间隔15秒、全机器人每天默认30次；按北京时间日界重置，额度和轮询位置持久化。尝试调用即计数，网络失败不退款，避免未知计费导致重试超支。
- 只向 DeepSeek 发送该天的黄历数据及用户问题，不发送 Telegram 身份或对话历史。日志不记录消息正文、令牌或密钥。
- 当前模型默认来自官方文档，账号不支持时可修改 DEEPSEEK_MODEL。接口地址固定为官方 HTTPS 地址。
- AI 失败时保留本地查询结果。解读是民俗参考，不代表现实结果，也不是专业决策依据。
- 为避免进程崩溃后重复付费，先保存更新位置再处理消息：异常崩溃可能导致当前消息未回复，请重新发送。消息投递不保证恰好一次。
- 单实例顺序处理；不能并行启动两个服务共用令牌。已设置 webhook 时拒绝启动，不自动删除原配置。
- 不自动发送早报、没有图片输出、不支持多轮聊天。本次不改网页功能。GitHub Pages 不能运行常驻机器人。
- `.env` 和状态文件不得上传仓库；生产密钥只放 `/etc/oldalmanac-bot.env`。服务器状态目录应随日常备份保留。

## 验证

10项离线自动测试涵盖日期校验、北京时间、已知农历、命令、消息分段、状态文件、模拟 DeepSeek 请求、权限、限流及AI故障降级。测试不使用真实密钥、不产生API费用。实际 Telegram 与 DeepSeek 端到端连通仍须配置后验证。

接口依据：[Telegram Bot API](https://core.telegram.org/bots/api)、[DeepSeek API](https://api-docs.deepseek.com/en/)。
