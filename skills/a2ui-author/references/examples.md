# A2UI Examples

## Confirmation Card

```json
[
  {
    "surfaceUpdate": {
      "surfaceId": "confirm_order",
      "components": [
        {
          "id": "root",
          "component": {
            "Column": {
              "children": { "explicitList": ["prompt", "actions"] }
            }
          }
        },
        {
          "id": "prompt",
          "component": {
            "Text": {
              "text": { "literalString": "Confirm this order?" }
            }
          }
        },
        {
          "id": "actions",
          "component": {
            "Row": {
              "children": { "explicitList": ["confirm_button"] },
              "distribution": "end"
            }
          }
        },
        {
          "id": "confirm_label",
          "component": {
            "Text": {
              "text": { "literalString": "Confirm" }
            }
          }
        },
        {
          "id": "confirm_button",
          "component": {
            "Button": {
              "child": "confirm_label",
              "primary": true,
              "action": {
                "name": "confirm",
                "context": [
                  { "key": "confirmed", "value": { "literalBoolean": true } }
                ]
              }
            }
          }
        }
      ]
    }
  },
  {
    "beginRendering": {
      "surfaceId": "confirm_order",
      "catalogId": "urn:a2ui:catalog:lark-card:v0_8",
      "root": "root"
    }
  }
]
```

## Form Submit Card

```json
[
  {
    "dataModelUpdate": {
      "surfaceId": "request_form",
      "path": "/",
      "contents": [
        {
          "key": "form",
          "valueMap": [
            { "key": "reason", "valueString": "" },
            {
              "key": "priority",
              "valueMap": [{ "key": "0", "valueString": "normal" }]
            }
          ]
        }
      ]
    }
  },
  {
    "surfaceUpdate": {
      "surfaceId": "request_form",
      "components": [
        {
          "id": "root",
          "component": {
            "Column": {
              "children": { "explicitList": ["intro", "form"] }
            }
          }
        },
        {
          "id": "intro",
          "component": {
            "Text": {
              "text": { "literalString": "Provide a reason and priority." }
            }
          }
        },
        {
          "id": "form",
          "component": {
            "Form": {
              "children": { "explicitList": ["reason_field", "priority_field"] },
              "submit": "submit_button"
            }
          }
        },
        {
          "id": "reason_field",
          "component": {
            "TextField": {
              "name": "reason",
              "label": { "literalString": "Reason" },
              "text": { "path": "/form/reason" },
              "textFieldType": "longText",
              "required": true
            }
          }
        },
        {
          "id": "priority_field",
          "component": {
            "MultipleChoice": {
              "name": "priority",
              "label": { "literalString": "Priority" },
              "selections": { "path": "/form/priority" },
              "options": [
                { "label": { "literalString": "Normal" }, "value": "normal" },
                { "label": { "literalString": "High" }, "value": "high" }
              ],
              "maxAllowedSelections": 1,
              "variant": "select"
            }
          }
        },
        {
          "id": "submit_label",
          "component": {
            "Text": {
              "text": { "literalString": "Submit" }
            }
          }
        },
        {
          "id": "submit_button",
          "component": {
            "Button": {
              "child": "submit_label",
              "primary": true,
              "action": {
                "name": "submit_form",
                "context": [
                  { "key": "source", "value": { "literalString": "request_form" } }
                ]
              }
            }
          }
        }
      ]
    }
  },
  {
    "beginRendering": {
      "surfaceId": "request_form",
      "catalogId": "urn:a2ui:catalog:lark-card:v0_8",
      "root": "root"
    }
  }
]
```
