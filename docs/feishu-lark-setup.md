# Feishu/Lark Setup Guide

Use this guide when the user is onboarding Pokoclaw. Feishu/Lark is currently the only supported channel, so this setup is required before startup.

## Phase 3C: Required Feishu/Lark setup

This phase is independent from:

- `docs/onboarding.md`, Phase 3A: OpenClaw import
- `docs/onboarding.md`, Phase 3B: Clean setup

Both paths must still complete this phase before `pnpm start`.

## Product boundary

Say this clearly before setup starts:

- current Feishu/Lark support is for one personal assistant
- the user should connect a personal account, or another account fully under their personal control
- a shared team account or shared bot account is not a normal setup target right now
- strongly recommend creating a dedicated new bot for Pokoclaw instead of reusing one from another product
- reusing an existing bot is error-prone because permissions, notification routing, and long-connection ownership can conflict in hard-to-debug ways

## Current setup mode

For normal onboarding:

- use long connection / WebSocket mode
- do not use webhook mode as the default path

## Setup steps

### 3C-1. Decide whether to reuse the existing OpenClaw bot

If the user's current OpenClaw already has Feishu/Lark configured:

- do not silently copy that bot config into Pokoclaw
- first ask whether they want to reuse the same bot or create a new one
- strongly recommend creating a new dedicated bot or app for Pokoclaw
- if they still want reuse, explain the concrete risk: one channel with two active backends can conflict or mix behavior

If the user explicitly chooses to reuse the same bot, make sure they understand the risk and do not present it as the default path.

### 3C-2. Choose the correct platform

Use the matching developer console:

- Feishu: <https://open.feishu.cn/app>
- Lark: <https://open.larksuite.com/app>

If the user is unsure, ask whether they are using a China Feishu tenant or an international Lark tenant.

### 3C-3. Create the app

In the developer console:

1. Click **Create enterprise app**.
2. Fill in the app name and description.
3. Choose an app icon.

### 3C-4. Collect credentials

From **Credentials & Basic Info**, collect:

- **App ID**
- **App Secret**

Do not ask the user to paste the App Secret into chat by default.

### 3C-5. Configure permissions

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
      "cardkit:template:read",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "event:ip_list",
      "im:app_feed_card:write",
      "im:biz_entity_tag_relation:read",
      "im:biz_entity_tag_relation:write",
      "im:chat",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.announcement:read",
      "im:chat.announcement:write_only",
      "im:chat.chat_pins:read",
      "im:chat.chat_pins:write_only",
      "im:chat.collab_plugins:read",
      "im:chat.collab_plugins:write_only",
      "im:chat.managers:write_only",
      "im:chat.members:bot_access",
      "im:chat.members:read",
      "im:chat.members:write_only",
      "im:chat.menu_tree:read",
      "im:chat.menu_tree:write_only",
      "im:chat.moderation:read",
      "im:chat.tabs:read",
      "im:chat.tabs:write_only",
      "im:chat.top_notice:write_only",
      "im:chat.widgets:read",
      "im:chat.widgets:write_only",
      "im:chat:create",
      "im:chat:delete",
      "im:chat:moderation:write_only",
      "im:chat:operate_as_owner",
      "im:chat:read",
      "im:chat:readonly",
      "im:chat:update",
      "im:datasync.feed_card.time_sensitive:write",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.group_msg",
      "im:message.p2p_msg:readonly",
      "im:message.pins:read",
      "im:message.pins:write_only",
      "im:message.reactions:read",
      "im:message.reactions:write_only",
      "im:message.urgent",
      "im:message.urgent.status:write",
      "im:message.urgent:phone",
      "im:message.urgent:sms",
      "im:message:readonly",
      "im:message:recall",
      "im:message:send_as_bot",
      "im:message:send_multi_depts",
      "im:message:send_multi_users",
      "im:message:send_sys_msg",
      "im:message:update",
      "im:resource",
      "im:tag:read",
      "im:tag:write",
      "im:url_preview.update",
      "im:user_agent:read"
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

### 3C-6. Enable bot capability

In **App Capability** > **Bot**:

1. Enable bot capability.
2. Set the bot name.

### 3C-7. Configure event subscription

In **Event Subscription**:

1. Choose **Use long connection to receive events**.
2. Add `im.message.receive_v1`.
3. If future document-comment workflows are needed, `drive.notice.comment_add_v1` can be added later.

Do not guide the user into webhook mode for normal onboarding.

### 3C-8. Publish the app

1. Create a version in **Version Management & Release**.
2. Submit for review and publish.
3. Wait for approval if the tenant requires it.

### 3C-9. Configure Pokoclaw

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

### 3C-10. Start Pokoclaw

Run:

```bash
pnpm build
pnpm start
```

`pnpm build` is the repo and toolchain check. `pnpm start` is the real config and startup check.

Pokoclaw does not yet provide a built-in background service or automatic restart path in this setup flow, so `pnpm start` is the normal launch path.

### 3C-11. Return to normal onboarding

Once Pokoclaw has started successfully, continue with `docs/onboarding.md`, Phase 4: Validation and first run.
