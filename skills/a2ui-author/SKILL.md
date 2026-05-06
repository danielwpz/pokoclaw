---
name: a2ui-author
description: Generate, validate, and interpret static A2UI v0.8 JSON for interactive UI surfaces. Use when an agent needs to call publish_a2ui, author A2UI messages, check whether generated A2UI JSON is valid, or handle normalized userAction replies from interactive UI callbacks.
---

# A2UI Author

Use this skill to work with the static A2UI v0.8 subset supported by the
current renderer.

## Workflow

1. Author A2UI server messages, not raw channel card JSON.
2. Read [references/protocol.md](references/protocol.md) for message structure,
   supported components, bindings, and current renderer adaptations.
3. Use [references/examples.md](references/examples.md) for compact examples.
4. Validate generated JSON with the bundled script. Resolve `<skill-dir>` to
   this skill directory before running the command:

```bash
node <skill-dir>/scripts/validate-a2ui.js --version v0_8 path/to/a2ui.messages.json
```

5. For user replies, reason from A2UI `userAction` events. Do not expose raw
   channel callback payloads to application logic or an LLM.

## Static Content Rule

Generate only static A2UI server messages: `dataModelUpdate`, `surfaceUpdate`,
`beginRendering`, and `deleteSurface`. Do not emit messages or components
outside the supported static subset documented in this skill.
