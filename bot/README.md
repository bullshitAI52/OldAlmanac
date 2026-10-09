# Telegram 黄历查询与 DeepSeek 解读

复用仓库原有 `lunar.js`，不抓取网页，也不让 AI 计算干支或宜忌。Node.js 22+，无第三方 npm 依赖，私聊文字版，长轮询运行，无须域名或入站端口。

## 命令模板

发送 `/template` 或点击“命令模板”，会显示三条带复制按钮的命令：`/today`、`/date 当天日期`、`/ask 当天日期 解释当天宜忌`。点击复制，粘贴后修改数字再发送。直接发 `/date`、`/ask` 也会打开模板。发送 `/help` 显示底部快捷键盘。

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
- 基础交互服务不定时发送；图片与自动推送见下方v0.2模块。不支持多轮聊天。本次不改网页功能。GitHub Pages 不能运行常驻机器人。
- `.env` 和状态文件不得上传仓库；生产密钥只放 `/etc/oldalmanac-bot.env`。服务器状态目录应随日常备份保留。

## 验证

基础10项离线自动测试涵盖日期校验、北京时间、已知农历、命令、消息分段、状态文件、模拟 DeepSeek 请求、权限、限流及AI故障降级。测试不使用真实密钥、不产生API费用。实际 Telegram 与 DeepSeek 端到端连通仍须配置后验证。

接口依据：[Telegram Bot API](https://core.telegram.org/bots/api)、[DeepSeek API](https://api-docs.deepseek.com/en/)。

## 每日00:01图片与大白话推送（v0.2）

按 **Asia/Shanghai（北京时间）每天00:01** 发送刚进入这一天的日历，例如10月9日晚过零点后发送10月10日。VPS使用什么系统时区不影响安排。

- 图片直接使用在线网页的当日画布，等待日期和渲染完成后导出PNG；固定浏览器日期及时区，避免服务器日期偏差。
- DeepSeek先读当天完整资料，按“开场介绍、宜与忌、时辰吉凶、吉神方位、干支五行与星宿、一句话总结”逐项通俗解释，约700–1000字，标明民俗参考。每日额外一次AI调用，与手动 /ask 限额独立；当天总结生成后缓存。
- AI失败使用明确标注的本地备用说明；网页/浏览器故障则不会发送错误日期或空白图片，服务最多有限重试。
- 图片和文字分别记录发送状态，重启不自动重复。发送请求超时等结果不确定时保留 uncertain 状态，需人工核查，避免重复推送；不承诺网络故障下恰好一次送达。
- 关机错过时间后，Persistent定时器恢复时补发**恢复当天**，不补历史多天。不会在00:00提前发。
- 只向 DAILY_CHAT_IDS 中且已在白名单的私人账号发送。用户需先打开机器人并发消息。

部署基础机器人后运行 `sudo sh bot/install-daily.sh`。增加配置：

```ini
DAILY_CHAT_IDS=接收人的数字ID
CHROMIUM_EXECUTABLE=/服务账号可访问的Chromium可执行文件
DAILY_STATE_DIR=/var/lib/oldalmanac-bot/daily
```

服务器没有浏览器时，可在 bot 目录使用 `PLAYWRIGHT_BROWSERS_PATH=/opt/oldalmanac-bot/runtime/browsers npx playwright-core install --with-deps chromium`，将安装后的可执行文件绝对路径填入配置，并保证服务账号可读。已有浏览器可复用，但不要指向 /root 私有目录。

```sh
sudo systemctl enable --now oldalmanac-daily.timer
sudo systemctl list-timers oldalmanac-daily.timer
sudo systemctl start oldalmanac-daily.service  # 立即推送当天样例，会真实发送
sudo journalctl -u oldalmanac-daily.service -n 30 --no-pager
sudo systemctl disable --now oldalmanac-daily.timer  # 关闭后续定时推送
```

状态/图片位于私有daily目录，需保留以防重发。该目录随天数增长，可按运维计划保留最近90天（勿删除当天状态）。新增测试：`node --test bot/test.cjs bot/daily.test.cjs`。图库抓取使用独立无登录浏览器，不加载API密钥。

详细模板说明：资料包含网页同源时辰、方位、五行、星宿、九星、胎神和冲煞标签。早子与晚子分开，不将网页过滤后的空白忌当作无禁忌；吉门为网页自定义公式。解释为民俗，不据此预测怀孕健康、个人风险或收益。长消息自动分段，保留结尾总结。
