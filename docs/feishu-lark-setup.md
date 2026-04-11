# Feishu/Lark Setup Guide

Use this guide when the user is onboarding Pokeclaw. Feishu/Lark is currently the only supported channel, so this setup is required before startup.

## Product boundary

Say this clearly before setup starts:

- current Feishu/Lark support is for one personal assistant
- the user should connect a personal account, or another account fully under their personal control
- a shared team account or shared bot account is not a normal setup target right now

## Current setup mode

For normal onboarding:

- use long connection / WebSocket mode
- do not use webhook mode as the default path

## Setup steps

### 1. Choose the correct platform

Use the matching developer console:

- Feishu: <https://open.feishu.cn/app>
- Lark: <https://open.larksuite.com/app>

If the user is unsure, ask whether they are using a China Feishu tenant or an international Lark tenant.

### 2. Create the app

In the developer console:

1. Click **Create enterprise app**.
2. Fill in the app name and description.
3. Choose an app icon.

### 3. Collect credentials

From **Credentials & Basic Info**, collect:

- **App ID**
- **App Secret**

Do not ask the user to paste the App Secret into chat by default.

### 4. Configure permissions

In **Permissions**, use **Batch import** and paste this permission set:

```json
{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "cardkit:card:read",
      "cardkit:card:write",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "event:ip_list",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:bot_access",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ],
    "user": [
      "aily:file:read",
      "aily:file:write",
      "im:chat.access_event.bot_p2p_chat:read"
    ]
  }
}
```

If the platform UI or permission names have changed, adapt carefully instead of pretending the old list is exact.

### 5. Enable bot capability

In **App Capability** > **Bot**:

1. Enable bot capability.
2. Set the bot name.

### 6. Configure event subscription

In **Event Subscription**:

1. Choose **Use long connection to receive events**.
2. Add `im.message.receive_v1`.
3. If future document-comment workflows are needed, `drive.notice.comment_add_v1` can be added later.

Do not guide the user into webhook mode for normal onboarding.

### 7. Publish the app

1. Create a version in **Version Management & Release**.
2. Submit for review and publish.
3. Wait for approval if the tenant requires it.

### 8. Configure Pokeclaw

This is a required part of runnable onboarding, not an optional integration step.

Write `config.toml` like this:

```toml
[channels.lark.installations.default]
enabled = true
appId = "cli_xxx"
appSecret_ref = "secret://channels/lark/default/appSecret"
connectionMode = "websocket"
```

Write `secrets.toml` like this:

```toml
[channels.lark.default]
appSecret = "paste-your-feishu-or-lark-app-secret-here"
```

Only write the real App Secret into a file if the user explicitly asks you to do that.

### 9. Start Pokeclaw

Run:

```bash
pnpm build
pnpm start
```

`pnpm build` is the repo and toolchain check. `pnpm start` is the real config and startup check.

Pokeclaw does not yet provide a built-in background service or automatic restart path in this setup flow, so `pnpm start` is the normal launch path.

### 10. Return to normal onboarding

Once Pokeclaw has started successfully, continue with any remaining checks from `docs/onboarding.md`.
