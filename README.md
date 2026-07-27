# Trinity Slack Controller

A small, dependency-free local web controller for sending deliberate Slack
messages through a bot.

It supports:

- editable Slack messages;
- reusable one-click templates;
- Slack `mrkdwn` formatting;
- real user mentions from `U…` member IDs;
- channel, group, DM, and member destinations;
- a confirmation dialog before every send;
- a loopback-only server that never exposes the bot token to the browser.

## Requirements

- Node.js 18 or newer
- Git
- A Slack app installed in your workspace
- A Slack bot token beginning with `xoxb-`

No `npm install` is required. The project uses only Node.js built-in modules.

## 1. Create and configure the Slack app

1. Open <https://api.slack.com/apps> and create an app.
2. Open **OAuth & Permissions**.
3. Add the `chat:write` bot-token scope.
4. Optional: add `chat:write.public` if the bot must post in public channels
   without first being invited.
5. Install or reinstall the app to the workspace.
6. Copy the **Bot User OAuth Token** beginning with `xoxb-`.
7. For private channels, invite the bot before sending.

Slack API references:

- [`chat.postMessage`](https://api.slack.com/methods/chat.postMessage)
- [Sending Slack messages](https://api.slack.com/messaging/sending)
- [Slack token safety](https://api.slack.com/docs/oauth-safety)

## 2. Clone the repository

```bash
git clone https://github.com/rose2221/trinity-slack-controller.git
cd trinity-slack-controller
```

## 3. Start on macOS

Terminal:

```bash
chmod +x start.command
./start.command
```

Paste the bot token into the hidden prompt. The controller opens at
<http://127.0.0.1:3847>.

You can also double-click `start.command` in Finder after making it executable.

## 4. Start on Linux

```bash
read -rsp "Slack bot token: " SLACK_BOT_TOKEN
echo
export SLACK_BOT_TOKEN
npm start
```

Open <http://127.0.0.1:3847> in a browser.

## 5. Start on Windows PowerShell 7

```powershell
$env:SLACK_BOT_TOKEN = Read-Host "Slack bot token" -MaskInput
npm start
```

Open <http://127.0.0.1:3847> in a browser.

## Optional environment settings

Use a different port:

```bash
PORT=4000 SLACK_BOT_TOKEN="$SLACK_BOT_TOKEN" npm start
```

The server binds to `127.0.0.1` by default. Keep it loopback-only unless you
understand the security implications of exposing a token-backed sender to a
network.

## Finding Slack IDs

Slack destinations use encoded IDs:

| Prefix | Destination |
| --- | --- |
| `C…` | Public or private channel |
| `G…` | Multi-person direct message or private group |
| `D…` | Existing one-to-one DM conversation |
| `U…` | Workspace member; Slack opens the bot conversation |

To find a member ID:

1. Open the member’s Slack profile.
2. Select **More**.
3. Select **Copy member ID**.

Channel and conversation links normally contain their encoded destination ID.
Do not use display names because they are not unique.

## Using the controller

1. Enter a destination ID.
2. Optionally enter a member ID to mention in saved templates.
3. Choose a saved message or edit the text box.
4. Review the confirmation dialog.
5. Confirm the send.

The DM panel has its own destination and sends the four-point team update
without changing the main channel destination.

Slack formatting uses single asterisks for bold text:

```text
*Bold task title*
```

A real member mention uses:

```text
<@U012ABCDEF>
```

## Customize the templates

Edit the `templates` and `dmTemplate` values in
[`public/index.html`](public/index.html), then restart or refresh the page.

Use `{{mention}}` inside a saved template. The controller replaces it with the
member ID entered in the UI, or with `the assignee` when no valid member ID is
provided.

## Validation commands

```bash
npm run check
npm test
```

Expected result:

```text
# pass 4
# fail 0
```

## Troubleshooting

### `invalid_auth` or `token_revoked`

Create or rotate the bot token, then restart the controller with the new token.

### `missing_scope`

Add `chat:write` under **OAuth & Permissions**, reinstall the Slack app, and use
the newly issued token.

### `channel_not_found`

Verify the encoded ID. For a private channel, invite the bot. For a DM, use the
member ID (`U…`) or an existing DM conversation ID (`D…`).

### `not_in_channel`

Invite the bot to the destination channel:

```text
/invite @YourBotName
```

### `Port 3847 is already in use`

Stop the other controller with `Control-C`, or choose another port:

```bash
PORT=4000 npm start
```

### The page shows an old validation message

Hard-refresh the browser:

- macOS: `Command-Shift-R`
- Windows/Linux: `Control-Shift-R`

## Security

- Never commit a real Slack token.
- Never paste a token into an issue, pull request, screenshot, or chat.
- Rotate a token immediately if it is exposed.
- Keep the server bound to `127.0.0.1`.
- Review the destination and confirmation dialog before every send.
- Use the minimum Slack scopes required for your workflow.

The token stays in the Node.js process. It is not embedded in the HTML, sent to
the browser, written to local storage, or logged by the controller.

## License

[MIT](LICENSE)
