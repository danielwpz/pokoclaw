# A2UI

A2UI is a channel-agnostic protocol for structured interactive UI. It lets an agent publish forms, choices, and other interactive surfaces instead of replying only with text.

The current Pokoclaw adapter renders A2UI into Lark CardKit, but A2UI itself is not a Lark-specific feature.

Pokoclaw's first production integration is intentionally narrow:

- Static A2UI runtime messages are supported: `surfaceUpdate`, `dataModelUpdate`, `beginRendering`, and `deleteSurface`.
- Channel callbacks are routed back to the source chat session.
- User-submitted form values are returned to the agent as `submittedValues`.
- Literal button context is returned to the agent.
- `dataSourceUpdate` is rejected.
- Dynamic data sources, bash-driven refresh, and TTL-based dynamic runtimes are not part of A2UI 1.0.
- `Button.action.context.value.path` is rejected so dataModel contents are not copied into the agent transcript through callback context.

## Callback Payload

The agent-visible callback payload contains only:

- action name
- surface id
- source component id
- timestamp
- literal context
- submitted user values

Renderer-normalized callback events are not forwarded wholesale because they can resolve `dataModel` paths into agent-visible context.

## Persistence

A2UI publication state is durable. It is stored in SQLite table `a2ui_surface_publications`, introduced by storage migration `0003_a2ui_surface_publications.sql`.

The stored state includes:

- source session, conversation, and branch
- channel type and installation
- channel artifact id and optional channel message id
- current channel update sequence
- serialized surface state and dataModel
- consumed action keys

This allows existing channel-rendered A2UI surfaces to keep handling callbacks after a Pokoclaw process restart. The Lark adapter maps its CardKit card id into `channel_artifact_id` and its message id into `channel_message_id`.
