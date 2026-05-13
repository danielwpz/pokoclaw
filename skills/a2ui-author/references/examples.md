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

## GitHub Dashboard Layout

Use this pattern for a static GitHub dashboard or repository status board. The
key layout rule is: use `Row` for equal-width columns, and put each colored
panel in a `Box`. Do not use `Grid` for normal dashboard cards; `Grid` is
fixed-width and is intended for pixel displays.

```json
[
  {
    "dataModelUpdate": {
      "surfaceId": "github_dashboard",
      "path": "/",
      "contents": [
        {
          "key": "github",
          "valueMap": [
            { "key": "repoLine", "valueString": "owner/name" },
            { "key": "updatedAt", "valueString": "Updated just now" },
            { "key": "openIssuesDisplay", "valueString": "# 128" },
            { "key": "openPRsDisplay", "valueString": "# 17" },
            {
              "key": "mergedMarkdown",
              "valueString": "### Recent merged PRs\n- #42 Improve dashboard layout\n- #41 Fix card refresh\n- #40 Add A2UI demo"
            },
            {
              "key": "issuesMarkdown",
              "valueString": "### Recent new issues\n- #128 Box layout support\n- #127 Dashboard demo\n- #126 Better stats cards"
            }
          ]
        }
      ]
    }
  },
  {
    "surfaceUpdate": {
      "surfaceId": "github_dashboard",
      "components": [
        {
          "id": "root",
          "component": {
            "Column": {
              "gap": 12,
              "children": {
                "explicitList": ["header_box", "stats_row", "lists_row"]
              }
            }
          }
        },
        {
          "id": "header_box",
          "component": {
            "Box": {
              "backgroundColor": "#0B57D0",
              "padding": 16,
              "borderRadius": 12,
              "children": { "explicitList": ["header_title", "repo_line", "updated_at"] }
            }
          }
        },
        {
          "id": "header_title",
          "component": {
            "Text": { "text": { "literalString": "# GitHub Dashboard" } }
          }
        },
        {
          "id": "repo_line",
          "component": {
            "Text": { "text": { "path": "/github/repoLine" } }
          }
        },
        {
          "id": "updated_at",
          "component": {
            "Text": { "text": { "path": "/github/updatedAt" } }
          }
        },
        {
          "id": "stats_row",
          "component": {
            "Row": {
              "gap": 12,
              "children": { "explicitList": ["issues_card", "prs_card"] }
            }
          }
        },
        {
          "id": "issues_card",
          "component": {
            "Box": {
              "backgroundColor": "#EAF2FF",
              "padding": 16,
              "borderRadius": 12,
              "children": {
                "explicitList": ["issues_title", "issues_count", "issues_meta"]
              }
            }
          }
        },
        {
          "id": "prs_card",
          "component": {
            "Box": {
              "backgroundColor": "#FFF3E4",
              "padding": 16,
              "borderRadius": 12,
              "children": { "explicitList": ["prs_title", "prs_count", "prs_meta"] }
            }
          }
        },
        {
          "id": "issues_title",
          "component": {
            "Text": { "text": { "literalString": "### Open Issues" } }
          }
        },
        {
          "id": "issues_count",
          "component": {
            "Text": { "text": { "path": "/github/openIssuesDisplay" } }
          }
        },
        {
          "id": "issues_meta",
          "component": {
            "Text": {
              "text": { "literalString": "Issues currently open in this repo." }
            }
          }
        },
        {
          "id": "prs_title",
          "component": {
            "Text": { "text": { "literalString": "### Open PRs" } }
          }
        },
        {
          "id": "prs_count",
          "component": {
            "Text": { "text": { "path": "/github/openPRsDisplay" } }
          }
        },
        {
          "id": "prs_meta",
          "component": {
            "Text": {
              "text": { "literalString": "Pull requests waiting for review or merge." }
            }
          }
        },
        {
          "id": "lists_row",
          "component": {
            "Row": {
              "gap": 12,
              "children": { "explicitList": ["merged_box", "new_issues_box"] }
            }
          }
        },
        {
          "id": "merged_box",
          "component": {
            "Box": {
              "backgroundColor": "#F8FAFC",
              "padding": 16,
              "borderRadius": 12,
              "children": { "explicitList": ["merged_list"] }
            }
          }
        },
        {
          "id": "new_issues_box",
          "component": {
            "Box": {
              "backgroundColor": "#F8FAFC",
              "padding": 16,
              "borderRadius": 12,
              "children": { "explicitList": ["new_issues_list"] }
            }
          }
        },
        {
          "id": "merged_list",
          "component": {
            "Text": { "text": { "path": "/github/mergedMarkdown" } }
          }
        },
        {
          "id": "new_issues_list",
          "component": {
            "Text": { "text": { "path": "/github/issuesMarkdown" } }
          }
        }
      ]
    }
  },
  {
    "beginRendering": {
      "surfaceId": "github_dashboard",
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
